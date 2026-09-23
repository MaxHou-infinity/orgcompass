import type { BoardDerivation, BoardPositionRow } from './boardScope';

/**
 * —— v2.3 M4：岗位缺口清单交付（契约 §7.2）——
 *
 * 单一派生：清单行只从 `deriveBoard` 的岗位结果生成，界面与 Excel 消费同一份数据
 * （A31：导出逐行对应界面和筛选范围）。
 *
 * 边界（§5.7 / §7.2）：
 * - 这是**编制缺口事实**，不是已批准招聘需求；不由红灯推导替换招聘，不生成「招聘中/已审批」；
 * - 待补与超额分别表达，不用净额抵消（A28）；
 * - 冻结、未配置编制、真实满编分别表达（A29）；
 * - 缺成本显示「无法估算」，不写成 0；汇总标为「已知部分」并给出缺失岗位数（A30）；
 * - 默认不含个人姓名、工号、个人薪酬明细、评分或复核依据。
 */

export type GapListStatusFilter = 'all' | 'pending' | 'overflow' | 'frozen' | 'unconfigured' | 'balanced';

export const GAP_LIST_FILTER_LABEL: Record<GapListStatusFilter, string> = {
  all: '全部岗位',
  pending: '有待补',
  overflow: '有超额',
  frozen: '编制冻结',
  unconfigured: '未配置编制',
  balanced: '真实满编',
};

/**
 * V2.4.0：暂不向用户提供的筛选项。
 *
 * `frozen`（编制冻结）——`Position.status = 'frozen'` 全仓**没有任何写入点**：
 * 唯一会写 status 的动作是「归档岗位」，而它只写 `'archived'`（新建/导入建岗一律 `'active'`）。
 * 因此这个筛选项对真实用户**永远匹配 0 行**，点进去只有空列表且不带解释 —— 属于误导性反馈
 * （用户实测确认：15 个岗位全部 active，筛「编制冻结」得 0 / 15）。
 *
 * 本次**只从界面隐藏**，不做任何数据层改动：
 * - `filterGapListRows(rows, 'frozen')`、`HEADCOUNT_STATUS_LABEL.frozen`、
 *   `summarizeGapList().frozenPositions` 与导出列全部保留，口径（frozen 不计缺口）不变；
 * - 待将来补上「冻结 / 解冻编制」的操作入口后，把这里清空即可恢复该筛选项。
 *
 * 背景（原始设计意图见 docs/v211-hr-value.md）：编制批了但被冻结（预算冻结 / 业务转型）时，
 * 岗位级会虚高缺口，导致招聘 BP 去招一个公司并不打算招的岗 —— 所以 frozen 必须不计缺口。
 * 该能力在 v2.1.1 建了模型、v2.3.x 建了展示与导出，**唯独漏了写入点**。
 */
export const GAP_LIST_HIDDEN_FILTERS: ReadonlySet<GapListStatusFilter> = new Set(['frozen']);

/** 界面实际提供的筛选项（顺序与 GAP_LIST_FILTER_LABEL 一致；导出与口径不受影响） */
export function gapListVisibleFilters(): GapListStatusFilter[] {
  return (Object.keys(GAP_LIST_FILTER_LABEL) as GapListStatusFilter[]).filter(
    (f) => !GAP_LIST_HIDDEN_FILTERS.has(f),
  );
}

const POSITION_STATUS_LABEL: Record<BoardPositionRow['status'], string> = {
  active: '正常',
  frozen: '编制冻结',
  archived: '已归档',
};

const HEADCOUNT_STATUS_LABEL: Record<BoardPositionRow['headcountStatus'], string> = {
  configured: '已配置',
  unconfigured: '未配置编制',
  frozen: '编制冻结',
};

/** 清单行（字段与 Excel 列一一对应；不含个人级别信息） */
export interface GapListRow {
  scenario: string;
  deptPath: string;
  position: string;
  /** 职级带宽（如 'L1 – L3'；未设 = '—'） */
  levelBand: string;
  /** 岗位状态（正常 / 编制冻结） */
  statusLabel: string;
  /** 编制配置状态（已配置 / 未配置编制 / 编制冻结） */
  headcountStatusLabel: string;
  headcount: number;
  primaryOccupied: number;
  secondaryRelations: number;
  /** 待补人数（净缺口为正部分） */
  pendingCount: number;
  /** 超额人数（净缺口为负部分） */
  overflowCount: number;
  /** 成本估算状态：已估算 / 无法估算 */
  costStatusLabel: string;
  /** 单位成本（万元/月）；无法估算 = null */
  unitCost: number | null;
  /** 该岗位缺口成本（万元/月）；无待补或缺依据 = null */
  gapCost: number | null;
  costBasis: string;
}

export interface GapListSummary {
  positionCount: number;
  /** 待补合计（各岗位正向缺口分别求和） */
  pendingTotal: number;
  /** 超额合计（各岗位超编分别求和） */
  overflowTotal: number;
  /** 净额：仅作补充，不以另一岗位超编抵消本岗位待补 */
  netTotal: number;
  pendingPositions: number;
  overflowPositions: number;
  frozenPositions: number;
  unconfiguredPositions: number;
  /** 已知缺口成本合计（万元/月） */
  knownCostTotal: number;
  knownCostPositions: number;
  /** 有待补但缺成本依据的岗位数 */
  costMissingPositions: number;
  /** 是否存在缺失 → 总额应标注「已知部分」 */
  costPartial: boolean;
}

function levelBandLabel(pos: BoardPositionRow): string {
  const { levelBandMin: min, levelBandMax: max } = pos;
  if (min && max) return min === max ? min : `${min} – ${max}`;
  return min ?? max ?? '—';
}

/** 由统一派生结果生成清单行（界面与导出共用）。 */
export function buildGapListRows(board: BoardDerivation, scenarioName: string): GapListRow[] {
  return board.positions.map((pos) => ({
    scenario: scenarioName,
    deptPath: pos.deptPath,
    position: pos.name,
    levelBand: levelBandLabel(pos),
    statusLabel: POSITION_STATUS_LABEL[pos.status],
    headcountStatusLabel: HEADCOUNT_STATUS_LABEL[pos.headcountStatus],
    headcount: pos.headcount,
    primaryOccupied: pos.primaryOccupied,
    secondaryRelations: pos.secondaryRelations,
    pendingCount: pos.pendingCount,
    overflowCount: pos.overflowCount,
    costStatusLabel: pos.costStatus === 'known' ? '已估算' : pos.pendingCount > 0 ? '无法估算' : '无待补缺口',
    unitCost: pos.unitCost,
    gapCost: pos.gapCost,
    costBasis: pos.costBasis,
  }));
}

/** 按岗位状态筛选（导出与界面用同一函数，保证逐行一致）。 */
export function filterGapListRows(rows: GapListRow[], filter: GapListStatusFilter): GapListRow[] {
  switch (filter) {
    case 'pending':
      return rows.filter((r) => r.pendingCount > 0);
    case 'overflow':
      return rows.filter((r) => r.overflowCount > 0);
    case 'frozen':
      return rows.filter((r) => r.headcountStatusLabel === HEADCOUNT_STATUS_LABEL.frozen);
    case 'unconfigured':
      return rows.filter((r) => r.headcountStatusLabel === HEADCOUNT_STATUS_LABEL.unconfigured);
    case 'balanced':
      return rows.filter((r) => r.headcountStatusLabel === HEADCOUNT_STATUS_LABEL.configured
        && r.pendingCount === 0 && r.overflowCount === 0);
    default:
      return rows;
  }
}

/** 缺口汇总：待补与超额分别求和；成本缺失显式标注，不写成 0。 */
export function summarizeGapList(rows: GapListRow[]): GapListSummary {
  const pendingRows = rows.filter((r) => r.pendingCount > 0);
  const costMissingPositions = pendingRows.filter((r) => r.gapCost === null).length;
  const knownCostPositions = pendingRows.filter((r) => r.gapCost !== null).length;
  return {
    positionCount: rows.length,
    pendingTotal: rows.reduce((s, r) => s + r.pendingCount, 0),
    overflowTotal: rows.reduce((s, r) => s + r.overflowCount, 0),
    netTotal: rows.reduce((s, r) => s + r.pendingCount - r.overflowCount, 0),
    pendingPositions: pendingRows.length,
    overflowPositions: rows.filter((r) => r.overflowCount > 0).length,
    frozenPositions: rows.filter((r) => r.headcountStatusLabel === HEADCOUNT_STATUS_LABEL.frozen).length,
    unconfiguredPositions: rows.filter((r) => r.headcountStatusLabel === HEADCOUNT_STATUS_LABEL.unconfigured).length,
    knownCostTotal: Math.round(rows.reduce((s, r) => s + (r.gapCost ?? 0), 0) * 10) / 10,
    knownCostPositions,
    costMissingPositions,
    costPartial: costMissingPositions > 0,
  };
}

export interface GapListMeta {
  projectName: string;
  scenarioName: string;
  scopeLabel: string;
  filterLabel: string;
  generatedAt: string;
}

/** 清单的统计口径说明（导出附页与界面共用文案，避免两处口径漂移）。 */
export const GAP_LIST_CALIBER: string[] = [
  '待补人数 = max(编制 − 主岗占用, 0)；超额人数 = max(主岗占用 − 编制, 0)。两者分别求和，净额只作补充。',
  '主岗占用 = 当前岗位有效主岗真人去重人数；兼岗通过虚拟副本回指真人，不占第二个编制名额。',
  '有效编制范围：岗位状态正常且编制 > 0。编制 0 = 未配置（不视为明确零编制）；编制冻结不计待补缺口。',
  '成本单位统一为万元/月；依据顺序：岗位职级带宽 → 在岗目标职级成本均值 → 在岗实际成本均值（降级须显式说明）。',
  '找不到成本依据时值为空并标注「无法估算」，不写成 0；部分岗位缺依据时总额标为「已知部分」并给出缺失岗位数。',
  '本清单是编制缺口事实，不是已批准招聘需求；不含个人姓名、工号、个人薪酬明细、评分或复核依据。',
];

export interface GapListExcelInput {
  rows: GapListRow[];
  summary: GapListSummary;
  meta: GapListMeta;
}

/** 导出用表格数据（纯数据，便于测试与复用）。 */
export function buildGapListTables(input: GapListExcelInput): {
  list: Record<string, string | number>[];
  meta: Record<string, string | number>[];
} {
  const list = input.rows.map((r) => ({
    场景: r.scenario,
    完整部门路径: r.deptPath,
    岗位: r.position,
    职级带宽: r.levelBand,
    岗位状态: r.statusLabel,
    编制配置状态: r.headcountStatusLabel,
    编制: r.headcount,
    主岗占用: r.primaryOccupied,
    兼岗关系数: r.secondaryRelations,
    待补人数: r.pendingCount,
    超额人数: r.overflowCount,
    成本估算状态: r.costStatusLabel,
    '估算值(万元/月)': r.unitCost ?? '', // 缺失保持空，不写成 0
    '缺口成本(万元/月)': r.gapCost ?? '',
    估算依据: r.costBasis,
  }));
  const s = input.summary;
  const meta: Record<string, string | number>[] = [
    { 项: '项目', 值: input.meta.projectName },
    { 项: '场景', 值: input.meta.scenarioName },
    { 项: '范围', 值: input.meta.scopeLabel },
    { 项: '筛选', 值: input.meta.filterLabel },
    { 项: '生成时间', 值: input.meta.generatedAt },
    { 项: '岗位数', 值: s.positionCount },
    { 项: '待补人数合计', 值: s.pendingTotal },
    { 项: '超额人数合计', 值: s.overflowTotal },
    { 项: '净额（仅补充，不用超编抵消待补）', 值: s.netTotal },
    { 项: '有待补岗位数', 值: s.pendingPositions },
    { 项: '有超额岗位数', 值: s.overflowPositions },
    { 项: '编制冻结岗位数', 值: s.frozenPositions },
    { 项: '未配置编制岗位数', 值: s.unconfiguredPositions },
    {
      项: '已知缺口成本合计(万元/月)',
      值: s.costPartial ? `${s.knownCostTotal}（已知部分，另有 ${s.costMissingPositions} 个岗位无法估算）` : s.knownCostTotal,
    },
    { 项: '可估算成本岗位数', 值: s.knownCostPositions },
    { 项: '无法估算成本岗位数', 值: s.costMissingPositions },
    ...GAP_LIST_CALIBER.map((line, i) => ({ 项: `口径 ${i + 1}`, 值: line })),
  ];
  return { list, meta };
}

/** 构建岗位缺口清单 Excel 字节。 */
export async function buildGapListExcelBytes(input: GapListExcelInput): Promise<Uint8Array> {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const tables = buildGapListTables(input);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tables.list), '岗位缺口清单');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tables.meta), '汇总与口径');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new Uint8Array(out as ArrayBuffer);
}
