import type {
  Assessment,
  CompetencyModel,
  Department,
  Employee,
  LevelConfig,
  MatchStatus,
  Position,
  PositionAssignment,
} from '../types';
import { computeHealthReport, costForLevel, employeeCost, round1, type HealthReport, type ReportTotals } from './analytics';
import {
  emptyCompetencySummary,
  expectedDimensions,
  type CompetencyCompleteness,
  type CompetencyScopeContext,
  type CompetencySummary,
} from './competency';
import { buildReviewEventIndex, listReviewEventsFromIndex, type ReviewEvent } from './assignment';
import { flattenPositions } from './positions';
import type { MatchResult } from './match';
import type { CompetencyStatus } from './statusUI';

/**
 * —— v2.3 M3：排兵布阵看板的统一范围派生（契约 §7.1）——
 *
 * 单一职责：给定「场景 + 部门范围 + 是否含下级 + 筛选」，产出一份派生结果。
 * 汇总、逐层下钻、Excel 导出都只能消费这份结果，不得各自重新遍历计数
 * （§7.1「下钻和导出使用同一个派生结果，不能分别用不同遍历逻辑重新计数」）。
 *
 * 去重口径（§2.3）：
 * - 人数按真人内部 id 去重；虚拟兼岗副本回指真人，不产生第二个人；
 * - 父级汇总遍历范围内全部部门后去重，不把子部门汇总相加；
 * - 未入架构的名册人员独立提示，不进入任何部门分母（A27）。
 *
 * 不合成「排兵布阵总分」：组织指标 / 岗位缺口 / 评价完整度 / 能力风险各有各的口径。
 */

export type BoardFilter = 'all' | 'unrated' | 'partial' | 'risk' | 'pending-review';

export const BOARD_FILTER_LABEL: Record<BoardFilter, string> = {
  all: '全部',
  unrated: '未评',
  partial: '部分已评',
  risk: '能力风险',
  'pending-review': '待复核',
};

/** 待复核原因（各自独立，不合并成结论） */
export type PendingReviewReason = 'candidate' | 'stale-basis' | 'conflict';

export const PENDING_REVIEW_LABEL: Record<PendingReviewReason, string> = {
  candidate: '红灯候选待人工确认',
  'stale-basis': '确认依据后已有新评分',
  conflict: '同一时点评分冲突待核对',
};

/** 明细行（汇总的唯一来源；导出同样消费它） */
export interface BoardRow {
  employeeId: string;
  name: string;
  employeeCode: string;
  deptId: string;
  /** 完整部门路径（从根到所属部门） */
  deptPath: string;
  positionId?: string;
  positionName?: string;
  /** 能力灯号（未评 = unrated 灰，不伪装绿/红） */
  status: CompetencyStatus;
  /** 完整度（与灯号分开表达） */
  completeness: CompetencyCompleteness;
  matchStatus: MatchStatus | 'unknown';
  overallScore: number | null;
  /** 待复核原因；null = 无需复核 */
  pendingReview: PendingReviewReason | null;
}

/** 岗位交付行（M3 看板与 M4 清单共用同一派生） */
export interface BoardPositionRow {
  positionId: string;
  name: string;
  departmentId: string;
  deptPath: string;
  levelBandMin?: string;
  levelBandMax?: string;
  status: Position['status'];
  /** 编制配置状态：configured 有效编制 / unconfigured 未配置 / frozen 冻结 */
  headcountStatus: 'configured' | 'unconfigured' | 'frozen';
  headcount: number;
  /** 主岗占用（真人去重） */
  primaryOccupied: number;
  /** 兼岗关系数（虚拟副本回指真人，不占第二个名额） */
  secondaryRelations: number;
  /** 净缺口 = 编制 − 主岗占用（仅有效编制可算） */
  netGap: number | null;
  /** 待补人数 = max(净缺口, 0) */
  pendingCount: number;
  /** 超额人数 = max(−净缺口, 0) */
  overflowCount: number;
  /** 成本估算状态：known 有依据 / unavailable 无法估算（不写成 0） */
  costStatus: 'known' | 'unavailable';
  /** 单位成本（万元/月） */
  unitCost: number | null;
  /** 缺口成本（万元/月）；无待补或缺依据 = null */
  gapCost: number | null;
  /** 估算依据说明（降级须显式说明） */
  costBasis: string;
}

export interface BoardOrganizationSummary {
  report: HealthReport;
  totals: ReportTotals;
}

export interface BoardSummary {
  /** 范围内真人去重人数 */
  employeeCount: number;
  /** 范围内部门数（按范围口径） */
  deptCount: number;
  /** 能力风险分布（互斥，来自 rows） */
  risk: { healthy: number; warn: number; danger: number; unrated: number };
  /** 评价完整度（来自 rows） */
  completeness: {
    expectedTotal: number;
    assessedTotal: number;
    modelUnconfigured: number;
    unrated: number;
    partial: number;
    complete: number;
    /** 完整已评且为绿 —— 「完整达标人数」唯一口径 */
    qualified: number;
    conflicted: number;
    historical: number;
  };
  /** 岗位缺口（待补与超额分别求和，不用净额抵消） */
  positionGap: {
    pendingTotal: number;
    overflowTotal: number;
    pendingPositions: number;
    overflowPositions: number;
    frozen: number;
    unconfigured: number;
  };
  /** 待复核项（各自独立计数，不相加当总人数） */
  pendingReview: { candidate: number; staleBasis: number; conflict: number; total: number };
}

export interface BoardUnplaced {
  count: number;
  names: string[];
}

/** 下钻卡片（当前范围的下一层部门；计数同样来自去重后的 rows，父子不重复累计） */
export interface BoardDeptCard {
  deptId: string;
  name: string;
  level: number;
  hasChildren: boolean;
  childCount: number;
  employeeCount: number;
  risk: { healthy: number; warn: number; danger: number; unrated: number };
  positionGap: { pendingTotal: number; overflowTotal: number };
}

export interface BoardDerivation {
  scopeDeptId: string | null;
  includeChildren: boolean;
  scopeLabel: string;
  /** 范围内部门 id（含自身；仅直属时只有自身） */
  scopeDeptIds: string[];
  /** 全部明细行（未筛选） */
  rows: BoardRow[];
  /** 筛选后的明细行（明细与导出统一取这里） */
  filteredRows: BoardRow[];
  filter: BoardFilter;
  /** 下一层部门卡片（逐层下钻用；计数来自同一 rows） */
  deptCards: BoardDeptCard[];
  /** 当前范围的祖先链（面包屑；不含自身） */
  breadcrumb: Array<{ id: string; name: string }>;
  summary: BoardSummary;
  organization: BoardOrganizationSummary;
  positions: BoardPositionRow[];
  /** 未入架构人员（独立提示，不进任何部门分母） */
  unplaced: BoardUnplaced;
  /** 数据问题（重复挂载、部门缺失、失效岗位等） */
  dataIssues: string[];
}

export interface BoardInput {
  departments: Department[];
  allEmployees: Employee[];
  /**
   * 可选岗位扁平表：**仅作兜底**。
   * 契约 §2.2 规定岗位以 `departments` 为结构来源，因此只要树内存在岗位就以树为准；
   * 只有树内完全没有岗位时才回退到这里（兼容仅持有扁平表的调用方）。
   * 历史遗留的 `Scenario.positions` 镜像可能为空或过期，**不能**作为唯一来源。
   */
  allPositions?: Position[];
  assessments: Assessment[];
  competencyModel: CompetencyModel;
  positionAssignments: PositionAssignment[];
  levelConfigs: LevelConfig[];
  competencySummaries: Map<string, CompetencySummary>;
  matchStates: MatchResult[];
  /** 已人工确认不胜任的员工集合 */
  confirmedNotCompetent?: ReadonlySet<string>;
  scopeDeptId: string | null;
  includeChildren: boolean;
  filter?: BoardFilter;
}

/** 收集部门自身 + 子树（includeChildren=false 时仅自身） */
export function collectScopeDepartments(depts: Department[], scopeDeptId: string | null, includeChildren: boolean): Department[] {
  if (!scopeDeptId) return depts;
  const find = (list: Department[]): Department | undefined => {
    for (const d of list) {
      if (d.id === scopeDeptId) return d;
      const child = find(d.children);
      if (child) return child;
    }
    return undefined;
  };
  const target = find(depts);
  if (!target) return [];
  return includeChildren ? [target] : [{ ...target, children: [] }];
}

/** 按 scope 展开部门列表（含子树；只保留节点自身，避免重复遍历子级） */
function flattenScope(depts: Department[]): Department[] {
  const out: Department[] = [];
  const walk = (list: Department[]) => {
    for (const d of list) {
      out.push({ ...d, children: [] });
      walk(d.children);
    }
  };
  walk(depts);
  return out;
}

function buildDeptPathIndex(depts: Department[]): Map<string, string> {
  const m = new Map<string, string>();
  const walk = (list: Department[], path: string[]) => {
    for (const d of list) {
      const next = [...path, d.name];
      m.set(d.id, next.join(' / '));
      walk(d.children, next);
    }
  };
  walk(depts, []);
  return m;
}

/**
 * 统一范围派生。所有汇总都从同一个去重后的 rows 统计，避免父子重复累计。
 */
export function deriveBoard(input: BoardInput): BoardDerivation {
  const filter: BoardFilter = input.filter ?? 'all';
  const scopeDepts = collectScopeDepartments(input.departments, input.scopeDeptId, input.includeChildren);
  const flatScope = flattenScope(scopeDepts);
  const scopeDeptIds = flatScope.map((d) => d.id);
  const scopeSet = new Set(scopeDeptIds);

  // 全公司口径的部门路径索引（导出/明细都要完整路径）
  const pathByDeptId = buildDeptPathIndex(input.departments);

  const matchById = new Map(input.matchStates.map((r) => [r.employeeId, r]));

  // —— 岗位来源：以部门树为唯一结构真值（契约 §2.2）——
  // 历史遗留的 Scenario.positions 镜像不被保存路径回写，可能长期为空；
  // 只有在树内完全没有岗位时才回退到调用方提供的扁平表。
  const treePositions = flattenPositions(input.departments);
  const suppliedPositions = input.allPositions ?? [];
  const structuralPositions = treePositions.length > 0 ? treePositions : suppliedPositions;
  const positionById = new Map(structuralPositions.map((p) => [p.id, p]));

  // 复核事件按员工分组（stale-basis 判定）。
  // v2.3.1（F-15）：改为**单次建索引**后按员工取用。旧实现对每个员工各调一次
  // `listReviewEvents`，每次都重建 activeRelations 并全表扫描 assessments → O(员工 × 关系)；
  // 实测 1000 人 / 1000 关系 / 4000 评分下占 deriveBoard 26ms 中的 21ms（82%）。
  const reviewIndex = buildReviewEventIndex(input.positionAssignments, input.assessments);
  const reviewsByEmployee = new Map<string, ReviewEvent[]>();
  for (const e of input.allEmployees) {
    if (e.isVirtual) continue;
    reviewsByEmployee.set(e.id, listReviewEventsFromIndex(reviewIndex, e.id));
  }

  const dataIssues: string[] = [];
  const seen = new Set<string>();
  const rows: BoardRow[] = [];
  const duplicated = new Set<string>();

  for (const dept of flatScope) {
    for (const emp of dept.employees) {
      if (emp.isVirtual) continue; // 兼岗副本不产生第二个人（§2.3）
      if (seen.has(emp.id)) {
        // 同一真人被重复挂载：只计一次，并作为数据问题显式提示
        if (!duplicated.has(emp.id)) {
          duplicated.add(emp.id);
          dataIssues.push(`${emp.name}：同一人员记录出现在多个位置，人数按真人去重`);
        }
        continue;
      }
      seen.add(emp.id);
      const summary = input.competencySummaries.get(emp.id);
      const completeness: CompetencyCompleteness = summary?.completeness
        ?? { status: 'unrated', expected: 0, assessed: 0, conflicted: [], historical: [], qualified: false, computable: false, dataIssue: false };
      const status: CompetencyStatus = summary?.overall ? summary.overall.status : 'unrated';
      const reviews = reviewsByEmployee.get(emp.id) ?? [];
      const activeStale = reviews.some((r) => !r.revoked && r.appliesToCurrentRelation && r.staleAfterNewAssessment);
      const pendingReview: PendingReviewReason | null = completeness.dataIssue
        ? 'conflict'
        : activeStale
          ? 'stale-basis'
          : summary?.notCompetentCandidate && !(input.confirmedNotCompetent?.has(emp.id) ?? false)
            ? 'candidate'
            : null;
      rows.push({
        employeeId: emp.id,
        name: emp.name,
        employeeCode: emp.employeeId,
        deptId: dept.id,
        deptPath: pathByDeptId.get(dept.id) ?? dept.name,
        ...(emp.positionId ? { positionId: emp.positionId } : {}),
        ...(emp.positionId ? { positionName: positionById.get(emp.positionId)?.name } : {}),
        status,
        completeness,
        matchStatus: matchById.get(emp.id)?.status ?? 'unknown',
        overallScore: summary?.overall?.score ?? null,
        pendingReview,
      });
    }
  }

  rows.sort((a, b) => (a.deptPath === b.deptPath ? a.name.localeCompare(b.name, 'zh-CN') : a.deptPath.localeCompare(b.deptPath, 'zh-CN')));

  // —— 岗位行：占用只从同一 rows 统计（口径与汇总一致） ——
  const occupiedByPosition = new Map<string, BoardRow[]>();
  for (const r of rows) {
    if (!r.positionId) continue;
    occupiedByPosition.set(r.positionId, [...(occupiedByPosition.get(r.positionId) ?? []), r]);
  }
  const secondaryCountByPosition = new Map<string, number>();
  for (const v of input.allEmployees) {
    if (!v.isVirtual || !v.positionId || !v.primaryEmployeeId) continue;
    if (!seen.has(v.primaryEmployeeId)) continue; // 只统计范围内真人的兼岗关系
    secondaryCountByPosition.set(v.positionId, (secondaryCountByPosition.get(v.positionId) ?? 0) + 1);
  }

  const positions: BoardPositionRow[] = [];
  // v2.3.1（Q-03）：员工内部 id → 员工记录，供成本估算按 id 查（不再用会抛错的非空断言）。
  const employeeById = new Map(input.allEmployees.map((e) => [e.id, e]));
  for (const pos of structuralPositions) {
    if (pos.status === 'archived') continue;
    if (!scopeSet.has(pos.departmentId)) continue;
    const occupied = occupiedByPosition.get(pos.id) ?? [];
    const primaryOccupied = occupied.length;
    const frozen = pos.status === 'frozen';
    const configured = !frozen && pos.headcount > 0;
    const netGap = configured ? pos.headcount - primaryOccupied : null;
    const pendingCount = netGap !== null && netGap > 0 ? netGap : 0;
    const overflowCount = netGap !== null && netGap < 0 ? -netGap : 0;
    // v2.3.1（Q-03）：占用记录可能指向不在 allEmployees 里的员工（数据不一致时，
    // 例如关系表引用了已从名册移除的真人）。旧实现用 `!` 断言直接取 → deriveBoard 抛 TypeError
    // 整块看板白屏。现在按 id 查、缺失即跳过（成本依据不足 → 走「无法估算」）。
    const occupiedEmployees = occupied
      .map((r) => employeeById.get(r.employeeId))
      .filter((e): e is NonNullable<typeof e> => Boolean(e));
    const unit = configured ? positionUnitCost(pos, occupiedEmployees, input.levelConfigs) : null;
    const gapCost = pendingCount > 0 && unit !== null && unit.cost > 0 ? round1(pendingCount * unit.cost) : null;
    positions.push({
      positionId: pos.id,
      name: pos.name,
      departmentId: pos.departmentId,
      deptPath: pathByDeptId.get(pos.departmentId) ?? '',
      ...(pos.levelBandMin ? { levelBandMin: pos.levelBandMin } : {}),
      ...(pos.levelBandMax ? { levelBandMax: pos.levelBandMax } : {}),
      status: pos.status,
      headcountStatus: frozen ? 'frozen' : pos.headcount > 0 ? 'configured' : 'unconfigured',
      headcount: pos.headcount,
      primaryOccupied,
      secondaryRelations: secondaryCountByPosition.get(pos.id) ?? 0,
      netGap,
      pendingCount,
      overflowCount,
      costStatus: gapCost === null ? 'unavailable' : 'known',
      unitCost: unit?.cost && unit.cost > 0 ? unit.cost : null,
      gapCost,
      costBasis: configured
        ? (unit?.basis ?? '无岗位带宽/目标职级/在岗成本依据')
        : frozen
          ? '编制已冻结，不计待补缺口'
          : '未配置编制（不视为明确零编制）',
    });
  }
  positions.sort((a, b) => (a.deptPath === b.deptPath ? (a.name ?? '').localeCompare(b.name ?? '', 'zh-CN') : a.deptPath.localeCompare(b.deptPath, 'zh-CN')));

  const filteredRows = rows.filter((r) => {
    switch (filter) {
      case 'unrated':
        return r.completeness.status === 'unrated';
      case 'partial':
        return r.completeness.status === 'partial';
      case 'risk':
        return r.status === 'danger' || r.status === 'warn';
      case 'pending-review':
        return r.pendingReview !== null;
      default:
        return true;
    }
  });

  // —— 汇总：全部由 rows / positions 统计，不另起遍历 ——
  const risk = { healthy: 0, warn: 0, danger: 0, unrated: 0 };
  const completeness = {
    expectedTotal: 0, assessedTotal: 0, modelUnconfigured: 0, unrated: 0,
    partial: 0, complete: 0, qualified: 0, conflicted: 0, historical: 0,
  };
  const pendingReview = { candidate: 0, staleBasis: 0, conflict: 0, total: 0 };
  for (const r of rows) {
    risk[r.status === 'unrated' ? 'unrated' : r.status] += 1;
    if (r.completeness.computable) {
      completeness.expectedTotal += r.completeness.expected;
      completeness.assessedTotal += r.completeness.assessed;
    }
    switch (r.completeness.status) {
      case 'model-unconfigured': completeness.modelUnconfigured += 1; break;
      case 'unrated': completeness.unrated += 1; break;
      case 'partial': completeness.partial += 1; break;
      case 'complete': completeness.complete += 1; break;
      default: break;
    }
    if (r.completeness.qualified) completeness.qualified += 1;
    if (r.completeness.dataIssue) completeness.conflicted += 1;
    if (r.completeness.historical.length > 0) completeness.historical += 1;
    if (r.pendingReview === 'candidate') pendingReview.candidate += 1;
    if (r.pendingReview === 'stale-basis') pendingReview.staleBasis += 1;
    if (r.pendingReview === 'conflict') pendingReview.conflict += 1;
    if (r.pendingReview) pendingReview.total += 1;
  }

  const positionGap = {
    pendingTotal: positions.reduce((s, p) => s + p.pendingCount, 0),
    overflowTotal: positions.reduce((s, p) => s + p.overflowCount, 0),
    pendingPositions: positions.filter((p) => p.pendingCount > 0).length,
    overflowPositions: positions.filter((p) => p.overflowCount > 0).length,
    frozen: positions.filter((p) => p.headcountStatus === 'frozen').length,
    unconfigured: positions.filter((p) => p.headcountStatus === 'unconfigured').length,
  };

  // 未入架构：名册里有、但不在任何部门的真人（独立提示，不进分母）
  const placedIds = new Set<string>();
  for (const d of flattenAll(input.departments)) for (const e of d.employees) if (!e.isVirtual) placedIds.add(e.id);
  const unplacedEmployees = input.allEmployees.filter((e) => !e.isVirtual && !placedIds.has(e.id));

  // v2.3.1（F-06）：组织指标必须与看板的「含下级 / 仅直属」同范围。
  // 旧实现只把 scopeDeptId 传下去（忽略 includeChildren），且 scope 失效时回退全公司。
  const report = computeHealthReport(input.departments, input.levelConfigs, input.scopeDeptId ?? undefined, undefined, {
    includeChildren: input.includeChildren,
  });
  const scopeLabel = input.scopeDeptId
    ? `${pathByDeptId.get(input.scopeDeptId) ?? input.scopeDeptId}${input.includeChildren ? '（含下级）' : '（仅直属）'}`
    : '全公司';

  // —— 下一层部门卡片：计数只从同一 rows / positions 过滤，父子不重复累计 ——
  const subtreeIds = (dept: Department): string[] => {
    const out: string[] = [];
    const walk = (list: Department[]) => {
      for (const d of list) { out.push(d.id); walk(d.children); }
    };
    walk([dept]);
    return out;
  };
  // v2.3.1（Q-01/Q-02）：
  // - 顶层卡片直接用「树根数组」，不再用 `d.level === 1` 判定（level 是可失真字段，
  //   analytics.ts 的 computeSpanBreakdown 已明确不信任它；level 失真会让卡片整批消失）。
  // - 「仅直属」范围内没有下级可见，因此不产出下钻卡片（旧实现会产出全部子部门卡片且人数一律 0）。
  const cardDepts: Department[] = input.scopeDeptId
    ? (() => {
        if (!input.includeChildren) return [];
        const found = findScopeDept(input.departments, input.scopeDeptId);
        return found ? found.children : [];
      })()
    : input.departments;
  const deptCards: BoardDeptCard[] = cardDepts.map((dept) => {
    const ids = new Set(subtreeIds(dept));
    const sub = rows.filter((r) => ids.has(r.deptId));
    const riskCard = { healthy: 0, warn: 0, danger: 0, unrated: 0 };
    for (const r of sub) riskCard[r.status === 'unrated' ? 'unrated' : r.status] += 1;
    const subPositions = positions.filter((p) => ids.has(p.departmentId));
    return {
      deptId: dept.id,
      name: dept.name,
      level: dept.level,
      hasChildren: dept.children.length > 0,
      childCount: dept.children.length,
      employeeCount: sub.length,
      risk: riskCard,
      positionGap: {
        pendingTotal: subPositions.reduce((s, p) => s + p.pendingCount, 0),
        overflowTotal: subPositions.reduce((s, p) => s + p.overflowCount, 0),
      },
    };
  });

  const breadcrumb: Array<{ id: string; name: string }> = [];
  if (input.scopeDeptId) {
    const walk = (list: Department[], path: Array<{ id: string; name: string }>): boolean => {
      for (const d of list) {
        const next = [...path, { id: d.id, name: d.name }];
        if (d.id === input.scopeDeptId) { breadcrumb.push(...path); return true; }
        if (walk(d.children, next)) return true;
      }
      return false;
    };
    walk(input.departments, []);
  }

  return {
    scopeDeptId: input.scopeDeptId,
    includeChildren: input.includeChildren,
    scopeLabel,
    scopeDeptIds,
    rows,
    filteredRows,
    filter,
    deptCards,
    breadcrumb,
    organization: { report, totals: report.totals },
    summary: {
      employeeCount: rows.length,
      deptCount: scopeDeptIds.length,
      risk,
      completeness,
      positionGap,
      pendingReview,
    },
    positions,
    unplaced: { count: unplacedEmployees.length, names: unplacedEmployees.map((e) => e.name) },
    dataIssues,
  };
}

/** 递归展平部门树（不改变原对象） */
function flattenAll(depts: Department[]): Department[] {
  const out: Department[] = [];
  const walk = (list: Department[]) => {
    for (const d of list) {
      out.push(d);
      walk(d.children);
    }
  };
  walk(depts);
  return out;
}

/** 按 id 查找部门（整树） */
function findScopeDept(depts: Department[], id: string): Department | undefined {
  for (const d of depts) {
    if (d.id === id) return d;
    const child = findScopeDept(d.children, id);
    if (child) return child;
  }
  return undefined;
}

/** 岗位目标职级单位成本（契约 §7.2 依据顺序：岗位带宽 → 在岗目标职级 → 在岗实际均值）。 */
export function positionUnitCost(
  pos: Position,
  assigned: Employee[],
  configs: LevelConfig[],
): { cost: number; basis: string } {
  for (const code of [pos.levelBandMin, pos.levelBandMax]) {
    if (!code) continue;
    const c = costForLevel(configs, code);
    if (c > 0) return { cost: c, basis: `岗位职级带宽 ${code} 的单位成本` };
  }
  const targetCosts = assigned
    .map((e) => (e.targetLevel ? costForLevel(configs, e.targetLevel) : 0))
    .filter((c) => c > 0);
  if (targetCosts.length > 0) {
    return {
      cost: round1(targetCosts.reduce((s, c) => s + c, 0) / targetCosts.length),
      basis: `在岗 ${targetCosts.length} 人目标职级成本均值（降级）`,
    };
  }
  const actualCosts = assigned.map((e) => employeeCost(e, configs)).filter((c) => c > 0);
  if (actualCosts.length > 0) {
    return {
      cost: round1(actualCosts.reduce((s, c) => s + c, 0) / actualCosts.length),
      basis: `在岗 ${actualCosts.length} 人实际成本均值（降级）`,
    };
  }
  return { cost: 0, basis: '无岗位带宽 / 目标职级 / 在岗成本依据' };
}

/** 便捷：从既有汇总构造单员工完整度占位（供看板在缺少 App 级派生时降级）。 */
export function fallbackCompleteness(model: CompetencyModel, group: CompetencyScopeContext['expectedGroup']): CompetencyCompleteness {
  const expected = expectedDimensions(model, group).length;
  return {
    status: expected === 0 ? 'model-unconfigured' : 'unrated',
    expected,
    assessed: 0,
    conflicted: [],
    historical: [],
    qualified: false,
    computable: expected > 0,
    dataIssue: false,
  };
}

/** 便捷：构造未评估占位汇总（看板降级路径复用同一语义）。 */
export function fallbackSummary(employeeId: string, model: CompetencyModel, group: CompetencyScopeContext['expectedGroup']): CompetencySummary {
  return emptyCompetencySummary(employeeId, group ?? null, fallbackCompleteness(model, group));
}
