import { describe, it, expect } from 'vitest';
import {
  assignmentsToProjection,
  confirmedNotCompetentSet,
  projectionToAssignments,
} from './assignment';
import type { Employee, Position, PositionAssignment } from '../types';

/** —— 测试工厂 —— */

const NOW = '2026-02-01T00:00:00.000Z';

function emp(id: string, over: Partial<Employee> = {}): Employee {
  return { id, name: `员工${id}`, employeeId: `E${id}`, level: 'L1', ...over };
}

function asg(
  over: Partial<PositionAssignment> & { employeeId: string; positionId: string },
): PositionAssignment {
  return {
    id: `asg-${over.employeeId}-${over.positionId}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'primary',
    startDate: '2026-01-01',
    status: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const P1: Position = {
  id: 'p1',
  departmentId: 'd1',
  name: '岗位1',
  headcount: 1,
  status: 'active',
  createdAt: NOW,
  updatedAt: NOW,
};
const P2: Position = {
  id: 'p2',
  departmentId: 'd1',
  name: '岗位2',
  headcount: 1,
  status: 'active',
  createdAt: NOW,
  updatedAt: NOW,
};

/** —— §7.2 projectionToAssignments —— */

describe('projectionToAssignments（前向 diff/upsert）', () => {
  it('真人员工 positionId → 生成 primary active 记录，startDate = 操作当日（now）', () => {
    const employees = [emp('a', { positionId: 'p1' })];
    const out = projectionToAssignments(employees, [P1], [], NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      employeeId: 'a',
      positionId: 'p1',
      type: 'primary',
      status: 'active',
      startDate: NOW,
    });
  });

  it('虚拟副本 → secondary 记录归属真人员工（不产生独立主体）', () => {
    const employees = [
      emp('a', { positionId: 'p1' }),
      emp('v1', { isVirtual: true, primaryEmployeeId: 'a', positionId: 'p2', assignmentType: 'secondary' }),
    ];
    const out = projectionToAssignments(employees, [P1, P2], [], NOW);
    expect(out).toHaveLength(2);
    const sec = out.find((x) => x.type === 'secondary')!;
    expect(sec.employeeId).toBe('a'); // 归属真人，不是虚拟副本 id
    expect(sec.positionId).toBe('p2');
    expect(sec).toMatchObject({ type: 'secondary', status: 'active', startDate: NOW });
  });

  it('幂等：重复调用不产生重复 active 记录', () => {
    const employees = [emp('a', { positionId: 'p1' })];
    const once = projectionToAssignments(employees, [P1], [], NOW);
    const twice = projectionToAssignments(employees, [P1], once, NOW);
    const thrice = projectionToAssignments(employees, [P1], twice, NOW);
    expect(twice).toHaveLength(once.length);
    expect(thrice).toHaveLength(once.length);
    expect(thrice).toEqual(once); // 完全不变
  });

  it('保留 ended 历史与 not_competent 确认态：同 key 已有任何状态记录 → 不重复追加', () => {
    const ended = asg({ employeeId: 'a', positionId: 'p1', status: 'ended', endDate: '2026-01-31' });
    const nc = asg({
      employeeId: 'b',
      positionId: 'p1',
      type: 'primary',
      status: 'not_competent',
      confirmedBy: 'hr',
      confirmedAt: NOW,
    });
    const employees2 = [emp('a', { positionId: 'p1' }), emp('b', { positionId: 'p1' })];
    const out = projectionToAssignments(employees2, [P1], [ended, nc], NOW);
    expect(out).toHaveLength(2); // 无新增 active
    expect(out.find((x) => x.id === ended.id)).toMatchObject({ status: 'ended' });
    expect(out.find((x) => x.id === nc.id)).toMatchObject({ status: 'not_competent' });
  });

  it('未套岗 / 无法归属的虚拟副本 → 不产生记录', () => {
    const employees = [
      emp('a'), // 无 positionId
      emp('v1', { isVirtual: true, positionId: 'p2' }), // 无 primaryEmployeeId
    ];
    expect(projectionToAssignments(employees, [P1, P2], [], NOW)).toEqual([]);
  });

  it('新增记录不影响已有无关记录（追加式，不清空）', () => {
    const existing = asg({ employeeId: 'old', positionId: 'p2', status: 'active' });
    const employees = [emp('a', { positionId: 'p1' })];
    const out = projectionToAssignments(employees, [P1, P2], [existing], NOW);
    expect(out).toHaveLength(2);
    expect(out.find((x) => x.id === existing.id)).toBeDefined();
  });
});

/** —— §7.2 assignmentsToProjection —— */

describe('assignmentsToProjection（恢复路径：只重建 active 投影，有损仅应急）', () => {
  it('active primary → 覆盖 positionId；ended/not_competent 不进投影', () => {
    const employees = [emp('a'), emp('b'), emp('c')];
    const records = [
      asg({ employeeId: 'a', positionId: 'p1', status: 'active' }),
      asg({ employeeId: 'b', positionId: 'p1', status: 'ended', endDate: '2026-01-31' }),
      asg({ employeeId: 'c', positionId: 'p1', status: 'not_competent' }),
    ];
    const out = assignmentsToProjection(employees, records, NOW);
    expect(out.find((x) => x.id === 'a')?.positionId).toBe('p1');
    expect(out.find((x) => x.id === 'b')?.positionId).toBeUndefined(); // ended 不进
    expect(out.find((x) => x.id === 'c')?.positionId).toBeUndefined(); // 确认态不进
  });

  it('active secondary → 补齐虚拟副本（primaryEmployeeId + positionId）', () => {
    const employees = [emp('a', { positionId: 'p1' })];
    const records = [
      asg({ employeeId: 'a', positionId: 'p1', type: 'primary', status: 'active' }),
      asg({ employeeId: 'a', positionId: 'p2', type: 'secondary', status: 'active' }),
    ];
    const out = assignmentsToProjection(employees, records, NOW);
    const vc = out.find((x) => x.isVirtual)!;
    expect(vc).toMatchObject({
      isVirtual: true,
      primaryEmployeeId: 'a',
      positionId: 'p2',
      assignmentType: 'secondary',
    });
    expect(out.find((x) => x.id === 'a')?.positionId).toBe('p1');
  });

  it('已有虚拟副本 → 保留原样，不重复创建；无记录员工保持原样', () => {
    const employees = [
      emp('a', { positionId: 'p1' }),
      emp('v1', { isVirtual: true, primaryEmployeeId: 'a', positionId: 'p2', assignmentType: 'secondary' }),
      emp('x', { positionId: 'p9' }), // 无任何记录
    ];
    const records = [asg({ employeeId: 'a', positionId: 'p2', type: 'secondary', status: 'active' })];
    const out = assignmentsToProjection(employees, records, NOW);
    expect(out.filter((x) => x.isVirtual)).toHaveLength(1);
    expect(out.find((x) => x.id === 'v1')).toBeDefined(); // 保留原有副本
    expect(out.find((x) => x.id === 'x')?.positionId).toBe('p9'); // 无记录不动
  });
});

/** —— §7.2 confirmedNotCompetentSet —— */

describe('confirmedNotCompetentSet（已确认不胜任 employeeId 集合）', () => {
  it('只收集当前主岗任职的有效确认', () => {
    const records = [
      asg({ id: 'active-a', employeeId: 'a', positionId: 'p1', status: 'active' }),
      asg({ relationId: 'active-a', employeeId: 'a', positionId: 'p1', status: 'not_competent' }),
      asg({ employeeId: 'a', positionId: 'p2', type: 'secondary', status: 'not_competent' }),
      asg({ employeeId: 'b', positionId: 'p1', status: 'active' }),
      asg({ employeeId: 'c', positionId: 'p1', status: 'ended', endDate: '2026-01-31' }),
    ];
    const s = confirmedNotCompetentSet(records, [emp('a', { positionId: 'p1' })]);
    expect(Array.from(s).sort()).toEqual(['a']);
  });
  it('空表 → 空集合', () => {
    expect(confirmedNotCompetentSet([]).size).toBe(0);
  });
});
