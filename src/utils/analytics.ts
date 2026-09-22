import { Department, Employee, LevelConfig, Position, LeaderType } from '../types';
import { fullCode } from './level';
import { computeMatchStates, MatchResult } from './match';
import { computeLevelGaps } from './deptLevel';
import { findUnconfiguredLevels } from './levels';

// —— v2.1.1 状态机接入：data-eng 于 src/utils/match.ts 提供，此处复用/再导出 ——
export { computeMatchStates };
export type { MatchResult };

/**
 * 组织健康度分析（纯函数，可单测）。
 *
 * 从 `departments` 树自动计算分层健康度指标：
 * - L1：部门人数 / 编制 / 职级分布（一级部门概览卡）
 * - L2：管理幅度 / 层级深度 / 管理者比 / 空岗率（红黄绿阈值 + 一句话判读）
 * - L3：编制 vs 实际 vs 缺口（含成本）
 *
 * 与本应用的状态 store 解耦：只吃 `departments` + `levelConfigs`，输出纯数据，
 * 供「健康度抽屉」「诊断报告」「单测」复用。
 */

/** 红黄绿状态 */
export type HealthStatus = 'healthy' | 'warn' | 'danger';

/** 状态中文语义（用于 UI 与报告展示） */
export const HEALTH_STATUS_LABEL: Record<HealthStatus, string> = {
  healthy: '健康',
  warn: '关注',
  danger: '预警',
};

/** L1 部门概览卡 */
export interface L1DeptSummary {
  deptId: string;
  name: string;
  level: number;
  /** 编制人数（子树合计；未配置为 null） */
  headcount: number | null;
  /** 实际人数（子树合计，不含虚拟兼岗） */
  actual: number;
  /** 职级分布：fullCode -> 人数（子树合计） */
  levelDistribution: Record<string, number>;
  /** 该部门整体健康状态（优先看空岗率；未配置则默认关注） */
  status: HealthStatus;
}

/** —— v2.0.9 口径修正：明细/分布数据结构（运行时派生，不进持久化模型） —— */

/** 管理幅度单行：某个「有负责人」部门的直管数 */
export interface SpanRow {
  deptId: string;
  deptName: string;
  /** 直管人数 = 节点直挂非虚拟 IC 数 + 下一层「有负责人」子部门数 */
  directReports: number;
}

/** 管理幅度分布（v2.0.9）：中位数主判 + 极值兜底 + 部门级裸奔明细 */
export interface SpanBreakdown {
  /** 有负责人部门数（样本量） */
  count: number;
  /** 主值：直管数中位数（round1） */
  median: number | null;
  /** 均值（保留作参考，不参与判定） */
  mean: number | null;
  /** 最窄直管数 */
  min: number | null;
  /** 极值：最宽直管数（用于「单点失衡」告警） */
  max: number | null;
  /** 每个有负责人部门的直管数，按 directReports 降序 */
  distribution: SpanRow[];
}

/** 层级深度分布（v2.0.9）：P90 主判 + max 硬上限 + 最深链定位 */
export interface DepthBreakdown {
  /** 最大层数（根 L1=1，= 旧 computeTreeDepth） */
  max: number;
  /** 所有部门节点深度的中位数 */
  p50: number;
  /** 所有部门节点深度的 90 分位（nearest-rank，整数层） */
  p90: number;
  /** 最深链路的叶子部门 id */
  deepestDeptId: string;
  /** 根 → … → 最深叶子的部门名链 */
  deepestPath: string[];
  /** 参与统计的部门总数（空树为 0） */
  deptCount: number;
}

/** 管理者明细（v2.0.9）：内部/外部/兼岗 + 双口径分母 */
export interface ManagerBreakdown {
  /** 内部负责人数（去重、剔除外部、只计 leaderType==='owner'）—— 主口径分子 */
  internalManagers: number;
  /** 外部/非正职负责人数（不在名册 owner + deputy/acting/external 型负责人）—— 仅展示，不计分子 */
  externalManagers: number;
  /** 兼岗：同一人兼任 ≥2 个部门（其中至少一处为正职）的人数（仅展示，去重后分子不变） */
  multiDeptManagers: number;
  /** 分母：员工总数（含管理者、非虚拟） */
  totalEmployees: number;
  /** 非管理员工数 = totalEmployees - internalManagers（辅助口径用） */
  nonManagerEmployees: number;
  /** leaderType==='vacant' 的部门数（负责人空缺提示） */
  vacantLeaderDepts: number;
}

/** L2 单项指标 */
export interface L2Metric {
  key: 'span' | 'depth' | 'managerRatio' | 'vacancy';
  label: string;
  /** 指标值；不可计算时为 null（如无负责人、无编制、无员工）。
   *  v2.0.9 语义：span = 直管数中位数；depth = 深度 P90（主）；managerRatio = 内部负责人 ÷ 含管理者全员。 */
  value: number | null;
  unit: string;
  status: HealthStatus;
  /** 一句话判读 */
  verdict: string;
  // —— v2.0.9 新增（可选，缺省退化为旧渲染行为）——
  spanBreakdown?: SpanBreakdown;
  depthBreakdown?: DepthBreakdown;
  managerBreakdown?: ManagerBreakdown;
}

/** L3 单行（编制 vs 实际 vs 缺口，含成本） */
export interface L3DeptRow {
  deptId: string;
  name: string;
  level: number;
  /** 编制（子树合计；未配置为 null） */
  headcount: number | null;
  /** 实际人数（子树合计） */
  actual: number;
  /** 缺口 = 编制 - 实际；正=空岗待补，负=超编 */
  gap: number | null;
  /** 平均月成本 */
  avgCost: number;
  /** 实际成本 */
  actualCost: number;
  /** 缺口成本 = 缺口 × 平均成本；**找不到成本依据时为 null（无法估算），不写成 0**（v2.3.1 F-11） */
  gapCost: number | null;
  status: HealthStatus;
}

/** 报告汇总 */
export interface HealthSummary {
  red: number;
  yellow: number;
  green: number;
  /** 整体诊断一句话 */
  diagnosis: string;
  /** 整体健康状态（取 L2 最差状态） */
  overall: HealthStatus;
}

/** 报告最高层指标 */
export interface ReportTotals {
  /** 总人数（不含虚拟兼岗） */
  totalEmployees: number;
  /** 部门总数 */
  totalDepartments: number;
  /** 编制缺口合计（正=空岗，负=超编）；当无任何部门配置编制时置为 null（未配置，不伪装成“超编/空岗”） */
  totalGap: number | null;
  /** 已配置部门的编制合计，与缺口覆盖范围一致。 */
  totalHeadcount: number | null;
  /** 月人力成本（实际成本合计） */
  totalCost: number;
  /** 有编制配置的一级部门数 */
  configuredHeadcount: number;
}

/** 完整健康报告 */
export interface HealthReport {
  scopeDeptId?: string;
  l1: L1DeptSummary[];
  l2: L2Metric[];
  summary: HealthSummary;
  l3: L3DeptRow[];
  totals: ReportTotals;
}

/**
 * 健康度阈值配置（v2.0.3 可配置化）。
 * 各指标阈值从硬编码抽离，可经设置面板调整并持久化到 localStorage。
 * 所有 compute* 函数接受可选阈值参数，缺省读取当前配置（默认值即 v2.0.2 历史口径）。
 */
export interface HealthThresholds {
  /** 管理幅度：健康区间 [spanHealthyMin, spanHealthyMax]；[spanWarnLow, spanHealthyMin) 与 (spanHealthyMax, spanWarnMax] 为关注；其余预警 */
  spanHealthyMin: number;
  spanHealthyMax: number;
  spanWarnLow: number;
  spanWarnMax: number;
  /** 层级深度：<= depthHealthyMax 健康；<= depthWarnMax 关注；其余预警 */
  depthHealthyMax: number;
  depthWarnMax: number;
  /** 管理者比（%）：<= managerHealthyMax 健康；<= managerWarnMax 关注；其余预警 */
  managerHealthyMax: number;
  managerWarnMax: number;
  /** 空岗率（%）：<= vacancyHealthyMax 健康；<= vacancyWarnMax 关注；其余预警 */
  vacancyHealthyMax: number;
  vacancyWarnMax: number;
  /** 超编梯度：超编占比 <= overWarnRatio 关注；其余预警 */
  overWarnRatio: number;
}

/** 默认阈值（v2.0.2 历史口径，作为迁移默认值） */
export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  spanHealthyMin: 3,
  spanHealthyMax: 8,
  spanWarnLow: 1,
  spanWarnMax: 12,
  depthHealthyMax: 4,
  depthWarnMax: 6,
  managerHealthyMax: 15,
  managerWarnMax: 25,
  vacancyHealthyMax: 10,
  vacancyWarnMax: 20,
  overWarnRatio: 0.2,
};

const HEALTH_THRESHOLDS_KEY = 'org-designer.health-thresholds';

/** 读取当前阈值配置；未配置/非法时回退默认值。 */
export function getHealthThresholds(): HealthThresholds {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_HEALTH_THRESHOLDS };
  try {
    const raw = localStorage.getItem(HEALTH_THRESHOLDS_KEY);
    if (!raw) return { ...DEFAULT_HEALTH_THRESHOLDS };
    const parsed = JSON.parse(raw) as Partial<HealthThresholds>;
    return { ...DEFAULT_HEALTH_THRESHOLDS, ...parsed };
  } catch {
    return { ...DEFAULT_HEALTH_THRESHOLDS };
  }
}

/** 持久化阈值配置。 */
export function setHealthThresholds(t: HealthThresholds): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(HEALTH_THRESHOLDS_KEY, JSON.stringify(t));
  }
}

/** 恢复默认阈值并清除自定义配置。 */
export function resetHealthThresholds(): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(HEALTH_THRESHOLDS_KEY);
  }
}

/** —— —— v2.0.8：企业阶段情景基准预设（只做“阶段”，不做“行业”） —— —— */

/** 企业阶段 */
export type OrganizationStage = 'startup' | 'growth' | 'mature';

/** 阶段预设：含标签、描述与对应阈值 */
export interface StagePreset {
  id: OrganizationStage;
  label: string;
  description: string;
  thresholds: HealthThresholds;
}

/**
 * 三档阶段基准（值来自 HR 审计档位值）。
 * 注意：growth 即当前默认口径（= DEFAULT_HEALTH_THRESHOLDS）。
 * 每一档 description 均注明「基准仅供参考，需结合本企业业务阶段校准」。
 */
export const STAGE_PRESETS: Record<OrganizationStage, StagePreset> = {
  startup: {
    id: 'startup',
    label: '初创期',
    description: '组织快速搭建、管理上线，基准仅供参考，需结合本企业业务阶段校准。',
    thresholds: {
      spanHealthyMin: 2,
      spanHealthyMax: 7,
      spanWarnLow: 1,
      spanWarnMax: 10,
      depthHealthyMax: 3,
      depthWarnMax: 4,
      managerHealthyMax: 20,
      managerWarnMax: 30,
      vacancyHealthyMax: 15,
      vacancyWarnMax: 25,
      overWarnRatio: 0.25,
    },
  },
  growth: {
    id: 'growth',
    label: '成长期',
    description: '快速扩张、层级与汇报线逐渐成形，基准仅供参考，需结合本企业业务阶段校准。',
    thresholds: { ...DEFAULT_HEALTH_THRESHOLDS },
  },
  mature: {
    id: 'mature',
    label: '成熟期',
    description: '组织稳定、流程固化，基准仅供参考，需结合本企业业务阶段校准。',
    thresholds: {
      spanHealthyMin: 5,
      spanHealthyMax: 9,
      spanWarnLow: 1,
      spanWarnMax: 14,
      depthHealthyMax: 5,
      depthWarnMax: 7,
      managerHealthyMax: 18,
      managerWarnMax: 25,
      vacancyHealthyMax: 8,
      vacancyWarnMax: 15,
      overWarnRatio: 0.15,
    },
  },
};

/** 默认阶段 = 成长期（= 当前默认阈值） */
export const DEFAULT_STAGE: OrganizationStage = 'growth';

/** 取某阶段阈值（返回副本，避免调用方误改原始预设）。 */
export function getStagePresetThresholds(stage: OrganizationStage): HealthThresholds {
  return { ...STAGE_PRESETS[stage].thresholds };
}

/** 应用某阶段阈值并持久化到 localStorage（复用现有 setHealthThresholds）。 */
export function setStagePreset(stage: OrganizationStage): void {
  setHealthThresholds(getStagePresetThresholds(stage));
}

/** 判断编制是否未配置（headcount 为 null/undefined）—— 供 UI 呈现灰色“无数据”。 */
export function isHeadcountUnset(headcount: number | null | undefined): boolean {
  return headcount == null;
}

/** —— 树遍历辅助 —— */

// v2.3.1（F-04）：旧的 `countEmployees`（按记录条数、含重复挂载）已删除 ——
// L1/L3 统一改用 `rowActual`（真人去重且与编制覆盖范围同口径）。

function collectEmployees(dept: Department, includeVirtual: boolean, out: Employee[] = []): Employee[] {
  for (const e of dept.employees) {
    if (includeVirtual || !e.isVirtual) out.push(e);
  }
  for (const child of dept.children) collectEmployees(child, includeVirtual, out);
  return out;
}

/** 扁平化所有部门 */
export function flattenDepartments(depts: Department[]): Department[] {
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

/** —— —— v2.0.9：口径修正基础工具 —— —— */

/**
 * 该员工是否为本部门负责人（v2.3.1 F-02 新增）。
 * 优先用 leaderId 命中 employeeId / 内部 id；仅当部门没有 leaderId 时才用姓名兜底
 * （避免同名误剔）。与 computeManagerBreakdown 的 resolveLeader 同语义。
 */
export function isDeptLeader(emp: Employee, dept: Department): boolean {
  if (dept.leaderId) return emp.employeeId === dept.leaderId || emp.id === dept.leaderId;
  if (dept.leaderName) return emp.name === dept.leaderName;
  return false;
}

/**
 * 某部门负责人的直管人数（v2.0.9 统一口径；v2.3.1 F-02 修正「含本人」）：
 *   = 节点直挂非虚拟 IC 数（**不含负责人本人**） + 下一层「有负责人」子部门数
 * 语义：经理直接管理的人 = 直接汇报给 TA 的一线员工 + 直接汇报给 TA 的下一级管理者。
 * 对扁平单层组织（无子部门）退化为「节点直挂 IC 数」。
 *
 * v2.3.1（F-02）：负责人通常同时是本部门成员（`App.handleUpdateLeader` 只改 leaderId 不移出成员，
 * `excel.buildDepartmentTree` 也把负责人 push 进本部门），旧实现把本人算作自己的下属 →
 * 「负责人无人直管」被降级为「偏窄(1 人)」、全组织 leader-only 时 span 中位数 0→1、灯号偏乐观。
 */
export function directReports(dept: Department): number {
  const directICs = dept.employees.filter((e) => !e.isVirtual && !isDeptLeader(e, dept)).length;
  const directManagers = dept.children.filter((c) => c.leaderId || c.leaderName).length;
  return directICs + directManagers;
}

/** 中位数：n 奇数取中间，偶数取两中间值平均（round1）。入参须已升序。 */
function medianOf(sortedValues: number[]): number {
  const n = sortedValues.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sortedValues[mid];
  return round1((sortedValues[mid - 1] + sortedValues[mid]) / 2);
}

/** nearest-rank 百分位：index = ceil(p·n) − 1，返回真实存在的样本值（保证整数分位）。入参须已升序。 */
function percentileNearestRank(sortedValues: number[], p: number): number {
  const n = sortedValues.length;
  if (n === 0) return 0;
  const idx = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1));
  return sortedValues[idx];
}

/** 取更差一档的状态（danger > warn > healthy） */
function worseStatus(a: HealthStatus, b: HealthStatus): HealthStatus {
  const rank: Record<HealthStatus, number> = { healthy: 0, warn: 1, danger: 2 };
  return rank[a] >= rank[b] ? a : b;
}

/**
 * 统一编制读取入口（v2.1.1）：
 * 优先聚合本部门直属岗位编制（只计 status==='active' 的岗位；frozen/archived 不计，
 * 其中 frozen 为「编制冻结」、archived 为软删除，均不产生可填补缺口），
 * 聚合结果 > 0 才视为「已配置编制」（返回该值）；否则回退读部门级冗余派生 `headcount`（过渡期兼容）。
 * 无有效编制时返回 null（与旧口径「未配置编制 → 不参与空岗率/缺口」一致）。
 * 迁移前 v1 数据无 positions → 恒回退 headcount，保证空岗率/缺口/成本与迁移前完全一致。
 */
export function deptHeadcount(dept: Department): number | null {
  if (dept.positions?.length) {
    // 只累加 status==='active' 且 headcount>0 的岗位（与 v2.0.8「只累加 headcount>0 部门」口径一致；
    // headcount===0 = 编制未配置/冻结；frozen/archived 不计）。聚合 >0 才视为「已配置有效编制」。
    const sum = dept.positions.reduce(
      (s, p) => s + (p.status === 'active' && p.headcount > 0 ? p.headcount : 0),
      0,
    );
    return sum > 0 ? sum : null;
  }
  return typeof dept.headcount === 'number' && Number.isFinite(dept.headcount) && dept.headcount > 0
    ? dept.headcount
    : null;
}

/**
 * 部门编制配置状态（v2.3.1 F-05 新增）：
 * - `configured`：存在有效编制（active 且 headcount>0，或部门级冗余 headcount>0）
 * - `frozen`：树内岗位全部处于「编制冻结」（无有效编制，但存在 status==='frozen' 岗位）
 * - `unconfigured`：既无有效编制也无冻结岗位（真正的「未配置」）
 *
 * 旧实现把 frozen 与 unconfigured 一起压成 null → 空岗率显示「无数据」、建议写「未配置编制，请补充」，
 * 而岗位级（boardScope 的 headcountStatus）已正确区分三态，两处口径互相矛盾（违反 v230-contract §5.7）。
 */
export type HeadcountStatus = 'configured' | 'frozen' | 'unconfigured';

export function deptHeadcountStatus(dept: Department): HeadcountStatus {
  if (deptHeadcount(dept) !== null) return 'configured';
  if (dept.positions?.some((p) => p.status === 'frozen')) return 'frozen';
  return 'unconfigured';
}

/** 子树内「编制冻结」部门数（F-05：用于把「全部冻结」与「未配置」的判读文案分开）。 */
function countFrozenDepts(roots: Department[]): number {
  return flattenDepartments(roots).filter((d) => deptHeadcountStatus(d) === 'frozen').length;
}

/** 有效编制和它覆盖的人员必须同口径；父子同配时员工只计一次。 */
export function headcountCoverage(roots: Department[]): { headcount: number | null; actual: number } {
  let headcount = 0;
  let found = false;
  const employeeIds = new Set<string>();
  const walk = (list: Department[], covered: boolean) => {
    for (const dept of list) {
      const hc = deptHeadcount(dept);
      if (hc !== null) { headcount += hc; found = true; }
      const inScope = covered || hc !== null;
      if (inScope) for (const emp of dept.employees) if (!emp.isVirtual) employeeIds.add(emp.id);
      walk(dept.children, inScope);
    }
  };
  walk(roots, false);
  return { headcount: found ? headcount : null, actual: employeeIds.size };
}

function sumHeadcountSubtree(dept: Department): number | null {
  return headcountCoverage([dept]).headcount;
}

/**
 * 子树「真人去重」人数（v2.3.1 F-04）：按内部 id 去重，与 headcountCoverage 同一去重键。
 * 同一真人被重复挂载到多个部门时只计一次。
 */
function countRealSubtree(dept: Department): number {
  const ids = new Set<string>();
  const walk = (d: Department) => {
    for (const e of d.employees) if (!e.isVirtual) ids.add(e.id);
    for (const c of d.children) walk(c);
  };
  walk(dept);
  return ids.size;
}

/**
 * L1/L3 行「实际人数」的统一口径（v2.3.1 F-04 修正）：
 * - 子树已配置有效编制 → 与 headcount / gap / status 完全同口径的**覆盖范围内真人去重**人数；
 * - 子树完全未配置编制 → 该子树**真人去重**人数（此时 headcount=null，不产生 gap，展示真实人数不矛盾）。
 *
 * 旧实现里 `actual` 用未去重的 `countEmployees`、`gap`/`status` 用已去重的 `headcountCoverage`，
 * 同一行两套口径 → 出现「编制 3，实际 3，空岗率 33.3%」这类自相矛盾的表格与建议文案。
 */
function rowActual(dept: Department): number {
  const coverage = headcountCoverage([dept]);
  return coverage.headcount === null ? countRealSubtree(dept) : coverage.actual;
}

/** 获取某职级配置的月成本；未知职级返回 0 */
export function costForLevel(configs: LevelConfig[], code: string): number {
  const match = configs.find((c) => fullCode(c) === code);
  return typeof match?.cost === 'number' && Number.isFinite(match.cost) ? match.cost : 0;
}

/** 员工月成本：优先用员工个人成本 emp.cost，缺省降级按职级成本映射。 */
export function employeeCost(emp: Employee, configs: LevelConfig[]): number {
  if (typeof emp.cost === 'number' && Number.isFinite(emp.cost)) return emp.cost;
  return costForLevel(configs, emp.level);
}

/**
 * 子树实际成本合计 = Σ(非虚拟员工月成本)。
 * v2.3.1（F-04 配套）：按内部 id 去重，与 countRealSubtree / headcountCoverage 同口径，
 * 避免同一真人被重复挂载时成本被双计（人数已去重而成本未去重会互相矛盾）。
 */
function sumCostSubtree(dept: Department, configs: LevelConfig[]): number {
  const seen = new Set<string>();
  let sum = 0;
  const walk = (d: Department) => {
    for (const e of d.employees) {
      if (e.isVirtual || seen.has(e.id)) continue;
      seen.add(e.id);
      sum += employeeCost(e, configs);
    }
    for (const c of d.children) walk(c);
  };
  walk(dept);
  return sum;
}

/** 子树平均成本 = 实际成本 / 实际人数（真人去重；无人则 0） */
function avgCostSubtree(dept: Department, configs: LevelConfig[]): number {
  const actual = countRealSubtree(dept);
  if (actual === 0) return 0;
  const realCost = sumCostSubtree(dept, configs);
  return round1(realCost / actual);
}

/** 子树职级分布 */
function levelDistributionSubtree(dept: Department): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const e of collectEmployees(dept, true)) {
    dist[e.level] = (dist[e.level] || 0) + 1;
  }
  return dist;
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** 查找部门（返回子树根） */
function findDept(depts: Department[], id: string): Department | null {
  for (const d of depts) {
    if (d.id === id) return d;
    const found = findDept(d.children, id);
    if (found) return found;
  }
  return null;
}

/** —— 阈值分级 —— */

function spanStatus(span: number, t: HealthThresholds): HealthStatus {
  // 3-8 健康；[spanWarnLow, healthyMin) 或 (healthyMax, warnMax] 关注；其余预警
  if (span >= t.spanHealthyMin && span <= t.spanHealthyMax) return 'healthy';
  if (span >= t.spanWarnLow && span < t.spanHealthyMin) return 'warn';
  if (span > t.spanHealthyMax && span <= t.spanWarnMax) return 'warn';
  return 'danger';
}

function depthStatus(depth: number, t: HealthThresholds): HealthStatus {
  if (depth <= t.depthHealthyMax) return 'healthy';
  if (depth <= t.depthWarnMax) return 'warn';
  return 'danger';
}

function managerRatioStatus(ratio: number, t: HealthThresholds): HealthStatus {
  if (ratio <= t.managerHealthyMax) return 'healthy';
  if (ratio <= t.managerWarnMax) return 'warn';
  return 'danger';
}

function vacancyStatus(rate: number, t: HealthThresholds): HealthStatus {
  if (rate <= t.vacancyHealthyMax) return 'healthy';
  if (rate <= t.vacancyWarnMax) return 'warn';
  return 'danger';
}

/** 超编梯度：超编占比 = |缺口| ÷ 实际人数；> overWarnRatio 预警，否则关注 */
function overStatus(ratio: number, t: HealthThresholds): HealthStatus {
  return ratio > t.overWarnRatio ? 'danger' : 'warn';
}

/**
 * 部门编制状态（L1 / L3 共用的统一口径，保证一致）。
 * - headcount 为 null/undefined → 未配置编制 → 关注（不做缺口分析）。
 * - 空岗（缺口>0）→ 按空岗率分级（≤10 健康 / ≤20 关注 / >20 预警）。
 * - 超编（缺口<0）→ 按超编梯度分级（|缺口|/实际 >20% 预警，否则关注）。
 * - 恰好满编 → 健康。
 */
function deptStatus(headcount: number | null, actual: number, t: HealthThresholds): HealthStatus {
  if (headcount === null) return 'warn';
  const gap = headcount - actual;
  if (gap > 0) return vacancyStatus((gap / headcount) * 100, t); // 空岗，headcount>0
  if (gap < 0) return overStatus(Math.abs(gap) / Math.max(actual, 1), t); // 超编梯度
  return 'healthy';
}

/** —— L1 —— */

export function computeL1(depts: Department[], thresholds: HealthThresholds = getHealthThresholds()): L1DeptSummary[] {
  return depts.map((d) => {
    // v2.3.1（F-04）：actual 与 gap/status 必须同口径（真人去重 + 与编制覆盖范围一致）。
    const actual = rowActual(d);
    const headcount = sumHeadcountSubtree(d);
    const status = deptStatus(headcount, headcountCoverage([d]).actual, thresholds);
    return {
      deptId: d.id,
      name: d.name,
      level: d.level,
      headcount,
      actual,
      levelDistribution: levelDistributionSubtree(d),
      status,
    };
  });
}

/** —— L2 —— */

/** —— v2.0.9：三个口径 breakdown 纯函数（独立可测，供场景差异比较与报告复用） —— */

/**
 * 管理幅度分布（v2.0.9）：
 * 统计对象 = 所有「有负责人」部门；直管数 = directReports(dept)。
 * median 为主值（对极端值稳健），mean 保留作参考，max 供「单点失衡」告警。
 */
export function computeSpanBreakdown(roots: Department[]): SpanBreakdown {
  const rows: SpanRow[] = [];
  for (const d of flattenDepartments(roots)) {
    if (d.leaderId || d.leaderName) {
      rows.push({ deptId: d.id, deptName: d.name, directReports: directReports(d) });
    }
  }
  if (rows.length === 0) {
    return { count: 0, median: null, mean: null, min: null, max: null, distribution: [] };
  }
  const values = rows.map((r) => r.directReports).sort((a, b) => a - b);
  return {
    count: rows.length,
    median: medianOf(values),
    mean: round1(values.reduce((s, v) => s + v, 0) / values.length),
    min: values[0],
    max: values[values.length - 1],
    distribution: rows
      .slice()
      .sort((a, b) => b.directReports - a.directReports || a.deptName.localeCompare(b.deptName, 'zh-CN')),
  };
}

/**
 * 层级深度分布（v2.0.9）：
 * 从结构重算每个部门的深度（根 L1=1），不信任 Department.level（防手工/导入导致 level 与真实深度不一致）。
 * 统计对象 = 所有部门节点（不是「叶路径」）：HR 关心「大多数部门在第几层」。
 */
export function computeDepthBreakdown(roots: Department[]): DepthBreakdown {
  const depths: number[] = [];
  let deepest = { depth: 0, deptId: '', path: [] as string[] };
  const walk = (d: Department, depth: number, path: string[]) => {
    depths.push(depth);
    if (d.children.length === 0 && depth > deepest.depth) {
      deepest = { depth, deptId: d.id, path: path.concat(d.name) };
    }
    const nextPath = path.concat(d.name);
    for (const c of d.children) walk(c, depth + 1, nextPath);
  };
  for (const r of roots) walk(r, 1, []);
  if (depths.length === 0) {
    return { max: 0, p50: 0, p90: 0, deepestDeptId: '', deepestPath: [], deptCount: 0 };
  }
  const sorted = depths.slice().sort((a, b) => a - b);
  return {
    max: deepest.depth,
    p50: medianOf(sorted),
    p90: percentileNearestRank(sorted, 0.9),
    deepestDeptId: deepest.deptId,
    deepestPath: deepest.path,
    deptCount: sorted.length,
  };
}

/**
 * 管理者明细（v2.0.9 口径 + v2.1.1 leaderType 精确化）：
 * - 统一去重：负责人解析到名册员工（优先 employeeId、其次姓名），修正「同一人 A 部门用 leaderId、
 *   B 部门用 leaderName」的双计 bug；
 * - 内部判定（v2.1.1）：主口径分子只计 leaderType==='owner'（缺省视为 'owner' 兼容旧数据）且能命中
 *   员工名册的负责人；否则判外部，不计分子、仅展示计数；
 * - 精确剔除（v2.1.1）：leaderType==='deputy'|'acting'|'external' 的负责人仅展示（externalManagers），
 *   不计主口径分子 —— 解决 v2.0.9「副职/挂名无法精确剔除」遗留问题；
 * - 空缺（v2.1.1）：leaderType==='vacant' 的部门触发「负责人空缺」提示，不计入内部/外部负责人；
 * - 兼岗：同一人兼任 ≥2 部门（其中至少一处为正职） → multiDeptManagers 暴露（去重后分子仍算 1）。
 */
export function computeManagerBreakdown(roots: Department[]): ManagerBreakdown {
  const allDepts = flattenDepartments(roots);
  const emps = collectEmployees(
    { id: '', name: '', level: 0, expanded: true, children: roots, employees: [], positions: [] } as Department,
    false,
  );

  const byEmployeeId = new Map<string, Employee>();
  const byName = new Map<string, Employee>();
  for (const e of emps) {
    if (e.employeeId && !byEmployeeId.has(e.employeeId)) byEmployeeId.set(e.employeeId, e);
    if (e.name && !byName.has(e.name)) byName.set(e.name, e);
  }

  // v2.3.1（F-03）：分母必须与分子同键去重。
  // 分子按 `emp:${employeeId || id}` 去重，而旧实现的分母 `emps.length` 按**记录条数**计数：
  // 同一真人被重复挂载、或同一工号存在两条记录时 → 分子 1 / 分母 3，管理者比被系统性低估，
  // 且与 managerBreakdown「兼岗已去重」的文案自相矛盾。
  const personKeyOf = (e: Employee) => `emp:${e.employeeId || e.id}`;
  const uniquePersons = new Map<string, Employee>();
  for (const e of emps) if (!uniquePersons.has(personKeyOf(e))) uniquePersons.set(personKeyOf(e), e);
  const totalEmployees = uniquePersons.size;

  /** 负责人 → 名册员工记录：优先 employeeId，其次姓名；都无法命中 → null（外部）。 */
  const resolveLeader = (d: Department): Employee | null => {
    if (d.leaderId) {
      const hit = byEmployeeId.get(d.leaderId);
      if (hit) return hit;
      // leaderId 未命中名册：借用姓名再试一次（同一人可能在其它部门仅以姓名记录）
      if (d.leaderName) {
        const byNameHit = byName.get(d.leaderName);
        if (byNameHit) return byNameHit;
      }
      return null;
    }
    if (d.leaderName) return byName.get(d.leaderName) ?? null;
    return null;
  };

  // 统一 person key：内部 = 名册员工记录（employeeId 优先），外部 = 原 key（id 优先）。
  // kindByPerson 记录该「人」是否为「正职内部负责人」（主口径分子）。同一人既是某部门正职、又兼任他处
  // 副职/挂名时，以「正职内部」为准（不会因副职角色被降级为外部）。
  const kindByPerson = new Map<string, 'internal' | 'external'>();
  const deptCountByPerson = new Map<string, number>();
  let vacantLeaderDepts = 0;
  for (const d of allDepts) {
    const lt: LeaderType = d.leaderType ?? 'owner';
    if (lt === 'vacant') {
      vacantLeaderDepts += 1;
      continue;
    }
    if (!d.leaderId && !d.leaderName) continue;
    const empHit = resolveLeader(d);
    const personKey = empHit ? `emp:${empHit.employeeId || empHit.id}` : `ext:${d.leaderId || d.leaderName}`;
    if (lt === 'owner') {
      // 正职：能命中名册 → 内部（分子）；否则外部（仅展示）。
      if (!kindByPerson.has(personKey)) {
        kindByPerson.set(personKey, empHit ? 'internal' : 'external');
      }
    } else {
      // deputy / acting / external：仅展示，不计分子（除非该人同时为正职内部，则保持内部）。
      if (kindByPerson.get(personKey) !== 'internal') {
        kindByPerson.set(personKey, 'external');
      }
    }
    deptCountByPerson.set(personKey, (deptCountByPerson.get(personKey) ?? 0) + 1);
  }

  let internalManagers = 0;
  let externalManagers = 0;
  for (const kind of kindByPerson.values()) {
    if (kind === 'internal') internalManagers += 1;
    else externalManagers += 1;
  }
  const multiDeptManagers = [...deptCountByPerson].filter(
    ([key, n]) => n >= 2 && kindByPerson.get(key) === 'internal',
  ).length;

  return {
    internalManagers,
    externalManagers,
    multiDeptManagers,
    totalEmployees,
    nonManagerEmployees: Math.max(totalEmployees - internalManagers, 0),
    vacantLeaderDepts,
  };
}

/**
 * v2.0.9 管理幅度灯号：中位数主判 + 极值升级（Captain 裁决）。
 * - 基础：spanStatus(median, thresholds)，阈值区间（spanHealthyMin~spanHealthyMax）不变；
 * - 极值升级：max > spanWarnMax → 至少「关注」；max ≥ spanWarnMax × 1.5 → 「预警」。
 *   使「一个 40 人直管部门不再被窄部门抹平」——L2 聚合看中位数，极值单独兜底。
 */
export function spanStatusWithBreakdown(b: SpanBreakdown, t: HealthThresholds): HealthStatus {
  if (b.count === 0 || b.median === null) return 'warn';
  let status = spanStatus(b.median, t);
  if (b.max !== null && b.max > t.spanWarnMax) {
    status = b.max >= t.spanWarnMax * 1.5 ? 'danger' : worseStatus(status, 'warn');
  }
  return status;
}

/**
 * v2.0.9 层级深度灯号（Captain 裁决）：P90 主判 + 孤立深链升级 + max 硬上限。
 * - 主判：p90 ≤ depthHealthyMax 健康 / ≤ depthWarnMax 关注 / > 预警（阈值沿用，不变）；
 * - 孤立深链升级：max > depthWarnMax → 至少「关注」（即使 P90 健康）；
 * - 硬上限：max > depthWarnMax + 2 → 「预警」（单条过深链路本身是治理信号）。
 */
export function depthStatusWithBreakdown(b: DepthBreakdown, t: HealthThresholds): HealthStatus {
  if (b.deptCount === 0) return 'warn';
  let status = depthStatus(b.p90, t);
  if (b.max > t.depthWarnMax) status = worseStatus(status, 'warn');
  if (b.max > t.depthWarnMax + 2) status = 'danger';
  return status;
}

/** v2.0.9 管理者比判读文案（主口径 + 辅助口径 + 外部/副职/兼岗/空缺留痕） */
function managerRatioVerdictText(status: HealthStatus, b: ManagerBreakdown): string {
  const base =
    status === 'healthy'
      ? '管理者占比合理'
      : status === 'warn'
        ? '管理者占比偏高，注意成本/官僚倾向'
        : '管理者占比过高，存在头重脚轻';
  const parts: string[] = [];
  if (b.externalManagers > 0) parts.push(`外部/非正职负责人 ${b.externalManagers} 人已剔除`);
  if (b.multiDeptManagers > 0) parts.push(`兼任多部门负责人 ${b.multiDeptManagers} 人已去重`);
  if (b.vacantLeaderDepts > 0) parts.push(`${b.vacantLeaderDepts} 个部门负责人空缺`);
  const per =
    b.nonManagerEmployees > 0 && b.internalManagers > 0
      ? Math.round(b.nonManagerEmployees / b.internalManagers)
      : null;
  if (per !== null) parts.push(`约 ${per} 名非管理员工配 1 名管理者`);
  return parts.length > 0 ? `${base}（${parts.join('；')}）` : base;
}

/**
 * 计算 L2 四项指标。
 * 口径（v2.0.9 修正，Captain 裁决定案）：
 * - 管理幅度 = 有负责人部门「直管人数」的中位数（直管 = 节点直挂 IC + 下一层有负责人子部门数）；
 *   主判中位数 + 极值升级（max > spanWarnMax → 至少关注；≥ ×1.5 → 预警）。
 * - 层级深度 = 部门节点深度分布（根 L1=1）的 P90 主判 + 孤立深链升级 + max 硬上限；
 *   展示 max / P50 / P90 与最深链定位。
 * - 管理者比 = 内部负责人数（去重、剔除外部、只计 leaderType==='owner'）÷ 员工总数（含管理者、非虚拟）× 100；
 *   副职/代理/外部挂名不计分子（v2.1.1 leaderType 精确化）。
 * - 空岗率 = 空缺职位数 ÷ 编制总数（编制经 deptHeadcount 读取；未填则跳过 → null）。
 * 所有阈值为「默认阈值」，可在分析面板标注"可后续调"（阈值结构不变）。
 * @param roots 作用域根部门列表（聚焦单个 L1 时传入 [该部门]）
 */
export function computeL2(roots: Department[], thresholds: HealthThresholds = getHealthThresholds()): L2Metric[] {

  // —— 管理幅度（v2.0.9：中位数主判 + 极值升级 + 直管口径修正）——
  const spanBreakdown = computeSpanBreakdown(roots);
  let span: number | null = null;
  let spanStatusVal: HealthStatus = 'warn';
  let spanVerdict = '无法计算管理幅度（未设置部门负责人）';
  if (spanBreakdown.count > 0 && spanBreakdown.median !== null) {
    const median = spanBreakdown.median;
    const max = spanBreakdown.max ?? median;
    span = median;
    spanStatusVal = spanStatusWithBreakdown(spanBreakdown, thresholds);
    const maxEscalated = spanBreakdown.max !== null && spanBreakdown.max > thresholds.spanWarnMax;
    if (spanStatusVal === 'healthy') {
      spanVerdict = `典型直管 ${median} 人（中位数），管理幅度适中；最宽 ${max} 人，无失控单点`;
    } else if (spanStatusVal === 'warn') {
      spanVerdict = maxEscalated
        ? `典型直管 ${median} 人（中位数）；最宽 ${max} 人已超出关注上限，存在单点失衡风险`
        : `典型直管 ${median} 人，幅度偏窄/偏宽，建议优化汇报线`;
    } else {
      spanVerdict = `典型直管 ${median} 人，管理幅度失衡；最宽 ${max} 人存在失控/冗余风险`;
    }
  }

  // —— 层级深度（v2.0.9：P90 主判 + 孤立深链升级 + max 硬上限；value 展示 P90）——
  const depthBreakdown = computeDepthBreakdown(roots);
  const depth = depthBreakdown.p90;
  const depthStatusVal = depthStatusWithBreakdown(depthBreakdown, thresholds);
  const depthVerdict =
    depthBreakdown.deptCount === 0
      ? '暂无部门数据，无法评估层级深度'
      : depthStatusVal === 'healthy'
        ? `层级精简（最深 ${depthBreakdown.max} 层）；典型 P50=${depthBreakdown.p50} 层，P90=${depthBreakdown.p90} 层`
        : depthStatusVal === 'warn'
          ? `最深 ${depthBreakdown.max} 层，典型 P50=${depthBreakdown.p50}/P90=${depthBreakdown.p90} 层；偏深主要来自个别深链，建议定位最深链路部门`
          : `层级过深（最深 ${depthBreakdown.max} 层）；典型 P50=${depthBreakdown.p50}/P90=${depthBreakdown.p90} 层，最深链路位于 ${depthBreakdown.deepestPath.join(' → ')}，建议压缩`;

  // —— 管理者比（v2.0.9：剔除外部 + 统一去重 + 暴露兼岗；分母含管理者，辅助口径展示）——
  const managerBreakdown = computeManagerBreakdown(roots);
  const totalEmployees = managerBreakdown.totalEmployees;
  let managerRatio: number | null = null;
  let managerRatioStatusVal: HealthStatus = 'warn';
  let managerRatioVerdict = '无法计算管理者比（无员工数据）';
  if (totalEmployees > 0) {
    managerRatio = round1((managerBreakdown.internalManagers / totalEmployees) * 100);
    managerRatioStatusVal = managerRatioStatus(managerRatio, thresholds);
    managerRatioVerdict = managerRatioVerdictText(managerRatioStatusVal, managerBreakdown);
  }

  // 空岗率（口径对齐 v2.0.8 / v2.1.1）：分子 = 已配置编制部门的编制合计；分母 = 同批已配置编制部门子树内的员工数（不含虚拟兼岗）。
  // 编制统一经 deptHeadcount 读取（优先岗位聚合、回退部门冗余派生），保证 v1→v2 迁移后部门级数字不变。
  // 未配置编制的部门不进分子也不进分母，避免分母虚大压低空岗率。
  // 覆盖判定：某部门或其任一祖先已配置有效编制，则其子树整体计入“已配置”分母（父子同配不重复计）。
  const coverage = headcountCoverage(roots);
  const headcount = coverage.headcount ?? 0;
  const configuredActual = coverage.actual;
  const foundHeadcount = coverage.headcount !== null;
  let vacancy: number | null = null;
  let vacancyStatusVal: HealthStatus = 'warn';
  let vacancyVerdict = '未配置编制数据，无法计算空岗率';
  if (foundHeadcount && headcount > 0) {
    const gap = headcount - configuredActual;
    vacancy = round1((gap / headcount) * 100);
    if (gap < 0) {
      // v2.3.1（F-01）：超编时 gap<0 → 旧实现把负值送进 vacancyStatus(rate <= 10) → 恒 healthy，
      // 判读还写成「编制基本满编」，与同屏 L1/L3 的 overStatus 判定方向相反。
      // 超编必须走超编梯度口径（与 deptStatus 完全一致）。
      vacancyStatusVal = overStatus(Math.abs(gap) / Math.max(configuredActual, 1), thresholds);
      vacancyVerdict =
        vacancyStatusVal === 'danger'
          ? '实际人数已超出编制，超编明显；请通过内部转岗或编制调整处理'
          : '实际人数已超出编制，需关注';
    } else {
      vacancyStatusVal = vacancyStatus(vacancy, thresholds);
      vacancyVerdict =
        vacancyStatusVal === 'healthy'
          ? '编制基本满编'
          : vacancyStatusVal === 'warn'
            ? '空岗率偏高，关注招聘节奏'
            : '空岗严重，影响业务交付';
    }
  } else {
    // v2.3.1（F-05）：区分「编制全部冻结」与「从未配置编制」——旧实现一律报「未配置编制，请补充」，
    // 与岗位级 headcountStatus='frozen' 的口径互相矛盾。
    const frozenDepts = countFrozenDepts(roots);
    if (frozenDepts > 0) {
      vacancyVerdict = `编制全部处于冻结状态（${frozenDepts} 个部门），本期不计缺口；如需评估请先解除冻结或补充有效编制`;
    }
  }

  return [
    {
      key: 'span',
      label: '管理幅度',
      value: span,
      unit: '人',
      status: spanStatusVal,
      verdict: spanVerdict,
      spanBreakdown,
    },
    {
      key: 'depth',
      label: '层级深度',
      value: depth,
      unit: '层',
      status: depthStatusVal,
      verdict: depthVerdict,
      depthBreakdown,
    },
    {
      key: 'managerRatio',
      label: '管理者比',
      value: managerRatio,
      unit: '%',
      status: managerRatioStatusVal,
      verdict: managerRatioVerdict,
      managerBreakdown,
    },
    { key: 'vacancy', label: '空岗率', value: vacancy, unit: '%', status: vacancyStatusVal, verdict: vacancyVerdict },
  ];
}

/** 计算树的层级深度（根为 1，逐层 +1） */
export function computeTreeDepth(roots: Department[]): number {
  if (roots.length === 0) return 0;
  const walk = (dept: Department): number => {
    if (dept.children.length === 0) return 1;
    return 1 + Math.max(...dept.children.map(walk));
  };
  return Math.max(...roots.map(walk));
}

/** —— —— v2.0.8：诊断口径说明（来自 HR 审计） —— —— */

/** 诊断指标 key（复用 L2 指标 key） */
export type DiagnosticMetricKey = L2Metric['key'];

/**
 * 各诊断指标的口径说明：怎么算 / 含或不含哪些数据 / 不等于什么。
 * 供 UI 展开「口径说明」使用；文案来自 HR 审计。
 */
export const METRIC_CALIBER_NOTES: Record<DiagnosticMetricKey, string> = {
  span: '管理幅度 = 有负责人部门「直管人数」的中位数（直管 = 节点直挂员工 **不含负责人本人** + 下一层有负责人子部门数）。中位数对极端值稳健，均值（仅作参考）不再主导判定；另展示最小/最大与部门级明细，最宽的部门单独标出、单点失衡不会被其它窄部门抹平。未设负责人的部门不参与统计，其缺失另见「负责人无人直管/未配置负责人」提示。',
  depth: '层级深度 = 部门节点深度分布（根 L1=1）的 P90 为主判（代表「大多数部门在第几层」），同时给出 P50 典型深度、最大层数与最深链路的部门定位。最大层数只代表最坏链，不代表大多数部门；孤立深链会触发至少「关注」、超过硬上限触发「预警」。深链（零售/医院/教育）可能正是业务所需，别据此一律压层。',
  managerRatio: '管理者比 = 内部负责人数（按真人同一键去重、剔除外部/非正职负责人，只计 leaderType==="owner"）÷ 员工总数（**同样按真人同一键去重**、含管理者、不含虚拟兼岗）。副职/代理/外部挂名负责人由 leaderType 精确剔除、不计分子仅展示；负责人空缺的部门会单独提示。另附「非管理者口径」供对照（每 N 名非管理员工配 1 名管理者）。',
  vacancy: '空岗率 =（有效编制 − 实际）÷ 有效编制。只统计配置了编制的部门（有效编制 = 岗位状态正常且编制 > 0；部门级冗余 headcount 仅作过渡兼容）；编制未填时提示「未配置编制数据」而非视为健康，**编制冻结时单独提示「编制冻结、本期不计缺口」**，两者不混为一谈。实际人数与编制按同一范围、按真人内部 ID 去重。**当实际人数超出编制时，空岗率为负，此时改按超编梯度判读（超标 >20% 预警），不会因为「负值 ≤ 10%」被误判为健康**。空岗可能是战略储备也可能是冗余，请结合业务确认；编制是否真实填写由 HR 复核。',
};

/** 取某指标口径说明。 */
export function metricCaliberNote(key: DiagnosticMetricKey): string {
  return METRIC_CALIBER_NOTES[key];
}

/** 整体诊断一句话 */
function summarizeDiagnosis(metrics: L2Metric[]): { red: number; yellow: number; green: number; overall: HealthStatus; diagnosis: string } {
  let red = 0;
  let yellow = 0;
  let green = 0;
  for (const m of metrics) {
    if (m.status === 'danger') red++;
    else if (m.status === 'warn') yellow++;
    else green++;
  }
  let overall: HealthStatus = 'healthy';
  if (red > 0) overall = 'danger';
  else if (yellow > 0) overall = 'warn';

  let diagnosis: string;
  if (red > 0) {
    diagnosis = `存在明显异常（${red} 项预警），建议优先治理。`;
  } else if (yellow > 0) {
    diagnosis = '整体健康，部分指标需持续关注。';
  } else {
    diagnosis = '整体健康度良好，组织结构稳健。';
  }
  return { red, yellow, green, overall, diagnosis };
}

/** —— L3 —— */

export function computeL3(roots: Department[], configs: LevelConfig[], thresholds: HealthThresholds = getHealthThresholds()): L3DeptRow[] {
  return flattenDepartments(roots).map((d) => {
    // v2.3.1（F-04）：actual 与 gap/status 同口径；否则同一行会出现
    // 「编制 3，实际 3，空岗率 33.3%」这类自相矛盾的表格与建议文案。
    const actual = rowActual(d);
    const headcount = sumHeadcountSubtree(d);
    const avgCost = avgCostSubtree(d, configs);
    const actualCost = round1(sumCostSubtree(d, configs));
    const gap = headcount === null ? null : headcount - headcountCoverage([d]).actual;
    // v2.3.1（F-11）：有缺口但找不到成本依据（无在岗人员且无职级成本映射）→ null（无法估算），
    // 不写成 0。旧实现把「不知道」印成「0w」，会进入可导出的诊断报告。
    const gapCost = gap === null || gap === 0 ? 0 : avgCost <= 0 ? null : round1(gap * avgCost);
    const status = deptStatus(headcount, headcountCoverage([d]).actual, thresholds);
    return {
      deptId: d.id,
      name: d.name,
      level: d.level,
      headcount,
      actual,
      gap,
      avgCost,
      actualCost,
      gapCost,
      status,
    };
  });
}

/** —— —— v2.1.1 岗位级编制/缺口/成本 —— —— */

/** 岗位级汇总单行（入口：全量岗位列表；assignedCount/gap/gapCost/status 均运行时派生，不进持久化） */
export interface PositionSummary {
  positionId: string;
  departmentId: string;
  name: string;
  /** 编制名额（本岗位可容纳人数） */
  headcount: number;
  /** 实际套岗人数（非虚拟员工 positionId 匹配本岗位） */
  assignedCount: number;
  /** 缺口 = headcount - assignedCount；frozen 或 headcount===0 → null（不计待补缺口） */
  gap: number | null;
  /** 岗位在岗平均月成本（套岗员工成本均值；无人 → 0） */
  avgCost: number;
  /** 缺口成本 = gap × 单位成本（levelBand 优先，其次 targetLevel 均值，回退在岗均值）；
   *  **找不到成本依据时为 null（无法估算），不写成 0**（v2.3.1 F-11） */
  gapCost: number | null;
  /** 缺口分级灯号：空岗按 vacancyStatus / 超编按 overStatus / 满编或 frozen → healthy */
  status: HealthStatus;
}

/** 岗位目标职级单位成本（估算每补一个缺口的月成本）：
 *  1) Position.levelBandMin/levelBandMax → costForLevel（带宽下限优先，代表入门级成本）；
 *  2) 该岗位套岗员工的 targetLevel → costForLevel 均值；
 *  3) 回退：该岗位当前在岗平均成本 avgCost（无部门上下文，用岗位级在岗均值近似「部门平均」）。 */
function positionUnitCost(pos: Position, assigned: Employee[], configs: LevelConfig[]): number {
  for (const code of [pos.levelBandMin, pos.levelBandMax]) {
    if (code) {
      const c = costForLevel(configs, code);
      if (c > 0) return c;
    }
  }
  const targetCosts = assigned
    .map((e) => (e.targetLevel ? costForLevel(configs, e.targetLevel) : 0))
    .filter((c) => c > 0);
  if (targetCosts.length > 0) {
    return round1(targetCosts.reduce((s, c) => s + c, 0) / targetCosts.length);
  }
  const actualCosts = assigned.map((e) => employeeCost(e, configs)).filter((c) => c > 0);
  return actualCosts.length > 0 ? round1(actualCosts.reduce((s, c) => s + c, 0) / actualCosts.length) : 0;
}

/**
 * 岗位级汇总（v2.1.1）：按每个岗位输出编制/在岗/缺口/成本，供「招聘缺口视图」与 L3 岗位展开消费。
 * - 只处理 active / frozen 岗位；archived（软删除）过滤；
 * - assignedCount 只计非虚拟员工（positionId === 本岗位 id），兼岗虚拟副本不计套餐；
 * - frozen 或 headcount<=0（= 未配置/冻结）→ gap=null（不计待补缺口、不判超编）、status=warn；
 * - 待补但找不到成本依据 → gapCost=null（无法估算，不写成 0，v2.3.1 F-11）；
 * - 其余 gap>0 按 vacancyStatus、gap<0 按 overStatus 分级。
 * @param positions 全量岗位扁平列表（Scenario.positions）
 * @param allEmployees 全量员工（非虚拟 + 兼岗虚拟副本；虚拟不计套岗）
 * @param configs 职级配置（成本映射）
 * @param thresholds 阈值（缺省当前配置，与其它 compute* 一致）
 */
export function computePositionSummary(
  positions: Position[],
  allEmployees: Employee[],
  configs: LevelConfig[],
  thresholds: HealthThresholds = getHealthThresholds(),
): PositionSummary[] {
  const assignedByPos = new Map<string, Employee[]>();
  for (const e of allEmployees) {
    if (e.isVirtual || !e.positionId) continue;
    const list = assignedByPos.get(e.positionId) ?? [];
    list.push(e);
    assignedByPos.set(e.positionId, list);
  }

  const out: PositionSummary[] = [];
  for (const p of positions) {
    if (p.status === 'archived') continue;
    const assigned = assignedByPos.get(p.id) ?? [];
    const assignedCount = assigned.length;
    const headcount = p.headcount;
    const frozen = p.status === 'frozen';
    // headcount<=0（= 编制未配置/冻结）或 frozen → gap=null：不计缺口、不判超编（即使 assignedCount>headcount）。
    const gap = frozen || headcount <= 0 ? null : headcount - assignedCount;
    const avgCost =
      assigned.length > 0 ? round1(assigned.reduce((s, e) => s + employeeCost(e, configs), 0) / assigned.length) : 0;
    // v2.3.1（F-11）：待补但找不到成本依据 → null（「无法估算」），不写成 0。
    // 与缺口清单链路（boardScope.buildPositionRows）保持同一语义：gapCost === null ⇔ 无法估算。
    let gapCost: number | null = 0;
    if (gap !== null && gap > 0) {
      const unit = positionUnitCost(p, assigned, configs);
      gapCost = unit > 0 ? round1(gap * unit) : null;
    }
    const status: HealthStatus =
      gap === null
        ? 'warn' // headcount<=0 / frozen → 未配置/冻结，不计缺口 → 关注（与部门级未配置编制口径一致）
        : gap > 0
          ? vacancyStatus((gap / headcount) * 100, thresholds)
          : gap < 0
            ? overStatus(Math.abs(gap) / Math.max(assignedCount, 1), thresholds)
            : 'healthy'; // gap === 0 → 满编/placed
    out.push({
      positionId: p.id,
      departmentId: p.departmentId,
      name: p.name,
      headcount,
      assignedCount,
      gap,
      avgCost,
      gapCost,
      status,
    });
  }
  return out;
}

/** —— 主入口 —— */

/** computeHealthReport 的范围选项（v2.3.1 F-06 新增）。 */
export interface HealthScopeOptions {
  /**
   * 仅统计 focusDeptId 自身，不包含其下级（默认 false = 含下级）。
   * v2.3.1 之前看板的「含下级 / 仅直属」切换只作用于看板汇总与明细，
   * 组织指标（L1/L2/L3）始终按下钻部门整棵子树计算 → 同一屏两套口径。
   */
  includeChildren?: boolean;
}

export function computeHealthReport(
  depts: Department[],
  configs: LevelConfig[],
  focusDeptId?: string,
  thresholds: HealthThresholds = getHealthThresholds(),
  options: HealthScopeOptions = {},
): HealthReport {
  let scope = depts;
  if (focusDeptId) {
    const target = findDept(depts, focusDeptId);
    // v2.3.1（F-06）：focusDeptId 未命中时旧实现**静默回退全公司**，
    // 导致「范围里没有数据」被显示成「全公司指标」。现在按空范围处理（口径诚实）。
    scope = target
      ? options.includeChildren === false
        ? [{ ...target, children: [] }]
        : [target]
      : [];
  }

  const l1 = computeL1(scope, thresholds);
  const l2 = computeL2(scope, thresholds);
  const summaryAgg = summarizeDiagnosis(l2);
  const l3 = computeL3(scope, configs, thresholds);

  // 汇总从原始人员去重计算，不能相加包含子树的展示行。
  const employees = new Map(flattenDepartments(scope).flatMap((d) => d.employees).filter((e) => !e.isVirtual).map((e) => [e.id, e]));
  const totalEmployees = employees.size;
  const configuredHeadcount = l1.filter((row) => row.headcount !== null).length;
  const coverage = headcountCoverage(scope);
  const totalGap = coverage.headcount === null ? null : coverage.headcount - coverage.actual;
  const totalCost = round1([...employees.values()].reduce((sum, emp) => sum + employeeCost(emp, configs), 0));

  const totals: ReportTotals = {
    totalEmployees,
    totalDepartments: flattenDepartments(scope).length,
    totalGap,
    totalHeadcount: coverage.headcount,
    totalCost,
    configuredHeadcount,
  };

  return {
    scopeDeptId: focusDeptId,
    l1,
    l2,
    summary: { ...summaryAgg },
    l3,
    totals,
  };
}

// —— 组织优化建议（v2.0.3 P1-3，纯函数可测） ——

export type SuggestionSeverity = 'critical' | 'major' | 'minor' | 'info';

export interface HealthSuggestion {
  id: string;
  severity: SuggestionSeverity;
  /** 关联指标 key（dept 级建议可能无） */
  metricKey?: L2Metric['key'] | 'headcount';
  /** 关联部门 id（可选；dept 级建议有值） */
  deptId?: string;
  /** 关联部门名 */
  deptName?: string;
  title: string;
  detail: string;
}

/** 按优先级排序建议（critical > major > minor > info） */
const SEVERITY_ORDER: Record<SuggestionSeverity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  info: 3,
};

/**
 * 基于 L2 指标生成「指标级」优化建议（纯函数，可测）。
 * 只对非健康（warn/danger）指标产出可执行建议，健康指标自动跳过。
 * @param metrics computeL2 的返回值
 */
export function generateSuggestions(metrics: L2Metric[]): HealthSuggestion[] {
  const out: HealthSuggestion[] = [];
  const push = (m: L2Metric, title: string, detail: string, severity: SuggestionSeverity) => {
    out.push({ id: `m-${m.key}`, severity, metricKey: m.key, title, detail });
  };

  for (const m of metrics) {
    if (m.status === 'healthy') continue;
    const sev: SuggestionSeverity = m.status === 'danger' ? 'critical' : 'major';
    switch (m.key) {
      case 'span':
        push(
          m,
          '优化管理幅度',
          m.value === null
            ? '当前未设置部门负责人，无法评估管理幅度。建议为关键部门配置负责人，明确汇报线。'
            : m.status === 'danger'
              ? `当前管理幅度（中位数）${m.value} 人，明显失衡。建议拆分过宽部门或合并过窄小组，使每名经理直管 ${DEFAULT_HEALTH_THRESHOLDS.spanHealthyMin}-${DEFAULT_HEALTH_THRESHOLDS.spanHealthyMax} 人。`
              : `当前管理幅度（中位数）${m.value} 人，偏离最佳区间。建议优化汇报线，适当调整管理层级。`,
          sev,
        );
        break;
      case 'depth':
        push(
          m,
          m.value === 0 ? '补充组织数据' : '推进组织扁平化',
          m.value === 0
            ? '当前没有部门数据，无法评估层级。请先导入或创建组织架构。'
            : m.status === 'danger'
              ? `典型层级深度（P90）${m.value} 层，最深 ${m.depthBreakdown?.max ?? m.value} 层，决策链路过长。建议压缩中间层级，缩短决策半径。`
              : `典型层级深度（P90）${m.value} 层，偏深。可考虑合并同层级小组或减少冗余汇报层。`,
          sev,
        );
        break;
      case 'managerRatio':
        push(
          m,
          '优化管理岗配置',
          m.value === null
            ? '当前无员工数据，无法评估管理者占比。'
            : m.status === 'danger'
              ? `内部管理者占比达 ${m.value}%，头重脚轻。建议精简管理岗或扩大基层。`
              : `内部管理者占比 ${m.value}%，偏高。注意控制成本与官僚化倾向。`,
          sev,
        );
        break;
      case 'vacancy':
        push(
          m,
          '关注招聘节奏',
          m.value === null
            ? '当前未配置编制，无法计算空岗率。建议为部门录入编制人数。'
            : m.status === 'danger'
              ? `空岗率达 ${m.value}%，严重缺编。建议优先补齐关键岗位。`
              : `空岗率 ${m.value}%，偏高。建议规划招聘节奏，及时补充人力。`,
          sev,
        );
        break;
    }
  }
  return out;
}

/**
 * 基于部门树生成「部门级」优化建议（纯函数，可测）。
 * 联动 computeL3 拿到编制/缺口/成本，并补充管理幅度（直管人数）失衡判断，
 * 可精确到部门名，给出可执行动作。
 * @param departments 组织树
 * @param thresholds 阈值配置（缺省用当前配置）
 */
export function generateDeptSuggestions(
  departments: Department[],
  thresholds: HealthThresholds = getHealthThresholds(),
): HealthSuggestion[] {
  const out: HealthSuggestion[] = [];
  const rows = computeL3(departments, [], thresholds);
  const deptMap = new Map(flattenDepartments(departments).map((d) => [d.id, d]));

  for (const row of rows) {
    const dept = deptMap.get(row.deptId);

    // 管理幅度：有负责人的部门，直管人数失衡才建议（v2.0.9 统一改用 directReports，
    // 与 L2 中位数口径一致：直管 = 节点直挂 IC + 下一层有负责人子部门数）
    if (dept && (dept.leaderId || dept.leaderName)) {
      const direct = directReports(dept);
      if (direct === 0) {
        out.push({
          id: `d-${row.deptId}-span0`,
          severity: 'critical',
          metricKey: 'span',
          deptId: row.deptId,
          deptName: row.name,
          title: `${row.name} 负责人无人直管`,
          detail: '该部门设置了负责人但无直属员工，存在虚设管理岗或职责不明风险，建议明确下属或调整编制。',
        });
      } else if (direct < thresholds.spanHealthyMin) {
        out.push({
          id: `d-${row.deptId}-spannarrow`,
          severity: 'major',
          metricKey: 'span',
          deptId: row.deptId,
          deptName: row.name,
          title: `${row.name} 管理幅度偏窄（${direct} 人）`,
          detail: `负责人仅直接管理 ${direct} 名下属（建议 ${thresholds.spanHealthyMin}-${thresholds.spanHealthyMax} 人）。建议合并相邻小团队，使管理幅度回到健康区间。`,
        });
      } else if (direct > thresholds.spanWarnMax) {
        out.push({
          id: `d-${row.deptId}-spanwide`,
          severity: 'critical',
          metricKey: 'span',
          deptId: row.deptId,
          deptName: row.name,
          title: `${row.name} 管理幅度过宽（${direct} 人）`,
          detail: `负责人直管 ${direct} 名下属，超出有效管理区间。建议增设管理岗并拆分小组，降低单点管理负荷。`,
        });
      } else if (direct > thresholds.spanHealthyMax) {
        out.push({
          id: `d-${row.deptId}-spanwide`,
          severity: 'major',
          metricKey: 'span',
          deptId: row.deptId,
          deptName: row.name,
          title: `${row.name} 管理幅度偏宽（${direct} 人）`,
          detail: `负责人直管 ${direct} 名下属，略超最佳区间。建议拆分小组或增设中层，优化管理质量。`,
        });
      }
    }

    // 空岗 / 超编 / 未配置编制
    if (row.gap != null && row.gap > 0) {
      const rate = row.headcount ? (row.gap / row.headcount) * 100 : 0;
      const sev: SuggestionSeverity =
        rate > thresholds.vacancyWarnMax ? 'critical' : rate > thresholds.vacancyHealthyMax ? 'major' : 'minor';
      out.push({
        id: `d-${row.deptId}-vacancy`,
        severity: sev,
        metricKey: 'vacancy',
        deptId: row.deptId,
        deptName: row.name,
        title: `${row.name} 存在 ${row.gap} 个空岗`,
        detail: `编制 ${row.headcount}，实际 ${row.actual}，空岗率 ${rate.toFixed(1)}%。建议优先补齐，${row.gapCost === null ? '当前无成本依据（无法估算缺口成本）' : `缺口成本约 ${row.gapCost}w`}。`,
      });
    } else if (row.gap != null && row.gap < 0) {
      const over = Math.abs(row.gap) / Math.max(row.actual, 1);
      const sev: SuggestionSeverity = over > thresholds.overWarnRatio ? 'critical' : 'major';
      out.push({
        id: `d-${row.deptId}-over`,
        severity: sev,
        metricKey: 'headcount',
        deptId: row.deptId,
        deptName: row.name,
        title: `${row.name} 超编 ${Math.abs(row.gap)} 人`,
        detail: `编制 ${row.headcount}，实际 ${row.actual}，超编占比 ${(over * 100).toFixed(1)}%。建议通过内部转岗或编制调整优化。`,
      });
    } else if (row.headcount == null) {
      // v2.3.1（F-05）：区分「编制冻结」与「未配置编制」，不再把冻结说成「未录入」。
      const status = dept ? deptHeadcountStatus(dept) : 'unconfigured';
      if (status === 'frozen') {
        out.push({
          id: `d-${row.deptId}-frozen`,
          severity: 'info',
          metricKey: 'headcount',
          deptId: row.deptId,
          deptName: row.name,
          title: `${row.name} 编制冻结`,
          detail: '该部门岗位编制已冻结，本期不计入待补缺口与超编判定；如需评估请先解除冻结。',
        });
      } else {
        out.push({
          id: `d-${row.deptId}-nohc`,
          severity: 'info',
          metricKey: 'headcount',
          deptId: row.deptId,
          deptName: row.name,
          title: `${row.name} 未配置编制`,
          detail: '未录入编制人数，空岗/超编分析被跳过。建议在健康度面板补充编制，以获得更完整判断。',
        });
      }
    }
  }

  return out.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.title.localeCompare(b.title, 'zh-CN'),
  );
}

/**
 * v2.3.2：层级断档建议（「某部门向上没有归属」）。
 *
 * 场景：员工信息表只填了一级和三级部门（二级留空）→ 三级部门直接挂在一级部门下。
 * 结构上成立，但通常意味着「缺一层管理归属」或「员工填表漏填」，需要被看见并可行动。
 *
 * 严重度取 `major` 而不是 `critical`：断档**可能是有意为之**（组织确实只有两层且列填在三级），
 * 所以它是「需确认」而不是「错误」。画布上的琥珀虚线 + 本建议构成同一条线索的两个入口。
 */
export function generateLevelGapSuggestions(departments: Department[]): HealthSuggestion[] {
  const out: HealthSuggestion[] = [];
  for (const gap of computeLevelGaps(departments).values()) {
    const missing = gap.missingLevels.length > 0
      ? `中间缺少 ${gap.missingLevels.map((l) => `L${l}`).join('、')} 部门，`
      : '';
    const where = gap.parentName ? `挂在 ${gap.parentName}（L${gap.parentLevel}）下` : '没有上级部门';
    out.push({
      id: `d-${gap.deptId}-levelgap`,
      severity: 'major',
      deptId: gap.deptId,
      deptName: gap.deptName,
      title: `${gap.deptName} 向上无归属（层级断档）`,
      detail: `${gap.deptName}（L${gap.level}）${where}，${missing}层级不连续。` +
        '建议核对员工表的部门列是否漏填中间层级；若确为有意设置，可忽略本提示（画布上该连线会显示为琥珀色虚线）。',
    });
  }
  return out;
}

/**
 * v2.3.2：职级配置覆盖率建议 —— 「名册里有、配置里没有」的职级必须被看见。
 *
 * 这些人的卡片颜色会回落成灰色、**成本按 0 计**（`costForLevel` 找不到就返回 0）、
 * 职级分布还会把他们单独分一档。旧实现三处全是静默降级，用户只会觉得"数字不对"。
 * 严重度取 `major`：它会直接改变成本与分布结论，但不是崩溃，也不该阻断使用。
 */
export function generateUnconfiguredLevelSuggestions(
  departments: Department[],
  levelConfigs: LevelConfig[],
): HealthSuggestion[] {
  const employees = flattenDepartments(departments).flatMap((d) => d.employees ?? []);
  const missing = findUnconfiguredLevels(employees, levelConfigs);
  if (missing.length === 0) return [];
  const total = missing.reduce((n, m) => n + m.count, 0);
  const detail = missing
    .map((m) => `${m.level}（${m.count} 人：${m.sampleNames.join('、')}${m.count > m.sampleNames.length ? ' 等' : ''}）`)
    .join('；');
  return [{
    id: 'level-unconfigured',
    severity: 'major',
    title: `有 ${total} 人的职级不在职级配置中（${missing.length} 种取值）`,
    detail:
      `${detail}。这些人的卡片颜色按灰色兜底、成本按 0 计、职级分布会被单独分成一档。` +
      '常见原因：职级字段里写了额外信息（如「L3.2Acting」把代理状态写进了职级）。' +
      '建议在「职级管理」里补一条同名职级，或把员工表里的职级规范成已有职级后重新导入。',
  }];
}

/** 合并指标级 + 部门级建议，并按优先级排序（供 HealthDrawer 直接消费）。 */
export function collectAllSuggestions(
  report: HealthReport,
  departments: Department[],
  thresholds: HealthThresholds = getHealthThresholds(),
  /** v2.3.2：职级配置，用于检测「名册里有、配置里没有」的职级（可选，缺省跳过该项） */
  levelConfigs?: LevelConfig[],
): HealthSuggestion[] {
  return [
    ...generateSuggestions(report.l2),
    ...generateDeptSuggestions(departments, thresholds),
    ...generateLevelGapSuggestions(departments),
    ...(levelConfigs ? generateUnconfiguredLevelSuggestions(departments, levelConfigs) : []),
  ].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.title.localeCompare(b.title, 'zh-CN'),
  );
}

/** —— v2.0.5：未入架构员工 & 员工职级差距 —— */

/** 解析职级码中的数字部分（如 'L1.1' → 1.1；'L5' → 5）。解析失败返回 null。
 *  v2.2.0：从 private 改为导出，供 competency.ts 的 benchmarkFor / positionBandRequirement 复用（不复制实现）。 */
export function parseLevelNumber(code: string): number | null {
  const num = code.replace(/^[A-Za-z]+/, '').trim();
  if (!num) return null;
  const n = Number.parseFloat(num);
  return Number.isFinite(n) ? n : null;
}

/** 员工职级差距灯（红黄绿）：targetLevel 相对当前 level 的差距。 */
export interface EmployeeLevelGap {
  comparable: boolean;
  current: number;
  target: number;
  /** target - current；正=当前低于目标（需提升） */
  gap: number;
  status: HealthStatus;
  label: string;
}

/**
 * 计算员工职级差距。仅当员工设置了 targetLevel 且可解析时返回非 null。
 * 跨度按数字部分计算（L1.1 vs L2.1 → gap 1）。status: 达到/超出(healthy) <1级(warn) ≥1级(danger)。
 */
export function employeeLevelGap(emp: Employee): EmployeeLevelGap | null {
  if (!emp.targetLevel) return null;
  const current = parseLevelNumber(emp.level);
  const target = parseLevelNumber(emp.targetLevel);
  if (current == null || target == null) return null;
  const gap = Math.round((target - current) * 10) / 10;
  const status: HealthStatus = gap <= 0 ? 'healthy' : gap <= 1 ? 'warn' : 'danger';
  const label = gap <= 0 ? '达到/超出目标' : gap <= 1 ? '接近目标' : '有明显差距';
  return { comparable: true, current, target, gap, status, label };
}

/** 计算未进入组织树（未挂载到任何部门员工列表）的员工。 */
export function computeUnassignedEmployees(allEmployees: Employee[], departments: Department[]): Employee[] {
  const placed = new Set<string>();
  const walk = (depts: Department[]) => {
    for (const d of depts) {
      for (const e of d.employees) placed.add(e.id);
      walk(d.children);
    }
  };
  walk(departments);
  return allEmployees.filter((e) => !e.isVirtual && !placed.has(e.id));
}
