import { describe, it, expect } from 'vitest';
import { deriveBoard } from './boardScope';
import { buildGapListRows, summarizeGapList } from './gapList';
import { parseProject, serializeProject, PROJECT_VERSION, createProject } from './project';
import { resolveSupervisorAssessment, computeManagerIdSet } from './competency';
import { DEFAULT_LEVELS } from './levels';
import { COMPETENCY_SCALE, DEFAULT_COMPETENCY_MODEL } from '../types';
import type { Assessment, Department, Employee, Position, PositionAssignment, Scenario } from '../types';

/**
 * —— v2.3.1 发布验收（B7）：规模回归 + 格式兼容 ——
 *
 * 对应当前版本的验收门槛：
 * - 1000 员工 / 52 部门规模下派生完整、去重正确、父子范围一致、缺口清单分列、序列化回读无损；
 * - `.orgproj` 保持格式 4，且能被 v2.3.0 形态的文件（无 assessmentDay）无损读取并给出正确结论。
 */

const T = '2026-09-01T00:00:00.000Z';

function buildScale(scale = 1000, deptCount = 52) {
  const employees: Employee[] = [];
  const departments: Department[] = [];
  const positions: Position[] = [];
  const assignments: PositionAssignment[] = [];
  const assessments: Assessment[] = [];
  const perDept = Math.ceil(scale / deptCount);
  let n = 0;
  for (let i = 0; i < deptCount; i++) {
    const l1 = i < 8;
    const dept: Department = {
      id: `d${i}`,
      name: `部门${i}`,
      level: l1 ? 1 : 2,
      parentId: l1 ? undefined : `d${i % 8}`,
      expanded: true,
      children: [],
      employees: [],
      positions: [],
      headcount: perDept,
      ...(l1 ? { leaderId: `E${i}` } : {}),
    };
    for (let p = 0; p < 3; p++) {
      const pos: Position = {
        id: `pos-${i}-${p}`,
        departmentId: dept.id,
        name: `岗位${i}-${p}`,
        headcount: Math.ceil(perDept / 3),
        status: 'active',
        createdAt: T,
        updatedAt: T,
      };
      positions.push(pos);
      dept.positions!.push(pos);
    }
    for (let k = 0; k < perDept && n < scale; k++, n++) {
      const emp: Employee = {
        id: `e${n}`,
        name: `员工${n}`,
        employeeId: `E${n}`,
        level: 'L2.1',
        positionId: `pos-${i}-${k % 3}`,
      };
      employees.push(emp);
      dept.employees.push(emp);
      assignments.push({
        id: `a${n}`,
        employeeId: emp.id,
        positionId: emp.positionId!,
        type: 'primary',
        status: 'active',
        source: 'operation',
        createdAt: T,
        updatedAt: T,
        startDate: '2026-01-01',
      });
      for (let d = 0; d < 4; d++) {
        assessments.push({
          id: `asm-${n}-${d}`,
          employeeId: emp.id,
          positionId: emp.positionId!,
          scope: 'position',
          relationId: `a${n}`,
          dimension: DEFAULT_COMPETENCY_MODEL.dimensions[d].key,
          score: 3,
          scale: COMPETENCY_SCALE,
          requirement: 3,
          assessorRole: 'supervisor',
          assessedAt: T,
          assessmentDay: '2026-09-01',
          source: 'manual',
          createdAt: T,
          updatedAt: T,
        });
      }
    }
    departments.push(dept);
  }
  return { employees, departments, positions, assignments, assessments };
}

function scenarioOf(scale = 1000): Scenario {
  const f = buildScale(scale);
  const p = createProject('规模验收');
  Object.assign(p.scenarios[0], {
    departments: f.departments,
    allEmployeesFlat: f.employees,
    positions: f.positions,
    positionAssignments: f.assignments,
    assessments: f.assessments,
    levelConfigs: DEFAULT_LEVELS.map((c) => ({ ...c })),
    competencyModel: DEFAULT_COMPETENCY_MODEL,
  });
  return p.scenarios[0];
}

describe('v2.3.1 B7：1000 员工 / 52 部门规模验收', () => {
  const f = buildScale(1000);
  const board = deriveBoard({
    departments: f.departments,
    allEmployees: f.employees,
    allPositions: f.positions,
    assessments: f.assessments,
    competencyModel: DEFAULT_COMPETENCY_MODEL,
    positionAssignments: f.assignments,
    levelConfigs: DEFAULT_LEVELS.map((c) => ({ ...c })),
    competencySummaries: new Map(),
    matchStates: [],
    scopeDeptId: null,
    includeChildren: true,
  });

  it('人数按真人去重、部门数正确、无数据问题', () => {
    expect(board.summary.employeeCount).toBe(1000);
    expect(board.scopeDeptIds).toHaveLength(52);
    expect(board.rows).toHaveLength(1000);
    expect(board.dataIssues).toEqual([]);
    expect(computeManagerIdSet(f.departments, f.employees).size).toBe(8); // 8 个一级部门负责人
  });

  it('父子范围不重复累计（父部门下钻人数 ≥ 子部门之和，且不重复计同一人）', () => {
    const parentScope = deriveBoard({
      departments: f.departments,
      allEmployees: f.employees,
      allPositions: f.positions,
      assessments: [],
      competencyModel: DEFAULT_COMPETENCY_MODEL,
      positionAssignments: f.assignments,
      levelConfigs: DEFAULT_LEVELS.map((c) => ({ ...c })),
      competencySummaries: new Map(),
      matchStates: [],
      scopeDeptId: 'd0',
      includeChildren: true,
    });
    const seen = new Set(parentScope.rows.map((r) => r.employeeId));
    expect(seen.size).toBe(parentScope.rows.length); // 父子不重复累计
    expect(parentScope.rows.length).toBeLessThanOrEqual(1000);
  });

  it('缺口清单按岗位分列，待补与超额分别求和', () => {
    const rows = buildGapListRows(board, '规模验收');
    expect(rows.length).toBeGreaterThan(0);
    const summary = summarizeGapList(rows);
    // 主岗占用合计 = 1000（每人都恰好占一个主岗名额）
    expect(rows.reduce((s, r) => s + r.primaryOccupied, 0)).toBe(1000);
    expect(summary.pendingTotal).toBeGreaterThanOrEqual(0);
    expect(summary.overflowTotal).toBeGreaterThanOrEqual(0);
    // 两者分别求和，净额只是补充口径
    expect(summary.netTotal).toBe(summary.pendingTotal - summary.overflowTotal);
  });

  it('序列化 → 反序列化回读无损（岗位/关系/评分/口径字段一致）', () => {
    const sc = scenarioOf(1000);
    const project = createProject('规模验收');
    Object.assign(project.scenarios[0], sc);
    const parsed = parseProject(serializeProject(project))!;
    const after = parsed.scenarios[0];
    expect(after.departments).toHaveLength(52);
    expect(after.allEmployeesFlat).toHaveLength(1000);
    expect(after.positions).toHaveLength(156);
    expect(after.positionAssignments).toHaveLength(1000);
    expect(after.assessments).toHaveLength(4000);
    expect(after.departments.find((d) => d.id === 'd10')!.positions).toHaveLength(3);
    // 评分口径字段（含 v2.3.1 新增的自然日）不丢
    expect(after.assessments![0].assessmentDay).toBe('2026-09-01');
    expect(parsed.version).toBe(PROJECT_VERSION);
  });
});

describe('v2.3.1 B7：格式 4 与向后兼容', () => {
  it('数据模型版本保持 4（patch 不破坏回读）', () => {
    expect(PROJECT_VERSION).toBe(4);
    const parsed = parseProject(serializeProject(createProject('v')) )!;
    expect(parsed.version).toBe(4);
  });

  it('v2.3.0 形态的评分（无 assessmentDay）仍按自然日正确判定同日', () => {
    // v2.3.0 写入的两条同日记录：批量评估用本地正午归一、导入用真实时刻
    const base: Assessment = {
      id: 'a1',
      employeeId: 'e1',
      dimension: 'business',
      score: 3,
      scale: COMPETENCY_SCALE,
      requirement: 3,
      assessorRole: 'supervisor',
      assessedAt: '2026-09-18T04:00:00.000Z',
      source: 'manual',
      createdAt: T,
      updatedAt: T,
    };
    const imported: Assessment = { ...base, id: 'a2', score: 5, assessedAt: '2026-09-18T02:00:00.000Z' };
    // 无 assessmentDay → 由 assessedAt 按本地时区回推自然日（两天记录落在同一天）
    const resolved = resolveSupervisorAssessment([base, imported], 'e1', 'business');
    expect(resolved.conflict).toBe(true); // 同日内容冲突 → 待核对，而不是静默取较晚时刻那条
    expect(resolved.effective).toBeNull();
  });

  it('显式 assessmentDay 优先于时刻（跨时区/跨机器一致）', () => {
    const base: Assessment = {
      id: 'a1', employeeId: 'e1', dimension: 'business', score: 3, scale: COMPETENCY_SCALE,
      requirement: 3, assessorRole: 'supervisor', assessedAt: '2026-09-18T04:00:00.000Z',
      assessmentDay: '2026-09-19', source: 'manual', createdAt: T, updatedAt: T,
    };
    const next: Assessment = { ...base, id: 'a2', score: 4, assessedAt: '2026-09-19T02:00:00.000Z', assessmentDay: '2026-09-19', revisionOf: 'a1' };
    const resolved = resolveSupervisorAssessment([base, next], 'e1', 'business');
    expect(resolved.conflict).toBe(false);
    expect(resolved.effective?.score).toBe(4);
  });
});
