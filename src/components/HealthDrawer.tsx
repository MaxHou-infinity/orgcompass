import { ScenarioCompareButton } from './ScenarioCompareButton';
import { SuccessionPanel, type PositionPlanPatch } from './SuccessionPanel';
import { ReportingChainsPanel } from './ReportingChainsPanel';
import { FunctionalSpanTable, ManagementSettings } from './FunctionalManagement';
import type { ManagementType } from '../utils/managementBenchmarks';
import { DEFAULT_MANAGEMENT_RANGES } from '../utils/managementBenchmarks';
import { ReportingQuality } from './ReportingQuality';
import { normalizeHealthThresholds, REPORTING_COVERAGE_WARN, REPORTING_COVERAGE_MIN } from '../utils/healthThresholds';

import { useMemo, useState, Fragment } from 'react';
import {
  Activity, Download, Building2, SlidersHorizontal, ChevronDown, ChevronRight,
  Briefcase, AlertTriangle, Sparkles, Gauge,
} from 'lucide-react';
import { Department, Scenario } from '../types';
import {
  computeHealthReport,
  HEALTH_STATUS_LABEL,
  HealthStatus,
  HealthThresholds,
  L2Metric,
  getHealthThresholds,
  setHealthThresholds,
  resetHealthThresholds,
  DEFAULT_HEALTH_THRESHOLDS,
  isHeadcountUnset,
  OrganizationStage,
  STAGE_PRESETS,
  getStagePresetThresholds,
  metricCaliberNote,
  PositionSummary,
} from '../utils/analytics';
import { STATUS_STYLE, fmt, fmtCost, fmtMetric, isMetricUnconfigured } from '../utils/statusUI';
import { useLevelConfigs } from '../utils/levels';
import { SubPageShell } from './SubPageShell';
import { OrganizationCostSummary } from './OrganizationCostSummary';

interface HealthPageProps {
  onDuplicateCurrentForComparison?: () => boolean | void;
  onUpdatePositionPlans?: (updates: PositionPlanPatch[]) => void;
  onDepartmentTypeChange?: (deptId: string, type?: ManagementType) => void;
  healthThresholds?: HealthThresholds;
  onHealthThresholdsChange?: (thresholds: HealthThresholds) => void;
  onFocusEmployee?: (employeeId: string, deptId: string) => void;
  /** V2.4.0：人岗核对问题（页面内呈现，不再占用主页面顶部） */
  placementIssues?: string[];
  unresolvedOverflow?: string[];
  open: boolean;
  onClose: () => void;
  departments: Department[];
  focusDeptId?: string;
  onClearFocus: () => void;
  onFocusDept: (deptId: string) => void;
  onUpdateHeadcount: (deptId: string, value: number) => void;
  /** v2.1.1：岗位级编制编辑（L3 部门→岗位展开行） */
  onSetPositionHeadcount?: (deptId: string, positionId: string, headcount: number) => void;
  /** v2.1.1：岗位级汇总（L3 岗位展开行消费） */
  positionSummaries?: PositionSummary[];
  onExportReport: () => void;
  currentScenarioName: string;
  /** 场景列表（用于「场景对比」入口可用性判断：≥2 场景才可点） */
  scenarios: Scenario[];
  onOpenScenarioDiff: () => void;
}

/**
 * v2.5.2：组织健康度页面重构（用户评审确认的四点）
 *
 * 1. 页面只呈现**可复算的事实与偏离**，不再给建议/结论 —— 建议只在「导出诊断报告」里，
 *    页面底部留 AI 深度分析位（后续由 AI 结合业务上下文给结论）。
 * 2. 「编制 vs 实际 vs 缺口」从页面最底部提到第 2 屏：用户先面对要修的数据，
 *    改完编制/成本，后面的指标立刻重算。
 * 3. 7 项指标由等高卡片改为**一张表**（异常置顶、可展开明细），解决卡片密度失衡。
 * 4. 业务场景（5 个）与企业阶段（3 档）合并为页脚「诊断基准」三档弹窗；
 *    原阈值面板折叠在弹窗的「高级」里，能力不丢但不占正文。
 */
const BASELINE_META: Record<OrganizationStage, { scale: string; fit: string }> = {
  startup: { scale: '团队 ≤ 50 人', fit: '适合：团队快速搭建、一人多岗、层级尚未固化。' },
  growth: { scale: '团队 50–200 人', fit: '适合：正在扩编、开始分层、岗位边界逐渐清晰。' },
  mature: { scale: '团队 200 人以上', fit: '适合：流程稳定、分工明确、更强调人效与成本。' },
};

const STATUS_ORDER: Record<HealthStatus, number> = { danger: 0, warn: 1, nodata: 2, healthy: 3 };

const round1 = (n: number) => Math.round(n * 10) / 10;

/** 管理幅度的可比区间按「知识型」呈现（当前组织的主要类型），与原型口径一致。 */
function spanRange(thresholds: HealthThresholds, stage: OrganizationStage) {
  const ranges = thresholds.managementRanges ?? DEFAULT_MANAGEMENT_RANGES;
  return ranges[stage]?.knowledge ?? ranges.growth.knowledge;
}

/** 指标事实表的「基准区间」列文案。 */
function baselineText(key: L2Metric['key'], thresholds: HealthThresholds, stage: OrganizationStage): string {
  const range = spanRange(thresholds, stage);
  switch (key) {
    case 'span': return `${range.min}–${range.max} 人（知识型）`;
    case 'depth': return `≤${thresholds.chainHealthyMax ?? 4} 层`;
    case 'managerRatio': return `≤${thresholds.managerHealthyMax}%`;
    case 'vacancy': return `≤${thresholds.vacancyHealthyMax}%`;
    case 'succession': return `≥${thresholds.successionHealthyMin ?? 70}%`;
    case 'managerPipeline': return `≥${thresholds.pipelineHealthyMin ?? 0.8} 人/岗`;
    case 'gradeInversion': return '0 对';
    default: return '—';
  }
}

/** 偏离方向：只陈述与当前基准的差值，不写「应该怎么办」。 */
function deviationFor(m: L2Metric, thresholds: HealthThresholds, stage: OrganizationStage): { text: string; tone: 'flat' | 'up' | 'down' } {
  if (m.value === null || m.status === 'nodata') return { text: '—', tone: 'flat' };
  const range = spanRange(thresholds, stage);
  switch (m.key) {
    case 'span': {
      if (m.value > range.max) return { text: `+${round1(m.value - range.max)} 人`, tone: 'up' };
      if (m.value < range.min) return { text: `−${round1(range.min - m.value)} 人`, tone: 'down' };
      return { text: '区间内', tone: 'flat' };
    }
    case 'managerRatio': {
      const max = thresholds.managerHealthyMax;
      return m.value > max ? { text: `+${round1(m.value - max)}pct`, tone: 'up' } : { text: '区间内', tone: 'flat' };
    }
    case 'depth': {
      const max = thresholds.chainHealthyMax ?? 4;
      return m.value > max ? { text: `+${round1(m.value - max)} 层`, tone: 'up' } : { text: '区间内', tone: 'flat' };
    }
    case 'vacancy': {
      const max = thresholds.vacancyHealthyMax;
      return m.value > max ? { text: `+${round1(m.value - max)}pct`, tone: 'up' } : { text: '区间内', tone: 'flat' };
    }
    case 'succession': {
      const min = thresholds.successionHealthyMin ?? 70;
      return m.value < min ? { text: `−${round1(min - m.value)}pct`, tone: 'down' } : { text: '区间内', tone: 'flat' };
    }
    case 'managerPipeline': {
      const min = thresholds.pipelineHealthyMin ?? 0.8;
      return m.value < min ? { text: `−${round1(min - m.value)}`, tone: 'down' } : { text: '区间内', tone: 'flat' };
    }
    case 'gradeInversion':
      return m.value > 0 ? { text: `+${m.value} 对`, tone: 'up' } : { text: '区间内', tone: 'flat' };
    default:
      return { text: '—', tone: 'flat' };
  }
}

function StatusDot({ status, label }: { status: HealthStatus; label?: string }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={`inline-flex items-center gap-1 ${s.text}`}>
      <span className={`w-2 h-2 rounded-full ${s.dot}`} />
      <span className="text-xs">{label ?? HEALTH_STATUS_LABEL[status]}</span>
    </span>
  );
}

/**
 * 部门编制状态点：未配置编制 → 中性灰「无数据」（不把缺失伪装成健康/异常结论），
 * 否则按缺口状态渲染。
 */
function DeptStatusDot({ status, headcount }: { status: HealthStatus; headcount: number | null }) {
  if (isHeadcountUnset(headcount)) {
    return (
      <span className="inline-flex items-center gap-1 text-slate-500" title="未配置编制，无法判断空岗/超编">
        <span className="w-2 h-2 rounded-full bg-slate-300" />
        <span className="text-xs">无数据</span>
      </span>
    );
  }
  return <StatusDot status={status} />;
}

/** 指标口径「?」说明：点击展开口径文案（怎么算的、含/不含哪些、不等于什么）。 */
function CaliberNote({ note }: { note: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex items-center">
      <button
        type="button"
        aria-label="指标口径说明"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        className="w-4 h-4 rounded-full bg-slate-200 hover:bg-slate-300 text-slate-500 grid place-items-center text-xs font-bold leading-none"
      >
        ?
      </button>
      {open && (
        <span className="absolute right-0 top-5 z-20 w-64 rounded-lg bg-white/95 backdrop-blur border border-slate-200 shadow-lg p-2.5 text-xs text-slate-600 leading-snug">
          {note}
        </span>
      )}
    </span>
  );
}

/** 管理幅度明细（中位数主值 + 极值 + 部门级直管分布，可展开定位） */
function SpanCardExtra({ m, thresholds, onFocusDept }: {
  m: L2Metric;
  thresholds: HealthThresholds;
  onFocusDept: (deptId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const b = m.spanBreakdown;
  if (!b || b.count === 0) return null;
  const widest = b.distribution[0];
  const widestManager = m.functionalSpans?.managers.find((manager) => manager.key === widest?.managerKey);
  const exceeded = m.status !== 'nodata' && (widestManager ? widestManager.status === 'danger' : b.max !== null && b.max > thresholds.spanWarnMax);
  return (
    <div className="mt-2">
      <div className="text-xs text-slate-500 leading-snug">
        极值 {fmt(b.min)}–{fmt(b.max)} 人 · {b.count} 名管理者（兼任已合并）
        {widest && (
          <span className={exceeded ? 'text-red-500 font-medium' : 'text-slate-500'}>
            {' '}· 最宽 {widest.deptName} {widest.directReports} 人{exceeded ? '（超出关注上限）' : ''}
          </span>
        )}
      </div>
      {b.distribution.length > 1 && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-1 text-xs text-indigo-500 hover:underline font-medium"
        >
          {open ? '收起直管分布 ▲' : '展开直管分布 ▼'}
        </button>
      )}
      {open && (
        <div className="mt-1.5 max-h-44 overflow-y-auto rounded-xl border border-slate-100 bg-white/60">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500 border-b border-slate-100 text-left">
                <th className="px-2.5 py-1.5 font-medium">部门</th>
                <th className="px-2 py-1.5 font-medium text-right">直管</th>
                <th className="px-2.5 py-1.5 font-medium text-right">判读</th>
              </tr>
            </thead>
            <tbody>
              {b.distribution.map((row) => {
                const range = m.functionalSpans?.managers.find((manager) => manager.key === row.managerKey)?.range;
                const label = m.status === 'nodata' ? '暂不判读' :
                  row.directReports === 0 ? '无人直管'
                    : row.directReports < (range?.min ?? thresholds.spanHealthyMin) ? '偏窄'
                      : row.directReports > (range?.warnMax ?? thresholds.spanWarnMax) ? '过宽'
                        : row.directReports > (range?.max ?? thresholds.spanHealthyMax) ? '偏宽'
                          : '适中';
                return (
                  <tr
                    key={row.managerKey ?? row.deptId}
                    onClick={() => onFocusDept(row.deptId)}
                    className="border-b border-slate-50 last:border-0 cursor-pointer hover:bg-indigo-50/60"
                    title="点击定位到画布"
                  >
                    <td className="px-2.5 py-1.5 text-slate-600">{row.managerName && <span className="font-medium">{row.managerName} · </span>}{row.deptName}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-700">{row.directReports}</td>
                    <td className={`px-2.5 py-1.5 text-right font-medium ${
                      label === '暂不判读' ? 'text-slate-500' : label === '过宽' || label === '无人直管'
                        ? 'text-red-500' : label === '偏窄' || label === '偏宽' ? 'text-amber-500' : 'text-emerald-500'
                    }`}>
                      {label}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** 汇报链明细：P50/P90/最深 + 最深链定位 */
function DepthCardExtra({ m, onFocusDept }: { m: L2Metric; onFocusDept: (deptId: string) => void }) {
  const b = m.depthBreakdown;
  if (!b || b.deptCount === 0) return null;
  return (
    <div className="mt-2 text-xs text-slate-500 leading-snug">
      <div>P50={b.p50} 层 · P90={b.p90} 层 · 最深 {b.max} 层 · {b.deptCount} 个部门</div>
      {b.deepestDeptId && (
        <button
          type="button"
          onClick={() => onFocusDept(b.deepestDeptId)}
          className="mt-1 block text-left text-indigo-500 hover:underline"
          title="点击定位到画布"
        >
          最深链：{b.deepestPath.join(' → ')}
        </button>
      )}
    </div>
  );
}

/** 管理者比明细：内部÷全员 + 正职/带人者 + IC:Mgr */
function ManagerCardExtra({ m }: { m: L2Metric }) {
  const b = m.managerBreakdown;
  if (!b) return null;
  const per = b.internalManagers > 0 ? round1(b.nonManagerEmployees / b.internalManagers) : null;
  const perRatio = b.nonManagerEmployees > 0 && b.internalManagers > 0
    ? Math.round((b.internalManagers / b.nonManagerEmployees) * 100) : null;
  return (
    <div className="mt-2 text-xs text-slate-500 leading-snug space-y-0.5">
      <div>内部 {b.internalManagers} ÷ {b.totalEmployees} 人（含管理者）= {fmt(m.value, '%')}</div>
      <div>正职负责人 {b.departmentOwners} 人 · 明确汇报关系中的带人者 {b.reportingManagers} 人（两类可重叠）</div>
      {per !== null && <div>IC:Mgr = {per}:1 · 样本 {b.totalEmployees} 人，阈值为当前配置，非行业标准</div>}
      {per !== null && perRatio !== null && <div>≈ 每 {per} 名非管理员工配 1 名管理者（非管理者口径 {perRatio}%）</div>}
      {(b.externalManagers > 0 || b.multiDeptManagers > 0) && (
        <div>外部负责人 {b.externalManagers} 已剔除 · 兼岗 {b.multiDeptManagers} 已去重</div>
      )}
    </div>
  );
}

/** v2.5.1 降本合并测算假设：经理转专业岗（默认）/ 离岗。 */
function SavingsAssumptionSelect({ value, onChange, ariaLabel = '降本合并测算假设' }: {
  value: 'toIC' | 'leave' | undefined;
  onChange: (v: 'toIC' | 'leave') => void;
  ariaLabel?: string;
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value ?? 'toIC'}
      onChange={(e) => onChange(e.target.value === 'leave' ? 'leave' : 'toIC')}
      title="经理转专业岗：只节省管理溢价（本人成本 − 原团队最高专业岗成本）；经理离岗：节省其全部月成本"
      className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-700 bg-white focus-ring"
    >
      <option value="toIC">经理转专业岗（只计管理溢价）</option>
      <option value="leave">经理离岗（计全部成本）</option>
    </select>
  );
}

function ThresholdInput({ label, value, onChange, suffix = '' }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          min="0"
          step="any"
          value={value}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) onChange(v);
          }}
          className="w-16 px-2 py-1 rounded-md border border-slate-200 text-right text-sm focus-ring"
        />
        {suffix && <span className="text-xs text-slate-500">{suffix}</span>}
      </span>
    </label>
  );
}

export function HealthPage({
  onDuplicateCurrentForComparison,
  healthThresholds, onHealthThresholdsChange, onFocusEmployee, onDepartmentTypeChange, onUpdatePositionPlans,
  placementIssues = [], unresolvedOverflow = [],
  open, onClose, departments, focusDeptId, onClearFocus, onFocusDept,
  onUpdateHeadcount, onSetPositionHeadcount, positionSummaries = [],
  onExportReport, currentScenarioName, scenarios, onOpenScenarioDiff,
}: HealthPageProps) {
  const configs = useLevelConfigs();
  const [localThresholds, setLocalThresholds] = useState<HealthThresholds>(() => getHealthThresholds());
  const thresholds = healthThresholds ?? localThresholds;
  const setThresholds = (next: HealthThresholds) => {
    const validated = normalizeHealthThresholds(next);
    setLocalThresholds(validated);
    onHealthThresholdsChange?.(validated);
  };
  const [baselineOpen, setBaselineOpen] = useState(false);
  const [expandedMetrics, setExpandedMetrics] = useState<Set<string>>(() => new Set());
  // v2.1.1：L3 部门→岗位展开（已展开的部门 id 集合）
  const [expandedPosDepts, setExpandedPosDepts] = useState<Set<string>>(() => new Set());
  const stage = thresholds.managementStage ?? 'growth';
  const stagePreset = STAGE_PRESETS[stage];

  // v2.3.1（Q-23）：页面关闭时按空部门派生（近似零成本），避免抽屉常驻挂载的空转。
  const report = useMemo(
    () => computeHealthReport(open ? departments : [], configs, focusDeptId, thresholds),
    [open, departments, configs, focusDeptId, thresholds],
  );
  const positionsByDept = useMemo(() => {
    const m = new Map<string, PositionSummary[]>();
    for (const p of positionSummaries) {
      const list = m.get(p.departmentId) ?? [];
      list.push(p);
      m.set(p.departmentId, list);
    }
    return m;
  }, [positionSummaries]);

  /** 异常置顶：预警 → 关注 → 未判定 → 健康；同级保持原顺序。 */
  const sortedMetrics = useMemo(
    () => report.l2
      .map((metric, index) => ({ metric, index }))
      .sort((a, b) => (STATUS_ORDER[a.metric.status] - STATUS_ORDER[b.metric.status]) || (a.index - b.index))
      .map((entry) => entry.metric),
    [report.l2],
  );

  if (!open) return null;

  const updateThresholds = (patch: Partial<HealthThresholds>) => {
    const next = normalizeHealthThresholds({ ...thresholds, ...patch });
    setThresholds(next);
    if (!healthThresholds) setHealthThresholds(next);
  };

  const resetThresholds = () => {
    const defs = { ...DEFAULT_HEALTH_THRESHOLDS };
    setThresholds(defs);
    if (!healthThresholds) resetHealthThresholds();
  };

  /** 切换诊断基准：应用该档位阈值预设并持久化；阈值细节仍可在「高级」里微调。 */
  const handleSetStage = (s: OrganizationStage) => {
    const preset = {
      ...thresholds,
      ...getStagePresetThresholds(s),
      managementStage: s,
      reportingCoverageMin: thresholds.reportingCoverageMin,
      reportingCoverageWarn: thresholds.reportingCoverageWarn,
      managementRanges: thresholds.managementRanges,
      jobFamilyTypes: thresholds.jobFamilyTypes,
    };
    setThresholds(preset);
    if (!healthThresholds) setHealthThresholds(preset);
  };

  const focusedName = focusDeptId ? report.l1[0]?.name ?? '部门' : null;
  const totals = report.totals;
  const summary = report.summary;
  const gapText = totals.totalGap === null
    ? '未配置'
    : totals.totalGap > 0 ? `+${totals.totalGap}` : totals.totalGap < 0 ? String(totals.totalGap) : '0';
  const gapNote = totals.totalGap === null
    ? '未配置编制，无法计算缺口'
    : totals.totalGap > 0 ? '空岗（待补）' : totals.totalGap < 0 ? '超编' : '满编';
  const gapTone = totals.totalGap === null
    ? 'text-slate-500'
    : totals.totalGap > 0 ? 'text-amber-600' : totals.totalGap < 0 ? 'text-red-600' : 'text-emerald-600';
  const range = spanRange(thresholds, stage);
  const baselineSummary = `${range.min}–${range.max} 人（知识型） · 汇报链 ≤${thresholds.chainHealthyMax ?? 4} 层 · 管理者比 ≤${thresholds.managerHealthyMax}% · 空岗率 ≤${thresholds.vacancyHealthyMax}%`;
  const toggleMetric = (key: string) => setExpandedMetrics((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const issueCount = placementIssues.length + unresolvedOverflow.length;

  return (
    <SubPageShell
      name="health"
      title={focusedName ? `${focusedName} · 组织健康度` : '组织健康度'}
      subtitle={`数据快照 · 场景「${currentScenarioName}」· 对照基准「${stagePreset.label}」${scenarios.length < 2 ? ' · 单场景：先复制一个场景再对比' : ''}`}
      icon={<Activity className="w-5 h-5 text-indigo-500" />}
      onBack={onClose}
      actions={<>
        {focusedName && (
          <button onClick={onClearFocus} className="flex items-center gap-1 h-9 px-3 rounded-xl text-sm text-indigo-600 border border-indigo-200 bg-white hover:bg-indigo-50 transition-colors">
            <Building2 className="w-4 h-4" />
            查看全公司
          </button>
        )}
        <ScenarioCompareButton canCompare={scenarios.length >= 2} onCompare={onOpenScenarioDiff} onDuplicateCurrent={onDuplicateCurrentForComparison} />
        <button
          onClick={onExportReport}
          disabled={departments.length === 0}
          className="flex items-center gap-1.5 h-9 px-3.5 rounded-xl text-sm font-medium text-white bg-gradient-to-r from-indigo-500 to-violet-500 shadow-md hover:shadow-lg transition-all disabled:opacity-50"
        >
          <Download className="w-4 h-4" />
          导出诊断报告
        </button>
      </>}
    >
      <div className="space-y-4 pb-6">
        {/* ① 事实带：第一屏就能看到编制/缺口/成本 */}
        <section aria-label="关键事实" className="grid grid-cols-2 md:grid-cols-5 rounded-2xl bg-white/70 backdrop-blur-xl border border-white/50 shadow-card overflow-hidden">
          <div className="p-4 border-r border-slate-100">
            <div className="text-xs text-slate-500">实际人数</div>
            <div className="text-2xl font-bold text-slate-900 tabular-nums mt-0.5">{totals.totalEmployees}</div>
            <div className="text-[11px] text-slate-400 mt-0.5">不含虚拟兼岗</div>
          </div>
          <div className="p-4 border-r border-slate-100">
            <div className="text-xs text-slate-500">编制</div>
            <div className="text-2xl font-bold text-slate-900 tabular-nums mt-0.5">
              {totals.totalHeadcount === null ? <span className="text-lg text-slate-500">未配置</span> : totals.totalHeadcount}
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5">{totals.configuredHeadcount} 个一级部门已配置</div>
          </div>
          <div className="p-4 border-r border-slate-100">
            <div className="text-xs text-slate-500">缺口</div>
            <div className={`text-2xl font-bold tabular-nums mt-0.5 ${gapTone}`}>{gapText}</div>
            <div className={`text-[11px] mt-0.5 ${gapTone}`}>{gapNote}</div>
          </div>
          <div className="p-4 border-r border-slate-100">
            <div className="text-xs text-slate-500">月成本</div>
            <div className="text-2xl font-bold text-slate-900 tabular-nums mt-0.5">{fmtCost(totals.totalCost)}</div>
            <div className="text-[11px] text-slate-400 mt-0.5">成本缺失 {report.costBreakdown.unknownEmployees} 人</div>
          </div>
          <div className="p-4">
            <div className="text-xs text-slate-500">可计算指标</div>
            <div className="text-2xl font-bold text-slate-900 tabular-nums mt-0.5">
              {report.dataCompleteness.availableMetrics}<span className="text-sm text-slate-500">/{report.dataCompleteness.totalMetrics}</span>
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5">未判定 {summary.unavailable} 项</div>
          </div>
        </section>

        {/* ② 编制 vs 实际 vs 缺口：可修数据的地方放在第 2 屏 */}
        <section aria-label="编制与缺口" className="rounded-2xl bg-white/70 backdrop-blur-xl border border-white/50 shadow-card">
          <div className="px-4 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-slate-800">编制 vs 实际 vs 缺口</h3>
              <span className="text-xs text-slate-500">人数与成本含下级部门 · 缺口不含在途 offer、待入职与待离职 · 无岗位的部门可直接改编制，有岗位的展开到岗位行修改</span>
            </div>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500 border-b border-slate-100">
                  <th className="text-left px-4 py-2 font-medium">部门</th>
                  <th className="text-right px-2 py-2 font-medium">编制</th>
                  <th className="text-right px-2 py-2 font-medium">实际</th>
                  <th className="text-right px-2 py-2 font-medium">缺口</th>
                  <th className="text-right px-2 py-2 font-medium">平均成本</th>
                  <th className="text-right px-2 py-2 font-medium">实际成本</th>
                  <th className="text-right px-4 py-2 font-medium">缺口成本</th>
                </tr>
              </thead>
              <tbody>
                {report.l3.map((r) => {
                  const deptPositions = positionsByDept.get(r.deptId) ?? [];
                  const hasPositions = deptPositions.length > 0;
                  const isExpanded = expandedPosDepts.has(r.deptId);
                  const toggle = () => setExpandedPosDepts((prev) => {
                    const next = new Set(prev);
                    if (next.has(r.deptId)) next.delete(r.deptId); else next.add(r.deptId);
                    return next;
                  });
                  return (
                    <Fragment key={r.deptId}>
                      <tr className="border-b border-slate-50 hover:bg-slate-50/60">
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-1.5">
                            {hasPositions ? (
                              <button onClick={toggle} className="p-0.5 rounded text-slate-500 hover:text-indigo-600" title={isExpanded ? '收起岗位' : '展开岗位'}>
                                {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                              </button>
                            ) : (
                              <span className="w-3.5 shrink-0" />
                            )}
                            <span className="text-slate-600">
                              {'　'.repeat(Math.min(r.level - 1, 3))}
                              {r.level > 1 && '└ '}
                              {r.name}
                            </span>
                            <DeptStatusDot status={r.status} headcount={r.headcount} />
                          </div>
                        </td>
                        <td className="px-2 py-2 text-right">
                          {hasPositions ? (
                            <span className="text-slate-600 tabular-nums" title={r.headcountSource}>{r.headcount ?? '—'}</span>
                          ) : (
                            <input
                              type="number"
                              min="0"
                              value={r.headcount ?? ''}
                              title={r.headcountSource}
                              placeholder="—"
                              aria-label={`${r.name}编制`}
                              onChange={(e) => {
                                const val = e.target.value === '' ? 0 : Number(e.target.value);
                                onUpdateHeadcount(r.deptId, Number.isFinite(val) ? val : 0);
                              }}
                              className="w-14 px-1.5 py-1 rounded-md border border-dashed border-slate-300 bg-slate-50/60 text-right text-sm tabular-nums hover:border-indigo-300 hover:bg-white focus-ring"
                            />
                          )}
                        </td>
                        <td className="px-2 py-2 text-right text-slate-700 tabular-nums">{r.actual}</td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {isHeadcountUnset(r.headcount) ? (
                            <span className="text-slate-500" title="未配置编制，无法判断空岗/超编">未配置</span>
                          ) : r.gap === null ? (
                            <span className="text-slate-500">—</span>
                          ) : (
                            <span className={r.gap > 0 ? 'text-amber-600' : r.gap < 0 ? 'text-red-600' : 'text-emerald-600'}>
                              {r.gap > 0 ? `+${r.gap} 空岗` : r.gap < 0 ? `${r.gap} 超编` : '满编'}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right text-slate-600 tabular-nums">{fmtCost(r.avgCost)}</td>
                        <td className="px-2 py-2 text-right text-slate-600 tabular-nums">{fmtCost(r.actualCost)}</td>
                        <td className="px-4 py-2 text-right tabular-nums">
                          {r.gapCost === null ? (
                            <span className="text-slate-500" title={r.gapCostBasis}>无法估算</span>
                          ) : (
                            <span title={r.gapCostBasis} className={r.gapCost > 0 ? 'text-amber-600' : r.gapCost < 0 ? 'text-red-600' : 'text-slate-500'}>
                              {fmtCost(r.gapCost)}
                            </span>
                          )}
                        </td>
                      </tr>
                      {isExpanded && deptPositions.map((p) => (
                        <tr key={p.positionId} className="border-b border-slate-50 bg-slate-50/40">
                          <td className="px-9 py-1.5">
                            <span className="flex items-center gap-1 text-xs text-slate-500">
                              <Briefcase className="w-3 h-3 shrink-0" />
                              {p.name}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            <input
                              type="number"
                              min="0"
                              value={p.headcount}
                              aria-label={`${p.name}岗位编制`}
                              onChange={(e) => {
                                const val = e.target.value === '' ? 0 : Number(e.target.value);
                                onSetPositionHeadcount?.(r.deptId, p.positionId, Number.isFinite(val) ? val : 0);
                              }}
                              title="岗位编制"
                              className="w-12 px-1 py-0.5 rounded-md border border-slate-200 bg-white text-right text-xs tabular-nums focus-ring"
                            />
                          </td>
                          <td className="px-2 py-1.5 text-right text-slate-600 tabular-nums">{p.assignedCount}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">
                            {p.gap === null ? <span className="text-slate-500 text-xs">—</span> : (
                              <span className={`text-xs ${p.gap > 0 ? 'text-amber-600' : p.gap < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                                {p.gap > 0 ? `+${p.gap}` : p.gap < 0 ? p.gap : '满编'}
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-right text-slate-500 text-xs tabular-nums">{fmtCost(p.avgCost)}</td>
                          <td className="px-2 py-1.5 text-right text-slate-500 text-xs">—</td>
                          <td className="px-4 py-1.5 text-right tabular-nums">
                            {p.gapCost === null ? (
                              <span className="text-slate-500 text-xs" title="找不到成本依据，缺口成本无法估算">无法估算</span>
                            ) : (
                              <span className={`text-xs ${p.gapCost > 0 ? 'text-amber-600' : p.gapCost < 0 ? 'text-red-600' : 'text-slate-500'}`}>
                                {fmtCost(p.gapCost)}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-slate-50/60">
                  <td className="px-4 py-2.5 font-semibold text-slate-700">合计</td>
                  <td className="px-2 py-2.5 text-right font-semibold text-slate-700 tabular-nums">
                    {totals.totalHeadcount === null ? '未配置' : fmt(totals.totalHeadcount)}
                  </td>
                  <td className="px-2 py-2.5 text-right font-semibold text-slate-700 tabular-nums">{totals.totalEmployees}</td>
                  <td className="px-2 py-2.5 text-right font-semibold text-slate-700 tabular-nums">
                    {totals.totalGap === null ? '未配置' : totals.totalGap > 0 ? `+${totals.totalGap}` : totals.totalGap}
                  </td>
                  <td className="px-2 py-2.5 text-right text-slate-500">—</td>
                  <td className="px-2 py-2.5 text-right font-semibold text-slate-700 tabular-nums">{fmtCost(totals.totalCost)}</td>
                  <td className="px-4 py-2.5 text-right text-slate-500">—</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        {/* ③ 结构指标：一张事实表，异常置顶，点击展开明细 */}
        <section aria-label="结构指标" className="rounded-2xl bg-white/70 backdrop-blur-xl border border-white/50 shadow-card">
          <div className="px-4 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-slate-800">结构指标</h3>
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full border border-indigo-100 bg-indigo-50 px-2.5 py-1 text-xs text-slate-600">
                  对照基准 <b className="text-indigo-600">{stagePreset.label}</b>
                </span>
                <button onClick={() => setBaselineOpen(true)} className="text-xs font-medium text-indigo-600 hover:underline">调整基准</button>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
              <StatusDot status="danger" label={`红 ${summary.red}`} />
              <StatusDot status="warn" label={`黄 ${summary.yellow}`} />
              <StatusDot status="healthy" label={`绿 ${summary.green}`} />
              <StatusDot status="nodata" label={`未判定 ${summary.unavailable}`} />
              {summary.overall === 'nodata' && <span className="text-slate-500">整体暂不判定</span>}
              <span className="ml-auto text-slate-400">灯号仅表示与当前基准的偏离，不构成建议</span>
            </div>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500 border-b border-slate-100">
                  <th className="text-left px-4 py-2 font-medium">指标</th>
                  <th className="text-right px-2 py-2 font-medium">数值</th>
                  <th className="text-left px-2 py-2 font-medium">基准区间</th>
                  <th className="text-right px-2 py-2 font-medium">偏离</th>
                  <th className="text-right px-4 py-2 font-medium">判读</th>
                </tr>
              </thead>
              <tbody>
                {sortedMetrics.map((m) => {
                  const deviation = deviationFor(m, thresholds, stage);
                  const isExpanded = expandedMetrics.has(m.key);
                  const unconfigured = isMetricUnconfigured(m.key, report.succession);
                  return (
                    <Fragment key={m.key}>
                      <tr
                        className="border-b border-slate-50 hover:bg-slate-50/60 cursor-pointer"
                        onClick={() => toggleMetric(m.key)}
                        aria-expanded={isExpanded}
                      >
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1.5">
                            {isExpanded ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
                            <span className="text-sm text-slate-800">{m.label}</span>
                            <CaliberNote note={metricCaliberNote(m.key)} />
                            {m.includedInOverall === false && <span className="text-[11px] text-slate-400">参考</span>}
                          </div>
                        </td>
                        <td className="px-2 py-2.5 text-right">
                          <span className={`text-lg font-bold tabular-nums ${STATUS_STYLE[m.status].text}`}>
                            {fmtMetric(m.value, m.unit, unconfigured)}
                          </span>
                        </td>
                        <td className="px-2 py-2.5 text-xs text-slate-600">{baselineText(m.key, thresholds, stage)}</td>
                        <td className="px-2 py-2.5 text-right">
                          <span className={`text-xs font-medium ${
                            deviation.tone === 'flat' ? 'text-emerald-600' : 'text-amber-600'
                          }`}>{deviation.text}</span>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <StatusDot status={m.status} />
                          {m.dataWarning && <div className="text-[11px] text-amber-700 mt-0.5">{m.dataWarning}</div>}
                        </td>
                      </tr>
                      <tr hidden={!isExpanded} className="border-b border-slate-50 bg-slate-50/50">
                        <td colSpan={5} className="px-4 py-3">
                          <p className="text-xs text-slate-500 leading-relaxed">{metricCaliberNote(m.key)}</p>
                          {m.key === 'span' && (
                            <>
                              <SpanCardExtra m={m} thresholds={thresholds} onFocusDept={onFocusDept} />
                              {m.functionalSpans && <div className="mt-2"><FunctionalSpanTable data={m.functionalSpans} /></div>}
                            </>
                          )}
                          {m.key === 'depth' && <DepthCardExtra m={m} onFocusDept={onFocusDept} />}
                          {m.key === 'managerRatio' && <ManagerCardExtra m={m} />}
                          {m.status === 'nodata' && (
                            <p className="text-xs text-amber-700 mt-1 leading-relaxed">{m.verdict}</p>
                          )}
                        </td>
                      </tr>
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="px-4 py-2 text-[11px] text-slate-400">点击任意指标行展开口径与明细；异常项自动置顶。</p>
        </section>

        {/* ④ 明细与数据质量：默认折叠，只显示需要核对的条目数 */}
        <section aria-label="明细与数据质量" className="rounded-2xl bg-white/70 backdrop-blur-xl border border-white/50 shadow-card overflow-hidden">
          <div className="px-4 pt-4 pb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-slate-800">明细与数据质量</h3>
            <span className="text-xs text-slate-500">默认折叠，只显示需要核对的条目数</span>
          </div>

          <details className="border-t border-slate-100">
            <summary className="px-4 py-2.5 text-sm text-slate-700 cursor-pointer hover:bg-slate-50/70">
              数据完整度
              <span className="ml-2 text-xs text-slate-500">
                可计算指标 {report.dataCompleteness.availableMetrics}/{report.dataCompleteness.totalMetrics} · 未判定 {summary.unavailable} 项
              </span>
            </summary>
            <div role="region" aria-label="数据完整度" className="px-4 pb-4 text-xs text-slate-600 leading-relaxed">
              <p>可计算指标 {report.dataCompleteness.availableMetrics}/{report.dataCompleteness.totalMetrics} · 未判定 {summary.unavailable} 项（不计入红黄绿）</p>
              <p>已设负责人 {report.dataCompleteness.departmentsWithLeader}/{report.dataCompleteness.totalDepartments} 个部门 · 已配置直属编制 {report.dataCompleteness.departmentsWithHeadcount}/{report.dataCompleteness.totalDepartments} 个部门</p>
              <p>管理类型默认归知识型：{report.dataCompleteness.managementTypeDefaults} 名下属{report.dataCompleteness.unmappedJobFamilies.length > 0 ? ` · 未映射岗位序列：${report.dataCompleteness.unmappedJobFamilies.join('、')}` : ''}</p>
              <p>继任：{report.dataCompleteness.successionUnconfigured}/{report.dataCompleteness.criticalPositions} 个关键岗位未录入继任人{report.succession.configured ? '' : '（继任指标显示为未配置）'}</p>
              <p className="mt-1 text-slate-500">完整度表示录入覆盖情况，不代表数据已核实；部门层级不等于人员到 CEO 的汇报链。</p>
            </div>
          </details>

          <details className="border-t border-slate-100">
            <summary className="px-4 py-2.5 text-sm text-slate-700 cursor-pointer hover:bg-slate-50/70">
              汇报线覆盖率
              <span className="ml-2 text-xs text-slate-500">
                {report.reporting.coverage === null ? '未知' : `${round1(report.reporting.coverage * 100)}%`}
              </span>
            </summary>
            <div className="px-4 pb-4">
              <ReportingQuality data={report.reporting} onFocusEmployee={onFocusEmployee} />
            </div>
          </details>

          <details className="border-t border-slate-100">
            <summary className="px-4 py-2.5 text-sm text-slate-700 cursor-pointer hover:bg-slate-50/70">
              关键岗位与继任
              <span className="ml-2 text-xs text-slate-500">
                {report.succession.configured ? '已配置' : '未配置'} · {report.succession.criticalCount} 个关键岗位
              </span>
            </summary>
            <div className="px-4 pb-4">
              <SuccessionPanel data={report.succession} departments={departments} onUpdatePlans={onUpdatePositionPlans} />
            </div>
          </details>

          <details className="border-t border-slate-100">
            <summary className="px-4 py-2.5 text-sm text-slate-700 cursor-pointer hover:bg-slate-50/70">
              汇报链与职级
              <span className="ml-2 text-xs text-slate-500">
                人员汇报链 P90 {report.reportingChains.p90 ?? '—'} 层 · 已核对 {report.reportingChains.checkedRelations} 对
              </span>
            </summary>
            <div className="px-4 pb-4">
              <ReportingChainsPanel data={report.reportingChains} onFocusEmployee={onFocusEmployee} />
            </div>
          </details>

          <details className="border-t border-slate-100">
            <summary className="px-4 py-2.5 text-sm text-slate-700 cursor-pointer hover:bg-slate-50/70">
              层级与管理者成本
              <span className="ml-2 text-xs text-slate-500">
                已知月成本 {fmtCost(report.costBreakdown.knownCost)} · 缺失 {report.costBreakdown.unknownEmployees} 人
              </span>
            </summary>
            <div className="px-4 pb-4">
              <OrganizationCostSummary data={report.costBreakdown} />
            </div>
          </details>

          {issueCount > 0 && (
            <details className="border-t border-slate-100">
              <summary className="px-4 py-2.5 text-sm text-amber-800 cursor-pointer hover:bg-amber-50/70">
                <AlertTriangle className="w-3.5 h-3.5 inline mr-1" />
                人岗核对
                <span className="ml-2 text-xs text-amber-700">{placementIssues.length} 项数据问题 · {unresolvedOverflow.length} 个超额岗位待判断</span>
              </summary>
              <ul className="px-4 pb-4 text-xs text-amber-900 list-disc list-inside space-y-1">
                {[...placementIssues, ...unresolvedOverflow].map((issue, idx) => <li key={idx}>{issue}</li>)}
              </ul>
            </details>
          )}
        </section>

        {/* AI 位：本页不再给建议，结论交给后续 AI 分析 */}
        <section aria-label="AI 深度分析" className="rounded-2xl border border-dashed border-indigo-300 bg-gradient-to-br from-indigo-50/90 to-violet-50/60 px-4 py-3.5 flex items-center gap-3">
          <span className="w-9 h-9 rounded-xl bg-white grid place-items-center shadow-sm text-indigo-500 shrink-0">
            <Sparkles className="w-4 h-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
              AI 深度分析
              <span className="text-[10px] font-bold text-indigo-600 bg-white rounded-full px-2 py-0.5">即将上线</span>
            </h3>
            <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">
              补充业务上下文后，由 AI 给出结论、优先级与调整建议。本页只呈现可复算的事实与偏离，不再直接给建议。
            </p>
          </div>
        </section>

        {/* 页脚：诊断基准（原业务场景 + 企业阶段 + 阈值设置合并于此） */}
        <footer aria-label="诊断基准" className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3 pb-1 text-xs text-slate-500">
          <Gauge className="w-3.5 h-3.5" />
          诊断基准：<b className="text-slate-700">{stagePreset.label}</b> · {baselineSummary}
          <button onClick={() => setBaselineOpen(true)} className="ml-auto h-7 px-2.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-600 hover:bg-slate-50">
            调整基准
          </button>
        </footer>
      </div>

      {/* 诊断基准弹窗：三档 + 高级阈值 */}
      {baselineOpen && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-slate-900/30 backdrop-blur-sm p-6"
          onClick={() => setBaselineOpen(false)}
          role="presentation"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="诊断基准"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-3xl max-h-[85vh] overflow-y-auto rounded-2xl bg-white shadow-2xl"
          >
            <div className="px-5 pt-5">
              <h3 className="text-base font-bold text-slate-900">诊断基准</h3>
              <p className="text-xs text-slate-500 mt-1">基准只决定灯号的判读区间，不改变组织数据。换基准后，所有指标按新区间重新判读。</p>
            </div>
            <div className="grid md:grid-cols-3 gap-3 px-5 py-4">
              {(Object.keys(STAGE_PRESETS) as OrganizationStage[]).map((s) => {
                const p = STAGE_PRESETS[s];
                const r = p.thresholds.managementRanges?.[s]?.knowledge ?? DEFAULT_MANAGEMENT_RANGES[s].knowledge;
                const active = s === stage;
                return (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={active}
                    onClick={() => { handleSetStage(s); setBaselineOpen(false); }}
                    className={`text-left rounded-xl border p-3.5 transition-colors ${
                      active ? 'border-indigo-400 bg-indigo-50/60 ring-2 ring-indigo-100' : 'border-slate-200 bg-white hover:border-indigo-300'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-slate-900">{p.label}</span>
                      {active && <span className="text-[10px] font-bold text-indigo-600 bg-white rounded-full px-1.5 py-0.5">当前</span>}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">{BASELINE_META[s].scale}</div>
                    <ul className="mt-2 space-y-1 text-[11px] text-slate-600">
                      <li>知识型管理幅度 {r.min}–{r.max} 人</li>
                      <li>汇报链 ≤{p.thresholds.chainHealthyMax ?? 4} 层</li>
                      <li>管理者比 ≤{p.thresholds.managerHealthyMax}%</li>
                      <li>空岗率 ≤{p.thresholds.vacancyHealthyMax}%</li>
                    </ul>
                    <p className="mt-2 pt-2 border-t border-dashed border-slate-200 text-[11px] text-slate-500 leading-snug">{BASELINE_META[s].fit}</p>
                  </button>
                );
              })}
            </div>

            <details className="mx-5 mb-4 rounded-xl border border-slate-200">
              <summary className="px-3 py-2 text-xs text-slate-600 cursor-pointer flex items-center gap-1.5">
                <SlidersHorizontal className="w-3.5 h-3.5" />
                高级：逐项自定义阈值（随项目保存）
              </summary>
              <div className="px-3 pb-3 space-y-2.5 border-t border-slate-100 pt-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-600">阈值配置</span>
                  <button onClick={resetThresholds} className="text-xs text-slate-500 hover:text-red-500 font-medium">恢复默认</button>
                </div>
                <ThresholdInput label="汇报覆盖率提醒线" suffix="%" value={(thresholds.reportingCoverageWarn ?? REPORTING_COVERAGE_WARN) * 100} onChange={(v) => updateThresholds({ reportingCoverageWarn: v / 100 })} />
                <ThresholdInput label="汇报覆盖率最低线" suffix="%" value={(thresholds.reportingCoverageMin ?? REPORTING_COVERAGE_MIN) * 100} onChange={(v) => updateThresholds({ reportingCoverageMin: v / 100 })} />
                <ManagementSettings thresholds={thresholds} onChange={updateThresholds} departments={departments} onDepartmentTypeChange={onDepartmentTypeChange} />
                <ThresholdInput label="管理者梯队健康下限（后备/岗）" value={thresholds.pipelineHealthyMin ?? 0.8} onChange={(v) => updateThresholds({ pipelineHealthyMin: v })} />
                <ThresholdInput label="管理者梯队关注下限（后备/岗）" value={thresholds.pipelineWarnMin ?? 0.5} onChange={(v) => updateThresholds({ pipelineWarnMin: v })} />
                <ThresholdInput label="继任覆盖健康下限" suffix="%" value={thresholds.successionHealthyMin ?? 70} onChange={(v) => updateThresholds({ successionHealthyMin: v })} />
                <ThresholdInput label="继任覆盖关注下限" suffix="%" value={thresholds.successionWarnMin ?? 50} onChange={(v) => updateThresholds({ successionWarnMin: v })} />
                <ThresholdInput label="继任覆盖最少关键岗位" value={thresholds.successionSampleMin ?? 5} onChange={(v) => updateThresholds({ successionSampleMin: v })} />
                <ThresholdInput label="汇报链健康上限（层）" value={thresholds.chainHealthyMax ?? 4} onChange={(v) => updateThresholds({ chainHealthyMax: v })} />
                <ThresholdInput label="汇报链关注上限（层）" value={thresholds.chainWarnMax ?? 5} onChange={(v) => updateThresholds({ chainWarnMax: v })} />
                <ThresholdInput label="管理者比健康上限（%）" value={thresholds.managerHealthyMax} onChange={(v) => updateThresholds({ managerHealthyMax: v })} />
                <ThresholdInput label="管理者比关注上限（%）" value={thresholds.managerWarnMax} onChange={(v) => updateThresholds({ managerWarnMax: v })} />
                <ThresholdInput label="空岗率健康上限（%）" value={thresholds.vacancyHealthyMax} onChange={(v) => updateThresholds({ vacancyHealthyMax: v })} />
                <ThresholdInput label="空岗率关注上限（%）" value={thresholds.vacancyWarnMax} onChange={(v) => updateThresholds({ vacancyWarnMax: v })} />
                <ThresholdInput label="超编预警占比" suffix="%" value={Math.round(thresholds.overWarnRatio * 100)} onChange={(v) => updateThresholds({ overWarnRatio: v / 100 })} />
                <label className="flex items-center justify-between gap-3">
                  <span className="text-xs text-slate-500">降本合并测算假设（只影响导出报告中的合并测算）</span>
                  <SavingsAssumptionSelect value={thresholds.efficiencySavingsAssumption} onChange={(v) => updateThresholds({ efficiencySavingsAssumption: v })} />
                </label>
              </div>
            </details>

            <div className="flex items-center gap-2 px-5 pb-5">
              <p className="text-[11px] text-slate-400 leading-snug">
                三个档位互斥，只能选一个。<br />
                原「业务场景」（快速扩张 / 降本增效等）已移出页面。
              </p>
              <button onClick={() => setBaselineOpen(false)} className="ml-auto h-9 px-3.5 rounded-xl border border-slate-200 text-sm text-slate-600 hover:bg-slate-50">关闭</button>
            </div>
          </div>
        </div>
      )}
    </SubPageShell>
  );
}
