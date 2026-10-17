import type { Department } from '../types';
import { deriveManagementLoads } from './management';

export type ManagementType = 'operational' | 'knowledge' | 'expert';
export type ManagementStage = 'startup' | 'growth' | 'mature';
export interface ManagementRange { min: number; max: number; warnMin: number; warnMax: number }
export type ManagementRanges = Record<ManagementStage, Record<ManagementType, ManagementRange>>;
export const MANAGEMENT_TYPE_LABELS = { operational: '操作型', knowledge: '知识型', expert: '专家型' } as const;
export const DEFAULT_JOB_FAMILY_TYPES: Record<string, ManagementType> = {
  客服: 'operational', 产线: 'operational', 门店: 'operational', 仓储: 'operational', 销售代表: 'operational',
  研发: 'knowledge', 技术: 'knowledge', 产品: 'knowledge', 设计: 'knowledge', 运营: 'knowledge', 市场: 'knowledge',
  法务: 'expert', 战略: 'expert', 投资: 'expert', 高级专家: 'expert',
};
/** 校准起点，不是行业标准；每个阶段/职能均可独立编辑。 */
export const DEFAULT_MANAGEMENT_RANGES: ManagementRanges = {
  startup: {
    operational: { min: 7, max: 28, warnMin: 3, warnMax: 38 },
    knowledge: { min: 3, max: 12, warnMin: 1, warnMax: 18 },
    expert: { min: 1, max: 7, warnMin: 0, warnMax: 11 },
  },
  growth: {
    operational: { min: 10, max: 25, warnMin: 5, warnMax: 35 },
    knowledge: { min: 5, max: 10, warnMin: 2, warnMax: 15 },
    expert: { min: 2, max: 6, warnMin: 1, warnMax: 10 },
  },
  mature: {
    operational: { min: 10, max: 22, warnMin: 5, warnMax: 30 },
    knowledge: { min: 5, max: 9, warnMin: 2, warnMax: 13 },
    expert: { min: 2, max: 5, warnMin: 1, warnMax: 8 },
  },
};
export function isManagementType(value: unknown): value is ManagementType {
  return value === 'operational' || value === 'knowledge' || value === 'expert';
}
export function managementLoadStatus(value: number, range: ManagementRange): 'healthy' | 'warn' | 'danger' {
  return value >= range.min && value <= range.max ? 'healthy' : value >= range.warnMin && value <= range.warnMax ? 'warn' : 'danger';
}
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null;
};
export function computeFunctionalSpans(roots: Department[], stage: ManagementStage = 'growth',
  ranges: ManagementRanges = DEFAULT_MANAGEMENT_RANGES, mapping: Record<string, ManagementType> = DEFAULT_JOB_FAMILY_TYPES) {
  const data = deriveManagementLoads(roots);
  const departments: Department[] = [];
  const walk = (list: Department[]) => list.forEach((d) => { departments.push(d); walk(d.children); });
  walk(roots);
  const positions = new Map(departments.flatMap((d) => d.positions ?? []).map((p) => [p.id, p]));
  let defaultedReports = 0;
  const managers = data.loads.map((load) => {
    const counts: Record<ManagementType, number> = { operational: 0, knowledge: 0, expert: 0 };
    const fallback = departments.find((d) => d.id === load.deptIds[0])?.defaultManagementType;
    for (const key of load.reports) {
      const employee = data.employeesByKey.get(key);
      const family = employee?.positionId ? positions.get(employee.positionId)?.jobFamily?.trim() : undefined;
      const departmentType = data.employeeDept.get(key)?.defaultManagementType ?? fallback;
      const type = family && mapping[family] ? mapping[family] : departmentType ?? 'knowledge';
      if ((!family || !mapping[family]) && !departmentType) defaultedReports++;
      counts[type]++;
    }
    // 同票优先部门默认；否则知识/操作/专家固定次序，不按部门名猜。
    const order: ManagementType[] = fallback ? [fallback, ...(['knowledge', 'operational', 'expert'] as ManagementType[]).filter((t) => t !== fallback)] : ['knowledge', 'operational', 'expert'];
    const type = order.reduce((best, next) => counts[next] > counts[best] ? next : best, order[0]);
    return { ...load, type, directReports: load.reports.size, range: ranges[stage][type], status: managementLoadStatus(load.reports.size, ranges[stage][type]) };
  });
  const types = (Object.keys(MANAGEMENT_TYPE_LABELS) as ManagementType[]).map((type) => {
    const rows = managers.filter((m) => m.type === type);
    const value = median(rows.map((m) => m.directReports));
    return { type, count: rows.length, median: value, healthyShare: rows.length ? rows.filter((m) => m.status === 'healthy').length / rows.length : null,
      range: ranges[stage][type], status: rows.length >= 3 && value !== null ? managementLoadStatus(value, ranges[stage][type]) : 'nodata' as const };
  });
  const ranks = { nodata: -1, healthy: 0, warn: 1, danger: 2 };
  const status = types.reduce<(typeof types)[number]['status']>((worst, row) => ranks[row.status] > ranks[worst] ? row.status : worst, 'nodata');
  return { managers, types, status, defaultedReports };
}

export function normalizeManagementRanges(raw: unknown): ManagementRanges {
  const result = structuredClone(DEFAULT_MANAGEMENT_RANGES);
  if (!raw || typeof raw !== 'object') return result;
  for (const stage of Object.keys(result) as ManagementStage[]) for (const type of Object.keys(result[stage]) as ManagementType[]) {
    const candidate = (raw as ManagementRanges)[stage]?.[type];
    if (candidate && ['min', 'max', 'warnMin', 'warnMax'].every((key) => typeof candidate[key as keyof ManagementRange] === 'number' && Number.isFinite(candidate[key as keyof ManagementRange]) && candidate[key as keyof ManagementRange] >= 0) &&
      candidate.warnMin <= candidate.min && candidate.min <= candidate.max && candidate.max <= candidate.warnMax) result[stage][type] = { min: candidate.min, max: candidate.max, warnMin: candidate.warnMin, warnMax: candidate.warnMax };
  }
  return result;
}
