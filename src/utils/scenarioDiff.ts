import { Department, Employee, LevelConfig, Scenario } from '../types';
import {
  computeL1,
  headcountCoverage,
  computeL2,
  computeL3,
  flattenDepartments,
  HealthStatus,
  HealthThresholds,
  L2Metric,
  L3DeptRow,
} from './analytics';
import { fullCode } from './level';

/**
 * 场景差异计算（纯函数，可单测）—— v2.0.9 唯一新特性的计算层。
 *
 * 把「基线场景 → 目标场景」的差异显式算出来，供「场景差异比较视图」与「管理层报告」消费：
 * - L1 四项指标 Δ：复用 analytics.computeL2 的 v2.0.9 口径值
 *   （span=中位数、depth=P90、managerRatio=内部负责人÷含管理者全员），**不重复实现计算逻辑**。
 * - L2 部门差异：增/删/移/改父级/改负责人/编制成本 Δ（L3 口径：子树编制/实际/缺口/缺口成本）。
 * - L3 人员调动清单：换部门 / 换汇报线 / 新增 / 移除（含兼岗 isVirtual 与未入架构员工）。
 * - 缺口与成本汇总：总编制 / 总月成本 / 总缺口 / 总缺口成本 Δ。
 *
 * 红线约定（docs/v209-roadmap.md §3、v209-product-scope.md §1.5）：
 * - 差异 = 「目标 − 基线」；任一方不可算 → delta = null 且 comparable = false（**不把缺失当 0**）。
 * - 只陈述事实、不评判优劣；不含任何黑盒评分 / 推荐逻辑。
 * - 纯函数、无副作用、不 import 组件；差异为运行时派生，不新增任何持久化字段。
 */

/** L2 指标 key（固定顺序，与 computeL2 返回一致） */
const METRIC_KEYS = ['span', 'depth', 'managerRatio', 'vacancy'] as const;

/** —— —— 契约接口（Captain 定稿，frontend-eng 按此消费） —— —— */

/** L1 指标差异（四项指标并排对比的原子数据） */
export interface MetricDiff {
  key: L2Metric['key'];
  label: string;
  unit: string;
  /** 基线值；不可算为 null */
  baseline: number | null;
  /** 目标值；不可算为 null */
  target: number | null;
  /** 目标 − 基线；任一方不可算 → null */
  delta: number | null;
  /** 基线健康灯号；不可算 → null（不做「0 值也是健康」的误判） */
  baselineStatus: HealthStatus | null;
  targetStatus: HealthStatus | null;
  /** 双方都可算才 true（「无数据/不可比」由 UI 依据此标志呈现） */
  comparable: boolean;
}

/** 部门差异行的单侧快照（抓取 L3 口径的子树值） */
export interface DeptDiffSnapshot {
  level: number;
  leaderName?: string;
  headcount: number | null;
  actual: number;
  gap: number | null;
  gapCost: number | null;
}

/** L2 部门差异行 */
export interface DeptDiff {
  deptId: string;
  name: string;
  /**
   * 变化类型（单标签，取最重要者）：
   * - added / removed：仅一侧存在；
   * - reparented：父级变化（汇报线变化，最重的结构信号）；
   * - moved：父级不变但层级（level）变化；
   * - leader-changed：负责人变化；
   * - config-changed：编制/实际/缺口/缺口成本变化；
   * - unchanged：完全一致。
   */
  changeType: 'added' | 'removed' | 'moved' | 'reparented' | 'leader-changed' | 'config-changed' | 'unchanged';
  /** 基线条目（仅 removed 时也有；added 时缺失） */
  baseline?: DeptDiffSnapshot;
  /** 目标条目（仅 added 时也有；removed 时缺失） */
  target?: DeptDiffSnapshot;
  /**
   * 数值 Δ：四字段恒存在（契约定稿，无 `?`）——双侧可比 = 目标 − 基线；
   * added = 目标值；removed = 基线值取负；单侧值缺失（如编制未配置）→ 该字段为 null（不把缺失当 0）。
   */
  delta: {
    headcount: number | null;
    actual: number | null;
    gap: number | null;
    gapCost: number | null;
  };
}

/** L3 人员调动清单条目 */
export interface PersonnelChange {
  employeeId: string;
  name: string;
  /** moved-dept：换了部门；moved-reporting：部门不变但汇报线（部门负责人）变化 */
  type: 'moved-dept' | 'moved-reporting' | 'added' | 'removed';
  fromDeptName?: string;
  toDeptName?: string;
  fromLeaderName?: string;
  toLeaderName?: string;
  /** 兼岗虚拟员工标记（只读透传，不做判定依据） */
  isVirtual?: boolean;
}

/** 单场景总量（供缺口/成本汇总与 Δ 计算；归并树内员工，避免父/子子树重复累计） */
export interface ScenarioTotals {
  /** 编制合计（只统计配置了编制的 L1 子树；完全未配置 → null） */
  totalHeadcount: number | null;
  /** 实际人数（树内非虚拟员工，按 id 去重） */
  totalEmployees: number;
  /** 总缺口 = 编制合计 − 实际人数；完全未配置 → null */
  totalGap: number | null;
  /** 总月成本（树内非虚拟员工成本合计，按 id 去重） */
  totalCost: number;
  /** 总缺口成本（仅 L1 层汇总，避免嵌套部门重复累计；完全未配置 → 0） */
  totalGapCost: number;
}

/** 缺口与成本汇总 Δ */
export interface ScenarioDiffTotals {
  headcountDelta: number | null;
  costDelta: number | null;
  gapDelta: number | null;
  gapCostDelta: number | null;
}

/** 场景差异完整结果 */
export interface ScenarioDiffResult {
  baselineScenarioId: string;
  targetScenarioId: string;
  metrics: MetricDiff[];
  departmentDiffs: DeptDiff[];
  personnelChanges: PersonnelChange[];
  totals: ScenarioDiffTotals;
  /** 整体健康度（取四项指标最差灯号；全部不可算 → null） */
  overall: {
    baseline: HealthStatus | null;
    target: HealthStatus | null;
    comparable: boolean;
  };
}

/** —— —— 内部辅助 —— —— */

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 员工身份 key：优先工号（跨导入稳定），缺失时退回记录 id。 */
function empKey(e: Employee): string {
  return e.employeeId ? `eid:${e.employeeId}` : `rid:${e.id}`;
}

/** 部门负责人身份 key（用于「是否换负责人」比较）。 */
function deptLeaderKey(d: Department): string {
  return `${d.leaderId ?? ''}||${d.leaderName ?? ''}`;
}

function placementLeaderKey(p: { leaderId?: string; leaderName?: string } | undefined): string {
  return p && (p.leaderId || p.leaderName) ? `${p.leaderId ?? ''}||${p.leaderName ?? ''}` : '';
}

/** 数值 Δ：任一方 null → null（不可比），不把缺失当 0。 */
function numDelta(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return round1(b - a);
}

/** 取负（removed 方向用；归一化 -0 → 0，避免 UI 显示「-0」）。 */
function neg(n: number): number {
  return n === 0 ? 0 : -n;
}

/** 员工月成本：优先个人 cost，缺省按职级成本映射（与 analytics 口径一致）。 */
function employeeMonthlyCost(emp: Employee, configs: LevelConfig[]): number {
  if (typeof emp.cost === 'number' && Number.isFinite(emp.cost)) return emp.cost;
  const match = configs.find((c) => fullCode(c) === emp.level);
  return match && typeof match.cost === 'number' && Number.isFinite(match.cost) ? match.cost : 0;
}

/** 取场景四项指标（computeL2 的 v2.0.9 口径值）。特例：组织树为空时层级深度视为不可算（引擎回 0 会误读为「0 层」）。 */
function metricValuesFor(s: Scenario, thresholds?: HealthThresholds): L2Metric[] {
  const hasDepts = flattenDepartments(s.departments).length > 0;
  const metrics = computeL2(s.departments, thresholds);
  if (!hasDepts) return metrics.map((m) => (m.key === 'depth' ? { ...m, value: null } : m));
  return metrics;
}

/** 员工放置信息：在哪个部门节点、该节点负责人（= 汇报对象）。 */
interface PlacementInfo {
  deptId?: string;
  deptName?: string;
  leaderId?: string;
  leaderName?: string;
}

/** 场景员工放置映射（树内员工优先；未入架构员工补入 flat 列表，无部门）。 */
function employeePlacements(s: Scenario): Map<string, PlacementInfo> {
  const map = new Map<string, PlacementInfo>();
  for (const d of flattenDepartments(s.departments)) {
    for (const e of d.employees) {
      const k = empKey(e);
      if (!map.has(k)) {
        map.set(k, { deptId: d.id, deptName: d.name, leaderId: d.leaderId, leaderName: d.leaderName });
      }
    }
  }
  for (const e of s.allEmployeesFlat) {
    const k = empKey(e);
    if (!map.has(k)) map.set(k, {});
  }
  return map;
}

/** 员工全集（树内 ∪ 未入架构，按身份 key 去重；含兼岗虚拟员工）。 */
function employeeUniverse(s: Scenario): Map<string, Employee> {
  const map = new Map<string, Employee>();
  for (const d of flattenDepartments(s.departments)) {
    for (const e of d.employees) {
      const k = empKey(e);
      if (!map.has(k)) map.set(k, e);
    }
  }
  for (const e of s.allEmployeesFlat) {
    const k = empKey(e);
    if (!map.has(k)) map.set(k, e);
  }
  return map;
}

/** —— —— L1：四项指标 Δ —— —— */

/**
 * 计算四项指标差异（纯函数；传入两组的 computeL2 结果即可，便于独立单测）。
 * 不重复实现指标计算逻辑——只做「对齐 + 求差 + 可比性」。
 */
export function computeMetricDiffs(baseline: L2Metric[], target: L2Metric[]): MetricDiff[] {
  return METRIC_KEYS.map((key) => {
    const b = baseline.find((m) => m.key === key);
    const t = target.find((m) => m.key === key);
    const bVal = b?.value ?? null;
    const tVal = t?.value ?? null;
    const comparable = bVal !== null && tVal !== null;
    return {
      key,
      label: t?.label ?? b?.label ?? key,
      unit: t?.unit ?? b?.unit ?? '',
      baseline: bVal,
      target: tVal,
      delta: comparable ? round1((tVal as number) - (bVal as number)) : null,
      baselineStatus: comparable && b ? b.status : null,
      targetStatus: comparable && t ? t.status : null,
      comparable,
    };
  });
}

/** —— —— L2：部门差异 —— —— */

function snapshotOf(row: L3DeptRow | undefined, dept: Department | undefined): DeptDiffSnapshot | undefined {
  if (!row || !dept) return undefined;
  return {
    level: dept.level,
    leaderName: dept.leaderName,
    headcount: row.headcount,
    actual: row.actual,
    gap: row.gap,
    gapCost: row.gapCost,
  };
}

function classifyDeptChange(b: Department, t: Department, a: DeptDiffSnapshot, z: DeptDiffSnapshot): DeptDiff['changeType'] {
  const parentChanged = (b.parentId ?? null) !== (t.parentId ?? null);
  const levelChanged = b.level !== t.level;
  const leaderChanged = deptLeaderKey(b) !== deptLeaderKey(t);
  const configChanged =
    (a.headcount ?? null) !== (z.headcount ?? null) ||
    a.actual !== z.actual ||
    a.gap !== z.gap ||
    a.gapCost !== z.gapCost;
  if (parentChanged) return 'reparented';
  if (levelChanged) return 'moved';
  if (leaderChanged) return 'leader-changed';
  if (configChanged) return 'config-changed';
  return 'unchanged';
}

function deltaOfBoth(a: DeptDiffSnapshot, b: DeptDiffSnapshot): DeptDiff['delta'] {
  return {
    headcount: numDelta(a.headcount, b.headcount),
    actual: round1(b.actual - a.actual),
    gap: numDelta(a.gap, b.gap),
    gapCost: gapCostDeltaOf(a, b),
  };
}

/** 缺口成本 Δ：任一侧编制缺失（gap=null）或成本缺失 → null（不把缺失当 0）。 */
function gapCostDeltaOf(a: DeptDiffSnapshot, b: DeptDiffSnapshot): number | null {
  if (a.gap === null || b.gap === null) return null;
  if (a.gapCost === null || b.gapCost === null) return null;
  return round1(b.gapCost - a.gapCost);
}

function buildDeptDiff(
  base: Department | undefined,
  tgt: Department | undefined,
  baseRows: Map<string, L3DeptRow>,
  tgtRows: Map<string, L3DeptRow>,
): DeptDiff {
  const deptId = (base ?? tgt as Department).id;
  const name = (base ?? tgt as Department).name;
  const baseSnap = snapshotOf(base ? baseRows.get(base.id) : undefined, base);
  const tgtSnap = snapshotOf(tgt ? tgtRows.get(tgt.id) : undefined, tgt);

  let changeType: DeptDiff['changeType'];
  let delta: DeptDiff['delta'];
  if (!baseSnap && tgtSnap) {
    changeType = 'added';
    delta = {
      headcount: tgtSnap.headcount,
      actual: tgtSnap.actual,
      gap: tgtSnap.gap,
      gapCost: tgtSnap.gap === null ? null : tgtSnap.gapCost,
    };
  } else if (baseSnap && !tgtSnap) {
    changeType = 'removed';
    delta = {
      headcount: baseSnap.headcount === null ? null : neg(baseSnap.headcount),
      actual: neg(baseSnap.actual),
      gap: baseSnap.gap === null ? null : neg(baseSnap.gap),
      gapCost: baseSnap.gap === null || baseSnap.gapCost === null ? null : neg(baseSnap.gapCost),
    };
  } else {
    changeType = classifyDeptChange(base as Department, tgt as Department, baseSnap as DeptDiffSnapshot, tgtSnap as DeptDiffSnapshot);
    delta = deltaOfBoth(baseSnap as DeptDiffSnapshot, tgtSnap as DeptDiffSnapshot);
  }
  return { deptId, name, changeType, baseline: baseSnap, target: tgtSnap, delta };
}

/**
 * 部门差异表：按 deptId 匹配（场景复制保留 id）；id 不在基线侧时按「唯一同名」兜底匹配
 * （容忍重命名/重新导入导致的 id 漂移）；剩余双侧各自为 added/removed。
 */
export function computeDeptDiffs(baseline: Scenario, target: Scenario, thresholds?: HealthThresholds): DeptDiff[] {
  const baseDepts = flattenDepartments(baseline.departments);
  const tgtDepts = flattenDepartments(target.departments);
  const baseDeptById = new Map(baseDepts.map((d) => [d.id, d]));
  const tgtDeptById = new Map(tgtDepts.map((d) => [d.id, d]));
  const baseRows = new Map(computeL3(baseline.departments, baseline.levelConfigs, thresholds).map((r) => [r.deptId, r]));
  const tgtRows = new Map(computeL3(target.departments, target.levelConfigs, thresholds).map((r) => [r.deptId, r]));

  interface Pair {
    base?: Department;
    tgt?: Department;
  }
  const pairs: Pair[] = [];
  const usedTgt = new Set<string>();
  for (const b of baseDepts) {
    let t = tgtDeptById.get(b.id);
    if (!t) {
      // 兜底：同名且唯一、且其 id 未与任何基线部门成对的目标部门
      const candidates = tgtDepts.filter(
        (x) => x.name === b.name && !usedTgt.has(x.id) && !baseDeptById.has(x.id),
      );
      if (candidates.length === 1) t = candidates[0];
    }
    if (t) usedTgt.add(t.id);
    pairs.push({ base: b, tgt: t });
  }
  for (const t of tgtDepts) {
    if (!usedTgt.has(t.id)) pairs.push({ tgt: t });
  }

  return pairs.map((p) => buildDeptDiff(p.base, p.tgt, baseRows, tgtRows));
}

/** —— —— L3：人员调动清单 —— —— */

/**
 * 人员调动清单：以「基线员工全集 vs 目标员工全集」按身份 key（工号优先）匹配。
 * - 只在一侧存在 → added / removed；
 * - 两侧存在但所属部门不同 → moved-dept（同时带出新旧部门的负责人名，供 UI 展示汇报线变化）；
 * - 部门相同但该部门负责人变化 → moved-reporting（换汇报线）。
 * 未入架构员工（flat 列表有、树内无）按「无部门」参与匹配，不重复、不遗漏。
 */
export function computePersonnelChanges(baseline: Scenario, target: Scenario): PersonnelChange[] {
  const baseEmps = employeeUniverse(baseline);
  const tgtEmps = employeeUniverse(target);
  const basePs = employeePlacements(baseline);
  const tgtPs = employeePlacements(target);
  const changes: PersonnelChange[] = [];

  for (const [k, tEmp] of tgtEmps) {
    const bEmp = baseEmps.get(k);
    if (!bEmp) {
      const tp = tgtPs.get(k);
      changes.push({
        employeeId: tEmp.employeeId || tEmp.id,
        name: tEmp.name,
        type: 'added',
        toDeptName: tp?.deptName,
        isVirtual: tEmp.isVirtual,
      });
      continue;
    }
    const bp = basePs.get(k);
    const tp = tgtPs.get(k);
    if (bp?.deptId !== tp?.deptId) {
      changes.push({
        employeeId: tEmp.employeeId || bEmp.employeeId || tEmp.id,
        name: tEmp.name || bEmp.name,
        type: 'moved-dept',
        fromDeptName: bp?.deptName,
        toDeptName: tp?.deptName,
        fromLeaderName: bp?.leaderName,
        toLeaderName: tp?.leaderName,
        isVirtual: tEmp.isVirtual ?? bEmp.isVirtual,
      });
    } else if (bp?.deptId && placementLeaderKey(bp) !== placementLeaderKey(tp)) {
      changes.push({
        employeeId: tEmp.employeeId || bEmp.employeeId || tEmp.id,
        name: tEmp.name || bEmp.name,
        type: 'moved-reporting',
        toDeptName: tp?.deptName,
        fromLeaderName: bp?.leaderName,
        toLeaderName: tp?.leaderName,
        isVirtual: tEmp.isVirtual ?? bEmp.isVirtual,
      });
    }
  }

  for (const [k, bEmp] of baseEmps) {
    if (!tgtEmps.has(k)) {
      const bp = basePs.get(k);
      changes.push({
        employeeId: bEmp.employeeId || bEmp.id,
        name: bEmp.name,
        type: 'removed',
        fromDeptName: bp?.deptName,
        isVirtual: bEmp.isVirtual,
      });
    }
  }

  return changes;
}

/** —— —— 缺口与成本汇总 —— —— */

/**
 * 单场景总量：
 * - 编制/缺口只统计配置了编制的 L1 子树（与空岗率口径一致）；完全未配置 → null（不伪装成 0）。
 * - 月成本 = 树内非虚拟员工成本合计（按 id 去重，避免父子子树重复累计）。
 * - 缺口成本 = L1 层（子树）缺口 × 子树平均成本，不做全树逐行累加（避免嵌套重复累计）。
 */
export function computeScenarioTotals(s: Scenario, thresholds?: HealthThresholds): ScenarioTotals {
  const l1 = computeL1(s.departments, thresholds);
  const l3 = computeL3(s.departments, s.levelConfigs, thresholds);
  const l1ById = new Set(l1.map((r) => r.deptId));
  const coverage = headcountCoverage(s.departments);

  let totalHeadcount = 0;
  let configured = 0;
  let totalEmployees = 0;
  let totalGapCost = 0;
  for (const row of l1) {
    totalEmployees += row.actual;
    if (row.headcount !== null) {
      configured++;
      totalHeadcount += row.headcount;
    }
  }
  for (const row of l3) {
    // v2.3.1（F-11）：gapCost 现在可为 null（无法估算），缺依据的部门不并入合计，
    // 避免把「不知道」当成 0 参与净差计算。
    if (l1ById.has(row.deptId) && row.gap !== null && row.gapCost !== null) totalGapCost += row.gapCost;
  }

  const seen = new Set<string>();
  let totalCost = 0;
  for (const d of flattenDepartments(s.departments)) {
    for (const e of d.employees) {
      if (e.isVirtual || seen.has(e.id)) continue;
      seen.add(e.id);
      totalCost += employeeMonthlyCost(e, s.levelConfigs);
    }
  }

  return {
    totalHeadcount: configured === 0 ? null : totalHeadcount,
    totalEmployees,
    totalGap: coverage.headcount === null ? null : round1(coverage.headcount - coverage.actual),
    totalCost: round1(totalCost),
    totalGapCost: round1(totalGapCost),
  };
}

/**
 * 缺口与成本 Δ：单侧「编制完全未配置」（totalGap=null）→ 对应 Δ 为 null（不可比）。
 * costDelta 双侧恒可算（0 员工 = 0 成本 = 真实值）。
 */
export function computeDiffTotals(baseline: Scenario, target: Scenario, thresholds?: HealthThresholds): ScenarioDiffTotals {
  const b = computeScenarioTotals(baseline, thresholds);
  const t = computeScenarioTotals(target, thresholds);
  return {
    headcountDelta: numDelta(b.totalHeadcount, t.totalHeadcount),
    costDelta: round1(t.totalCost - b.totalCost),
    gapDelta: numDelta(b.totalGap, t.totalGap),
    gapCostDelta: b.totalGap === null || t.totalGap === null ? null : round1(t.totalGapCost - b.totalGapCost),
  };
}

/** —— —— 主入口 —— —— */

/** 整体健康度：取四项指标最差灯号（danger > warn > healthy）；全部不可算 → null。 */
function worstStatus(statuses: (HealthStatus | null)[]): HealthStatus | null {
  if (statuses.includes('danger')) return 'danger';
  if (statuses.includes('warn')) return 'warn';
  if (statuses.includes('healthy')) return 'healthy';
  return null;
}

/**
 * 场景差异主入口：基线 vs 目标（1 对 1）。
 * @param baseline 基线场景（默认取项目第一个场景，UI 可手动切换，见 v209-roadmap §3.1）
 * @param target 对比目标场景
 * @param thresholds 阈值配置；缺省沿用 getHealthThresholds()（computeL2 的缺省行为）
 */
export function computeScenarioDiff(baseline: Scenario, target: Scenario, thresholds?: HealthThresholds): ScenarioDiffResult {
  const metrics = computeMetricDiffs(metricValuesFor(baseline, thresholds), metricValuesFor(target, thresholds));
  const baselineOverall = worstStatus(metrics.map((m) => m.baselineStatus));
  const targetOverall = worstStatus(metrics.map((m) => m.targetStatus));

  return {
    baselineScenarioId: baseline.id,
    targetScenarioId: target.id,
    metrics,
    departmentDiffs: computeDeptDiffs(baseline, target, thresholds),
    personnelChanges: computePersonnelChanges(baseline, target),
    totals: computeDiffTotals(baseline, target, thresholds),
    overall: {
      baseline: baselineOverall,
      target: targetOverall,
      comparable: baselineOverall !== null && targetOverall !== null,
    },
  };
}
