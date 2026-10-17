import type { HealthThresholds } from './healthThresholds';
import { DEFAULT_MANAGEMENT_RANGES } from './managementBenchmarks';

export type BusinessContext = 'normal' | 'expansion' | 'efficiency' | 'integration' | 'incubation';
interface BusinessPolicy {
  label: string;
  /** 参与总评的指标（数据化配置）。focus 中出现但无阈值的参考指标（如管理者成本占比）由 referenceOnly 排除。 */
  focus: readonly string[]; spanMinFactor: number; managerFactor: number; chainFactor: number; vacancyFloor: number; advice: string;
  spanFactorKey?: keyof HealthThresholds; managerFactorKey?: keyof HealthThresholds; chainFactorKey?: keyof HealthThresholds; vacancyFloorKey?: keyof HealthThresholds;
}
export const BUSINESS_CONTEXTS: Record<BusinessContext, BusinessPolicy> = {
  normal: { label: '常态运营', focus: ['span', 'depth', 'managerRatio', 'vacancy', 'succession', 'gradeInversion'], spanMinFactor: 1, managerFactor: 1, chainFactor: 1, vacancyFloor: 0, advice: '结合职责核对组织结构与人员配置。' },
  expansion: { spanFactorKey: 'expansionSpanFactor', vacancyFloorKey: 'expansionVacancyHealthyMax', label: '快速扩张', focus: ['succession', 'vacancy', 'managerPipeline', 'span'], spanMinFactor: 0.7, managerFactor: 1, chainFactor: 1, vacancyFloor: 15, advice: '优先储备关键岗位、培养管理者梯队，保留合理扩张空间。' },
  efficiency: { managerFactorKey: 'efficiencyManagerFactor', chainFactorKey: 'efficiencyChainFactor', label: '降本增效', focus: ['managerRatio', 'depth', 'managerCost', 'span'], spanMinFactor: 1, managerFactor: 0.8, chainFactor: 0.8, vacancyFloor: 0, advice: '核对层级与管理负荷；仅在明确岗位、人员及成本假设后估算压缩收益。' },
  integration: { label: '并购整合', focus: ['gradeInversion', 'duplicatePositions', 'reportingConflicts'], spanMinFactor: 1, managerFactor: 1, chainFactor: 1, vacancyFloor: 0, advice: '先核对职级对齐、同名职能候选与汇报冲突，不自动认定岗位冗余。' },
  incubation: { label: '新业务孵化', focus: ['span', 'depth'], spanMinFactor: 0, managerFactor: 1, chainFactor: 1, vacancyFloor: 0, advice: '保持扁平并明确负责人；小团队不因幅度偏窄被要求增减管理层。' },
} as const;
export function isBusinessContext(value: unknown): value is BusinessContext {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BUSINESS_CONTEXTS, value);
}
export function effectiveBusinessThresholds(base: HealthThresholds, context: BusinessContext = 'normal'): HealthThresholds {
  const policy = BUSINESS_CONTEXTS[context];
  const configured = (key: keyof HealthThresholds | undefined, fallback: number) => key && typeof base[key] === 'number' ? base[key] as number : fallback;
  const spanFactor = configured(policy.spanFactorKey, policy.spanMinFactor);
  const managerFactor = configured(policy.managerFactorKey, policy.managerFactor);
  const chainFactor = configured(policy.chainFactorKey, policy.chainFactor);
  const vacancyFloor = configured(policy.vacancyFloorKey, policy.vacancyFloor);
  const ranges = structuredClone(base.managementRanges ?? DEFAULT_MANAGEMENT_RANGES);
  for (const stage of Object.values(ranges)) for (const range of Object.values(stage)) {
    range.min = Math.floor(range.min * spanFactor);
    range.warnMin = Math.floor(range.warnMin * spanFactor);
  }
  return { ...base, managementRanges: ranges,
    managerHealthyMax: base.managerHealthyMax * managerFactor, managerWarnMax: base.managerWarnMax * managerFactor,
    chainHealthyMax: Math.floor((base.chainHealthyMax ?? 4) * chainFactor), chainWarnMax: Math.floor((base.chainWarnMax ?? 5) * chainFactor),
    vacancyHealthyMax: Math.max(base.vacancyHealthyMax, vacancyFloor), vacancyWarnMax: Math.max(base.vacancyWarnMax, vacancyFloor) };
}
