import { describe, it, expect } from 'vitest';
import { collectScopeDepartments, deriveBoard } from './boardScope';
import { computeCompetencyStates } from './competency';
import { DEFAULT_COMPETENCY_MODEL } from '../types';
import type { Assessment, Department, Employee, LevelConfig, Position, PositionAssignment } from '../types';
import { DEFAULT_LEVELS } from './levels';

const LEVELS: LevelConfig[] = DEFAULT_LEVELS.map((c) => ({ ...c }));

/**
 * V2.3 M3 验收样例（docs/v230-contract.md §8：A26—A27）。
 * 关键断言：统一范围派生下，父子部门不重复累计；未入架构人员独立提示且不进分母。
 */

const T = '2026-09-01T00:00:00.000Z';

function emp(id: string, name: string, positionId?: string): Employee {
  return { id, name, employeeId: `E-${id}`, level: 'L2', ...(positionId ? { positionId } : {}) };
}

function pos(id: string, departmentId: string, headcount: number, over: Partial<Position> = {}): Position {
  return { id, departmentId, name: `岗位-${id}`, headcount, status: 'active', createdAt: T, updatedAt: T, ...over };
}

/** 树：A（研发部）→ A1（后端组）、A2（前端组）；e1 同时挂在 A 与 A1（重复挂载） */
function fixture(over: { duplicate?: boolean; unplaced?: boolean } = {}) {
  const e1 = emp('e1', '张三', 'p1');
  const e2 = emp('e2', '李四', 'p2');
  const e3 = emp('e3', '王五', 'p3');
  const e4 = emp('e4', '赵六', 'p4');
  const a1: Department = { id: 'a1', name: '后端组', level: 2, employees: [e1, e2], children: [], expanded: true, positions: [pos('p1', 'a1', 2), pos('p2', 'a1', 1)] };
  const a2: Department = { id: 'a2', name: '前端组', level: 2, employees: [e3], children: [], expanded: true, positions: [pos('p3', 'a2', 1)] };
  const a: Department = {
    id: 'a', name: '研发部', level: 1, employees: over.duplicate ? [e1] : [], children: [a1, a2], expanded: true,
    positions: [pos('p4', 'a', 3)],
  };
  const b: Department = { id: 'b', name: '市场部', level: 1, employees: [e4], children: [], expanded: true, positions: [] };
  const departments: Department[] = [a, b];
  const allEmployees: Employee[] = over.duplicate ? [e1, e2, e3, e4] : [e1, e2, e3, e4];
  if (over.unplaced) allEmployees.push(emp('e9', '未入架构者'));
  const positions: Position[] = [pos('p1', 'a1', 2), pos('p2', 'a1', 1), pos('p3', 'a2', 1), pos('p4', 'a', 3)];
  const assessments: Assessment[] = [];
  const levelConfigs: LevelConfig[] = DEFAULT_LEVELS.map((c) => ({ ...c }));
  const positionAssignments: PositionAssignment[] = [];
  return { departments, allEmployees, positions, assessments, levelConfigs, positionAssignments };
}

function board(over: Parameters<typeof fixture>[0] & {
  scopeDeptId?: string | null;
  includeChildren?: boolean;
  filter?: Parameters<typeof deriveBoard>[0]['filter'];
} = {}) {
  const f = fixture(over);
  const summaries = new Map(
    computeCompetencyStates(f.assessments, f.allEmployees, DEFAULT_COMPETENCY_MODEL).map((s) => [s.employeeId, s]),
  );
  return deriveBoard({
    departments: f.departments,
    allEmployees: f.allEmployees,
    allPositions: f.positions,
    assessments: f.assessments,
    competencyModel: DEFAULT_COMPETENCY_MODEL,
    positionAssignments: f.positionAssignments,
    levelConfigs: f.levelConfigs,
    competencySummaries: summaries,
    matchStates: [],
    scopeDeptId: over.scopeDeptId ?? null,
    includeChildren: over.includeChildren ?? true,
    ...(over.filter ? { filter: over.filter } : {}),
  });
}

describe('A26 范围与去重：父子部门不重复累计', () => {
  it('全公司范围列出全部真人（按 id 去重）', () => {
    const b = board();
    expect(b.summary.employeeCount).toBe(4);
    expect(b.scopeDeptIds.sort()).toEqual(['a', 'a1', 'a2', 'b']);
    expect(b.rows.map((r) => r.employeeId).sort()).toEqual(['e1', 'e2', 'e3', 'e4']);
  });

  it('选父部门（含下级）→ 子树范围一致，且只统计一次', () => {
    const b = board({ scopeDeptId: 'a' });
    expect(b.scopeDeptIds.sort()).toEqual(['a', 'a1', 'a2']);
    expect(b.summary.employeeCount).toBe(3); // e1/e2/e3
    expect(b.scopeDeptId).toBe('a');
    expect(b.includeChildren).toBe(true);
  });

  it('下钻子部门 → 只覆盖该子部门子树，不牵连兄弟部门', () => {
    const b = board({ scopeDeptId: 'a1' });
    expect(b.scopeDeptIds).toEqual(['a1']);
    expect(b.summary.employeeCount).toBe(2);
    expect(b.rows.every((r) => r.deptId === 'a1')).toBe(true);
  });

  it('仅直属（不含下级）→ 只统计本部门直属人员', () => {
    const b = board({ scopeDeptId: 'a', includeChildren: false });
    expect(b.scopeDeptIds).toEqual(['a']);
    expect(b.summary.employeeCount).toBe(0); // A 无直属人员
    const withDup = board({ scopeDeptId: 'a', includeChildren: false, duplicate: true });
    expect(withDup.summary.employeeCount).toBe(1); // 只统计重复挂载中的一次
  });

  it('同一真人重复挂载 → 父级去重，不计两次，并作为数据问题显式提示', () => {
    const b = board({ duplicate: true });
    expect(b.summary.employeeCount).toBe(4); // e1 只算一次
    expect(b.rows.filter((r) => r.employeeId === 'e1')).toHaveLength(1);
    expect(b.dataIssues.some((x) => x.includes('张三') && x.includes('去重'))).toBe(true);
  });

  it('部门卡片计数来自同一派生，父子不重复累计', () => {
    const b = board();
    const cardA = b.deptCards.find((c) => c.deptId === 'a')!;
    const cardB = b.deptCards.find((c) => c.deptId === 'b')!;
    expect(cardA.employeeCount).toBe(3);
    expect(cardA.hasChildren).toBe(true);
    expect(cardB.employeeCount).toBe(1);
    // 卡片人数之和 = 全公司去重人数（一级部门互不重叠）
    expect(b.deptCards.reduce((s, c) => s + c.employeeCount, 0)).toBe(b.summary.employeeCount);
  });

  it('兼岗虚拟副本不产生第二个人', () => {
    const f = fixture();
    f.allEmployees.push({ ...emp('v1', '张三兼岗', 'p3'), isVirtual: true, primaryEmployeeId: 'e1' });
    const summaries = new Map(
      computeCompetencyStates(f.assessments, f.allEmployees, DEFAULT_COMPETENCY_MODEL).map((s) => [s.employeeId, s]),
    );
    const b = deriveBoard({
      departments: f.departments, allEmployees: f.allEmployees, allPositions: f.positions,
      assessments: f.assessments, competencyModel: DEFAULT_COMPETENCY_MODEL,
      positionAssignments: f.positionAssignments, levelConfigs: f.levelConfigs,
      competencySummaries: summaries, matchStates: [], scopeDeptId: null, includeChildren: true,
    });
    expect(b.summary.employeeCount).toBe(4);
    expect(b.rows.some((r) => r.employeeId === 'v1')).toBe(false);
  });

  it('collectScopeDepartments：includeChildren=false 只返回自身且不带子树', () => {
    const f = fixture();
    const only = collectScopeDepartments(f.departments, 'a', false);
    expect(only).toHaveLength(1);
    expect(only[0].id).toBe('a');
    expect(only[0].children).toEqual([]);
  });
});

describe('T09 回归：岗位只存在于部门树、扁平镜像为空时仍能派生', () => {
  /** 真实项目形态：useOrgWorkspace 只维护 departments，不写回 Scenario.positions 镜像 */
  function treeOnly() {
    const e1 = emp('e1', '张三', 'p1');
    const departments: Department[] = [{
      id: 'd1', name: '产品部', level: 1, children: [], expanded: true, employees: [e1],
      positions: [pos('p1', 'd1', 2, { name: '体验验证岗位' })],
    }];
    return { departments, allEmployees: [e1], positions: [] as Position[] };
  }

  it('扁平镜像为空（缺省）→ deriveBoard 仍从部门树读到岗位', () => {
    const f = treeOnly();
    const b = deriveBoard({
      departments: f.departments,
      allEmployees: f.allEmployees,
      // allPositions 故意不传：模拟 Scenario.positions 缺省
      assessments: [], competencyModel: DEFAULT_COMPETENCY_MODEL, positionAssignments: [],
      levelConfigs: LEVELS, competencySummaries: new Map(), matchStates: [],
      scopeDeptId: null, includeChildren: true, filter: 'all',
    });
    expect(b.positions).toHaveLength(1);
    expect(b.positions[0].name).toBe('体验验证岗位');
    expect(b.positions[0].primaryOccupied).toBe(1);
    expect(b.positions[0].pendingCount).toBe(1); // 编制 2 − 占用 1
  });

  it('扁平镜像为空数组（显式过期）→ 仍以部门树为准，不被空镜像覆盖', () => {
    const f = treeOnly();
    const b = deriveBoard({
      departments: f.departments, allEmployees: f.allEmployees, allPositions: [],
      assessments: [], competencyModel: DEFAULT_COMPETENCY_MODEL, positionAssignments: [],
      levelConfigs: LEVELS, competencySummaries: new Map(), matchStates: [],
      scopeDeptId: null, includeChildren: true, filter: 'all',
    });
    expect(b.positions).toHaveLength(1);
    expect(b.summary.positionGap.pendingTotal).toBe(1);
  });

  it('树内无岗位时，才回退到调用方提供的扁平表', () => {
    const orphan = pos('pFlat', 'd1', 3, { name: '扁平表岗位' });
    const departments: Department[] = [{ id: 'd1', name: '产品部', level: 1, children: [], expanded: true, employees: [], positions: [] }];
    const b = deriveBoard({
      departments, allEmployees: [], allPositions: [orphan],
      assessments: [], competencyModel: DEFAULT_COMPETENCY_MODEL, positionAssignments: [],
      levelConfigs: LEVELS, competencySummaries: new Map(), matchStates: [],
      scopeDeptId: null, includeChildren: true, filter: 'all',
    });
    expect(b.positions.map((p) => p.name)).toEqual(['扁平表岗位']);
  });

  it('扁平镜像过期（含已从树中删除的岗位）不会重复或污染结果', () => {
    const f = treeOnly();
    const ghost = pos('pGhost', 'd1', 9, { name: '树中已不存在的岗位' });
    const b = deriveBoard({
      departments: f.departments, allEmployees: f.allEmployees, allPositions: [ghost],
      assessments: [], competencyModel: DEFAULT_COMPETENCY_MODEL, positionAssignments: [],
      levelConfigs: LEVELS, competencySummaries: new Map(), matchStates: [],
      scopeDeptId: null, includeChildren: true, filter: 'all',
    });
    expect(b.positions.map((p) => p.name)).toEqual(['体验验证岗位']);
  });
});

describe('A27 未入架构人员独立提示，不混入部门分母', () => {
  it('未入架构者不进 rows、不进任何部门分母，独立计数', () => {
    const b = board({ unplaced: true });
    expect(b.summary.employeeCount).toBe(4); // 未入架构者不计入
    expect(b.rows.some((r) => r.employeeId === 'e9')).toBe(false);
    expect(b.unplaced.count).toBe(1);
    expect(b.unplaced.names).toEqual(['未入架构者']);
  });

  it('选择任意部门时同样不混入', () => {
    const b = board({ unplaced: true, scopeDeptId: 'a1' });
    expect(b.summary.employeeCount).toBe(2);
    expect(b.unplaced.count).toBe(1);
  });
});

describe('M3 汇总口径：完整度 / 风险 / 待复核各自独立', () => {
  it('未评估时完整度按模型分母呈现，不伪装达标', () => {
    const b = board();
    expect(b.summary.completeness.qualified).toBe(0);
    expect(b.summary.completeness.unrated).toBe(4);
    expect(b.summary.risk.unrated).toBe(4);
    expect(b.summary.risk.danger).toBe(0);
  });

  it('待复核项按原因独立计数', () => {
    const b = board({ unplaced: true });
    const withCandidate = b.rows.length;
    expect(withCandidate).toBe(4);
    expect(b.summary.pendingReview.total).toBe(0); // 无评分时既不是候选也不冲突
  });

  it('筛选待复核时空结果也保持计数一致', () => {
    const b = board({ filter: 'pending-review' });
    expect(b.filteredRows).toHaveLength(0);
    expect(b.summary.pendingReview.total).toBe(0);
    expect(b.rows).toHaveLength(4); // 汇总口径不受筛选影响
  });
});
