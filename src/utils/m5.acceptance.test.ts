import { describe, it, expect } from 'vitest';
import { computeCompetencyStates } from './competency';
import { deriveBoard } from './boardScope';
import { buildGapListRows, summarizeGapList } from './gapList';
import { createProject, parseProject, serializeProject } from './project';
import { DEFAULT_COMPETENCY_MODEL, COMPETENCY_SCALE } from '../types';
import { DEFAULT_LEVELS } from './levels';
import type { Assessment, Department, Employee, Position, PositionAssignment } from '../types';

/**
 * V2.3 M5 综合验收（路线图 §9.2—9.3）。
 *
 * 覆盖：historic 规模复测（1000 名员工 / 52 个部门 / 6000 条评分）下的
 * 派生正确性、去重口径、看板下钻一致性与序列化完整性。
 * A32（更高文件格式拒绝）已在 m1.workspace.test.ts 覆盖，此处不重复。
 *
 * 说明：本文件不做桌面安装包 / 双平台 / 真实浏览器视觉验收 —— 那些仍需人工执行，
 * 结论记录在 docs/v230-m2-m5-delivery.md 的验收边界一节。
 */

const T = '2026-09-01T00:00:00.000Z';
const n = (i: number) => `id-${i}`;

interface ScaleFixture {
  departments: Department[];
  allEmployees: Employee[];
  positions: Position[];
  assessments: Assessment[];
  parentDeptId: string;
  employeeCount: number;
  deptCount: number;
  assessmentCount: number;
}

/** 1000 名员工 / 52 个部门 / 6000 条评分（每维 1 条 supervisor 原始分） */
function buildScaleFixture(): ScaleFixture {
  const ROOTS = 4;
  const CHILDREN_PER_ROOT = 12; // 4 + 48 = 52
  const EMPLOYEES = 1000;
  const positions: Position[] = [];
  const departments: Department[] = [];
  const allEmployees: Employee[] = [];

  let empSeq = 0;
  let posSeq = 0;
  for (let r = 0; r < ROOTS; r += 1) {
    const children: Department[] = [];
    for (let c = 0; c < CHILDREN_PER_ROOT; c += 1) {
      const deptId = `d-${r}-${c}`;
      const deptEmployees: Employee[] = [];
      const deptPositions: Position[] = [];
      // 每子部门 3 个岗位：前 2 个有在岗（人员均分），第 3 个无人且无成本依据
      for (let p = 0; p < 3; p += 1) {
        posSeq += 1;
        const position: Position = {
          id: `p-${posSeq}`, departmentId: deptId, name: `岗位${posSeq}`,
          headcount: p === 2 ? 5 : 12, status: 'active', createdAt: T, updatedAt: T,
          ...(p === 0 ? { levelBandMin: 'L3.1' } : {}),
        };
        positions.push(position);
        deptPositions.push(position);
      }
      const perDept = Math.floor(EMPLOYEES / (ROOTS * CHILDREN_PER_ROOT));
      for (let k = 0; k < perDept; k += 1) {
        empSeq += 1;
        const target = deptPositions[k % 2];
        const employee: Employee = {
          id: n(empSeq), name: `员工${empSeq}`, employeeId: `E${String(empSeq).padStart(4, '0')}`,
          level: k % 3 === 0 ? 'L3.1' : 'L2.1', positionId: target.id,
        };
        allEmployees.push(employee);
        deptEmployees.push(employee);
      }
      children.push({
        id: deptId, name: `子部门${r}-${c}`, level: 2, employees: deptEmployees, children: [],
        expanded: true, positions: deptPositions, parentId: `d-${r}`,
      });
    }
    departments.push({
      id: `d-${r}`, name: `一级部门${r}`, level: 1, employees: [], children, expanded: true, positions: [],
    });
  }

  // 补足到 1000 人（整除余数放进第一个子部门）
  const remainder = EMPLOYEES - allEmployees.length;
  if (remainder > 0) {
    const first = departments[0].children[0];
    for (let k = 0; k < remainder; k += 1) {
      empSeq += 1;
      const employee: Employee = {
        id: n(empSeq), name: `员工${empSeq}`, employeeId: `E${String(empSeq).padStart(4, '0')}`,
        level: 'L2.1', positionId: first.positions![k % 2].id,
      };
      allEmployees.push(employee);
      first.employees.push(employee);
    }
  }

  // 6000 条评分 = 1000 人 × 6 维（默认模型 6 维）
  const assessments: Assessment[] = [];
  const dims = DEFAULT_COMPETENCY_MODEL.dimensions.map((d) => d.key);
  let asmSeq = 0;
  for (const [empIndex, e] of allEmployees.entries()) {
    for (const dim of dims) {
      asmSeq += 1;
      assessments.push({
        id: `asm-${asmSeq}`, employeeId: e.id, positionId: e.positionId, scope: 'position',
        relationId: `asg-${empIndex}`,
        dimension: dim, score: (asmSeq % 5) + 1, scale: COMPETENCY_SCALE, requirement: 3,
        assessorRole: 'supervisor', assessorId: 'mgr', assessedAt: T, source: 'manual',
        createdAt: T, updatedAt: T,
      });
    }
  }

  return {
    departments, allEmployees, positions, assessments,
    parentDeptId: 'd-0',
    employeeCount: allEmployees.length,
    deptCount: departments.length + departments.reduce((s, d) => s + d.children.length, 0),
    assessmentCount: assessments.length,
  };
}

/** 规模场景的当前任职关系（每人一条主岗） */
function scaleAssignments(f: ScaleFixture): PositionAssignment[] {
  return f.allEmployees.map((e, i) => ({
    id: `asg-${i}`, employeeId: e.id, positionId: e.positionId!, type: 'primary' as const,
    status: 'active' as const, source: 'operation' as const, startDate: T, createdAt: T, updatedAt: T,
  }));
}

/** 走真实 M2 适用范围路径的派生（岗位评价绑定当前任职；员工模型 2 维应评） */
function scaleStates(f: ScaleFixture, assignments: PositionAssignment[]) {
  const byEmployee = new Map(assignments.map((a) => [a.employeeId, a]));
  return computeCompetencyStates(f.assessments, f.allEmployees, DEFAULT_COMPETENCY_MODEL, (e) => ({
    expectedGroup: 'staff',
    currentPositionId: e.positionId,
    currentRelationId: byEmployee.get(e.id)?.id,
    assignments,
  }));
}

describe('M5 规模验收：1000 人 / 52 部门 / 6000 条评分', () => {
  const f = buildScaleFixture();

  it('规模构造符合路线图口径', () => {
    expect(f.employeeCount).toBe(1000);
    expect(f.deptCount).toBe(52);
    expect(f.assessmentCount).toBe(6000);
  });

  it('胜任度派生完整：每员工一条，岗位评价按当前任职适用，完整度按员工模型 2 维', () => {
    const states = scaleStates(f, scaleAssignments(f));
    expect(states).toHaveLength(1000);
    expect(states.every((s) => s.completeness.expected === 2)).toBe(true);
    expect(states.every((s) => s.completeness.assessed === 2)).toBe(true);
    expect(states.every((s) => s.completeness.status === 'complete')).toBe(true);
    expect(states.every((s) => s.completeness.historical.length === 0)).toBe(true); // 当前任职适用，无历史遗留
    expect(states.some((s) => s.overall?.status === 'danger')).toBe(true);
  });

  it('看板派生：全公司人数去重、部门数与岗位数一致，且能按时完成', () => {
    const started = Date.now();
    const board = deriveBoard({
      departments: f.departments,
      allEmployees: f.allEmployees,
      allPositions: f.positions,
      assessments: f.assessments,
      competencyModel: DEFAULT_COMPETENCY_MODEL,
      positionAssignments: [],
      levelConfigs: DEFAULT_LEVELS,
      competencySummaries: new Map(scaleStates(f, scaleAssignments(f)).map((s) => [s.employeeId, s])),
      matchStates: [],
      scopeDeptId: null,
      includeChildren: true,
      filter: 'all',
    });
    const elapsed = Date.now() - started;
    expect(board.summary.employeeCount).toBe(1000);
    // v2.3.1（T-09）：原护栏写的是 `elapsed < 15000`，而 vitest 默认 testTimeout = 5000 ——
    // 一旦真的超过 5s，测试会先以超时失败，这条断言**永远不可达**（形同虚设）。
    // 改为在超时预算内、且对性能回流真正敏感的阈值（旧实现 1000 人约 26ms，留足 CI 余量）。
    expect(elapsed).toBeLessThan(3000);
    expect(board.scopeDeptIds).toHaveLength(52);
    expect(board.positions).toHaveLength(f.positions.length);
    expect(board.dataIssues).toEqual([]);
    // 汇总与明细同源
    expect(board.rows).toHaveLength(board.summary.employeeCount);
    expect(board.summary.risk.healthy + board.summary.risk.warn + board.summary.risk.danger + board.summary.risk.unrated)
      .toBe(board.summary.employeeCount);
  });

  it('父部门下钻与子部门范围一致，不重复累计', () => {
    const summaries = new Map(scaleStates(f, scaleAssignments(f)).map((s) => [s.employeeId, s]));
    const base = {
      departments: f.departments, allEmployees: f.allEmployees, allPositions: f.positions,
      assessments: f.assessments, competencyModel: DEFAULT_COMPETENCY_MODEL,
      positionAssignments: [], levelConfigs: DEFAULT_LEVELS, competencySummaries: summaries,
      matchStates: [], includeChildren: true, filter: 'all' as const,
    };
    const parent = deriveBoard({ ...base, scopeDeptId: f.parentDeptId });
    const childTotals = f.departments[0].children.reduce(
      (sum, child) => sum + deriveBoard({ ...base, scopeDeptId: child.id }).summary.employeeCount,
      0,
    );
    expect(parent.summary.employeeCount).toBe(childTotals); // 无重复挂载时二者相等
    expect(parent.scopeDeptIds).toHaveLength(13); // 1 + 12
    expect(parent.deptCards).toHaveLength(12);
  });

  it('岗位缺口清单在规模下完整且待补/超额分列', () => {
    const board = deriveBoard({
      departments: f.departments, allEmployees: f.allEmployees, allPositions: f.positions,
      assessments: f.assessments, competencyModel: DEFAULT_COMPETENCY_MODEL,
      positionAssignments: [], levelConfigs: DEFAULT_LEVELS, competencySummaries: new Map(),
      matchStates: [], scopeDeptId: null, includeChildren: true, filter: 'all',
    });
    const rows = buildGapListRows(board, '规模场景');
    expect(rows).toHaveLength(f.positions.length);
    const s = summarizeGapList(rows);
    expect(s.pendingTotal).toBe(rows.reduce((x, r) => x + r.pendingCount, 0));
    expect(s.overflowTotal).toBe(rows.reduce((x, r) => x + r.overflowCount, 0));
    // 缺成本不写成 0：无带宽依据的岗位成本为 null，并计入缺失数
    expect(rows.some((r) => r.gapCost === null)).toBe(true);
    expect(s.costMissingPositions).toBeGreaterThan(0);
    expect(s.costPartial).toBe(true);
  });

  it('大规模自动保存与重启恢复：序列化回读后关系/评分/模型完整', () => {
    const project = createProject('规模项目');
    const sc = project.scenarios[0];
    sc.departments = f.departments;
    sc.allEmployeesFlat = f.allEmployees;
    sc.positions = f.positions;
    sc.assessments = f.assessments;
    const assignments = scaleAssignments(f);
    sc.positionAssignments = assignments;

    const json = serializeProject(project);
    const again = parseProject(json)!;
    const sc2 = again.scenarios[0];
    expect(sc2.allEmployeesFlat).toHaveLength(1000);
    expect(sc2.assessments).toHaveLength(6000);
    expect(sc2.positionAssignments).toHaveLength(1000);
    expect(sc2.positions).toHaveLength(f.positions.length);
    expect(sc2.competencyModel?.dimensions).toHaveLength(6);
    // 回读后派生口径不变（同一套适用范围规则仍解析到当前任职）
    const byEmployee = new Map(sc2.positionAssignments!.map((a) => [a.employeeId, a]));
    const states = computeCompetencyStates(sc2.assessments!, sc2.allEmployeesFlat, sc2.competencyModel!, (e) => ({
      expectedGroup: 'staff',
      currentPositionId: e.positionId,
      currentRelationId: byEmployee.get(e.id)?.id,
      assignments: sc2.positionAssignments!,
    }));
    expect(states.every((s) => s.completeness.status === 'complete')).toBe(true);
    expect(states.every((s) => s.dimensions.every((d) => d.applicability === 'current'))).toBe(true);
  });
});
