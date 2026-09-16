import { useMemo, useState } from 'react';
import { useDialogFocus } from '../utils/useDialogFocus';
import { X, ClipboardList, FileSpreadsheet, Building2 } from 'lucide-react';
import type { Scenario } from '../types';
import { deriveBoard } from '../utils/boardScope';
import {
  GAP_LIST_CALIBER,
  GAP_LIST_FILTER_LABEL,
  buildGapListExcelBytes,
  buildGapListRows,
  filterGapListRows,
  summarizeGapList,
  type GapListStatusFilter,
} from '../utils/gapList';
import { fmtCost } from '../utils/statusUI';

/**
 * —— v2.3 M4：岗位缺口清单（契约 §7.2）——
 *
 * 从**当前场景**直接查看与导出，不强制先建立第二个场景。
 * 清单行来自 `deriveBoard` 的岗位派生结果，界面与 Excel 使用同一份 filteredRows。
 * 边界：这是编制缺口事实，不是已批准招聘需求；不生成「招聘中/已审批」等状态；
 * 默认不含个人姓名、工号、个人薪酬、评分或复核依据。
 */

interface GapListModalProps {
  open: boolean;
  onClose: () => void;
  projectName: string;
  scenario: Scenario;
  /** 定位画布中的部门（可核对该部门岗位） */
  onLocateDept?: (deptId: string) => void;
  onToast: (msg: string) => void;
}

export function GapListModal({ open, onClose, projectName, scenario, onLocateDept, onToast }: GapListModalProps) {
  const [scopeDeptId, setScopeDeptId] = useState<string | null>(null);
  const [includeChildren, setIncludeChildren] = useState(true);
  const [statusFilter, setStatusFilter] = useState<GapListStatusFilter>('all');
  const [exporting, setExporting] = useState(false);
  const dialogRef = useDialogFocus(open, onClose);

  const board = useMemo(
    () => deriveBoard({
      departments: scenario.departments,
      allEmployees: scenario.allEmployeesFlat,
      // v2.3 M4 修复：岗位以 scenario.departments 为结构来源（契约 §2.2）；
      // scenario.positions 是可能过期的历史镜像，只作树内无岗位时的兜底。
      allPositions: scenario.positions ?? [],
      assessments: scenario.assessments ?? [],
      competencyModel: scenario.competencyModel ?? { dimensions: [] },
      positionAssignments: scenario.positionAssignments ?? [],
      levelConfigs: scenario.levelConfigs,
      competencySummaries: new Map(),
      matchStates: [],
      scopeDeptId,
      includeChildren,
      filter: 'all',
    }),
    [scenario, scopeDeptId, includeChildren],
  );

  const allRows = useMemo(() => buildGapListRows(board, scenario.name), [board, scenario.name]);
  const rows = useMemo(() => filterGapListRows(allRows, statusFilter), [allRows, statusFilter]);
  const summary = useMemo(() => summarizeGapList(rows), [rows]);

  const deptOptions = useMemo(() => {
    const out: Array<{ id: string; name: string; depth: number }> = [];
    const walk = (list: Scenario['departments'], depth: number) => {
      for (const d of list) {
        out.push({ id: d.id, name: d.name, depth });
        walk(d.children, depth + 1);
      }
    };
    walk(scenario.departments, 0);
    return out;
  }, [scenario.departments]);

  if (!open) return null;

  const handleExport = async () => {
    setExporting(true);
    try {
      const generatedAt = new Date().toLocaleString('zh-CN', { dateStyle: 'long', timeStyle: 'short' });
      const bytes = await buildGapListExcelBytes({
        rows,
        summary,
        meta: {
          projectName,
          scenarioName: scenario.name,
          scopeLabel: board.scopeLabel,
          filterLabel: GAP_LIST_FILTER_LABEL[statusFilter],
          generatedAt,
        },
      });
      const { saveFile } = await import('../utils/tauri');
      const ok = await saveFile(
        `岗位缺口清单-${scenario.name}.xlsx`,
        bytes,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      onToast(ok ? '岗位缺口清单 Excel 已导出' : '已取消导出');
    } catch (error) {
      console.error('导出岗位缺口清单失败:', error);
      onToast('导出岗位缺口清单失败');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="岗位缺口清单" tabIndex={-1} className="fixed inset-0 z-[95] bg-white/95 backdrop-blur-lg overflow-y-auto">
      <div className="sticky top-0 z-10 bg-white/85 backdrop-blur border-b border-slate-100 px-6 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button onClick={onClose} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-slate-600 hover:bg-slate-100 transition-colors">
            <X className="w-4 h-4" />
            返回编辑
          </button>
          <span className="text-sm font-semibold text-slate-800 flex items-center gap-1.5">
            <ClipboardList className="w-4 h-4 text-indigo-500" />
            岗位缺口清单
          </span>
          <span className="text-xs text-slate-500">{scenario.name} · {board.scopeLabel}</span>
        </div>
        <button
          onClick={handleExport}
          disabled={exporting}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 transition-colors"
        >
          <FileSpreadsheet className="w-4 h-4" />
          {exporting ? '导出中…' : '导出 Excel'}
        </button>
      </div>

      <div className="px-6 py-4 space-y-4">
        {/* 范围与筛选（导出与界面共用同一结果） */}
        <section className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-2">
            <span className="text-slate-500">部门范围</span>
            <select
              aria-label="部门范围"
              value={scopeDeptId ?? ''}
              onChange={(e) => setScopeDeptId(e.target.value || null)}
              className="px-2 py-1 rounded-lg border border-slate-200 bg-white"
            >
              <option value="">全公司</option>
              {deptOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {'　'.repeat(Math.min(d.depth, 3))}{d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-slate-600 cursor-pointer">
            <input type="checkbox" checked={includeChildren} onChange={(e) => setIncludeChildren(e.target.checked)} className="accent-indigo-500" />
            含下级部门
          </label>
          <div className="flex items-center gap-1.5">
            <span className="text-slate-500">岗位状态</span>
            {(Object.keys(GAP_LIST_FILTER_LABEL) as GapListStatusFilter[]).map((f) => (
              <button
                key={f}
                onClick={() => setStatusFilter(f)}
                aria-pressed={statusFilter === f}
                className={`px-2 py-0.5 rounded-lg border font-medium transition-colors ${
                  statusFilter === f ? 'bg-indigo-500 text-white border-indigo-500' : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'
                }`}
              >
                {GAP_LIST_FILTER_LABEL[f]}
              </button>
            ))}
          </div>
          <span className="ml-auto text-slate-500">岗位 {rows.length} / {allRows.length}</span>
        </section>

        {/* 汇总：待补与超额分别表达；成本缺失标为已知部分 */}
        <section className="grid grid-cols-2 min-[720px]:grid-cols-4 gap-3">
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <div className="text-xs text-slate-500">待补人数</div>
            <div className="text-xl font-bold tabular-nums text-amber-600">{summary.pendingTotal}</div>
            <div className="text-[10px] text-slate-500">{summary.pendingPositions} 个岗位有待补</div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <div className="text-xs text-slate-500">超额人数</div>
            <div className="text-xl font-bold tabular-nums text-red-600">{summary.overflowTotal}</div>
            <div className="text-[10px] text-slate-500">{summary.overflowPositions} 个岗位超额</div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <div className="text-xs text-slate-500">净额（仅补充）</div>
            <div className="text-xl font-bold tabular-nums text-slate-700">{summary.netTotal}</div>
            <div className="text-[10px] text-slate-500">不用超编抵消待补</div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <div className="text-xs text-slate-500">已知缺口成本（万元/月）</div>
            <div className="text-xl font-bold tabular-nums text-slate-700">{fmtCost(summary.knownCostTotal)}</div>
            <div className="text-[10px] text-slate-500">
              {summary.costPartial ? `已知部分 · ${summary.costMissingPositions} 个待补岗位无法估算` : '全部有待补岗位均可估算'}
            </div>
          </div>
        </section>

        {/* 清单表 */}
        <section className="rounded-xl border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr className="text-xs text-slate-500 uppercase tracking-wide border-b border-slate-200">
                  <th className="text-left px-3 py-2 font-medium">完整部门路径</th>
                  <th className="text-left px-3 py-2 font-medium">岗位</th>
                  <th className="text-left px-2 py-2 font-medium">职级带宽</th>
                  <th className="text-left px-2 py-2 font-medium">岗位状态</th>
                  <th className="text-left px-2 py-2 font-medium">编制配置</th>
                  <th className="text-right px-2 py-2 font-medium">编制</th>
                  <th className="text-right px-2 py-2 font-medium">主岗占用</th>
                  <th className="text-right px-2 py-2 font-medium">兼岗</th>
                  <th className="text-right px-2 py-2 font-medium">待补</th>
                  <th className="text-right px-2 py-2 font-medium">超额</th>
                  <th className="text-right px-2 py-2 font-medium">缺口成本</th>
                  <th className="text-left px-3 py-2 font-medium">成本依据</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.deptPath}-${r.position}-${r.headcount}-${r.primaryOccupied}`} className="border-b border-slate-50 last:border-0">
                    <td className="px-3 py-1.5 text-[11px] text-slate-500">
                      <span className="inline-flex items-center gap-1">
                        {r.deptPath}
                        {onLocateDept && (
                          <button
                            onClick={() => {
                              const found = deptOptions.find((d) => r.deptPath.endsWith(d.name));
                              if (found) onLocateDept(found.id);
                            }}
                            className="text-indigo-500 hover:text-indigo-700"
                            title="定位画布部门"
                          >
                            <Building2 className="w-3 h-3" />
                          </button>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-slate-700">{r.position}</td>
                    <td className="px-2 py-1.5 text-slate-600 tabular-nums">{r.levelBand}</td>
                    <td className="px-2 py-1.5 text-slate-600">{r.statusLabel}</td>
                    <td className={`px-2 py-1.5 ${r.headcountStatusLabel === '已配置' ? 'text-slate-600' : 'text-amber-600'}`}>{r.headcountStatusLabel}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-700">
                      {r.headcountStatusLabel === '未配置编制' ? <span title="编制 0 = 未配置，不视为明确零编制">{r.headcount}</span> : r.headcount}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-700">{r.primaryOccupied}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{r.secondaryRelations}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-amber-600 font-medium">{r.pendingCount || ''}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-red-600 font-medium">{r.overflowCount || ''}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-700">
                      {r.gapCost === null ? <span className="text-slate-400">—</span> : fmtCost(r.gapCost)}
                    </td>
                    <td className="px-3 py-1.5 text-[10px] text-slate-500 max-w-[220px]">
                      {r.gapCost === null && r.pendingCount > 0 ? <span className="text-amber-600">无法估算：</span> : ''}
                      {r.costBasis}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={12} className="py-8 text-center text-sm text-slate-500">当前范围与筛选下没有岗位</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
          <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">统计口径</h3>
          <ul className="space-y-0.5 text-[11px] text-slate-600 leading-snug">
            {GAP_LIST_CALIBER.map((line) => <li key={line}>· {line}</li>)}
          </ul>
        </section>
      </div>
    </div>
  );
}
