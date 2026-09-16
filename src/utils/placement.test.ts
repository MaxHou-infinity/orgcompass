import { describe, expect, it } from 'vitest';
import type { Department, Employee, PositionAssignment } from '../types';
import { DEFAULT_COMPETENCY_MODEL } from '../types';
import { assignPrimary, inspectPlacements, reconcilePlacementChange, seedLegacyAssignments } from './placement';
import type { HistorySnapshot } from './history';
import { confirmedNotCompetentSet } from './assignment';
import { computeMatchStates } from './match';

const t0 = '2026-09-01T00:00:00.000Z';
const t1 = '2026-09-02T00:00:00.000Z';
const t2 = '2026-09-03T00:00:00.000Z';
function emp(id: string, positionId?: string): Employee {
  return { id, name: id, employeeId: id, level: 'L1', positionId };
}
function dept(id: string, employees: Employee[] = []): Department {
  return { id, name: id, level: 1, children: [], employees, expanded: true,
    positions: [{ id: `p${id}`, departmentId: id, name: `岗位${id}`, status: 'active', headcount: 1, createdAt: t0, updatedAt: t0 }] };
}
function fixture(): HistorySnapshot {
  const e = emp('e', 'pa');
  return { departments: [dept('a', [e]), dept('b'), dept('c')], allEmployeesFlat: [e], assessments: [],
    competencyModel: structuredClone(DEFAULT_COMPETENCY_MODEL), positionAssignments: [] };
}
const apply = (before: HistorySnapshot, after: HistorySnapshot, at = t1) => reconcilePlacementChange(before, after, at);
function confirm(s: HistorySnapshot): HistorySnapshot {
  const records = seedLegacyAssignments(s.allEmployeesFlat, s.departments, s.positionAssignments, t0);
  return { ...s, positionAssignments: [...records, { ...records[0], id: 'confirm', relationId: records[0].id,
    status: 'not_competent', confirmedAt: t0 }] };
}

describe('M1 当前关系与历史', () => {
  it('A05/A06 换岗后旧确认失效，返回原岗位也不复活；前快照不被改写', () => {
    const a = confirm(fixture());
    expect(confirmedNotCompetentSet(a.positionAssignments, a.allEmployeesFlat).has('e')).toBe(true);
    const b = apply(a, assignPrimary(a, 'e', 'pb'));
    expect(b.allEmployeesFlat[0].positionId).toBe('pb');
    expect(b.departments[0].employees).toHaveLength(0);
    expect(b.departments[1].employees[0].positionId).toBe('pb');
    expect(b.positionAssignments.find((r) => r.id === a.positionAssignments[0].id)).toMatchObject({ status: 'ended', endDate: t1 });
    expect(confirmedNotCompetentSet(b.positionAssignments, b.allEmployeesFlat).size).toBe(0);
    const back = apply(b, assignPrimary(b, 'e', 'pa'), t2);
    expect(back.positionAssignments.find((r) => r.status === 'active')!.id).not.toBe(a.positionAssignments[0].id);
    expect(confirmedNotCompetentSet(back.positionAssignments, back.allEmployeesFlat).size).toBe(0);
    expect(back.positionAssignments.find((r) => r.id === 'confirm')).toEqual(a.positionAssignments[1]);
    expect(a.positionAssignments[0].status).toBe('active');
    expect(inspectPlacements(back.allEmployeesFlat, back.departments)).toEqual([]);
  });

  it('A08 跨部门移动结束旧岗，名册和画布同时清引用', () => {
    const a = confirm(fixture());
    const b = apply(a, { ...a, departments: [dept('a'), dept('b', a.allEmployeesFlat), dept('c')] });
    expect(b.allEmployeesFlat[0].positionId).toBeUndefined();
    expect(b.departments[1].employees[0].positionId).toBeUndefined();
    expect(b.positionAssignments.filter((r) => r.status === 'active')).toEqual([]);
    expect(b.positionAssignments[0].endDate).toBe(t1);
  });

  it.each(['取消套岗', '移出架构', '岗位归档', '部门移除'])('%s 保留真人和评分，结束关联', (operation) => {
    const a = confirm(fixture());
    let next = structuredClone(a);
    if (operation === '取消套岗') {
      next.allEmployeesFlat[0].positionId = undefined;
      next.departments[0].employees[0].positionId = undefined;
    }
    if (operation === '移出架构') next.departments[0].employees = [];
    if (operation === '岗位归档') next.departments[0].positions![0].status = 'archived';
    if (operation === '部门移除') next = { ...next, departments: next.departments.slice(1) };
    const b = apply(a, next);
    expect(b.allEmployeesFlat).toHaveLength(1);
    expect(b.allEmployeesFlat[0].positionId).toBeUndefined();
    expect(b.assessments).toEqual(a.assessments);
    expect(b.positionAssignments[0]).toMatchObject({ status: 'ended', endDate: t1 });
    expect(b.positionAssignments.find((r) => r.id === 'confirm')).toBeDefined();
  });

  it('A04 两个兼岗各有独立关系，取消一个不影响另一个及主岗', () => {
    const a = fixture();
    const vb = { ...emp('vb', 'pb'), isVirtual: true, primaryEmployeeId: 'e', assignmentType: 'secondary' as const };
    const vc = { ...vb, id: 'vc', positionId: 'pc' };
    const b = apply(a, { ...a, allEmployeesFlat: [...a.allEmployeesFlat, vb, vc],
      departments: [a.departments[0], dept('b', [vb]), dept('c', [vc])] });
    expect(b.positionAssignments.filter((r) => r.status === 'active')).toHaveLength(3);
    expect(computeMatchStates(b.allEmployeesFlat, b.departments.flatMap((d) => d.positions!))).toHaveLength(1);
    const c = apply(b, { ...b, allEmployeesFlat: b.allEmployeesFlat.filter((e) => e.id !== 'vb'),
      departments: [b.departments[0], dept('b'), b.departments[2]] }, t2);
    expect(c.positionAssignments.filter((r) => r.status === 'active')).toHaveLength(2);
    expect(c.positionAssignments.find((r) => r.positionId === 'pb')).toMatchObject({ status: 'ended', endDate: t2 });
    expect(c.allEmployeesFlat[0].positionId).toBe('pa');
  });

  it('A24 旧关系只生成未知日期标识，重复处理不改标识；展开改名不生成历史', () => {
    const a = fixture();
    const records = seedLegacyAssignments(a.allEmployeesFlat, a.departments, [], t0);
    expect(records[0]).toMatchObject({ status: 'active', source: 'legacy' });
    expect(records[0].startDate).toBeUndefined();
    expect(seedLegacyAssignments(a.allEmployeesFlat, a.departments, records, t1)).toEqual(records);
    const b = apply(a, { ...a, departments: a.departments.map((d) => ({ ...d, name: '新名称', expanded: false })) });
    expect(b.positionAssignments).toEqual([]);
  });

  it('A09 重复挂载、失效岗位、画布名册分歧可见，不能判为正常套岗', () => {
    const a = fixture();
    a.departments[1].employees.push(a.allEmployeesFlat[0]);
    expect(inspectPlacements(a.allEmployeesFlat, a.departments)[0]).toContain('多个位置');
    const results = computeMatchStates(a.allEmployeesFlat, a.departments.flatMap((d) => d.positions!), undefined, [], a.departments);
    expect(results[0]).toMatchObject({ status: 'unassigned', reason: 'unknown' });
    a.departments[1].employees = [];
    a.allEmployeesFlat = [{ ...a.allEmployeesFlat[0], positionId: 'missing' }];
    expect(inspectPlacements(a.allEmployeesFlat, a.departments)[0]).toContain('不存在');
    a.allEmployeesFlat[0].positionId = undefined;
    expect(inspectPlacements(a.allEmployeesFlat, a.departments)[0]).toContain('不一致');
  });

  it('孤立评分、冲突在任关系明确提示，冲突不算正常套岗', () => {
    const a = confirm(fixture());
    const rows = [...a.positionAssignments, { ...a.positionAssignments[0], id: 'other', positionId: 'pb' }];
    const orphan = { id: 'score', employeeId: 'missing', dimension: 'business', score: 2, scale: { min: 1, max: 5 }, requirement: 3,
      assessorRole: 'supervisor' as const, assessedAt: t0, source: 'manual' as const, createdAt: t0, updatedAt: t0 };
    const issues = inspectPlacements(a.allEmployeesFlat, a.departments, rows, [orphan]);
    expect(issues.some((i) => i.includes('多条在任主岗'))).toBe(true);
    expect(confirmedNotCompetentSet(rows, a.allEmployeesFlat).size).toBe(0);
    expect(issues.some((i) => i.includes('评分的真人对象无法核对'))).toBe(true);
    expect(computeMatchStates(a.allEmployeesFlat, a.departments.flatMap((d) => d.positions!), undefined, rows, a.departments)[0].status).toBe('unassigned');
  });

  it('显式修复跨部门失效投影时关闭旧在任记录，建立唯一新任职', () => {
    const a = confirm(fixture());
    a.departments[0].employees = [];
    a.departments[1].employees = [...a.allEmployeesFlat];
    const b = apply(a, assignPrimary(a, 'e', 'pa'));
    const active = b.positionAssignments.filter((r) => r.status === 'active');
    expect(active).toHaveLength(1);
    expect(active[0].id).not.toBe(a.positionAssignments[0].id);
    expect(confirmedNotCompetentSet(b.positionAssignments, b.allEmployeesFlat).size).toBe(0);
    expect(inspectPlacements(b.allEmployeesFlat, b.departments, b.positionAssignments)).toEqual([]);
  });

  it('撤销确认只失效该确认，任职仍在；缺关联的历史确认不能自动生效', () => {
    const a = confirm(fixture());
    const revoked = a.positionAssignments.map((r) => r.status === 'not_competent' ? { ...r, revokedAt: t1 } : r);
    expect(confirmedNotCompetentSet(revoked, a.allEmployeesFlat).size).toBe(0);
    expect(revoked[0].status).toBe('active');
    const unlinked = a.positionAssignments.map((r) => ({ ...r, relationId: undefined }));
    expect(confirmedNotCompetentSet(unlinked, a.allEmployeesFlat).size).toBe(0);
  });

  it('显式取消失效引用也结束已有关系，不在读取阶段猜测离岗', () => {
    const a = confirm(fixture());
    a.departments[0].positions = [];
    const b = apply(a, { ...a, allEmployeesFlat: [{ ...a.allEmployeesFlat[0], positionId: undefined }] });
    expect(b.positionAssignments[0]).toMatchObject({ status: 'ended', endDate: t1 });
  });
});

describe('M1 岗位内超编归因', () => {
  const emps = [emp('a', 'pa'), emp('b1', 'pb'), emp('b2', 'pb')];
  const positions = [dept('a').positions![0], dept('b').positions![0]];
  function records(equal = false): PositionAssignment[] {
    return emps.map((e, i) => ({ id: `r${e.id}`, employeeId: e.id, positionId: e.positionId!, type: 'primary', status: 'active',
      source: 'operation', startDate: equal ? t0 : [t0, t1, t2][i], createdAt: t0, updatedAt: t0 }));
  }
  it('A01 缺日期时 B 超额 1，但不指定 B1/B2，A 不受影响', () => {
    const r = computeMatchStates(emps, positions);
    expect(r[0].positionOverflow).toBeUndefined();
    expect(r.slice(1).every((m) => m.status === 'placed' && m.positionOverflow === 1 && m.overflowUnresolved)).toBe(true);
  });
  it('A02 B 岗内有可信顺序，改变数组或 A 岗人员不改变 B2 归因', () => {
    for (const employees of [emps, [...emps].reverse(), emps.slice(1)]) {
      const r = computeMatchStates(employees, positions, undefined, records());
      expect(r.find((m) => m.employeeId === 'b1')?.status).toBe('placed');
      expect(r.find((m) => m.employeeId === 'b2')?.status).toBe('overstaffed');
    }
  });
  it('A03 同时间跨编制边界不按 ID 排序定人；旧来源即使有日期也不冒充操作顺序', () => {
    for (const rows of [records(true), records().map((r) => ({ ...r, source: 'legacy' as const }))]) {
      expect(computeMatchStates(emps, positions, undefined, rows).slice(1).every((m) => m.overflowUnresolved && m.status === 'placed')).toBe(true);
    }
  });
});
