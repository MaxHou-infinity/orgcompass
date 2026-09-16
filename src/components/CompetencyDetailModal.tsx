import { useState } from 'react';
import { AppModal } from './AppModal';
import { Employee, MatchStatus, Position } from '../types';
import {
  CompetencySummary,
  LeadershipDossier,
  levelRequirement,
  listAssessmentHistory,
  positionBandRequirement,
} from '../utils/competency';
import type { ReviewEvent } from '../utils/assignment';
import { parseLevelNumber } from '../utils/analytics';
import { COMPETENCY_STYLE, COMPETENCY_LABEL, fmt } from '../utils/statusUI';
import { CompetencyCapsule, CompetencyRing } from './CompetencyDrawer';
import { Info, History, UserCheck, CalendarClock, ClipboardCheck, AlertTriangle } from 'lucide-react';

/**
 * —— v2.2.0 胜任度详情弹窗（design §9 = ux §2.2 = od §1.3）——
 *
 * 分维度分值 + Gap + 基准（可点开口径）+ 评分人 + 时间 + 历史轨迹。
 * 干部时附「定管理职级依据」只读块，显式标注「本工具只呈现依据，不自动定级/晋升」（红线）。
 * 数据全部由 props 传入（App 层用 computeCompetencySummary / buildLeadershipDossier /
 * listAssessmentHistory 派生好再传）。
 */

const MATCH_DOT_LABEL: Record<MatchStatus, string> = {
  placed: '已套岗',
  unassigned: '未套岗',
  overstaffed: '超编',
  not_competent: '不胜任（已确认）',
};

/** v2.3 M2：完整度状态文案（与能力灯号分开表达） */
const COMPLETENESS_LABEL: Record<CompetencySummary['completeness']['status'], string> = {
  'model-unconfigured': '模型未配置（分母不可算）',
  unrated: '未评',
  partial: '部分已评',
  complete: '完整已评',
};

/** v2.3 M2：评价来源文案（能力信号可追溯） */
const APPLICABILITY_LABEL: Record<'current' | 'current-position' | 'general', string> = {
  current: '当前任职',
  'current-position': '按当前岗位核对（旧记录，未绑定具体任职）',
  general: '通用评价（不限岗位）',
};

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface CompetencyDetailModalProps {
  assignments?: import('../types').PositionAssignment[];
  /** v2.3 M2：该员工的全部人工复核事件（含已撤销与历史确认） */
  reviews?: ReviewEvent[];
  open: boolean;
  onClose: () => void;
  employee: Employee | null;
  /** 员工当前岗位（基准口径展示用） */
  position: Position | null;
  /** computeCompetencySummary 输出（未评员工 = null） */
  summary: CompetencySummary | null;
  /** buildLeadershipDossier 输出（非干部/无领导力评估 = null） */
  dossier: LeadershipDossier | null;
  /** listAssessmentHistory 输出（历史轨迹，含软删/orphan 维度） */
  history: ReturnType<typeof listAssessmentHistory>;
  /** 人岗匹配状态（标题行展示） */
  matchStatus?: MatchStatus;
  /** employeeId → 姓名（评分人可追溯展示） */
  resolveName: (id: string) => string;
  /** v2.3 M2：人工复核（确认/撤销）录入；复核人必填，依据/原因可留痕 */
  onReview?: (employeeId: string, confirmed: boolean, payload: { reviewer: string; reason?: string }) => void;
}

/** 基准口径「?」说明：Gap 相对什么基准（可点开，不黑盒） */
function BenchmarkNote({
  requirement,
  position,
  employee,
}: {
  requirement: number;
  position: Position | null;
  employee: Employee;
}) {
  const [open, setOpen] = useState(false);
  const b2 = positionBandRequirement(position ?? undefined);
  const b1 = levelRequirement(parseLevelNumber(employee.level));
  return (
    <span className="relative inline-flex items-center">
      <span className="inline-flex items-center gap-1 text-xs tabular-nums text-slate-700">
        {requirement}
        <button
          type="button"
          aria-label="基准口径说明"
          onClick={() => setOpen((o) => !o)}
          className="w-3.5 h-3.5 rounded-full bg-slate-200 hover:bg-slate-300 text-slate-500 grid place-items-center text-[9px] font-bold leading-none"
        >
          ?
        </button>
      </span>
      {open && (
        <span className="absolute right-0 top-5 z-20 w-72 rounded-lg bg-white/95 backdrop-blur border border-slate-200 shadow-lg p-2.5 text-[11px] text-slate-600 leading-snug">
          <div className="font-semibold text-slate-700 mb-1">基准（要求分）口径</div>
          <div>评估时快照要求分：<b>{requirement}</b>（冻结时点标准，改岗位带宽不影响历史灯号）</div>
          <div className="mt-1">
            · 岗位带宽（B2）：{position ? `${position.name} ${position.levelBandMin ?? '未设'} → ${b2 ?? '—'}` : '未套岗 → —'}
          </div>
          <div>· 职级（B1）：{employee.level} → {b1}</div>
          <div>· 缺省：3（无 B2/B1 时）</div>
          <div className="mt-1 text-slate-500">Gap = 要求分 − 原始分（正 = 不足）；灯号 = 最差维度 Gap。</div>
        </span>
      )}
    </span>
  );
}

export function CompetencyDetailModal({
  open,
  onClose,
  employee,
  position,
  summary,
  dossier,
  history,
  matchStatus,
  resolveName,
  assignments = [],
  reviews = [],
  onReview,
}: CompetencyDetailModalProps) {
  const status = summary?.overall?.status ?? 'unrated';
  const score = summary?.overall?.score ?? null;
  const threshold = summary?.overall != null ? summary.overall.score + summary.overall.gap : null;
  const [reviewer, setReviewer] = useState('');
  const [reason, setReason] = useState('');
  const activeReview = reviews.find((r) => !r.revoked && r.appliesToCurrentRelation) ?? null;
  const canReview = Boolean(onReview && employee && assignments.some((a) => a.status === 'active' && a.type === 'primary' && !a.endDate));

  return (
    <AppModal
      open={open}
      onClose={onClose}
      title={employee ? `胜任度详情 · ${employee.name}` : '胜任度详情'}
      subtitle={
        employee
          ? `${employee.employeeId}${position ? ` · ${position.name}` : ''}${matchStatus ? ` · ${MATCH_DOT_LABEL[matchStatus]}` : ''}`
          : undefined
      }
      maxWidth="max-w-2xl"
    >
      {!employee ? (
        <div className="py-8 text-center text-sm text-slate-500">未找到员工</div>
      ) : (
        <div className="space-y-4">
          <section className="rounded-xl border border-slate-200 p-4">
            <h3 className="font-semibold text-sm text-slate-800 mb-2">任职记录</h3>
            {assignments.length === 0 ? <p className="text-xs text-slate-500">尚无任职记录；旧数据不会补造到岗时间。</p> :
              <ul className="space-y-2 text-xs text-slate-600">{assignments.filter((a) => a.status !== 'not_competent').map((a) => <li key={a.id}>
                <span className="font-medium">{a.positionName || a.positionId}</span> · {a.type === 'primary' ? '主岗' : '兼岗'} ·
                {a.status === 'ended' ? '已结束' : '当前任职'}
                <span> · {a.startDate ? formatDateTime(a.startDate) : '到岗时间未知'} → {a.endDate ? formatDateTime(a.endDate) : '至今'}{a.source === 'legacy' ? ' · 旧快照' : ' · 本次调整生效时点'}</span>
              </li>)}</ul>}
          </section>

          {/* v2.3 M2：人工复核（确认/撤销分别留痕；原确认在撤销后仍保留） */}
          <section className="rounded-xl border border-slate-200 p-4">
            <h3 className="font-semibold text-sm text-slate-800 mb-2 flex items-center gap-1.5">
              <ClipboardCheck className="w-4 h-4 text-slate-500" />
              人工复核记录
              <span className="text-[10px] font-normal text-slate-500">（复核绑定具体人岗关系，不改变任职状态）</span>
            </h3>
            {reviews.length === 0 ? (
              <p className="text-xs text-slate-500">尚无人工确认记录。能力风险是派生信号，需人工确认后才成为复核结论。</p>
            ) : (
              <ul className="space-y-2 text-xs text-slate-600">
                {reviews.map((r) => (
                  <li key={r.id} className="rounded-lg bg-slate-50 px-2.5 py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${r.revoked ? 'bg-slate-200 text-slate-600' : 'bg-red-50 text-red-700'}`}>
                        {r.revoked ? '确认已撤销（原记录保留）' : '人工确认不胜任'}
                      </span>
                      <span className="font-medium">{r.positionName || r.positionId}</span>
                      {!r.relationActive && <span className="px-1 rounded bg-slate-100 text-slate-500">关联任职已结束（仅历史）</span>}
                      {r.relationActive && !r.appliesToCurrentRelation && <span className="px-1 rounded bg-slate-100 text-slate-500">非当前任职，不继承</span>}
                      {r.staleAfterNewAssessment && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 text-[10px] font-semibold">
                          <AlertTriangle className="w-3 h-3" />
                          确认依据之后有新评分，待复核
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500">
                      确认人：{r.confirmedBy || '历史/当前记录未提供确认人'} · 确认于 {formatDateTime(r.confirmedAt ?? null)}
                      {' · '}关系：{r.relationId || '未关联任职'}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      依据说明：{r.note || '未填写'} · 引用评分：
                      {r.assessmentIds.length > 0 ? r.assessmentIds.join('、') : '未记录'}
                    </div>
                    {r.revoked && (
                      <div className="text-[11px] text-slate-500">
                        撤销人：{r.revokedBy || '未提供'} · 撤销于 {formatDateTime(r.revokedAt ?? null)} · 原因：{r.revokeReason || '未填写'}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {canReview && (
              <div className="mt-3 border-t border-slate-100 pt-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    value={reviewer}
                    onChange={(e) => setReviewer(e.target.value)}
                    placeholder="复核人（必填）"
                    aria-label="复核人"
                    className="w-36 px-2 py-1 rounded-lg border border-slate-200 text-xs focus-ring"
                  />
                  <input
                    type="text"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder={activeReview ? '撤销原因' : '确认依据说明'}
                    aria-label={activeReview ? '撤销原因' : '确认依据说明'}
                    className="flex-1 min-w-[160px] px-2 py-1 rounded-lg border border-slate-200 text-xs focus-ring"
                  />
                  <button
                    type="button"
                    disabled={!reviewer.trim()}
                    onClick={() => {
                      onReview?.(employee.id, !activeReview, {
                        reviewer: reviewer.trim(),
                        ...(reason.trim() ? { reason: reason.trim() } : {}),
                      });
                      setReason('');
                    }}
                    title={!reviewer.trim() ? '请填写复核人（本地录入身份，不声称经过认证）' : undefined}
                    className={`px-3 py-1 rounded-lg text-xs font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${activeReview ? 'bg-slate-500 hover:bg-slate-600' : 'bg-red-500 hover:bg-red-600'}`}
                  >
                    {activeReview ? '撤销确认' : '确认不胜任'}
                  </button>
                </div>
                <p className="text-[10px] text-slate-500 leading-snug">
                  「撤销确认」保留业务记录（原确认与撤销事实都可查），与编辑器「撤销刚才操作」不同；
                  系统不自动撤销人工结论，也不会把未复核的新评分展示为已复核。
                </p>
              </div>
            )}
          </section>
          {/* 当前灯 + 评分人 + 时间 */}
          <div className="rounded-2xl bg-white/70 backdrop-blur-xl border border-white/50 shadow-card p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-700">当前灯</span>
              <CompetencyCapsule status={status} score={score} />
            </div>
            {/* v2.3 M2：完整度与灯号分开（部分达标不算完整达标） */}
            {summary && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 font-medium">
                  完整度：{COMPLETENESS_LABEL[summary.completeness.status]}
                  {summary.completeness.computable ? ` ${summary.completeness.assessed}/${summary.completeness.expected}` : ''}
                </span>
                {summary.completeness.qualified && (
                  <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 font-medium">完整达标</span>
                )}
                {summary.completeness.status === 'partial' && summary.overall?.status === 'healthy' && (
                  <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">已评维度达标，整体仍为部分已评</span>
                )}
                {summary.completeness.historical.length > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                    {summary.completeness.historical.length} 个维度仅有历史岗位评价，适用性待复核
                  </span>
                )}
                {summary.completeness.dataIssue && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-50 text-red-700 font-medium">
                    <AlertTriangle className="w-3 h-3" />
                    存在数据问题：{summary.completeness.conflicted.length} 个维度评分冲突待核对
                  </span>
                )}
              </div>
            )}
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-xs text-slate-500">
              <span className="inline-flex items-center gap-1.5">
                <UserCheck className="w-3.5 h-3.5 text-slate-500" />
                评分人：{summary && summary.assessedBy.length > 0 ? summary.assessedBy.map(resolveName).join(' / ') : '—'}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <CalendarClock className="w-3.5 h-3.5 text-slate-500" />
                最近评分：{formatDateTime(summary?.latestAssessedAt ?? null)}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Info className="w-3.5 h-3.5 text-slate-500" />
                综合阈值：{threshold == null ? '—' : fmt(threshold)}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Info className="w-3.5 h-3.5 text-slate-500" />
                未评维度不计入灯号（灰 = 未评分）
              </span>
            </div>
          </div>

          {/* 分维度表 */}
          <div className="rounded-2xl bg-white/70 backdrop-blur-xl border border-white/50 shadow-card overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-100 text-sm font-semibold text-slate-700">
              分维度分值 / Gap / 基准
            </div>
            {!summary || summary.dimensions.length === 0 ? (
              <div className="px-4 py-6 text-sm text-slate-500 text-center">
                暂无评估记录 —— 未评 = 中性灰，不伪装绿/红
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-slate-500 uppercase tracking-wide border-b border-slate-100">
                    <th className="text-left px-4 py-2 font-medium">维度</th>
                    <th className="text-right px-2 py-2 font-medium">分值</th>
                    <th className="text-center px-2 py-2 font-medium">基准</th>
                    <th className="text-right px-2 py-2 font-medium">Gap</th>
                    <th className="text-center px-2 py-2 font-medium">灯</th>
                    <th className="text-left px-2 py-2 font-medium">来源 / 评分依据</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.dimensions.map((d) => (
                    <tr key={d.dimension} className="border-b border-slate-50 last:border-0">
                      <td className="px-4 py-2">
                        <div className="text-xs font-medium text-slate-700">{d.label}</div>
                        <div className="text-[10px] text-slate-500 max-w-[260px] leading-snug" title={d.definition}>
                          {d.definition}
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-slate-700">{d.score}</td>
                      <td className="px-2 py-2 text-center">
                        <BenchmarkNote requirement={d.requirement} position={position} employee={employee} />
                      </td>
                      <td className={`px-2 py-2 text-right tabular-nums font-medium ${COMPETENCY_STYLE[d.status].text}`}>
                        {d.gap > 0 ? `+${d.gap}` : d.gap}
                      </td>
                      <td className="px-2 py-2 text-center">
                        <CompetencyRing status={d.status} score={d.score} threshold={d.requirement} />
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex flex-wrap items-center gap-1 text-[10px] text-slate-500">
                          <span className="px-1 rounded bg-slate-100 text-slate-600">{APPLICABILITY_LABEL[d.applicability]}</span>
                          <span>{formatDateTime(d.assessedAt)}</span>
                          {d.assessorId && <span>· {resolveName(d.assessorId)}</span>}
                          {d.revised && <span className="px-1 rounded bg-amber-50 text-amber-700">同日修订（旧分保留）</span>}
                          {d.duplicate && <span className="px-1 rounded bg-slate-100 text-slate-600">重复记录已折叠</span>}
                          <span className="text-slate-400">· {d.assessmentId}</span>
                        </div>
                        {d.hrbpCalibration && (
                          <div className="mt-0.5 flex items-center gap-1 text-[10px]">
                            <span className="px-1 rounded bg-violet-50 text-violet-700">HRBP 校准</span>
                            <span className="tabular-nums text-slate-600">
                              {d.hrbpCalibration.score} / 要求 {d.hrbpCalibration.requirement}
                            </span>
                            <span className="text-slate-400">{formatDateTime(d.hrbpCalibration.assessedAt)}</span>
                            {d.hrbpCalibration.assessorId && <span className="text-slate-500">· {resolveName(d.hrbpCalibration.assessorId)}</span>}
                            <span className="text-slate-400">（并列对照，不参与灯号）</span>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* 干部「定管理职级依据」只读块 */}
          {dossier && dossier.dimensions.length > 0 && (
            <div className="rounded-2xl border border-indigo-100 bg-indigo-50/40 p-4">
              <div className="flex items-center gap-1.5 text-sm font-semibold text-indigo-700 mb-2">
                <Info className="w-4 h-4" />
                定管理职级依据（仅供参考，本工具不自动定级/晋升）
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-xs text-slate-600">
                <span>
                  当前领导力总分：<b className="tabular-nums">{fmt(dossier.overall?.score ?? null)}</b>
                </span>
                <span>
                  灯号：
                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold ${COMPETENCY_STYLE[dossier.overall?.status ?? 'unrated'].ring} ${COMPETENCY_STYLE[dossier.overall?.status ?? 'unrated'].text}`}>
                    {COMPETENCY_STYLE[dossier.overall?.status ?? 'unrated'].glyph}{' '}
                    {COMPETENCY_LABEL[dossier.overall?.status ?? 'unrated']}
                  </span>
                </span>
                <span>
                  目标管理职级：<b>{dossier.targetLevel ?? '—'}</b>
                </span>
                <span>
                  评分人：
                  {summary && summary.assessedBy.length > 0 ? summary.assessedBy.map(resolveName).join(' / ') : '—'}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {dossier.dimensions.map((d) => (
                  <span
                    key={d.dimension}
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold ${COMPETENCY_STYLE[d.status].ring} ${COMPETENCY_STYLE[d.status].text}`}
                    title={`${d.label}：${d.score} 分 / 要求 ${d.requirement} · Gap ${d.gap > 0 ? `+${d.gap}` : d.gap}`}
                  >
                    {d.label} {d.score}/{d.requirement}
                  </span>
                ))}
              </div>
              <p className="mt-2 text-[10px] text-indigo-400 leading-snug">
                此区块仅呈现「分值 / Gap / 灯号 / 来源」作为讨论依据；晋升 / 定级由 HR 与业务人工决策，系统不下结论。
              </p>
            </div>
          )}

          {/* 历史轨迹 */}
          <div className="rounded-2xl bg-white/70 backdrop-blur-xl border border-white/50 shadow-card overflow-hidden">
            <div className="px-4 py-2.5 border-b border-slate-100 text-sm font-semibold text-slate-700 flex items-center gap-1.5">
              <History className="w-4 h-4 text-slate-500" />
              历史轨迹（含软删/已删除维度）
            </div>
            {history.length === 0 ? (
              <div className="px-4 py-5 text-sm text-slate-500 text-center">暂无历史评估</div>
            ) : (
              <div className="max-h-64 overflow-y-auto divide-y divide-slate-50">
                {history.map((g) => (
                  <div key={g.dimension} className="px-4 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium text-slate-700">{g.label}</span>
                      {g.orphan && (
                        <span className="text-[10px] px-1 rounded bg-slate-100 text-slate-500">维度已删除</span>
                      )}
                      {!g.orphan && !g.enabled && (
                        <span className="text-[10px] px-1 rounded bg-slate-100 text-slate-500">已停用（不计当前灯号）</span>
                      )}
                      <span className="text-[10px] text-slate-500">{g.group === 'leadership' ? '领导力' : '员工'}</span>
                    </div>
                    <div className="mt-1 space-y-0.5">
                      {g.records.map((r) => (
                        <div key={r.id} className="flex items-center gap-2 text-[11px] text-slate-500">
                          <span className="tabular-nums">{formatDateTime(r.assessedAt)}</span>
                          <span className={`px-1 rounded ${r.assessorRole === 'hrbp' ? 'bg-violet-50 text-violet-600' : 'bg-slate-100 text-slate-600'}`}>
                            {r.assessorRole === 'hrbp' ? 'HRBP校准' : '上级原始分'}
                          </span>
                          <span className="tabular-nums font-medium text-slate-700">{r.score}</span>
                          <span className="text-slate-500">/ 要求 {r.requirement}</span>
                          {r.assessorId && <span>· {resolveName(r.assessorId)}</span>}
                          {r.note && <span className="text-slate-500 truncate max-w-[140px]" title={r.note}>· {r.note}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <p className="text-[10px] text-slate-500 leading-snug">
            说明：分数与 Gap 由系统按固定档位（≤0 绿 / =1 黄 / ≥2 红）计算；评分人 / 时间 / 备注可追溯，本工具不自动下结论。
          </p>
        </div>
      )}
    </AppModal>
  );
}
