import type { BusinessContext } from '../utils/businessContext';
import type { HealthThresholds } from '../utils/healthThresholds';
import { useDialogFocus } from '../utils/useDialogFocus';
import { useMemo, useState } from 'react';
import { X, GitCompare, Download, Building2, Users } from 'lucide-react';
import { Scenario } from '../types';
import {
  computeScenarioDiff,
  computeScenarioTotals,
  DeptDiff,
  PersonnelChange,
  ScenarioDiffResult,
} from '../utils/scenarioDiff';
import {
  computeHealthReport,
  HEALTH_STATUS_LABEL,
  HealthStatus,
  L2Metric,
  METRIC_CALIBER_NOTES,
  SpanBreakdown,
  getHealthThresholds,
  DEFAULT_HEALTH_THRESHOLDS,
} from '../utils/analytics';
import { STATUS_STYLE, fmt, fmtCost } from '../utils/statusUI';

interface ScenarioDiffViewProps {
  businessContext?: BusinessContext;
  healthThresholds?: HealthThresholds;
  open: boolean;
  onClose: () => void;
  baseline: Scenario;
  target: Scenario;
  /** 全部场景（供基线/目标切换选择器） */
  scenarios: Scenario[];
  onSelectBaseline: (scenarioId: string) => void;
  onSelectTarget: (scenarioId: string) => void;
  onLocateDept: (deptId: string) => void;
  onLocateEmployee: (employeeId: string) => void;
  /** 打开管理层报告 */
  onExportReport: () => void;
}

/** 方向色（↑ 蓝 / ↓ 灰 / 持平 灰）——与健康灯号红黄绿严格分离（v209-product-scope §1.5） */
const DIR_UP = 'text-sky-600';
const DIR_DOWN = 'text-slate-500';
const DIR_FLAT = 'text-slate-400';

function dirClass(delta: number): string {
  return delta > 0 ? DIR_UP : delta < 0 ? DIR_DOWN : DIR_FLAT;
}

function dirArrow(delta: number): string {
  return delta > 0 ? '↑' : delta < 0 ? '↓' : '—';
}

function StatusDot({ status, label }: { status: HealthStatus | null; label?: string }) {
  if (status === null) {
    return (
      <span className="inline-flex items-center gap-1 text-slate-400">
        <span className="w-2 h-2 rounded-full bg-slate-300" />
        <span className="text-xs">{label ?? '无数据'}</span>
      </span>
    );
  }
  const s = STATUS_STYLE[status];
  return (
    <span className={`inline-flex items-center gap-1 ${s.text}`}>
      <span className={`w-2 h-2 rounded-full ${s.dot}`} />
      <span className="text-xs">{label ?? HEALTH_STATUS_LABEL[status]}</span>
    </span>
  );
}

/** 指标口径「?」说明 */
function CaliberNote({ note }: { note: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex items-center">
      <button
        type="button"
        aria-label="指标口径说明"
        onClick={() => setOpen((o) => !o)}
        className="w-4 h-4 rounded-full bg-slate-200 hover:bg-slate-300 text-slate-500 grid place-items-center text-[10px] font-bold leading-none"
      >
        ?
      </button>
      {open && (
        <span className="absolute left-0 top-5 z-20 w-64 rounded-lg bg-white/95 backdrop-blur border border-slate-200 shadow-lg p-2.5 text-[11px] text-slate-600 leading-snug">
          {note}
        </span>
      )}
    </span>
  );
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
}

/** Δ 数值（方向色 + 符号 + 幅度）；null → 无数据/不可比（不把缺失当 0） */
function DeltaText({ delta, format }: { delta: number | null; format: (n: number) => string }) {
  if (delta === null) return <span className="text-slate-400">无数据/不可比</span>;
  return (
    <span className={`font-medium tabular-nums ${dirClass(delta)}`}>
      {dirArrow(delta)} {format(Math.abs(delta))}
    </span>
  );
}

/** 表变量：基线 → 目标 + Δ（单侧缺失且另一侧有值 → 无数据/不可比） */
function Cell({
  base,
  target,
  delta,
  format,
}: {
  base: number | null | undefined;
  target: number | null | undefined;
  delta: number | null | undefined;
  format: (n: number) => string;
}) {
  const b = base ?? null;
  const t = target ?? null;
  const d = delta ?? null;
  return (
    <div className="text-right">
      <div className="tabular-nums text-slate-600">
        {fmt(b, '')} <span className="text-slate-300">→</span> {fmt(t, '')}
      </div>
      <div className="text-[10px] tabular-nums">
        {d === null ? (
          b === null && t === null ? (
            <span className="text-slate-300">—</span>
          ) : (
            <span className="text-slate-400">无数据/不可比</span>
          )
        ) : d === 0 ? (
          <span className={DIR_FLAT}>— 0</span>
        ) : (
          <span className={dirClass(d)}>
            {dirArrow(d)} {format(Math.abs(d))}
          </span>
        )}
      </div>
    </div>
  );
}

/** 变化类型 → 中文标签与徽章样式（结构标记，非方向色/健康色） */
const CHANGE_LABEL: Record<DeptDiff['changeType'], string> = {
  added: '新增',
  removed: '删除',
  reparented: '改汇报线',
  moved: '改层级',
  'leader-changed': '改负责人',
  'config-changed': '编制/成本变化',
  unchanged: '无变化',
};
const CHANGE_STYLE: Record<DeptDiff['changeType'], string> = {
  added: 'bg-emerald-50 text-emerald-600',
  removed: 'bg-red-50 text-red-600',
  reparented: 'bg-amber-50 text-amber-600',
  moved: 'bg-sky-50 text-sky-600',
  'leader-changed': 'bg-violet-50 text-violet-600',
  'config-changed': 'bg-slate-100 text-slate-500',
  unchanged: 'bg-slate-50 text-slate-300',
};

const PERSON_LABEL: Record<PersonnelChange['type'], string> = {
  'moved-dept': '换部门',
  'moved-reporting': '换汇报线',
  added: '新增',
  removed: '移除',
};
const PERSON_STYLE: Record<PersonnelChange['type'], string> = {
  'moved-dept': 'bg-sky-50 text-sky-600',
  'moved-reporting': 'bg-violet-50 text-violet-600',
  added: 'bg-emerald-50 text-emerald-600',
  removed: 'bg-red-50 text-red-600',
};

/** 指标口径与明细：展开后显示口径说明 + 基线/目标两侧 breakdown（复用 analytics 的 breakdown，不重复计算） */
function MetricDetail({
  key,
  bL2,
  tL2,
  onLocateDept,
}: {
  key: L2Metric['key'];
  bL2: L2Metric[];
  tL2: L2Metric[];
  onLocateDept: (deptId: string) => void;
}) {
  const b = bL2.find((m) => m.key === key);
  const t = tL2.find((m) => m.key === key);

  const spanRows = (title: string, br: SpanBreakdown | undefined) => (
    <div className="min-w-0 flex-1">
      <div className="text-[10px] font-semibold text-slate-500 mb-1">{title}</div>
      {!br || br.count === 0 ? (
        <div className="text-[10px] text-slate-400">无数据/不可比</div>
      ) : (
        <>
          <div className="text-[10px] text-slate-400 mb-1">
            中位数 {fmt(br.median)} 人 · 均值 {fmt(br.mean)} 人 · 极值 {fmt(br.min)}–{fmt(br.max)} 人 ·{' '}
            {br.count} 个部门
          </div>
          <div className="max-h-28 overflow-y-auto rounded-lg border border-slate-100">
            <table className="w-full text-[10px]">
              <tbody>
                {br.distribution.map((row) => (
                  <tr
                    key={row.managerKey ?? row.deptId}
                    onClick={() => onLocateDept(row.deptId)}
                    className="border-b border-slate-50 last:border-0 cursor-pointer hover:bg-indigo-50/60"
                    title="点击定位到画布"
                  >
                    <td className="px-2 py-1 text-slate-600">{row.deptName}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-slate-700">{row.directReports}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );

  if (key === 'span') {
    return (
      <div className="flex gap-3">
        {spanRows(`基线 · ${b?.label ?? ''}`, b?.spanBreakdown)}
        {spanRows(`目标 · ${t?.label ?? ''}`, t?.spanBreakdown)}
      </div>
    );
  }

  if (key === 'depth') {
    const depthBlock = (title: string, m: L2Metric | undefined) => {
      const br = m?.depthBreakdown;
      return (
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold text-slate-500 mb-1">{title}</div>
          {!br || br.deptCount === 0 ? (
            <div className="text-[10px] text-slate-400">无数据/不可比</div>
          ) : (
            <>
              <div className="text-[10px] text-slate-400 leading-snug">
                P50={br.p50} 层 · P90={br.p90} 层 · 最深 {br.max} 层 · {br.deptCount} 个部门
              </div>
              {br.deepestDeptId && (
                <button
                  type="button"
                  onClick={() => onLocateDept(br.deepestDeptId)}
                  className="mt-1 block text-left text-[10px] text-indigo-500 hover:underline"
                  title="点击定位到画布"
                >
                  最深链：{br.deepestPath.join(' → ') || '—'}
                </button>
              )}
            </>
          )}
        </div>
      );
    };
    return (
      <div className="flex gap-3">
        {depthBlock(`基线 · ${b?.label ?? ''}`, b)}
        {depthBlock(`目标 · ${t?.label ?? ''}`, t)}
      </div>
    );
  }

  if (key === 'managerRatio') {
    const mgrBlock = (title: string, m: L2Metric | undefined) => {
      const br = m?.managerBreakdown;
      return (
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold text-slate-500 mb-1">{title}</div>
          {!br || br.totalEmployees === 0 ? (
            <div className="text-[10px] text-slate-400">无数据/不可比</div>
          ) : (
            <div className="text-[10px] text-slate-400 leading-snug">
              内部 {br.internalManagers} / 全员 {br.totalEmployees} · 外部 {br.externalManagers} · 兼岗{' '}
              {br.multiDeptManagers} · 非管理 {br.nonManagerEmployees}
              {br.nonManagerEmployees > 0 && br.internalManagers > 0
                ? ` · ≈每 ${Math.round(br.nonManagerEmployees / br.internalManagers)} 名非管理员工配 1 名管理者`
                : ''}
            </div>
          )}
        </div>
      );
    };
    return (
      <div className="flex gap-3">
        {mgrBlock(`基线 · ${b?.label ?? ''}`, b)}
        {mgrBlock(`目标 · ${t?.label ?? ''}`, t)}
      </div>
    );
  }

  // vacancy：仅口径说明（无 breakdown 结构）
  return <div className="text-[10px] text-slate-400 leading-snug">无额外明细数据。</div>;
}

const STATUS_RANK: Record<HealthStatus, number> = { nodata: -1, healthy: 0, warn: 1, danger: 2 };

export function ScenarioDiffView({
  businessContext = 'normal', healthThresholds,
  open,
  onClose,
  baseline,
  target,
  scenarios,
  onSelectBaseline,
  onSelectTarget,
  onLocateDept,
  onLocateEmployee,
  onExportReport,
}: ScenarioDiffViewProps) {
  const [showAll, setShowAll] = useState(false);
  const fallbackThresholds = useMemo(() => open ? getHealthThresholds() : DEFAULT_HEALTH_THRESHOLDS, [open]);
  const thresholds = healthThresholds ?? fallbackThresholds;
  const [openMetric, setOpenMetric] = useState<L2Metric['key'] | null>(null);

  const diff: ScenarioDiffResult = useMemo(
    () => computeScenarioDiff(baseline, target, thresholds, businessContext),
    [baseline, target, thresholds, businessContext],
  );
  const bTotals = useMemo(() => computeScenarioTotals(baseline), [baseline]);
  const tTotals = useMemo(() => computeScenarioTotals(target), [target]);
  // 明细侧 breakdown（差异计算已用同一口径；此处仅用于「口径与明细」展开）
  const bL2 = useMemo(() => computeHealthReport(baseline.departments, baseline.levelConfigs, undefined, thresholds, { businessContext }).l2, [baseline, thresholds, businessContext]);
  const tL2 = useMemo(() => computeHealthReport(target.departments, target.levelConfigs, undefined, thresholds, { businessContext }).l2, [target, thresholds, businessContext]);

  const dialogRef = useDialogFocus(open, onClose);

  if (!open) return null;

  const overallBase = diff.overall.baseline;
  const overallTgt = diff.overall.target;
  const improved = diff.metrics.filter(
    (m) =>
      m.comparable &&
      m.baselineStatus &&
      m.targetStatus &&
      STATUS_RANK[m.targetStatus] < STATUS_RANK[m.baselineStatus],
  ).length;
  const worsened = diff.metrics.filter(
    (m) =>
      m.comparable &&
      m.baselineStatus &&
      m.targetStatus &&
      STATUS_RANK[m.targetStatus] > STATUS_RANK[m.baselineStatus],
  ).length;
  const flatCount = diff.metrics.filter(
    (m) =>
      m.comparable &&
      m.baselineStatus &&
      m.targetStatus &&
      STATUS_RANK[m.targetStatus] === STATUS_RANK[m.baselineStatus],
  ).length;
  const employeesDelta = tTotals.totalEmployees - bTotals.totalEmployees;

  const visibleDepts = showAll
    ? diff.departmentDiffs
    : diff.departmentDiffs.filter((d) => d.changeType !== 'unchanged');

  return (
    <div className="fixed inset-0 z-[85]">
      <div className="absolute inset-0 bg-slate-900/10 backdrop-blur-[2px]" onClick={onClose} />
      <aside ref={dialogRef} role="dialog" aria-modal="true" aria-label="场景差异比较" tabIndex={-1} className="absolute inset-y-0 right-0 w-[900px] max-w-[96vw] glass border-l border-white/40 shadow-2xl flex flex-col animate-slideInRight">
        {/* 头部 */}
        <div className="px-5 py-4 border-b border-slate-100">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <GitCompare className="w-5 h-5 text-indigo-500" />
              <h2 className="text-lg font-bold text-slate-900">场景差异比较</h2>
              <span className="text-[10px] text-slate-400">差异 = 目标 − 基线 · 只陈述事实，不评判优劣</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={onExportReport}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium text-white bg-gradient-to-r from-indigo-500 to-violet-500 shadow-md hover:shadow-lg transition-all"
              >
                <Download className="w-4 h-4" />
                管理层报告
              </button>
              <button
                onClick={onClose}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
                aria-label="关闭"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>
          {/* 基线 / 目标 选择器（锚点默认第一个场景，可手动切换；目标默认当前场景） */}
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <span className="text-xs text-slate-500">基线</span>
              <select
                aria-label="基线场景"
                value={baseline.id}
                onChange={(e) => onSelectBaseline(e.target.value)}
                className="px-2 py-1.5 rounded-lg border border-slate-200 bg-white text-sm focus-ring"
              >
                {scenarios
                  .filter((s) => s.id !== target.id)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
              <span className="text-[10px] text-slate-400">快照 {fmtTime(baseline.updatedAt)}</span>
            </label>
            <span className="text-slate-400">vs</span>
            <label className="flex items-center gap-2">
              <span className="text-xs text-slate-500">目标</span>
              <select
                aria-label="目标场景"
                value={target.id}
                onChange={(e) => onSelectTarget(e.target.value)}
                className="px-2 py-1.5 rounded-lg border border-slate-200 bg-white text-sm focus-ring"
              >
                {scenarios
                  .filter((s) => s.id !== baseline.id)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
              <span className="text-[10px] text-slate-400">快照 {fmtTime(target.updatedAt)}</span>
            </label>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
          {/* L0 结论条 */}
          <section className="rounded-2xl bg-white/70 backdrop-blur-xl border border-white/50 shadow-card p-4">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-slate-700">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-slate-500">整体健康度</span>
                <StatusDot status={overallBase} label={overallBase ? HEALTH_STATUS_LABEL[overallBase] : '无数据'} />
                <span className="text-slate-300">→</span>
                <StatusDot status={overallTgt} label={overallTgt ? HEALTH_STATUS_LABEL[overallTgt] : '无数据'} />
              </div>
              <div className="text-xs text-slate-500">
                {diff.metrics.length} 项指标 <b className="text-emerald-600">{improved} 改善</b> /{' '}
                <b className="text-slate-500">{flatCount} 持平</b> / <b className="text-red-600">{worsened} 恶化</b>
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-500">
                总人数
                <DeltaText
                  delta={employeesDelta}
                  format={(n) => `${n} 人`}
                />
                · 月成本
                <DeltaText delta={diff.totals.costDelta} format={(n) => `${n}w`} />
                · 缺口
                <DeltaText delta={diff.totals.gapDelta} format={(n) => `${n} 人`} />
              </div>
            </div>
            {!diff.overall.comparable && (
              <div className="mt-2 text-xs text-amber-600">
                部分指标无数据/不可比：场景数据不一致时按「无数据」呈现，不做 0 计算。
              </div>
            )}
          </section>

          {/* L1 四项指标并排对比 */}
          <section>
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">L1 指标对比</h3>
            <div className="grid grid-cols-2 gap-3">
              {diff.metrics.map((m) => (
                <div
                  key={m.key}
                  className={`rounded-2xl bg-white/70 backdrop-blur-xl border border-white/50 shadow-card p-4 ${
                    openMetric === m.key ? 'ring-2 ring-indigo-300' : ''
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <span className="text-xs text-slate-500">{m.label}</span>
                      <CaliberNote note={METRIC_CALIBER_NOTES[m.key]} />
                    </span>
                    <span className="flex items-center gap-1">
                      <StatusDot status={m.baselineStatus} />
                      <span className="text-slate-300 text-xs">→</span>
                      <StatusDot status={m.targetStatus} />
                    </span>
                  </div>
                  <div className="mt-1 flex items-baseline gap-2">
                    <span className={`text-2xl font-bold tabular-nums ${m.baselineStatus ? STATUS_STYLE[m.baselineStatus].text : 'text-slate-400'}`}>
                      {fmt(m.baseline, m.unit)}
                    </span>
                    <span className="text-slate-300 text-sm">→</span>
                    <span className={`text-2xl font-bold tabular-nums ${m.targetStatus ? STATUS_STYLE[m.targetStatus].text : 'text-slate-400'}`}>
                      {fmt(m.target, m.unit)}
                    </span>
                  </div>
                  <div className="mt-1 text-xs">
                    {m.comparable ? (
                      <DeltaText delta={m.delta} format={(n) => `${n}${m.unit}`} />
                    ) : (
                      <span className="text-slate-400">无数据/不可比</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setOpenMetric((k) => (k === m.key ? null : m.key))}
                    className="mt-2 text-[10px] text-indigo-500 hover:underline font-medium"
                  >
                    {openMetric === m.key ? '收起明细 ▲' : '口径与明细 ▼'}
                  </button>
                  {openMetric === m.key && (
                    <div className="mt-2 rounded-xl border border-slate-100 bg-white/60 p-2.5">
                      <MetricDetail key={m.key} bL2={bL2} tL2={tL2} onLocateDept={onLocateDept} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* L2 部门差异表 */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
                L2 部门差异 {visibleDepts.length}/{diff.departmentDiffs.length}
              </h3>
              <button
                type="button"
                role="switch"
                aria-checked={showAll}
                onClick={() => setShowAll((v) => !v)}
                className="flex items-center gap-1.5 text-[11px] font-medium text-indigo-600 hover:underline"
              >
                <span
                  className={`w-7 h-4 rounded-full transition-colors relative ${
                    showAll ? 'bg-indigo-500' : 'bg-slate-200'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-all ${
                      showAll ? 'left-3.5' : 'left-0.5'
                    }`}
                  />
                </span>
                {showAll ? '显示全部' : '只看差异'}
              </button>
            </div>
            <div className="overflow-x-auto rounded-2xl bg-white/70 backdrop-blur-xl border border-white/50 shadow-card">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-slate-400 uppercase tracking-wide border-b border-slate-100">
                    <th className="text-left px-4 py-2.5 font-medium">部门</th>
                    <th className="text-left px-2 py-2.5 font-medium">变化</th>
                    <th className="text-left px-2 py-2.5 font-medium">负责人</th>
                    <th className="text-right px-2 py-2.5 font-medium">编制</th>
                    <th className="text-right px-2 py-2.5 font-medium">实际</th>
                    <th className="text-right px-2 py-2.5 font-medium">缺口</th>
                    <th className="text-right px-2 py-2.5 font-medium">缺口成本</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleDepts.map((d) => {
                    const b = d.baseline;
                    const t = d.target;
                    return (
                      <tr
                        key={d.deptId}
                        onClick={() => onLocateDept(d.deptId)}
                        className={`border-b border-slate-50 hover:bg-indigo-50/40 cursor-pointer ${
                          d.changeType === 'unchanged' ? 'opacity-55' : ''
                        }`}
                        title="点击定位到画布"
                      >
                        <td className="px-4 py-2.5">
                          <span className="flex items-center gap-1.5 text-slate-700">
                            <Building2 className="w-3.5 h-3.5 text-slate-300 shrink-0" />
                            {d.name}
                            <span className="text-[10px] text-slate-300">L{Math.max(b?.level ?? 0, t?.level ?? 0)}</span>
                          </span>
                        </td>
                        <td className="px-2 py-2.5">
                          <span
                            className={`inline-block text-[10px] px-1.5 py-0.5 rounded-full font-medium ${CHANGE_STYLE[d.changeType]}`}
                          >
                            {CHANGE_LABEL[d.changeType]}
                          </span>
                        </td>
                        <td className="px-2 py-2.5 text-xs text-slate-600">
                          {b?.leaderName ?? '—'} <span className="text-slate-300">→</span>{' '}
                          {t?.leaderName ?? '—'}
                        </td>
                        <td className="px-2 py-2.5">
                          <Cell base={b?.headcount} target={t?.headcount} delta={d.delta.headcount} format={(n) => `${n} 人`} />
                        </td>
                        <td className="px-2 py-2.5">
                          <Cell base={b?.actual} target={t?.actual} delta={d.delta.actual} format={(n) => `${n} 人`} />
                        </td>
                        <td className="px-2 py-2.5">
                          <Cell
                            base={b?.gap}
                            target={t?.gap}
                            delta={d.delta.gap}
                            format={(n) => `${n} 人`}
                          />
                        </td>
                        <td className="px-2 py-2.5">
                          <Cell
                            base={b?.gapCost}
                            target={t?.gapCost}
                            delta={d.delta.gapCost}
                            format={(n) => `${n}w`}
                          />
                        </td>
                      </tr>
                    );
                  })}
                  {visibleDepts.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-6 text-center text-sm text-slate-400">
                        {showAll ? '暂无部门数据' : '无部门差异（可切换「显示全部」查看全量）'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* L3 人员调动清单 */}
          <section>
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
              L3 人员调动清单 {diff.personnelChanges.length}
            </h3>
            {diff.personnelChanges.length === 0 ? (
              <div className="rounded-2xl bg-white/70 backdrop-blur-xl border border-white/50 shadow-card p-4 text-sm text-slate-400 text-center">
                无人员调动
              </div>
            ) : (
              <div className="space-y-2 max-h-[38vh] overflow-y-auto pr-1">
                {diff.personnelChanges.map((p, i) => (
                  <button
                    key={`${p.employeeId}-${p.type}-${i}`}
                    type="button"
                    onClick={() => onLocateEmployee(p.employeeId)}
                    className="w-full text-left rounded-2xl bg-white/70 backdrop-blur-xl border border-white/50 shadow-card p-3 hover:shadow-md transition-shadow"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${PERSON_STYLE[p.type]}`}
                      >
                        {PERSON_LABEL[p.type]}
                      </span>
                      <span className="text-sm font-semibold text-slate-800">{p.name}</span>
                      <span className="text-[10px] text-slate-400">{p.employeeId}</span>
                      {p.isVirtual && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-600 font-medium">
                          兼岗
                        </span>
                      )}
                      {p.type === 'added' && !p.toDeptName && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 font-medium">
                          未入架构
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {p.type === 'moved-dept' && (
                        <>
                          {p.fromDeptName ?? '未入架构'} <span className="text-slate-300">→</span>{' '}
                          {p.toDeptName ?? '未入架构'}
                        </>
                      )}
                      {p.type === 'moved-reporting' && (
                        <>
                          {p.toDeptName ?? ''}
                          {p.toDeptName ? ' · ' : ''}汇报线：{p.fromLeaderName ?? '—'}{' '}
                          <span className="text-slate-300">→</span> {p.toLeaderName ?? '—'}
                        </>
                      )}
                      {p.type === 'added' && <>新增至 {p.toDeptName ?? '未入架构'}</>}
                      {p.type === 'removed' && <>从 {p.fromDeptName ?? '未知部门'} 移除</>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* 缺口与成本汇总 */}
          <section>
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
              缺口与成本汇总
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <div className="rounded-2xl bg-white/70 backdrop-blur-xl border border-white/50 shadow-card p-4">
                <div className="text-xs text-slate-500">总编制</div>
                <div className="mt-1 text-xl font-bold tabular-nums text-slate-800 text-right">
                  {fmt(bTotals.totalHeadcount)} <span className="text-slate-300 text-sm">→</span> {fmt(tTotals.totalHeadcount)}
                </div>
                <div className="text-[11px] tabular-nums">
                  <DeltaText delta={diff.totals.headcountDelta} format={(n) => `${n} 人`} />
                </div>
              </div>
              <div className="rounded-2xl bg-white/70 backdrop-blur-xl border border-white/50 shadow-card p-4">
                <div className="text-xs text-slate-500">总人数</div>
                <div className="mt-1 text-xl font-bold tabular-nums text-slate-800 text-right">
                  {bTotals.totalEmployees} <span className="text-slate-300 text-sm">→</span> {tTotals.totalEmployees}
                </div>
                <div className="text-[11px] tabular-nums">
                  <DeltaText delta={employeesDelta} format={(n) => `${n} 人`} />
                </div>
              </div>
              <div className="rounded-2xl bg-white/70 backdrop-blur-xl border border-white/50 shadow-card p-4">
                <div className="text-xs text-slate-500">总缺口</div>
                <div className="mt-1 text-xl font-bold tabular-nums text-slate-800 text-right">
                  {fmt(bTotals.totalGap)} <span className="text-slate-300 text-sm">→</span> {fmt(tTotals.totalGap)}
                </div>
                <div className="text-[11px] tabular-nums">
                  <DeltaText delta={diff.totals.gapDelta} format={(n) => `${n} 人`} />
                </div>
              </div>
              <div className="rounded-2xl bg-white/70 backdrop-blur-xl border border-white/50 shadow-card p-4">
                <div className="text-xs text-slate-500">月人力成本</div>
                <div className="mt-1 text-xl font-bold tabular-nums text-slate-800 text-right">
                  {fmtCost(bTotals.totalCost)} <span className="text-slate-300 text-sm">→</span> {fmtCost(tTotals.totalCost)}
                </div>
                <div className="text-[11px] tabular-nums">
                  <DeltaText delta={diff.totals.costDelta} format={(n) => `${n}w`} />
                </div>
              </div>
              <div className="rounded-2xl bg-white/70 backdrop-blur-xl border border-white/50 shadow-card p-4">
                <div className="text-xs text-slate-500">缺口成本</div>
                <div className="mt-1 text-xl font-bold tabular-nums text-slate-800 text-right">
                  {fmtCost(bTotals.totalGapCost)} <span className="text-slate-300 text-sm">→</span>{' '}
                  {fmtCost(tTotals.totalGapCost)}
                </div>
                <div className="text-[11px] tabular-nums">
                  <DeltaText delta={diff.totals.gapCostDelta} format={(n) => `${n}w`} />
                </div>
              </div>
            </div>
            <p className="mt-2 flex items-center gap-1 text-[10px] text-slate-400">
              <Users className="w-3 h-3" />
              人员调动可点击定位；数据随场景实时派生，不持久化新增字段。
            </p>
          </section>
        </div>
      </aside>
    </div>
  );
}
