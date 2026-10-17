import { DEFAULT_JOB_FAMILY_TYPES, DEFAULT_MANAGEMENT_RANGES, normalizeManagementRanges, isManagementType, type ManagementRanges, type ManagementStage, type ManagementType } from './managementBenchmarks';
export const REPORTING_COVERAGE_WARN = 0.95;
export const REPORTING_COVERAGE_MIN = 0.80;

export interface HealthThresholds {
  expansionSpanFactor?: number;
  expansionVacancyHealthyMax?: number;
  efficiencyManagerFactor?: number;
  efficiencyChainFactor?: number;
  successionHealthyMin?: number;
  successionWarnMin?: number;
  successionSampleMin?: number;
  /** v2.5.1 管理者梯队：近期可接后备人数 ÷ 管理岗数 ≥ healthy 健康；≥ warn 关注；其余预警。 */
  pipelineHealthyMin?: number;
  pipelineWarnMin?: number;
  /** v2.5.1 降本合并测算假设：toIC = 被合并经理转为专业岗，只节省管理溢价；leave = 本人离岗，节省全部成本。 */
  efficiencySavingsAssumption?: 'toIC' | 'leave';
  chainHealthyMax?: number;
  chainWarnMax?: number;
  managementStage?: ManagementStage;
  managementRanges?: ManagementRanges;
  jobFamilyTypes?: Record<string, ManagementType>;
  reportingCoverageWarn?: number;
  reportingCoverageMin?: number;
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
  expansionSpanFactor: 0.7, expansionVacancyHealthyMax: 15, efficiencyManagerFactor: 0.8, efficiencyChainFactor: 0.8,
  successionHealthyMin: 70, successionWarnMin: 50, successionSampleMin: 5,
  pipelineHealthyMin: 0.8, pipelineWarnMin: 0.5, efficiencySavingsAssumption: 'toIC',
  chainHealthyMax: 4, chainWarnMax: 5,
  managementStage: 'growth', managementRanges: DEFAULT_MANAGEMENT_RANGES, jobFamilyTypes: DEFAULT_JOB_FAMILY_TYPES,
  reportingCoverageWarn: REPORTING_COVERAGE_WARN,
  reportingCoverageMin: REPORTING_COVERAGE_MIN,
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

/** 文件导入与设置共用校验；不允许非法配置绕过覆盖率门槛。 */
export function normalizeHealthThresholds(raw: unknown): HealthThresholds {
  const result = { ...DEFAULT_HEALTH_THRESHOLDS };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    for (const key of Object.keys(result) as (keyof HealthThresholds)[]) {
      const value = record[key];
      if (typeof result[key] === 'number' && typeof value === 'number' && Number.isFinite(value) && value >= 0) (result as unknown as Record<string, unknown>)[key] = value;
    }
  }
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (source.managementStage === 'startup' || source.managementStage === 'growth' || source.managementStage === 'mature') result.managementStage = source.managementStage;
  result.managementRanges = normalizeManagementRanges(source.managementRanges);
  if (source.jobFamilyTypes && typeof source.jobFamilyTypes === 'object' && !Array.isArray(source.jobFamilyTypes)) {
    // v2.5.1 迁移：旧项目只保存了旧版默认映射，合并新默认后用户自定义仍优先。
    result.jobFamilyTypes = { ...DEFAULT_JOB_FAMILY_TYPES, ...Object.fromEntries(Object.entries(source.jobFamilyTypes).filter(([key, value]) => key.length > 0 && key.length < 100 && isManagementType(value))) };
  }
  if (result.successionHealthyMin! > 100 || result.successionWarnMin! > result.successionHealthyMin!) { result.successionHealthyMin = 70; result.successionWarnMin = 50; }
  result.successionSampleMin = Math.max(1, Math.ceil(result.successionSampleMin!));
  if (result.pipelineWarnMin! > result.pipelineHealthyMin!) { result.pipelineHealthyMin = 0.8; result.pipelineWarnMin = 0.5; }
  result.efficiencySavingsAssumption = source.efficiencySavingsAssumption === 'leave' ? 'leave' : 'toIC';
  if (result.chainHealthyMax! > result.chainWarnMax!) { result.chainHealthyMax = 4; result.chainWarnMax = 5; }
  for (const key of ['expansionSpanFactor', 'efficiencyManagerFactor', 'efficiencyChainFactor'] as const) {
    if (result[key]! > 1) result[key] = DEFAULT_HEALTH_THRESHOLDS[key];
  }
  if (result.expansionVacancyHealthyMax! > 100) result.expansionVacancyHealthyMax = 15;
  const min = result.reportingCoverageMin!;
  const warn = result.reportingCoverageWarn!;
  if (min > warn || warn > 1) {
    result.reportingCoverageMin = REPORTING_COVERAGE_MIN;
    result.reportingCoverageWarn = REPORTING_COVERAGE_WARN;
  }
  return result;
}
