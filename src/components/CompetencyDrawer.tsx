import { useDialogFocus } from '../utils/useDialogFocus';
import { useMemo, useState } from 'react';
import {
  X,
  Target,
  Briefcase,
  ChevronDown,
  ChevronRight,
  Building2,
  ClipboardList,
  SlidersHorizontal,
  AlertTriangle,
  UserMinus,
} from 'lucide-react';
import { Assessment, CompetencyModel, Department, Employee, LevelConfig, MatchStatus, Position, PositionAssignment } from '../types';
import { MatchResult } from '../utils/match';
import { CompetencySummary } from '../utils/competency';
import {
  BOARD_FILTER_LABEL,
  PENDING_REVIEW_LABEL,
  deriveBoard,
  type BoardDerivation,
  type BoardFilter,
} from '../utils/boardScope';
import { employeeLevelGap } from '../utils/analytics';
import { COMPETENCY_STYLE, COMPETENCY_LABEL, CompetencyStatus, fmt } from '../utils/statusUI';

/**
 * —— v2.2.0 / v2.3 M3 胜任度看板抽屉 ——
 *
 * 独立右侧抽屉（不塞进 HealthDrawer：数量 vs 质量两类任务）。
 * v2.3 M3 起改为**统一范围派生**（utils/boardScope.deriveBoard）驱动：
 * 组织指标、岗位缺口、评价完整度、能力风险、待复核项共享同一份派生结果，
 * 汇总与明细不再各自遍历计数；支持任意层级部门下钻与「含下级 / 仅直属」切换，
 * 未评 / 部分已评 / 能力风险 / 待复核筛选，以及与详情、画布定位的联动。
 *
 * 红线：未评 = 中性灰；不合成「排兵布阵总分」；只呈现派生值不落库。
 */

/** 胜任度小环（看板/明细共用）：环形 + 图标 + title 带分值/阈值（可解释，visual §3.2） */
export function CompetencyRing({
  status,
  score,
  threshold,
}: {
  status: CompetencyStatus;
  score?: number | null;
  threshold?: number | null;
}) {
  const s = COMPETENCY_STYLE[status];
  return (
    <span
      className={`inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border-2 text-[9px] font-bold leading-none shrink-0 ${s.ring} ${s.text}`}
      title={`胜任度 · ${COMPETENCY_LABEL[status]} · 综合 ${score == null ? '—' : fmt(score)} · 阈值 ${threshold == null ? '—' : fmt(threshold)}`}
      aria-label={`胜任度：${COMPETENCY_LABEL[status]}`}
    >
      {s.glyph}
    </span>
  );
}

/** 展开态/看板胶囊（带分值，visual §3.2） */
export function CompetencyCapsule({
  status,
  score,
}: {
  status: CompetencyStatus;
  score?: number | null;
}) {
  const s = COMPETENCY_STYLE[status];
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-xs font-semibold ${s.ring} ${s.text}`}
    >
      {s.glyph} {score == null ? COMPETENCY_LABEL[status] : fmt(score)}
    </span>
  );
}

/** 常驻图例（visual §4.5：形状谱系 + 灰=未评；防「四灯同色」混淆） */
function LegendBar() {
  const states: CompetencyStatus[] = ['healthy', 'warn', 'danger', 'unrated'];
  return (
    <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-2">
      <div className="text-xs uppercase tracking-wider text-slate-500 mb-1.5">图例</div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {states.map((st) => (
          <span key={st} className={`inline-flex items-center gap-1 text-xs ${COMPETENCY_STYLE[st].text}`}>
            <span className={`inline-flex items-center justify-center w-3 h-3 rounded-full border-2 text-[8px] font-bold leading-none ${COMPETENCY_STYLE[st].ring} ${COMPETENCY_STYLE[st].text}`}>
              {COMPETENCY_STYLE[st].glyph}
            </span>
            {COMPETENCY_LABEL[st]}
          </span>
        ))}
        <span className="inline-flex items-center gap-1 text-xs text-slate-500">
          <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />匹配点
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-slate-500">
          <span className="inline-flex items-center justify-center w-3 h-3 rounded-full border-2 border-red-400 text-[8px] font-bold text-red-700 bg-red-50">×</span>
          不胜任(已确认)
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-slate-500">
          <span className="text-xs px-1 rounded bg-amber-100 text-amber-600 font-medium">+N</span>职级差距
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-slate-500">
          <span className="text-xs px-1 rounded bg-slate-100 text-slate-500 font-medium">–</span>无数据/未评分
        </span>
      </div>
    </div>
  );
}

/** 员工胜任度状态（未评 → unrated 灰，绝不伪装绿/红） */
function summaryStatus(s: CompetencySummary | undefined): CompetencyStatus {
  return s?.overall ? s.overall.status : 'unrated';
}

interface CompetencyDrawerProps {
  open: boolean;
  onClose: () => void;
  /** 胜任度汇总（computeCompetencyStates 输出，key = Employee.id） */
  competencySummaries: Map<string, CompetencySummary>;
  /** 人岗匹配状态（computeMatchStates 输出，供 L3 匹配点） */
  matchStates: MatchResult[];
  /** 部门树（唯一真值；L1/L2/L3 穿透数据源） */
  departments: Department[];
  /** 全量员工扁平列表（L2 岗位在岗反查用） */
  allEmployees: Employee[];
  /** 全量岗位扁平列表（空缺标记 / 岗位信息用） */
  allPositions: Position[];
  /** v2.3 M3：统一范围派生输入（缺省时按空场景降级，保证组件可独立渲染） */
  assessments?: Assessment[];
  competencyModel?: CompetencyModel;
  positionAssignments?: PositionAssignment[];
  levelConfigs?: LevelConfig[];
  /** v2.3 M3：导出/交付入口（消费同一份 board 派生结果） */
  onExportGapList?: (board: BoardDerivation) => void;
  /** 点击部门卡 → 画布定位该部门 */
  onFocusDept: (deptId: string) => void;
  /** 点击员工行 → 打开胜任度详情 */
  onOpenDetail: (empId: string) => void;
  /** 发起批量评估（打开 BatchAssessmentModal） */
  onStartBatch: () => void;
  /** 打开维度配置（CompetencyModelModal） */
  onOpenModelConfig: () => void;
  /** 已人工确认不胜任的 employeeId 集合 */
  confirmedNotCompetent?: ReadonlySet<string>;
}

export function CompetencyDrawer({
  open,
  onClose,
  competencySummaries,
  matchStates,
  departments,
  allEmployees,
  allPositions,
  assessments = [],
  competencyModel,
  positionAssignments = [],
  levelConfigs = [],
  onExportGapList,
  onFocusDept,
  onOpenDetail,
  onStartBatch,
  onOpenModelConfig,
  confirmedNotCompetent,
}: CompetencyDrawerProps) {
  // 本地「聚焦部门」state（点击部门卡聚焦；同时调用 onFocusDept 定位画布）
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(null);
  /** v2.3 M3：范围是否含下级（默认含，与部门汇总口径一致） */
  const [includeChildren, setIncludeChildren] = useState(true);
  /** v2.3 M3：明细筛选 */
  const [filter, setFilter] = useState<BoardFilter>('all');
  // L2 岗位展开（已展开岗位 id 集合）
  const [expandedPosIds, setExpandedPosIds] = useState<Set<string>>(() => new Set());

  const emptyModel: CompetencyModel = useMemo(() => ({ dimensions: [] }), []);
  /** v2.3 M3：本次看板唯一派生结果（汇总、下钻、导出共用） */
  const board = useMemo(
    () => deriveBoard({
      departments,
      allEmployees,
      allPositions,
      assessments,
      competencyModel: competencyModel ?? emptyModel,
      positionAssignments,
      levelConfigs,
      competencySummaries,
      matchStates,
      ...(confirmedNotCompetent ? { confirmedNotCompetent } : {}),
      scopeDeptId: selectedDeptId,
      includeChildren,
      filter,
    }),
    [departments, allEmployees, allPositions, assessments, competencyModel, emptyModel, positionAssignments,
      levelConfigs, competencySummaries, matchStates, confirmedNotCompetent, selectedDeptId, includeChildren, filter],
  );

  const dialogRef = useDialogFocus(open, onClose);
  const matchById = useMemo(
    () => new Map<string, MatchResult>(matchStates.map((r) => [r.employeeId, r])),
    [matchStates],
  );
  const positionById = useMemo(
    () => new Map<string, Position>(allPositions.map((p) => [p.id, p])),
    [allPositions],
  );

  if (!open) return null;

  const togglePosition = (pid: string) => {
    setExpandedPosIds((prev) => {
      const next = new Set(prev);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
  };

  /** L3 员工行（通用）：匹配点 + 职级差距 + 胜任度环 + 总分 + 待复核标记 */
  const renderEmployeeRow = (row: BoardDerivation['rows'][number]) => {
    const emp = allEmployees.find((e) => e.id === row.employeeId);
    if (!emp) return null;
    const match = matchById.get(emp.id);
    const summary = competencySummaries.get(emp.id);
    const st = summaryStatus(summary);
    const score = summary?.overall?.score ?? null;
    const threshold =
      summary?.overall != null ? summary.overall.score + summary.overall.gap : null;
    const gap = employeeLevelGap(emp);
    const isConfirmed = confirmedNotCompetent?.has(emp.id) ?? false;
    const isCandidate = summary?.notCompetentCandidate === true;
    const matchDot: Record<MatchStatus, string> = {
      placed: 'bg-emerald-500',
      unassigned: 'bg-amber-500',
      overstaffed: 'bg-red-500',
      not_competent: 'bg-red-50 border border-red-400',
    };
    return (
      <div
        key={emp.id}
        className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-indigo-50/50 transition-colors cursor-pointer"
        onClick={() => onOpenDetail(emp.id)}
        role="button"
        tabIndex={0}
        aria-label={`查看 ${emp.name} 的胜任度详情`}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            onOpenDetail(emp.id);
          }
        }}
        title="点击查看胜任度详情"
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${match ? matchDot[match.status] : 'bg-slate-200'}`} />
        <span className="text-xs text-slate-700 truncate min-w-0 flex-1">{emp.name}</span>
        {emp.positionId && (
          <span className="text-xs text-slate-500 truncate max-w-[120px]">
            {positionById.get(emp.positionId)?.name ?? '—'}
          </span>
        )}
        {gap && (
          <span
            className={`text-xs px-1 rounded font-medium shrink-0 ${
              gap.status === 'healthy'
                ? 'bg-emerald-100 text-emerald-600'
                : gap.status === 'warn'
                  ? 'bg-amber-100 text-amber-600'
                  : 'bg-red-100 text-red-600'
            }`}
            title={`目标 ${emp.targetLevel ?? '—'} · ${gap.label}`}
          >
            {gap.gap > 0 ? `+${gap.gap}` : gap.gap}
          </span>
        )}
        <CompetencyRing status={st} score={score} threshold={threshold} />
        <span className="text-xs text-slate-500 w-8 text-right tabular-nums shrink-0">
          {score == null ? '—' : fmt(score)}
        </span>
        {emp.positionId && (isCandidate || isConfirmed) && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              // v2.3 M2：复核必须记录复核人与依据 → 统一在详情弹窗完成，不在列表一键落结论
              onOpenDetail(emp.id);
            }}
            className={`shrink-0 text-xs px-1.5 py-0.5 rounded-md border font-medium transition-colors ${
              isConfirmed
                ? 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100'
                : 'border-slate-200 bg-white text-slate-500 hover:border-red-300 hover:text-red-600'
            }`}
            title={
              isConfirmed
                ? '已人工确认不胜任；在详情中撤销并留痕'
                : '胜任度红灯候选（worstGap≥2）→ 在详情中人工确认（需填写复核人与依据）'
            }
          >
            {isConfirmed ? '已确认不胜任 →' : '去复核'}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-[80]">
      {/* 轻遮罩 */}
      <div className="absolute inset-0 bg-slate-900/10 backdrop-blur-[2px]" onClick={onClose} />
      {/* 抽屉 */}
      <aside ref={dialogRef} role="dialog" aria-modal="true" aria-label="胜任度看板" tabIndex={-1} className="absolute inset-y-0 right-0 competency-drawer w-[760px] max-w-full bg-white border-l border-white/40 shadow-2xl flex flex-col animate-slideInRight">
        {/* 头部 */}
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <Target className="w-4 h-4 text-indigo-500" />
              {selectedDeptId ? `${board.scopeLabel.split('（')[0]} · 胜任度` : '胜任度'}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              选择部门查看岗位和人员，点击姓名复核评分依据
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onStartBatch}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 transition-all"
            >
              <ClipboardList className="w-4 h-4" />
              发起批量评估
            </button>
            <button
              onClick={onOpenModelConfig}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium text-slate-600 border border-slate-200 bg-white/70 hover:bg-slate-50 transition-colors"
              title="维度配置：新增/停用/权重/定义"
            >
              <SlidersHorizontal className="w-4 h-4" />
              维度配置
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-600 transition-colors"
              aria-label="关闭"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">
          {/* 常驻图例 */}
          <LegendBar />

          {/* v2.3 M3：统一范围条（当前范围 + 含下级 / 仅直属 + 返回上一层） */}
          <section className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Building2 className="w-3.5 h-3.5 text-slate-500" />
              <span className="text-xs text-slate-500">当前范围</span>
              <span className="text-sm font-semibold text-slate-800">{board.scopeLabel}</span>
              <div className="ml-auto flex items-center gap-1.5">
                {board.breadcrumb.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => setSelectedDeptId(b.id)}
                    className="text-xs text-indigo-600 hover:underline"
                  >
                    {b.name}
                  </button>
                ))}
                {selectedDeptId && (
                  <button
                    onClick={() => { setSelectedDeptId(null); }}
                    className="text-xs text-indigo-600 hover:underline"
                  >
                    {board.breadcrumb.length > 0 ? '← 全公司' : '← 全公司'}
                  </button>
                )}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
              <label className="flex items-center gap-1.5 text-slate-600 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeChildren}
                  onChange={(e) => setIncludeChildren(e.target.checked)}
                  className="accent-indigo-500"
                />
                含下级部门
              </label>
              <span className="text-slate-500">
                {board.summary.deptCount} 个部门 · {board.summary.employeeCount} 人（真人去重）
              </span>
              {onExportGapList && (
                <button
                  onClick={() => onExportGapList(board)}
                  className="ml-auto px-2.5 py-1 rounded-lg text-xs font-medium border border-indigo-200 bg-white text-indigo-600 hover:bg-indigo-50 transition-colors"
                  title="导出岗位缺口事实清单（与当前范围、筛选一致；默认不含个人评价明细）"
                >
                  导出岗位缺口清单
                </button>
              )}
            </div>
          </section>

          {/* A27：未入架构人员独立提示，不混入任何部门分母 */}
          {board.unplaced.count > 0 && (
            <section className="rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2 text-xs text-amber-800">
              <span className="inline-flex items-center gap-1.5 font-medium">
                <UserMinus className="w-3.5 h-3.5" />
                全公司另有 {board.unplaced.count} 人已入名册但未进入组织架构
              </span>
              <span className="ml-1 text-amber-700">
                （不计入任何部门人数与完整度分母；示例：{board.unplaced.names.slice(0, 3).join('、')}
                {board.unplaced.count > 3 ? ' 等' : ''}）
              </span>
            </section>
          )}

          {/* v2.3 M3：五块口径并列，不合成「排兵布阵总分」 */}
          <section className="grid grid-cols-1 min-[560px]:grid-cols-2 gap-3">
            <div className="rounded-xl bg-white border border-slate-200 p-3">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">组织指标</h3>
              <div className="space-y-1 text-xs text-slate-600">
                <div>人数：<b className="tabular-nums">{board.summary.employeeCount}</b>（真人去重）</div>
                <div>部门数：<b className="tabular-nums">{board.summary.deptCount}</b></div>
                <div>
                  管理幅度中位数：
                  <b className="tabular-nums">{fmt(board.organization.totals.totalEmployees === 0 ? null : (board.organization.report.l2.find((m) => m.key === 'span')?.value ?? null))}</b>
                </div>
                <div>
                  层级深度：
                  <b className="tabular-nums">{fmt(board.organization.report.l2.find((m) => m.key === 'depth')?.value ?? null)}</b>
                </div>
                <div>
                  总编制：
                  <b className="tabular-nums">{board.organization.totals.totalHeadcount ?? '未配置'}</b>
                  {board.organization.totals.totalGap !== null && (
                    <span className="ml-1 text-slate-500">（净差 {board.organization.totals.totalGap}，仅供参考）</span>
                  )}
                </div>
              </div>
            </div>

            <div className="rounded-xl bg-white border border-slate-200 p-3">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">岗位缺口</h3>
              <div className="space-y-1 text-xs text-slate-600">
                <div>待补：<b className="tabular-nums text-amber-600">{board.summary.positionGap.pendingTotal}</b> 人 · {board.summary.positionGap.pendingPositions} 个岗位</div>
                <div>超额：<b className="tabular-nums text-red-600">{board.summary.positionGap.overflowTotal}</b> 人 · {board.summary.positionGap.overflowPositions} 个岗位</div>
                <div className="text-slate-500">冻结岗位 {board.summary.positionGap.frozen} 个 · 未配置编制 {board.summary.positionGap.unconfigured} 个</div>
                <div className="text-[10px] text-slate-500 leading-snug">待补与超额分别求和；净额只作补充，不以超编抵消待补。</div>
              </div>
            </div>

            <div className="rounded-xl bg-white border border-slate-200 p-3">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">评价完整度</h3>
              <div className="space-y-1 text-xs text-slate-600">
                <div>应评合计：<b className="tabular-nums">{board.summary.completeness.expectedTotal}</b> 维度 · 有效已评 <b className="tabular-nums">{board.summary.completeness.assessedTotal}</b></div>
                <div>完整达标：<b className="tabular-nums text-emerald-600">{board.summary.completeness.qualified}</b> 人（完整已评且绿）</div>
                <div className="text-slate-500">
                  部分已评 {board.summary.completeness.partial} · 未评 {board.summary.completeness.unrated} · 模型未配置 {board.summary.completeness.modelUnconfigured}
                </div>
                <div className="text-[10px] text-slate-500 leading-snug">部分已评、未评、模型未配置分别列出，不与风险人数相加。</div>
              </div>
            </div>

            <div className="rounded-xl bg-white border border-slate-200 p-3">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">能力风险 · 待复核</h3>
              <div className="space-y-1 text-xs text-slate-600">
                <div>
                  绿 {board.summary.risk.healthy} · 黄 {board.summary.risk.warn} · 红 {board.summary.risk.danger} · 未评 {board.summary.risk.unrated}
                </div>
                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  <span className="inline-flex items-center gap-1 text-amber-700">
                    <AlertTriangle className="w-3 h-3" />
                    待复核 {board.summary.pendingReview.total} 人
                  </span>
                  <span className="text-[10px] text-slate-500">
                    红灯候选 {board.summary.pendingReview.candidate} · 依据已变 {board.summary.pendingReview.staleBasis} · 冲突 {board.summary.pendingReview.conflict}
                  </span>
                </div>
                {board.summary.completeness.conflicted > 0 && (
                  <div className="text-[10px] text-red-600">存在数据问题：{board.summary.completeness.conflicted} 人存在未解决评分冲突</div>
                )}
                {board.summary.completeness.historical > 0 && (
                  <div className="text-[10px] text-slate-500">{board.summary.completeness.historical} 人仅有历史岗位评价，适用性待复核</div>
                )}
              </div>
            </div>
          </section>

          {/* 下钻：下一层部门卡片 */}
          {board.deptCards.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
                {selectedDeptId ? '下级部门' : '一级部门'}（点击下钻并定位画布）
              </h3>
              <div className="grid grid-cols-1 min-[540px]:grid-cols-2 gap-3">
                {board.deptCards.map((card) => {
                  const total = card.employeeCount;
                  const pct = (n: number) => (total === 0 ? 0 : Math.round((n / total) * 100));
                  return (
                    <button
                      key={card.deptId}
                      onClick={() => {
                        setSelectedDeptId(card.deptId);
                        onFocusDept(card.deptId);
                      }}
                      className={`min-w-0 rounded-xl bg-white border border-slate-200 p-4 text-left transition-all hover:shadow-md ${
                        selectedDeptId === card.deptId ? 'ring-2 ring-indigo-400' : ''
                      }`}
                      title="点击下钻该部门（并画布定位）"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-sm font-bold text-slate-800 truncate flex items-center gap-1">
                          {card.name}
                          {card.hasChildren && <ChevronRight className="w-3 h-3 text-slate-400" />}
                        </span>
                        <span className="text-xs text-slate-500 shrink-0">{total} 人</span>
                      </div>
                      <div className="flex h-2 rounded-full overflow-hidden bg-slate-100">
                        <div className="bg-emerald-500" style={{ width: `${pct(card.risk.healthy)}%` }} />
                        <div className="bg-amber-500" style={{ width: `${pct(card.risk.warn)}%` }} />
                        <div className="bg-red-500" style={{ width: `${pct(card.risk.danger)}%` }} />
                        <div className="bg-slate-300" style={{ width: `${pct(card.risk.unrated)}%` }} />
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-emerald-600">绿 {card.risk.healthy}</span>
                        <span className="text-amber-600">黄 {card.risk.warn}</span>
                        <span className="text-red-600">红 {card.risk.danger}</span>
                        <span className="text-slate-500">未评 {card.risk.unrated}</span>
                        <span className="ml-auto text-slate-500">
                          {card.positionGap.pendingTotal > 0 && <span className="text-amber-600">待补 {card.positionGap.pendingTotal} </span>}
                          {card.positionGap.overflowTotal > 0 && <span className="text-red-600">超额 {card.positionGap.overflowTotal}</span>}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* 筛选（作用于明细与导出，同一份 filteredRows） */}
          <section className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500">筛选</span>
            {(Object.keys(BOARD_FILTER_LABEL) as BoardFilter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                  filter === f
                    ? 'bg-indigo-500 text-white border-indigo-500'
                    : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'
                }`}
              >
                {BOARD_FILTER_LABEL[f]}
              </button>
            ))}
            <span className="text-xs text-slate-500 ml-auto">明细 {board.filteredRows.length} / {board.rows.length} 人</span>
          </section>

          {/* 岗位与人员明细（范围与汇总一致） */}
          <section>
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
              {board.scopeLabel} · 岗位与人员
            </h3>

            {board.positions.length > 0 && (
              <div className="space-y-2">
                {board.positions.map((pos) => {
                  const occupants = board.rows.filter((r) => r.positionId === pos.positionId);
                  const counts = { healthy: 0, warn: 0, danger: 0, unrated: 0 };
                  for (const r of occupants) counts[r.status === 'unrated' ? 'unrated' : r.status] += 1;
                  const total = occupants.length;
                  const pct = (n: number) => (total === 0 ? 0 : Math.round((n / total) * 100));
                  const noCompetent = total > 0 && counts.danger === total;
                  const isExpanded = expandedPosIds.has(pos.positionId);
                  return (
                    <div key={pos.positionId} className="rounded-xl bg-slate-50 border border-slate-200 overflow-hidden">
                      <div className="flex items-center gap-1.5 px-3 py-2">
                        <button
                          onClick={() => togglePosition(pos.positionId)}
                          className="p-0.5 rounded text-slate-500 hover:text-indigo-600"
                          title={isExpanded ? '收起员工' : '展开员工'}
                        >
                          {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                        </button>
                        <Briefcase className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                        <span className="text-sm font-medium text-slate-700 truncate">{pos.name}</span>
                        {pos.secondaryRelations > 0 && (
                          <span className="shrink-0 text-[10px] px-1 rounded bg-violet-50 text-violet-600" title="兼岗关系数（不占第二个编制名额）">
                            兼岗 {pos.secondaryRelations}
                          </span>
                        )}
                        <span
                          className={`ml-auto shrink-0 text-xs font-medium ${
                            pos.headcountStatus !== 'configured'
                              ? 'text-slate-500'
                              : pos.pendingCount > 0
                                ? 'text-amber-600'
                                : pos.overflowCount > 0
                                  ? 'text-red-600'
                                  : 'text-emerald-600'
                          }`}
                          title={
                            pos.headcountStatus === 'frozen'
                              ? '编制已冻结，不计待补缺口'
                              : pos.headcountStatus === 'unconfigured'
                                ? '未配置编制（不视为明确零编制）'
                                : `编制 ${pos.headcount} · 主岗占用 ${pos.primaryOccupied} · 净缺口 ${pos.netGap}`
                          }
                        >
                          {pos.headcountStatus === 'frozen'
                            ? '冻结'
                            : pos.headcountStatus === 'unconfigured'
                              ? '未配置'
                              : pos.pendingCount > 0
                                ? `待补 ${pos.pendingCount}`
                                : pos.overflowCount > 0
                                  ? `超额 ${pos.overflowCount}`
                                  : '满编'}
                        </span>
                        {noCompetent && (
                          <span className="shrink-0 text-xs px-1.5 py-0.5 rounded-full bg-red-50 text-red-600 border border-red-200">
                            无胜任者
                          </span>
                        )}
                      </div>
                      <div className="px-3 pb-1">
                        <div className="flex h-1.5 rounded-full overflow-hidden bg-slate-100">
                          <div className="bg-emerald-500" style={{ width: `${pct(counts.healthy)}%` }} />
                          <div className="bg-amber-500" style={{ width: `${pct(counts.warn)}%` }} />
                          <div className="bg-red-500" style={{ width: `${pct(counts.danger)}%` }} />
                          <div className="bg-slate-300" style={{ width: `${pct(counts.unrated)}%` }} />
                        </div>
                        <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                          <span className="text-emerald-600">绿 {counts.healthy}</span>
                          <span className="text-amber-600">黄 {counts.warn}</span>
                          <span className="text-red-600">红 {counts.danger}</span>
                          <span>未评 {counts.unrated}</span>
                          <span className="ml-auto">主岗占用 {pos.primaryOccupied} 人</span>
                        </div>
                      </div>
                      {isExpanded && (
                        <div className="px-2 pb-2 pt-1 border-t border-slate-100">
                          {occupants.length === 0 ? (
                            <div className="text-[11px] text-slate-500 text-center py-2">该岗位暂无在岗员工</div>
                          ) : (
                            <div className="space-y-0.5">{occupants.map(renderEmployeeRow)}</div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* 未套岗 / 未落入当前筛选的人员明细 */}
            {(() => {
              const inPosition = new Set(board.positions.map((p) => p.positionId));
              const loose = board.filteredRows.filter((r) => !r.positionId || !inPosition.has(r.positionId));
              return (
                <div className="rounded-xl bg-slate-50 border border-slate-200 p-2 mt-2">
                  {loose.length === 0 ? (
                    <div className="text-[11px] text-slate-500 text-center py-2">
                      {board.rows.length === 0 ? '当前范围暂无员工' : '当前筛选下没有未套岗人员'}
                    </div>
                  ) : (
                    <div className="space-y-0.5">{loose.map(renderEmployeeRow)}</div>
                  )}
                </div>
              );
            })()}
          </section>

          {/* 数据问题（可见，不静默） */}
          {board.dataIssues.length > 0 && (
            <section className="rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2 text-[11px] text-amber-800 space-y-0.5">
              {board.dataIssues.slice(0, 5).map((issue) => (
                <div key={issue}>· {issue}</div>
              ))}
            </section>
          )}

          {/* 待复核清单（可点击进入详情，复核人在详情中填写） */}
          {filter === 'pending-review' && board.filteredRows.length > 0 && (
            <section className="rounded-xl border border-amber-200 bg-white px-3 py-2">
              <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">待复核项</h3>
              <ul className="space-y-1 text-xs text-slate-600">
                {board.filteredRows.map((r) => (
                  <li key={r.employeeId} className="flex items-center gap-2">
                    <button onClick={() => onOpenDetail(r.employeeId)} className="text-indigo-600 hover:underline">
                      {r.name}
                    </button>
                    <span className="text-slate-500">{r.deptPath}</span>
                    <span className="ml-auto px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[10px]">
                      {r.pendingReview ? PENDING_REVIEW_LABEL[r.pendingReview] : '—'}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* 底部说明（红线：只呈现、不下结论） */}
          <p className="text-xs text-slate-500 leading-snug">
            胜任度灯 = 最差维度 Gap（木桶）：绿=达标 / 黄=待提升 / 红=不胜任候选（worstGap≥2，需人工确认）。
            未评 = 中性灰，不计入红黄绿。完整达标只统计「完整已评且绿」。
            本页组织指标 / 岗位缺口 / 完整度 / 风险各有口径，不合成总分；只呈现可追溯依据，不自动定级 / 晋升 / 淘汰。
          </p>
        </div>
      </aside>
    </div>
  );
}
