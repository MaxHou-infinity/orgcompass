// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { useRef } from 'react';
import type { Department, Employee, PositionAssignment } from '../types';

/**
 * —— v2.3.1 性能与身份稳定性回归（审计报告 F-15 / Q-23 / Q-24 / Q-25 / Q-33）——
 *
 * 这些优化如果被回退，功能测试不会变红（结果依然正确，只是白烧 CPU / 反复重绑监听）。
 * 因此这里断言的是**结构事实**（调用次数、参数、引用身份），它们在回退时必然失败。
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetModules();
});

// ───────────────────── F-15：复核事件索引只建一次 ─────────────────────

describe('v2.3.1 F-15：deriveBoard 不得逐员工重建复核索引', () => {
  it('无论多少员工，buildReviewEventIndex 只调用一次（旧实现是 O(员工×关系)）', async () => {
    const counters = { indexBuilds: 0, perEmployeeCalls: 0 };
    vi.doMock('./assignment', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./assignment')>();
      return {
        ...actual,
        buildReviewEventIndex: (...args: Parameters<typeof actual.buildReviewEventIndex>) => {
          counters.indexBuilds += 1;
          return actual.buildReviewEventIndex(...args);
        },
        listReviewEvents: (...args: Parameters<typeof actual.listReviewEvents>) => {
          counters.perEmployeeCalls += 1;
          return actual.listReviewEvents(...args);
        },
      };
    });
    const { deriveBoard } = await import('./boardScope');
    const { DEFAULT_COMPETENCY_MODEL } = await import('../types');
    
    const employees: Employee[] = [];
    const departments: Department[] = [];
    for (let i = 0; i < 200; i++) {
      const dept: Department = {
        id: `d${i}`,
        name: `部门${i}`,
        level: 1,
        expanded: true,
        children: [],
        employees: [],
        positions: [
          { id: `p${i}`, departmentId: `d${i}`, name: `岗位${i}`, headcount: 5, status: 'active', createdAt: 't', updatedAt: 't' },
        ],
      };
      for (let k = 0; k < 5; k++) {
        const e: Employee = {
          id: `e${i}-${k}`,
          name: `员工${i}-${k}`,
          employeeId: `E${i}-${k}`,
          level: 'L1',
          positionId: `p${i}`,
        };
        employees.push(e);
        dept.employees.push(e);
      }
      departments.push(dept);
    }
    const assignments: PositionAssignment[] = employees.map((e, i) => ({
      id: `a${i}`,
      employeeId: e.id,
      positionId: e.positionId!,
      type: 'primary',
      status: 'active',
      createdAt: 't',
      updatedAt: 't',
    }));

    deriveBoard({
      departments,
      allEmployees: employees,
      assessments: [],
      competencyModel: DEFAULT_COMPETENCY_MODEL,
      positionAssignments: assignments,
      levelConfigs: [],
      competencySummaries: new Map(),
      matchStates: [],
      scopeDeptId: null,
      includeChildren: true,
    });

    expect(counters.indexBuilds).toBe(1); // ← v2.3.0 这里是 1000（每员工一次）
    expect(counters.perEmployeeCalls).toBe(0); // 不再走「逐员工调 listReviewEvents」这条慢路径
  });
});

// ───────────────────── Q-24 / Q-33：干部判定单一实现 ─────────────────────

describe('v2.3.1 Q-24/Q-33：computeManagerIdSet 与 isManager 语义一致', () => {
  it('批量集合等于逐人调用 isManager 的结果（避免双实现漂移）', async () => {
    const { computeManagerIdSet, isManager } = await import('./competency');
        const leader: Employee = { id: 'e1', name: '林涛', employeeId: 'E001', level: 'L5' };
    const sub: Employee = {
      id: 'e2',
      name: '陈晨',
      employeeId: 'E002',
      level: 'L3',
      reportsToEmployeeId: 'E001',
    };
    const ic: Employee = { id: 'e3', name: '王雨', employeeId: 'E003', level: 'L2' };
    const child: Department = {
      id: 'd2',
      name: '研发部',
      level: 2,
      expanded: true,
      children: [],
      employees: [sub, ic],
      leaderId: 'E002',
    };
    const root: Department = {
      id: 'd1',
      name: '技术中心',
      level: 1,
      expanded: true,
      children: [child],
      employees: [leader],
      leaderId: 'E001',
    };
    const departments = [root];
    const all = [leader, sub, ic];

    const set = computeManagerIdSet(departments, all);
    expect(set).toEqual(new Set(['e1', 'e2']));
    for (const e of all) {
      expect(set.has(e.id)).toBe(isManager(e.id, departments, all));
    }
    expect(isManager('e3', departments, all)).toBe(false);
  });

  it('自己汇报给自己不算干部', async () => {
    const { computeManagerIdSet } = await import('./competency');
        const weird: Employee = {
      id: 'x',
      name: 'X',
      employeeId: 'X1',
      level: 'L1',
      reportsToEmployeeId: 'X1',
    };
    expect(computeManagerIdSet([], [weird]).size).toBe(0);
  });
});

// ───────────────────── Q-23：关闭态的常驻抽屉不得空跑派生 ─────────────────────

describe('v2.3.1 Q-23：抽屉关闭时按空输入派生（不白烧 CPU）', () => {
  it('CompetencyPage 关闭态传给 deriveBoard 的是空输入', async () => {
    const seen: Array<{ departments: unknown[]; allEmployees: unknown[] }> = [];
    vi.doMock('./boardScope', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./boardScope')>();
      return {
        ...actual,
        deriveBoard: (input: Parameters<typeof actual.deriveBoard>[0]) => {
          seen.push({ departments: input.departments, allEmployees: input.allEmployees });
          return actual.deriveBoard(input);
        },
      };
    });
    const { CompetencyPage } = await import('../components/CompetencyDrawer');
        const emp: Employee = { id: 'e1', name: 'A', employeeId: 'E1', level: 'L1' };
    const dept: Department = {
      id: 'd1',
      name: '研发部',
      level: 1,
      expanded: true,
      children: [],
      employees: [emp],
    };
    render(
      <CompetencyPage
        open={false}
        onClose={() => {}}
        competencySummaries={new Map()}
        matchStates={[]}
        departments={[dept]}
        allEmployees={[emp]}
        allPositions={[]}
        onFocusDept={() => {}}
        onOpenDetail={() => {}}
        onStartBatch={() => {}}
        onOpenModelConfig={() => {}}
      />,
    );
    expect(seen.length).toBeGreaterThan(0);
    // ← v2.3.0 关闭态仍会把真实 departments/allEmployees 传进 deriveBoard
    expect(seen.every((s) => s.departments.length === 0 && s.allEmployees.length === 0)).toBe(true);
  });
});

// ───────────────────── Q-24：批量评估不得逐人调用 isManager ─────────────────────

describe('v2.3.1 Q-24：批量评估范围筛选不得逐人调用 isManager', () => {
  it('50 人的范围筛选里 isManager 调用次数为 0（旧实现每人 2 次）', async () => {
    const calls = { isManager: 0 };
    vi.doMock('./competency', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./competency')>();
      return {
        ...actual,
        isManager: (...args: Parameters<typeof actual.isManager>) => {
          calls.isManager += 1;
          return actual.isManager(...args);
        },
      };
    });
    const { BatchAssessmentModal } = await import('../components/BatchAssessmentModal');
    const { DEFAULT_COMPETENCY_MODEL } = await import('../types');
        const employees: Employee[] = [];
    const dept: Department = {
      id: 'd1',
      name: '研发部',
      level: 1,
      expanded: true,
      children: [],
      employees: [],
      leaderId: 'E0',
    };
    employees.push({ id: 'e0', name: '负责人', employeeId: 'E0', level: 'L4' });
    for (let i = 1; i < 50; i++) {
      employees.push({
        id: `e${i}`,
        name: `员工${i}`,
        employeeId: `E${i}`,
        level: 'L2',
        reportsToEmployeeId: 'E0',
      });
    }
    dept.employees = employees;

    render(
      <BatchAssessmentModal
        open
        onClose={() => {}}
        departments={[dept]}
        allEmployees={employees}
        allPositions={[]}
        competencyModel={DEFAULT_COMPETENCY_MODEL}
        assessments={[]}
        onSave={() => {}}
        onImportExcel={() => {}}
      />,
    );
    // ← v2.3.0：isManager 被调用 2 × 50 = 100 次（三元两个分支各一次，且每次都递归整树 + 全表扫描）
    expect(calls.isManager).toBe(0);
  });
});

// ───────────────────── Q-25：undo/redo 引用身份稳定 ─────────────────────

describe('v2.3.1 Q-25：useHistoryState 的 setter 引用必须稳定', () => {
  it('无关重渲染不会产生新的 undo/redo 引用（否则全局 keydown 反复重绑）', async () => {
    const { useHistoryState } = await import('./history');
    const { renderHook } = await import('@testing-library/react');
    const initial = { departments: [], allEmployeesFlat: [], assessments: [], competencyModel: { dimensions: [] }, positionAssignments: [] };
    const { result, rerender } = renderHook(() => {
      // 用 ref 记录首次引用，模拟「无关 state 变化导致的重渲染」
      const hook = useHistoryState(initial, 5);
      const first = useRef(hook);
      return { hook, first: first.current };
    });
    const before = result.current.hook;
    rerender();
    rerender();
    const after = result.current.hook;
    expect(after.undo).toBe(before.undo);
    expect(after.redo).toBe(before.redo);
    expect(after.set).toBe(before.set);
    expect(after.replace).toBe(before.replace);
  });
});
