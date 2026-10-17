import type { Department } from '../types';
import { deriveManagementLoads } from './management';

export type ManagementType = 'operational' | 'knowledge' | 'expert';
export type ManagementStage = 'startup' | 'growth' | 'mature';
export interface ManagementRange { min: number; max: number; warnMin: number; warnMax: number }
export type ManagementRanges = Record<ManagementStage, Record<ManagementType, ManagementRange>>;
export const MANAGEMENT_TYPE_LABELS = { operational: '操作型', knowledge: '知识型', expert: '专家型' } as const;
/** v2.5.1：与应用实际使用的岗位序列（岗位与编制页 JOB_FAMILIES）对齐，并保留常见细分写法。
 * - 操作型：销售（一线销售代表）、客服、门店、生产/产线、仓储、物流、护理（病区护理按班组排班）
 * - 知识型：技术/研发、产品、设计、运营、市场、数据、医疗、教学；
 *   职能（人力/财务/行政等共享服务）按知识型；管理（直属下属本身是管理者）按知识型 5–10 的“管理管理者”区间。
 * - 专家型：法务、战略、投资、专家/高级专家。
 * 未在映射中的序列不猜测：退回部门默认类型，仍无则暂按知识型并计入数据完整度。
 */
export const DEFAULT_JOB_FAMILY_TYPES: Record<string, ManagementType> = {
  销售: 'operational', 销售代表: 'operational', 客服: 'operational', 门店: 'operational', 生产: 'operational', 产线: 'operational',
  仓储: 'operational', 物流: 'operational', 护理: 'operational',
  技术: 'knowledge', 研发: 'knowledge', 产品: 'knowledge', 设计: 'knowledge', 运营: 'knowledge', 市场: 'knowledge', 数据: 'knowledge',
  医疗: 'knowledge', 教学: 'knowledge', 职能: 'knowledge', 管理: 'knowledge',
  法务: 'expert', 战略: 'expert', 投资: 'expert', 专家: 'expert', 高级专家: 'expert',
};
/** 岗位序列下拉选项（岗位与编制页、岗位弹窗共用），与默认映射保持一致。 */
export const JOB_FAMILY_OPTIONS = ['技术', '产品', '设计', '运营', '市场', '职能', '管理', '销售', '客服', '门店', '生产', '仓储', '护理', '医疗', '教学', '法务', '战略', '专家'] as const;
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
  const unmappedFamilies = new Set<string>();
  const managers = data.loads.map((load) => {
    const counts: Record<ManagementType, number> = { operational: 0, knowledge: 0, expert: 0 };
    const fallback = departments.find((d) => d.id === load.deptIds[0])?.defaultManagementType;
    for (const key of load.reports) {
      const employee = data.employeesByKey.get(key);
      const family = employee?.positionId ? positions.get(employee.positionId)?.jobFamily?.trim() : undefined;
      const departmentType = data.employeeDept.get(key)?.defaultManagementType ?? fallback;
      const type = family && mapping[family] ? mapping[family] : departmentType ?? 'knowledge';
      if (family && !mapping[family]) unmappedFamilies.add(family);
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
    const range = ranges[stage][type];
    const max = rows.length ? Math.max(...rows.map((m) => m.directReports)) : null;
    let status: 'healthy' | 'warn' | 'danger' | 'nodata' = rows.length >= 3 && value !== null ? managementLoadStatus(value, range) : 'nodata';
    // v2.5.1：单点幅度过宽不被中位数抹平——同类最宽者超过关注上限至少「关注」，≥1.5 倍上限「预警」（延续 v2.0.9 口径）。
    const overloaded = rows.filter((m) => m.directReports > range.warnMax);
    if (status !== 'nodata' && max !== null && max > range.warnMax) {
      const escalated = max >= range.warnMax * 1.5 ? 'danger' : 'warn';
      if (status === 'healthy' || (status === 'warn' && escalated === 'danger')) status = escalated;
    }
    return { type, count: rows.length, median: value, max, overloaded: overloaded.map((m) => ({ name: m.name, directReports: m.directReports })),
      healthyShare: rows.length ? rows.filter((m) => m.status === 'healthy').length / rows.length : null, range, status };
  });
  const ranks = { nodata: -1, healthy: 0, warn: 1, danger: 2 };
  const status = types.reduce<(typeof types)[number]['status']>((worst, row) => ranks[row.status] > ranks[worst] ? row.status : worst, 'nodata');
  return { managers, types, status, defaultedReports, unmappedFamilies: [...unmappedFamilies].sort() };
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
