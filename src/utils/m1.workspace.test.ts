// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useOrgWorkspace } from './useOrgWorkspace';
import { assignPrimary } from './placement';
import { createProject, parseProject, persistProject, loadProject, PROJECT_STORAGE_KEY, PROJECT_BACKUP_KEY } from './project';
import type { Department, Employee } from '../types';
import { resolveAssessmentEmployees } from './excel';
import { compressToUTF16 } from 'lz-string';

const storage = new Map<string, string>();
const employee: Employee = { id: 'e', name: '张一', employeeId: 'E01', level: 'L1' };
const t = '2026-09-01T00:00:00.000Z';
const departments: Department[] = ['a', 'b'].map((id) => ({ id, name: id, level: 1, employees: [], children: [], expanded: true,
  positions: [{ id: `p${id}`, departmentId: id, name: id, headcount: 1, status: 'active', createdAt: t, updatedAt: t }] }));

beforeEach(() => {
  storage.clear();
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) });
  vi.useFakeTimers();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function setup() {
  const hook = renderHook(() => useOrgWorkspace());
  act(() => { hook.result.current.importWorkspace('原场景', departments, [employee]); });
  return hook;
}

describe('M1 工作区事务与迁移保护', () => {
  it('A07/A25 一步套岗一步撤销，重做、即时导出、自动保存重开事实一致', () => {
    const { result, unmount } = setup();
    let json = '';
    act(() => { result.current.setBoth((s) => assignPrimary(s, 'e', 'pa')); json = result.current.exportProjectJson(); });
    const active = result.current.positionAssignments[0];
    expect(active).toMatchObject({ status: 'active', source: 'operation', positionId: 'pa' });
    expect(parseProject(json)!.scenarios[0].positionAssignments).toEqual([active]);
    act(() => result.current.undo());
    expect(result.current.positionAssignments).toEqual([]);
    expect(result.current.allEmployeesFlat[0].positionId).toBeUndefined();
    expect(result.current.departments[0].employees).toEqual([]);
    act(() => result.current.redo());
    expect(result.current.positionAssignments).toEqual([active]);
    expect(result.current.departments[0].employees[0].positionId).toBe('pa');
    act(() => vi.advanceTimersByTime(800));
    unmount();
    const reopened = renderHook(() => useOrgWorkspace());
    expect(reopened.result.current.positionAssignments).toEqual([active]);
    expect(reopened.result.current.allEmployeesFlat[0].positionId).toBe('pa');
  });

  it('T09 修复：保存时回写岗位扁平镜像，Scenario.positions 不再长期为空', () => {
    const { result } = setup();
    // 模拟真实项目：只有 departments[].positions，Scenario.positions 缺省/为空
    expect(result.current.project.scenarios[0].positions ?? []).toEqual([]);
    act(() => { result.current.setBoth((s) => assignPrimary(s, 'e', 'pa')); });
    act(() => vi.advanceTimersByTime(800));
    const saved = loadProject()!.scenarios[0];
    expect(saved.positions?.map((p) => p.id).sort()).toEqual(['pa', 'pb']);
    // 镜像与树保持一致（同一结构真值）
    expect(saved.positions?.every((p) => saved.departments.some((d) => (d.positions ?? []).some((x) => x.id === p.id)))).toBe(true);
  });

  it('A22 已有评分、任职、确认的场景导入后完整保留；新场景不误带关联', () => {
    const { result } = setup();
    const orig = result.current.currentScenarioId;
    act(() => {
      result.current.setBoth((s) => assignPrimary(s, 'e', 'pa'));
      result.current.setAssessments([{ id: 'score', employeeId: 'e', dimension: 'business', score: 2, scale: { min: 1, max: 5 }, requirement: 3,
        assessorRole: 'supervisor', assessedAt: t, source: 'manual', createdAt: t, updatedAt: t }]);
      result.current.setPositionAssignments((rows) => [...rows, { ...rows[0], id: 'confirm', relationId: rows[0].id, status: 'not_competent', confirmedAt: t }]);
    });
    const originalRecords = result.current.positionAssignments;
    act(() => { expect(result.current.importWorkspace('新名单', departments, [{ ...employee, id: 'new' }])).toBe(true); });
    expect(result.current.project.scenarios).toHaveLength(2);
    expect(result.current.assessments).toEqual([]);
    expect(result.current.positionAssignments).toEqual([]);
    expect(result.current.canUndo).toBe(false);
    act(() => result.current.switchScenario(orig));
    expect(result.current.assessments).toHaveLength(1);
    expect(result.current.positionAssignments).toEqual(originalRecords);
    expect(result.current.departments[0].employees[0].id).toBe('e');
  });

  it('A25 复制当前场景先读取最新事实；新场景的撤销不能穿透到原场景', () => {
    const { result } = setup();
    act(() => {
      result.current.setBoth((s) => assignPrimary(s, 'e', 'pa'));
      result.current.duplicateScenario(result.current.currentScenarioId);
    });
    expect(result.current.project.scenarios[1].positionAssignments).toEqual(result.current.positionAssignments);
    act(() => result.current.createNewScenario('分支'));
    expect(result.current.canUndo).toBe(false);
    act(() => result.current.setBoth((s) => assignPrimary(s, 'e', 'pb')));
    act(() => result.current.undo());
    expect(result.current.allEmployeesFlat[0].positionId).toBe('pa');
    expect(result.current.positionAssignments.filter((a) => a.status === 'active')).toHaveLength(1);
  });

  it('存储失败时导入不替换当前场景与实时数据', () => {
    const { result } = setup();
    const orig = result.current.currentScenarioId;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    act(() => { expect(result.current.importWorkspace('新名单', [], [{ ...employee, id: 'new' }])).toBe(false); });
    expect(result.current.currentScenarioId).toBe(orig);
    expect(result.current.allEmployeesFlat[0].id).toBe('e');
    expect(result.current.project.scenarios).toHaveLength(1);
  });

  it.each([false, true])('旧格式备份原字节（压缩=%s），失败不覆盖旧存储', (compressed) => {
    const p = createProject('旧项目'); p.version = 3; p.meta.version = 3;
    const json = JSON.stringify(p);
    const raw = compressed ? `lz16:${compressToUTF16(json)}` : json;
    storage.set(PROJECT_STORAGE_KEY, raw);
    const migrated = loadProject()!;
    expect(migrated.version).toBe(4);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const set = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(persistProject(migrated)).toBe(false);
    expect(storage.get(PROJECT_STORAGE_KEY)).toBe(raw);
    set.mockRestore();
    expect(persistProject(migrated)).toBe(true);
    expect(storage.get(PROJECT_BACKUP_KEY)).toBe(raw);
    expect(loadProject()!.version).toBe(4);
  });

  it('A32 更高版本拒绝解析、导入与自动覆盖，原字节保留', () => {
    const p = createProject('未来项目'); p.version = 99;
    const raw = JSON.stringify(p); storage.set(PROJECT_STORAGE_KEY, raw);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => parseProject(raw)).toThrow('99');
    expect(persistProject(createProject('空白'))).toBe(false);
    const { result } = renderHook(() => useOrgWorkspace());
    expect(result.current.loadIssue).toContain('99');
    act(() => vi.advanceTimersByTime(2000));
    expect(storage.get(PROJECT_STORAGE_KEY)).toBe(raw);
  });
});

describe('A23 评分身份解析', () => {
  const roster = [employee, { ...employee, id: 'e2', name: 'E01', employeeId: 'E02' }];
  it('工号与姓名是独立索引；跨索引相同值不会错配', () => {
    expect(resolveAssessmentEmployees([{ employeeKey: 'E01', employeeKeyType: 'employeeId', scores: { business: 3 } }], roster)[0].id).toBe('e');
    expect(resolveAssessmentEmployees([{ employeeKey: 'E01', employeeKeyType: 'name', scores: { business: 3 } }], roster)[0].id).toBe('e2');
  });
  it.each(['name', 'employeeId'] as const)('重复 %s 不取第一人，且后行失败整批不返回', (field) => {
    const roster = [employee, { ...employee, id: 'e2' }, { ...employee, id: 'unique', name: '唯一', employeeId: 'U01' }];
    const rows = [{ employeeKey: 'U01', employeeKeyType: 'employeeId' as const, scores: { business: 2 } },
      { employeeKey: employee[field], employeeKeyType: field, scores: { business: 3 } }];
    expect(() => resolveAssessmentEmployees(rows, roster)).toThrow('本批未写入');
  });
  it('明确工号不存在时不能退回同名；批内同人同维同日期重复不写入', () => {
    expect(() => resolveAssessmentEmployees([{ employeeKey: '张一', employeeKeyType: 'employeeId', scores: { business: 3 } }], roster)).toThrow();
    const row = { employeeKey: 'E01', employeeKeyType: 'employeeId' as const, assessedAt: '2026-09-01', scores: { business: 3 } };
    expect(() => resolveAssessmentEmployees([row, row], roster)).toThrow();
  });
});
