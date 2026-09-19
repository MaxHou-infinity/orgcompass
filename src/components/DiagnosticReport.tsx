import { useDialogFocus } from '../utils/useDialogFocus';
import { exportCanvas } from '../utils/exportCanvas';
import { useMemo, useRef } from 'react';
import { ArrowLeft, Printer, Image as ImageIcon } from 'lucide-react';
import { Department, LevelConfig } from '../types';
import { APP_VERSION } from '../version';
import {
  computeHealthReport,
  deptHeadcount,
  collectAllSuggestions,
  HEALTH_STATUS_LABEL,
  SuggestionSeverity,
  METRIC_CALIBER_NOTES,
  PositionSummary,
} from '../utils/analytics';
import { STATUS_STYLE, fmt, fmtCost } from '../utils/statusUI';

interface DiagnosticReportProps {
  open: boolean;
  onClose: () => void;
  departments: Department[];
  levelConfigs: LevelConfig[];
  /** v2.1.1：岗位级汇总（招聘缺口/岗位级缺口表用） */
  positionSummaries?: PositionSummary[];
  projectName: string;
  scenarioName: string;
  onToast: (msg: string) => void;
}

/** 只读组织架构快照（递归嵌套，非交互，适合打印/导出） */
function ReportOrgChart({ departments }: { departments: Department[] }) {
  if (departments.length === 0) {
    return <div className="text-sm text-slate-400 py-6 text-center">暂无部门数据</div>;
  }
  return (
    <div className="flex flex-wrap gap-3 justify-center">
      {departments.map((dept) => (
        <ReportNode key={dept.id} dept={dept} />
      ))}
    </div>
  );
}

function ReportNode({ dept }: { dept: Department }) {
  const levelBg: Record<number, string> = {
    1: 'bg-indigo-50/80 border-l-indigo-400',
    2: 'bg-emerald-50/80 border-l-emerald-400',
    3: 'bg-amber-50/80 border-l-amber-400',
  };
  return (
    <div className="flex flex-col items-center">
      <div
        className={`rounded-xl border border-slate-100 border-l-4 shadow-sm px-4 py-3 text-center ${
          levelBg[dept.level] || 'bg-slate-50 border-l-slate-300'
        }`}
      >
        <div className="text-sm font-bold text-slate-800">{dept.name}</div>
        {dept.leaderName && <div className="text-xs text-slate-500 mt-0.5">负责人 · {dept.leaderName}</div>}
        <div className="text-xs text-slate-400 mt-1">
          {dept.employees.length} 人
          {deptHeadcount(dept) != null ? ` / 编制 ${deptHeadcount(dept)}` : ''}
        </div>
      </div>
      {dept.children.length > 0 && (
        <div className="flex flex-wrap gap-3 mt-3 justify-center border-t-2 border-slate-100 pt-3">
          {dept.children.map((c) => (
            <ReportNode key={c.id} dept={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function flattenForDetail(depts: Department[]): Department[] {
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

const SEV_LABEL: Record<SuggestionSeverity, string> = {
  critical: '关键',
  major: '建议',
  minor: '提示',
  info: '信息',
};
const SEV_STYLE: Record<SuggestionSeverity, string> = {
  critical: 'bg-red-50 text-red-600 ring-red-200',
  major: 'bg-amber-50 text-amber-600 ring-amber-200',
  minor: 'bg-slate-50 text-slate-500 ring-slate-200',
  info: 'bg-slate-50 text-slate-500 ring-slate-200',
};

export function DiagnosticReport({
  open,
  onClose,
  departments,
  levelConfigs,
  positionSummaries = [],
  projectName,
  scenarioName,
  onToast,
}: DiagnosticReportProps) {
  const reportRef = useRef<HTMLDivElement>(null);
  const report = useMemo(
    () => computeHealthReport(departments, levelConfigs),
    [departments, levelConfigs],
  );

  const deptNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of flattenForDetail(departments)) m.set(d.id, d.name);
    return m;
  }, [departments]);

  const suggestions = useMemo(
    () => collectAllSuggestions(report, departments),
    [report, departments],
  );

  const generatedAt = useMemo(
    () => new Date().toLocaleString('zh-CN', { dateStyle: 'long', timeStyle: 'short' }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open],
  );

  const dialogRef = useDialogFocus(open, onClose);

  if (!open) return null;

  const flat = flattenForDetail(departments);
  const summary = report.summary;

  const handlePrint = () => {
    window.print();
  };

  const handleExportPng = async () => {
    if (!reportRef.current) return;
    try {
      const canvas = await exportCanvas(reportRef.current);
      const dataUrl = canvas.toDataURL('image/png');
      const base64 = dataUrl.split(',')[1];
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const { saveFile } = await import('../utils/tauri');
      const ok = await saveFile(`诊断报告-${scenarioName}.png`, bytes, 'image/png');
      onToast(ok ? 'PNG 已导出' : '已取消导出');
    } catch (error) {
      console.error('导出报告PNG失败:', error);
      onToast('导出报告PNG失败');
    }
  };

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="诊断报告" tabIndex={-1} className="fixed inset-0 z-[90] bg-white/95 backdrop-blur-lg overflow-y-auto">
      {/* 顶部工具条（打印时隐藏） */}
      <div className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b border-slate-100 px-6 py-3 flex items-center justify-between no-print">
        <div className="flex items-center gap-3">
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-slate-600 hover:bg-slate-100 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            返回编辑
          </button>
          <span className="text-sm font-semibold text-slate-800">诊断报告</span>
          <span className="text-xs text-slate-400">场景：{scenarioName}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExportPng}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 transition-colors"
          >
            <ImageIcon className="w-4 h-4" />
            导出PNG
          </button>
          <button
            onClick={handlePrint}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium text-white bg-gradient-to-r from-indigo-500 to-violet-500 shadow-md hover:shadow-lg transition-all"
          >
            <Printer className="w-4 h-4" />
            打印/导出PDF
          </button>
        </div>
      </div>

      {/* 报告正文 */}
      <div ref={reportRef} className="max-w-5xl mx-auto px-6 py-8 space-y-8 bg-white">
        {/* 报告头部 */}
        <header className="border-b-2 border-slate-900 pb-4">
          <h1 className="text-2xl font-bold text-slate-900">组织架构诊断报告</h1>
          <div className="flex gap-4 mt-2 text-xs text-slate-500">
            <span>项目：{projectName}</span>
            <span>场景：{scenarioName}</span>
            <span>生成时间：{generatedAt}</span>
          </div>
        </header>

        {/* 摘要指标卡 */}
        <section>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <div className={`rounded-2xl border ${STATUS_STYLE[summary.overall].border} ${STATUS_STYLE[summary.overall].bg} shadow-soft p-4`}>
              <div className="text-xs text-slate-500">整体健康度</div>
              <div className={`text-2xl font-bold ${STATUS_STYLE[summary.overall].text}`}>
                {HEALTH_STATUS_LABEL[summary.overall]}
              </div>
              <div className="text-xs text-slate-400 mt-1">红{summary.red} 黄{summary.yellow} 绿{summary.green}</div>
            </div>
            <div className="rounded-2xl bg-white border border-slate-100 shadow-soft p-4">
              <div className="text-xs text-slate-500">总人数</div>
              <div className="text-2xl font-bold text-slate-900">{report.totals.totalEmployees}</div>
              <div className="text-xs text-slate-400 mt-1">不含虚拟兼岗</div>
            </div>
            <div className="rounded-2xl bg-white border border-slate-100 shadow-soft p-4">
              <div className="text-xs text-slate-500">部门数</div>
              <div className="text-2xl font-bold text-slate-900">{report.totals.totalDepartments}</div>
              <div className="text-xs text-slate-400 mt-1">全组织节点</div>
            </div>
            <div className="rounded-2xl bg-white border border-slate-100 shadow-soft p-4">
              <div className="text-xs text-slate-500">编制缺口</div>
              <div className={`text-2xl font-bold ${report.totals.totalGap == null ? 'text-slate-400' : report.totals.totalGap > 0 ? 'text-amber-600' : report.totals.totalGap < 0 ? 'text-red-600' : 'text-slate-900'}`}>
                {report.totals.totalGap == null ? '未配置' : report.totals.totalGap > 0 ? `+${report.totals.totalGap}` : report.totals.totalGap}
              </div>
              <div className="text-xs text-slate-400 mt-1">{report.totals.totalGap == null ? '未配置编制，无法计算缺口' : '仅已配置部门；正=空岗，负=超编'}</div>
            </div>
            <div className="rounded-2xl bg-white border border-slate-100 shadow-soft p-4">
              <div className="text-xs text-slate-500">月人力成本</div>
              <div className="text-2xl font-bold text-slate-900">{fmtCost(report.totals.totalCost)}</div>
              <div className="text-xs text-slate-400 mt-1">按职级成本映射</div>
            </div>
          </div>
        </section>

        {/* 健康度指标 */}
        <section>
          <h2 className="text-base font-bold text-slate-900 mb-3">健康度指标</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {report.l2.map((m) => (
              <div key={m.key} className={`rounded-2xl border ${STATUS_STYLE[m.status].border} ${STATUS_STYLE[m.status].bg} shadow-soft p-4`}>
                <div className="text-xs text-slate-500">{m.label}</div>
                <div className={`text-3xl font-bold ${STATUS_STYLE[m.status].text}`}>{fmt(m.value, m.unit)}</div>
                {/* v2.0.9 口径小字：中位数/极值、P50/P90、内部/外部/兼岗 */}
                {m.key === 'span' && m.spanBreakdown && (
                  <div className="text-[11px] text-slate-400 mt-0.5 leading-snug">
                    极值 {fmt(m.spanBreakdown.min)}–{fmt(m.spanBreakdown.max)} 人 · {m.spanBreakdown.count} 个有负责人部门
                  </div>
                )}
                {m.key === 'depth' && m.depthBreakdown && m.depthBreakdown.deptCount > 0 && (
                  <div className="text-[11px] text-slate-400 mt-0.5 leading-snug">
                    P50={m.depthBreakdown.p50} 层 · 最深 {m.depthBreakdown.max} 层
                  </div>
                )}
                {m.key === 'managerRatio' && m.managerBreakdown && (
                  <div className="text-[11px] text-slate-400 mt-0.5 leading-snug">
                    内部 {m.managerBreakdown.internalManagers}/{m.managerBreakdown.totalEmployees} · 外部 {m.managerBreakdown.externalManagers} · 兼岗 {m.managerBreakdown.multiDeptManagers}
                  </div>
                )}
                <div className="text-xs text-slate-400 mt-1 leading-snug">{m.verdict}</div>
              </div>
            ))}
          </div>
          <p className="text-sm text-slate-700 mt-3">{summary.diagnosis}</p>
        </section>

        {/* 指标口径与边界（报告可解释性） */}
        <section>
          <h2 className="text-base font-bold text-slate-900 mb-3">指标口径与边界</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {report.l2.map((m) => (
              <div key={m.key} className="rounded-2xl border border-slate-100 shadow-soft p-4">
                <div className="text-xs font-semibold text-slate-600 mb-1">{m.label}</div>
                <div className="text-xs leading-snug text-slate-500">{METRIC_CALIBER_NOTES[m.key]}</div>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-400 mt-2 leading-snug">
            指标用于发现值得讨论的结构性信号，不替代业务背景、人才判断与管理责任。阈值可在健康度面板中按企业阶段与口径调整。
          </p>
        </section>

        {/* 组织架构图（只读） */}
        <section className="report-section">
          <h2 className="text-base font-bold text-slate-900 mb-3">组织架构图</h2>
          <div className="rounded-2xl border border-slate-100 shadow-soft p-6 report-orgchart">
            <ReportOrgChart departments={departments} />
          </div>
        </section>

        {/* 部门明细表 */}
        <section className="report-section">
          <h2 className="text-base font-bold text-slate-900 mb-3">部门明细（人数、编制含下级；职级分布为直属人员）</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500 uppercase tracking-wide border-b border-slate-200">
                <th className="text-left py-2 font-medium">部门</th>
                <th className="text-left py-2 font-medium">层级</th>
                <th className="text-left py-2 font-medium">负责人</th>
                <th className="text-right py-2 font-medium">人数</th>
                <th className="text-right py-2 font-medium">编制</th>
                <th className="text-right py-2 font-medium">缺口</th>
                <th className="text-left py-2 font-medium">职级分布</th>
              </tr>
            </thead>
            <tbody>
              {flat.map((d) => {
                const metric = report.l3.find((row) => row.deptId === d.id);
                const dist = Object.entries(
                  d.employees.reduce<Record<string, number>>((agg, e) => {
                    agg[e.level] = (agg[e.level] || 0) + 1;
                    return agg;
                  }, {}),
                )
                  .map(([k, n]) => `${k}×${n}`)
                  .join(', ');
                return (
                  <tr key={d.id} className="border-b border-slate-100">
                    <td className="py-2 text-slate-700">
                      <span className="mr-1 text-slate-300">{'　'.repeat(Math.min(d.level - 1, 3))}{d.level > 1 && '└ '}</span>
                      {d.name}
                    </td>
                    <td className="py-2 text-slate-500">L{d.level}</td>
                    <td className="py-2 text-slate-600">{d.leaderName || '—'}</td>
                    <td className="py-2 text-right text-slate-700">{metric?.actual ?? 0}</td>
                    <td className="py-2 text-right text-slate-600">{metric?.headcount ?? '—'}</td>
                    <td className="py-2 text-right text-slate-600">
                      {metric?.gap ?? '—'}
                    </td>
                    <td className="py-2 text-slate-500">{dist || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        {/* 岗位级缺口表（v2.1.1：招聘缺口视图，部门 → 岗位两级） */}
        {positionSummaries.length > 0 && (
          <section className="report-section">
            <h2 className="text-base font-bold text-slate-900 mb-3">岗位级缺口（招聘缺口）</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500 uppercase tracking-wide border-b border-slate-200">
                  <th className="text-left py-2 font-medium">岗位</th>
                  <th className="text-left py-2 font-medium">所属部门</th>
                  <th className="text-right py-2 font-medium">编制</th>
                  <th className="text-right py-2 font-medium">在岗</th>
                  <th className="text-right py-2 font-medium">缺口</th>
                  <th className="text-right py-2 font-medium">缺口成本</th>
                </tr>
              </thead>
              <tbody>
                {positionSummaries.map((p) => (
                  <tr key={p.positionId} className="border-b border-slate-100">
                    <td className="py-2 text-slate-700">{p.name}</td>
                    <td className="py-2 text-slate-500">{deptNameById.get(p.departmentId) ?? '—'}</td>
                    <td className="py-2 text-right text-slate-600">{p.headcount}</td>
                    <td className="py-2 text-right text-slate-700">{p.assignedCount}</td>
                    <td className="py-2 text-right">
                      {p.gap === null ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <span className={p.gap > 0 ? 'text-amber-600' : p.gap < 0 ? 'text-red-600' : 'text-emerald-600'}>
                          {p.gap > 0 ? `+${p.gap} 空岗` : p.gap < 0 ? `${p.gap} 超编` : '满编'}
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      {/* v2.3.1 F-11：找不到成本依据 → 「无法估算」，不写成 0w */}
                      {p.gapCost === null ? (
                        <span className="text-slate-500" title="找不到成本依据（无在岗人员且无职级成本映射），缺口成本无法估算">
                          无法估算
                        </span>
                      ) : (
                        <span className={p.gapCost > 0 ? 'text-amber-600' : p.gapCost < 0 ? 'text-red-600' : 'text-slate-500'}>
                          {fmtCost(p.gapCost)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-slate-400 mt-2 leading-snug">
              岗位级缺口 = 平均月成本 × 缺口；目标职级/带宽优先，缺省回退在岗均值。冻结岗位不计缺口。
            </p>
          </section>
        )}

        {/* 诊断建议 / 组织优化建议 */}
        <section className="report-section">
          <h2 className="text-base font-bold text-slate-900 mb-3">组织优化建议</h2>
          <div className="rounded-2xl bg-slate-50 border border-slate-100 p-5">
            {suggestions.length === 0 ? (
              <p className="text-sm text-slate-600">组织结构较为健康，暂无优化建议。</p>
            ) : (
              <ul className="space-y-2 text-sm text-slate-700">
                {suggestions.slice(0, 30).map((s) => (
                  <li key={s.id} className="flex items-start gap-2">
                    <span
                      className={`shrink-0 mt-0.5 text-[10px] px-1.5 py-0.5 rounded-full ring-1 font-medium ${SEV_STYLE[s.severity]}`}
                    >
                      {SEV_LABEL[s.severity]}
                    </span>
                    <span>
                      <span className="font-medium">{s.deptName ? `${s.deptName} · ` : ''}{s.title}</span>
                      <span className="text-slate-500">：{s.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-sm text-slate-600 mt-4">{summary.diagnosis}</p>
          </div>
        </section>

        <footer className="text-xs text-slate-400 text-center pt-4 border-t border-slate-100">
          由组织罗盘 OrgCompass v{APP_VERSION} 生成 · {projectName} · {scenarioName} · {generatedAt}
        </footer>
      </div>
    </div>
  );
}
