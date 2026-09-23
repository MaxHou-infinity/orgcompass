import { Fragment, useMemo, useState } from 'react';
import { Briefcase, Download, Filter, Plus, UserMinus, X, Check, ChevronRight, ChevronDown, Layers } from 'lucide-react';
import { SubPageShell } from './SubPageShell';
import { deriveBoard } from '../utils/boardScope';
import { buildGapListExcelBytes, buildGapListRows, GAP_LIST_CALIBER, GAP_LIST_FILTER_LABEL, gapListVisibleFilters } from '../utils/gapList';
import { flattenDeptOptions, findEmployeeDept, findDeptById } from '../utils/departments';
import { findPositionlessEmployees } from '../utils/positions';
import { fmtCost } from '../utils/statusUI';
import type { Assessment, CompetencyModel, Department, Employee, LevelConfig, Position, PositionAssignment, Scenario } from '../types';
import type { PositionSummary } from '../utils/analytics';
import { fullCode } from '../utils/level';
import type { PositionCreateFields } from './PositionModal';

/**
 * V2.4.0「岗位与编制」页面级子界面。
 *
 * 为什么是**页面**而不是弹窗（用户要求）：这个界面要同时承担「看全部岗位 + 改编制 +
 * 增删改岗位 + 套岗」，弹窗放不下，交互也施展不开。
 *
 * 为什么把顶部「岗位操作」与「缺口清单」合并（用户要求）：两者本来就是同一份数据的
 * 两种看法 —— 缺口清单是只读视图，岗位操作是写入入口，分开会出现「在 A 看、去 B 改」的断层。
 * 本页**与缺口清单同源**（都用 `deriveBoard`），因此数字与导出口径天然一致。
 *
 * 一个关键的数据事实（用户提出）：同一个岗位**名**可能出现在多个部门
 * （实测数据：15 个岗位实体只有 13 个不同名称）。所以：
 * - 「按部门」视图：一行 = 一个岗位**实体**，部门作可折叠分组表头；
 * - 「按岗位」视图：一行 = 一个岗位**名**，聚合显示「分布在 N 个部门」，可展开明细。
 */

type ViewMode = 'dept' | 'position';
type StatusFilter = 'all' | 'pending' | 'overflow' | 'unconfigured' | 'balanced';

interface PositionBoardPageProps {
  onBack: () => void;
  projectName: string;
  scenario: Scenario;
  departments: Department[];
  allEmployees: Employee[];
  assessments: Assessment[];
  competencyModel: CompetencyModel;
  positionAssignments: PositionAssignment[];
  levelConfigs: LevelConfig[];
  positionSummaries: PositionSummary[];
  onSetPositionHeadcount: (deptId: string, positionId: string, headcount: number) => void;
  onCreatePosition: (deptId: string, fields: PositionCreateFields) => void;
  onUpdatePosition: (deptId: string, positionId: string, fields: PositionCreateFields) => void;
  onArchivePosition: (deptId: string, positionId: string) => void;
  onAssignEmployee: (empId: string, positionId: string) => void;
  onToast: (msg: string) => void;
  onLocateDept?: (deptId: string) => void;
}

const JOB_FAMILIES = ['技术', '产品', '设计', '职能', '管理', '销售', '运营'];

interface Draft {
  deptId: string;
  name: string;
  jobFamily: string;
  bandMin: string;
  bandMax: string;
  headcount: string;
}

const emptyDraft = (deptId: string): Draft => ({
  deptId, name: '', jobFamily: '', bandMin: '', bandMax: '', headcount: '',
});

const draftOf = (deptId: string, p: Position): Draft => ({
  deptId,
  name: p.name,
  jobFamily: p.jobFamily ?? '',
  bandMin: p.levelBandMin ?? '',
  bandMax: p.levelBandMax ?? '',
  headcount: String(p.headcount ?? 0),
});

export function PositionBoardPage(props: PositionBoardPageProps) {
  const {
    onBack, scenario, departments, allEmployees, assessments, competencyModel,
    positionAssignments, levelConfigs, onSetPositionHeadcount, onCreatePosition,
    onUpdatePosition, onArchivePosition, onAssignEmployee, onToast, onLocateDept,
  } = props;

  const [scopeDeptId, setScopeDeptId] = useState<string | null>(null);
  const [includeChildren, setIncludeChildren] = useState(true);
  const [view, setView] = useState<ViewMode>('dept');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expandedNames, setExpandedNames] = useState<Set<string>>(new Set());
  /** 新增岗位的内联表单（null = 收起） */
  const [createDraft, setCreateDraft] = useState<Draft | null>(null);
  /** 正在编辑的岗位（positionId）与其草稿 */
  const [editTarget, setEditTarget] = useState<{ positionId: string; draft: Draft } | null>(null);
  /** 正在套岗的岗位（展开候选人面板） */
  const [assignTarget, setAssignTarget] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const board = useMemo(
    () => deriveBoard({
      departments, allEmployees, allPositions: scenario.positions ?? [],
      assessments, competencyModel, positionAssignments, levelConfigs,
      competencySummaries: new Map(), matchStates: [],
      scopeDeptId, includeChildren,
    }),
    [departments, allEmployees, scenario.positions, assessments, competencyModel,
     positionAssignments, levelConfigs, scopeDeptId, includeChildren],
  );

  const rows = board.positions;
  const deptOptions = useMemo(() => flattenDeptOptions(departments), [departments]);

  /** 未入架构之外的「无明确岗位」员工（删除岗位后需要持续可见） */
  const positionless = useMemo(
    () => findPositionlessEmployees(allEmployees, departments),
    [allEmployees, departments],
  );
  const missing = positionless.filter((x) => x.reason === 'missing-position');

  const filteredRows = useMemo(() => {
    switch (filter) {
      case 'pending': return rows.filter((r) => r.pendingCount > 0);
      case 'overflow': return rows.filter((r) => r.overflowCount > 0);
      case 'unconfigured': return rows.filter((r) => r.headcountStatus === 'unconfigured');
      case 'balanced': return rows.filter((r) => r.headcountStatus === 'configured' && r.pendingCount === 0 && r.overflowCount === 0);
      default: return rows;
    }
  }, [rows, filter]);

  const totals = useMemo(() => ({
    positions: rows.length,
    headcount: rows.reduce((s, r) => s + (r.headcountStatus === 'configured' ? r.headcount : 0), 0),
    occupied: rows.reduce((s, r) => s + r.primaryOccupied, 0),
    pending: rows.reduce((s, r) => s + r.pendingCount, 0),
    overflow: rows.reduce((s, r) => s + r.overflowCount, 0),
    unconfigured: rows.filter((r) => r.headcountStatus === 'unconfigured').length,
    gapCost: Math.round(rows.reduce((s, r) => s + (r.gapCost ?? 0), 0) * 10) / 10,
    costMissing: rows.filter((r) => r.pendingCount > 0 && r.gapCost === null).length,
  }), [rows]);

  /** 按部门分组（按部门视图）：保持派生的部门顺序 */
  const groups = useMemo(() => {
    const map = new Map<string, { deptId: string; deptPath: string; rows: typeof filteredRows }>();
    for (const r of filteredRows) {
      const g = map.get(r.departmentId);
      if (g) g.rows.push(r);
      else map.set(r.departmentId, { deptId: r.departmentId, deptPath: r.deptPath, rows: [r] });
    }
    return [...map.values()];
  }, [filteredRows]);

  /** 按岗位名聚合（按岗位视图）：同名跨部门合并成一行 */
  const nameGroups = useMemo(() => {
    const map = new Map<string, typeof filteredRows>();
    for (const r of filteredRows) {
      const list = map.get(r.name);
      if (list) list.push(r);
      else map.set(r.name, [r]);
    }
    return [...map.entries()].map(([name, list]) => ({
      name,
      rows: list,
      deptCount: new Set(list.map((r) => r.departmentId)).size,
      headcount: list.reduce((s, r) => s + (r.headcountStatus === 'configured' ? r.headcount : 0), 0),
      occupied: list.reduce((s, r) => s + r.primaryOccupied, 0),
      pending: list.reduce((s, r) => s + r.pendingCount, 0),
      overflow: list.reduce((s, r) => s + r.overflowCount, 0),
      unconfigured: list.filter((r) => r.headcountStatus === 'unconfigured').length,
    })).sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name));
  }, [filteredRows]);

  /** 某岗位当前在岗人员（含兼岗副本的归属人），用于行内展示「选了谁」 */
  const occupantsOf = (positionId: string): { real: string[]; secondary: string[] } => {
    const real: string[] = [];
    const secondary: string[] = [];
    for (const e of allEmployees) {
      if (e.positionId !== positionId) continue;
      if (e.isVirtual) {
        const owner = allEmployees.find((x) => x.id === e.primaryEmployeeId);
        secondary.push(owner ? owner.name : e.name);
      } else {
        real.push(e.name);
      }
    }
    return { real, secondary };
  };

  /** 套岗候选人：真人 + 现属部门›岗位（旧实现只显示姓名，用户不知道这人现在在哪） */
  const candidatesOf = (positionId: string) =>
    allEmployees
      .filter((e) => !e.isVirtual && e.positionId !== positionId)
      .map((e) => {
        const d = findEmployeeDept(departments, e.id);
        const cur = e.positionId ? board.positions.find((r) => r.positionId === e.positionId) : undefined;
        return { employee: e, deptName: d?.name ?? '未入架构', curName: cur?.name ?? '未套岗', sameDept: d?.id === findDeptById(departments, positionId)?.id };
      })
      .sort((a, b) => Number(b.sameDept) - Number(a.sameDept) || a.employee.name.localeCompare(b.employee.name));

  const exportExcel = async () => {
    setExporting(true);
    try {
      // 与缺口清单同一套行构造：把**筛选后**的岗位注入 board，界面与导出必然一致
      const rowsForExport = buildGapListRows({ ...board, positions: filteredRows }, scenario.name);
      const bytes = await buildGapListExcelBytes({
        rows: rowsForExport, summary: {
          positionCount: rowsForExport.length,
          pendingTotal: totals.pending,
          overflowTotal: totals.overflow,
          netTotal: totals.pending - totals.overflow,
          pendingPositions: filteredRows.filter((r) => r.pendingCount > 0).length,
          overflowPositions: filteredRows.filter((r) => r.overflowCount > 0).length,
          frozenPositions: filteredRows.filter((r) => r.headcountStatus === 'frozen').length,
          unconfiguredPositions: filteredRows.filter((r) => r.headcountStatus === 'unconfigured').length,
          knownCostTotal: totals.gapCost,
          knownCostPositions: filteredRows.filter((r) => r.gapCost !== null).length,
          costMissingPositions: totals.costMissing,
          costPartial: totals.costMissing > 0,
        },
        meta: {
          projectName: props.projectName, scenarioName: scenario.name,
          scopeLabel: board.scopeLabel, filterLabel: GAP_LIST_FILTER_LABEL[filter],
          generatedAt: new Date().toLocaleString('zh-CN'),
        },
      });
      const { saveFile } = await import('../utils/tauri');
      const ok = await saveFile(`岗位与编制_${scenario.name}.xlsx`, bytes,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      onToast(ok ? '已导出岗位与编制清单' : '已取消导出');
    } catch (e) {
      onToast(`导出岗位与编制清单失败：${e instanceof Error ? e.message : '未知错误'}`);
    } finally {
      setExporting(false);
    }
  };

  const bandLabel = (r: { levelBandMin?: string; levelBandMax?: string }) =>
    r.levelBandMin || r.levelBandMax ? `${r.levelBandMin ?? '—'} ~ ${r.levelBandMax ?? '—'}` : '—';

  const headcountCell = (deptId: string, positionId: string, headcount: number, headcountStatus: string) => (
    <input
      type="number"
      min="0"
      value={headcount}
      disabled={headcountStatus === 'frozen'}
      onChange={(e) => {
        const v = e.target.value === '' ? 0 : Number(e.target.value);
        onSetPositionHeadcount(deptId, positionId, Number.isFinite(v) ? v : 0);
      }}
      aria-label={`${deptId}:${positionId} 编制`}
      title="岗位编制（可编辑）：填 0 = 未配置，不计缺口"
      className="w-14 px-1.5 py-0.5 rounded border border-slate-200 text-right text-xs tabular-nums focus-ring disabled:bg-slate-50"
    />
  );

  const gapCell = (r: { headcountStatus: string; pendingCount: number; overflowCount: number }) => {
    if (r.headcountStatus === 'frozen') return <span className="text-[11px] text-slate-400">冻结</span>;
    if (r.headcountStatus === 'unconfigured') return <span className="text-[11px] text-slate-400" title="编制 0 = 未配置，不计缺口">未配编制</span>;
    if (r.pendingCount > 0) return <span className="text-[11px] font-medium text-amber-600">缺 {r.pendingCount}</span>;
    if (r.overflowCount > 0) return <span className="text-[11px] font-medium text-red-600">超 {r.overflowCount}</span>;
    return <span className="text-[11px] font-medium text-emerald-600">满编</span>;
  };

  return (
    <SubPageShell
      name="position-board"
      title="岗位与编制"
      subtitle={`场景：${scenario.name}`}
      icon={<Briefcase className="w-5 h-5 text-indigo-500" />}
      onBack={onBack}
    >
      {/* 工具条 */}
      <div className="flex flex-wrap items-center gap-3 pb-3 text-xs">
        <label className="flex items-center gap-1.5 text-slate-600">
          范围
          <select
            aria-label="部门范围"
            value={scopeDeptId ?? ''}
            onChange={(e) => setScopeDeptId(e.target.value || null)}
            className="px-2 py-1 rounded-lg border border-slate-200 text-xs focus-ring max-w-[220px]"
          >
            <option value="">全部部门</option>
            {deptOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-slate-600 cursor-pointer">
          <input type="checkbox" checked={includeChildren} onChange={(e) => setIncludeChildren(e.target.checked)} className="accent-indigo-500" />
          含下级部门
        </label>

        <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-0.5">
          {([['dept', '按部门'], ['position', '按岗位']] as const).map(([v, label]) => (
            <button
              key={v}
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={`px-2.5 py-1 rounded-md font-medium transition-colors ${view === v ? 'bg-indigo-500 text-white' : 'text-slate-600 hover:bg-slate-50'}`}
            >
              {label}
            </button>
          ))}
        </div>

        <span className="flex items-center gap-1 text-slate-500"><Filter className="w-3 h-3" />缺口状态</span>
        {gapListVisibleFilters().filter((f) => f !== 'all').map((f) => (
          <button
            key={f}
            onClick={() => setFilter(filter === f ? 'all' : f as StatusFilter)}
            aria-pressed={filter === f}
            className={`px-2 py-0.5 rounded-lg border font-medium transition-colors ${filter === f ? 'bg-indigo-500 text-white border-indigo-500' : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'}`}
          >
            {GAP_LIST_FILTER_LABEL[f]}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-2">
          <span className="text-slate-500">岗位 {filteredRows.length} / {rows.length}</span>
          <button
            onClick={exportExcel}
            disabled={exporting || filteredRows.length === 0}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-slate-600 hover:border-indigo-300 hover:text-indigo-600 disabled:opacity-40 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />导出 Excel
          </button>
          <button
            onClick={() => setCreateDraft(emptyDraft(scopeDeptId ?? deptOptions[0]?.id ?? ''))}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-500 text-white font-medium hover:bg-indigo-600 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />新增岗位
          </button>
        </span>
      </div>

      {/* 汇总条 */}
      <div className="grid grid-cols-3 min-[900px]:grid-cols-6 gap-2 pb-3">
        {[
          { k: '岗位', v: totals.positions, cls: 'text-slate-700' },
          { k: '编制合计', v: totals.headcount, cls: 'text-slate-700' },
          { k: '在岗合计', v: totals.occupied, cls: 'text-indigo-600' },
          { k: '待补人数', v: totals.pending, cls: 'text-amber-600' },
          { k: '超额人数', v: totals.overflow, cls: 'text-red-600' },
          { k: '未配置编制', v: totals.unconfigured, cls: 'text-slate-500' },
        ].map((c) => (
          <div key={c.k} className="rounded-xl border border-slate-200 bg-white px-3 py-2">
            <div className="text-[10px] text-slate-500">{c.k}</div>
            <div className={`text-lg font-bold tabular-nums ${c.cls}`}>{c.v}</div>
          </div>
        ))}
      </div>

      {/* 无明确岗位提示位：删除岗位后**持续可见**，不是一次性 toast */}
      {positionless.length > 0 && (
        <div
          data-positionless-banner
          className={`mb-3 rounded-xl border px-3 py-2 text-xs flex items-start gap-2 ${missing.length > 0 ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-slate-200 bg-slate-50 text-slate-600'}`}
        >
          <UserMinus className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <p className="font-medium">
              当前有 {positionless.length} 名员工处于无明确岗位状态
              {missing.length > 0 ? `（其中 ${missing.length} 人所在岗位已被删除）` : ''}
            </p>
            <p className="text-[11px] opacity-90">
              建议：新建岗位后把他们分配过去，或在上方对应岗位用「套岗」把他们调到其他岗位。
            </p>
            <p className="text-[11px] opacity-90">
              名单：{positionless.slice(0, 8).map((x) => `${x.employee.name}（${x.reason === 'missing-position' ? '岗位已删除' : '未套岗'}${x.deptName ? ` · ${x.deptName}` : ''}）`).join('、')}
              {positionless.length > 8 ? ` 等 ${positionless.length} 人` : ''}
            </p>
          </div>
        </div>
      )}

      {/* 表格 */}
      <div className="flex-1 min-h-0 overflow-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 bg-slate-50 z-10">
            <tr className="text-slate-500">
              <th className="text-left px-3 py-2 font-medium">{view === 'dept' ? '部门 / 岗位' : '岗位'}</th>
              <th className="text-left px-2 py-2 font-medium w-32">职级带宽</th>
              <th className="text-right px-2 py-2 font-medium w-20">编制</th>
              <th className="text-right px-2 py-2 font-medium w-16">在岗</th>
              <th className="text-left px-2 py-2 font-medium w-20">缺口</th>
              <th className="text-left px-3 py-2 font-medium">在岗人员</th>
              <th className="text-right px-3 py-2 font-medium w-56">操作</th>
            </tr>
          </thead>
          <tbody>
            {/* 新增岗位内联表单 */}
            {createDraft && (
              <tr className="bg-indigo-50/40" data-create-position-row>
                <td colSpan={7} className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label="新岗位目标部门"
                      value={createDraft.deptId}
                      onChange={(e) => setCreateDraft({ ...createDraft, deptId: e.target.value })}
                      className="px-2 py-1 rounded-lg border border-slate-200 text-xs focus-ring max-w-[200px]"
                    >
                      {deptOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                    <input
                      aria-label="新岗位名称"
                      value={createDraft.name}
                      onChange={(e) => setCreateDraft({ ...createDraft, name: e.target.value })}
                      placeholder="岗位名称 *"
                      className="px-2 py-1 rounded-lg border border-slate-200 text-xs focus-ring w-44"
                    />
                    <select
                      aria-label="新岗位序列"
                      value={createDraft.jobFamily}
                      onChange={(e) => setCreateDraft({ ...createDraft, jobFamily: e.target.value })}
                      className="px-2 py-1 rounded-lg border border-slate-200 text-xs focus-ring"
                    >
                      <option value="">序列（可选）</option>
                      {JOB_FAMILIES.map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                    <select
                      aria-label="新岗位职级下限"
                      value={createDraft.bandMin}
                      onChange={(e) => setCreateDraft({ ...createDraft, bandMin: e.target.value })}
                      className="px-2 py-1 rounded-lg border border-slate-200 text-xs focus-ring"
                    >
                      <option value="">职级下限</option>
                      {levelConfigs.map((c) => <option key={fullCode(c)} value={fullCode(c)}>{fullCode(c)}</option>)}
                    </select>
                    <select
                      aria-label="新岗位职级上限"
                      value={createDraft.bandMax}
                      onChange={(e) => setCreateDraft({ ...createDraft, bandMax: e.target.value })}
                      className="px-2 py-1 rounded-lg border border-slate-200 text-xs focus-ring"
                    >
                      <option value="">职级上限</option>
                      {levelConfigs.map((c) => <option key={fullCode(c)} value={fullCode(c)}>{fullCode(c)}</option>)}
                    </select>
                    <input
                      aria-label="新岗位编制"
                      type="number" min="0"
                      value={createDraft.headcount}
                      onChange={(e) => setCreateDraft({ ...createDraft, headcount: e.target.value })}
                      placeholder="编制"
                      className="px-2 py-1 rounded-lg border border-slate-200 text-xs focus-ring w-20"
                    />
                    <button
                      onClick={() => {
                        if (!createDraft.name.trim() || !createDraft.deptId) return;
                        onCreatePosition(createDraft.deptId, {
                          name: createDraft.name.trim(),
                          jobFamily: createDraft.jobFamily || undefined,
                          levelBandMin: createDraft.bandMin || undefined,
                          levelBandMax: createDraft.bandMax || undefined,
                          headcount: createDraft.headcount === '' ? 0 : Number(createDraft.headcount),
                        });
                        setCreateDraft(null);
                      }}
                      disabled={!createDraft.name.trim()}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-500 text-white font-medium hover:bg-indigo-600 disabled:opacity-40"
                    >
                      <Check className="w-3.5 h-3.5" />创建
                    </button>
                    <button onClick={() => setCreateDraft(null)} className="flex items-center gap-1 px-2 py-1 rounded-lg text-slate-500 hover:bg-slate-100">
                      <X className="w-3.5 h-3.5" />取消
                    </button>
                  </div>
                </td>
              </tr>
            )}

            {filteredRows.length === 0 && !createDraft && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-slate-400">
                  {rows.length === 0 ? '当前范围还没有岗位。点右上角「新增岗位」开始。' : '没有符合筛选条件的岗位。'}
                </td>
              </tr>
            )}

            {/* —— 按部门视图 —— */}
            {view === 'dept' && groups.map((g) => (
              <Fragment key={`g-${g.deptId}`}>
                <tr className="bg-slate-50/80 border-t border-slate-200">
                  <td colSpan={7} className="px-3 py-1.5">
                    <button
                      onClick={() => setCollapsed((prev) => {
                        const next = new Set(prev);
                        if (next.has(g.deptId)) next.delete(g.deptId); else next.add(g.deptId);
                        return next;
                      })}
                      className="flex items-center gap-1.5 text-slate-600 hover:text-indigo-600 font-medium"
                    >
                      {collapsed.has(g.deptId) ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                      <span className="truncate max-w-[220px]" title={g.deptPath}>{g.deptPath.split(' / ').slice(-1)[0]}</span>
                      <span className="text-[10px] font-normal text-slate-400 truncate" title={g.deptPath}>{g.deptPath}</span>
                      <span className="text-[10px] font-normal text-slate-500">· {g.rows.length} 个岗位</span>
                    </button>
                  </td>
                </tr>
                {!collapsed.has(g.deptId) && g.rows.map((r) => {
                  const occ = occupantsOf(r.positionId);
                  const editing = editTarget?.positionId === r.positionId;
                  return (
                    <Fragment key={r.positionId}>
                      <tr data-position-row={r.positionId} className="border-t border-slate-100 hover:bg-slate-50/60">
                        <td className="px-3 py-1.5">
                          {/*
                            V2.4.0：名称单行截断（title 里给全名），「定位」按钮 shrink-0 固定同行。
                            踩过的坑：名称用 max-w-full 会占满整格，把「定位」挤到第二行 →
                            表格行高变成 35/45 参差（Chromium 实测）。
                          */}
                          <div className="flex items-center gap-2">
                            <span className="text-slate-800 truncate max-w-[240px]" title={r.name}>{r.name}</span>
                            {editing ? null : (
                              <button onClick={() => onLocateDept?.(r.departmentId)} className="shrink-0 text-[10px] text-slate-400 hover:text-indigo-600" title="在画布中定位该部门">定位</button>
                            )}
                          </div>
                        </td>
                        <td className="px-2 py-1.5 text-slate-500 whitespace-nowrap">{bandLabel(r)}</td>
                        <td className="px-2 py-1.5 text-right">{headcountCell(r.departmentId, r.positionId, r.headcount, r.headcountStatus)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-slate-700 whitespace-nowrap">{r.primaryOccupied}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap">{gapCell(r)}</td>
                        <td className="px-3 py-1.5 text-slate-600">
                          {occ.real.length === 0 && occ.secondary.length === 0 ? <span className="text-slate-400">—</span> : (
                            <span
                              className="block truncate max-w-[260px]"
                              title={`${occ.real.join('、')}${occ.secondary.length > 0 ? `（兼：${occ.secondary.join('、')}）` : ''}`}
                            >
                              {occ.real.join('、')}
                              {occ.secondary.length > 0 && <span className="text-slate-400">（兼：{occ.secondary.join('、')}）</span>}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-right whitespace-nowrap">
                          <button onClick={() => setAssignTarget(assignTarget === r.positionId ? null : r.positionId)}
                            className="px-2 py-0.5 rounded-md text-[11px] text-indigo-600 bg-indigo-50 hover:bg-indigo-100" title="把某员工调到本岗位（会同时改所属部门）">套岗</button>
                          <button onClick={() => setEditTarget(editing ? null : { positionId: r.positionId, draft: draftOf(r.departmentId, findDeptById(departments, r.departmentId)?.positions?.find((p) => p.id === r.positionId) ?? ({ id: r.positionId, departmentId: r.departmentId, name: r.name, headcount: r.headcount, status: r.status, createdAt: '', updatedAt: '' } as Position)) })}
                            className="ml-1 px-2 py-0.5 rounded-md text-[11px] text-slate-600 bg-slate-100 hover:bg-slate-200">编辑</button>
                          <button onClick={() => onArchivePosition(r.departmentId, r.positionId)}
                            className="ml-1 px-2 py-0.5 rounded-md text-[11px] text-red-600 bg-red-50 hover:bg-red-100" title="删除岗位（归档）：挂靠人员会进入「无明确岗位」提示">删除</button>
                        </td>
                      </tr>
                      {editing && (
                        <tr className="bg-indigo-50/40" data-edit-position-row={r.positionId}>
                          <td colSpan={7} className="px-3 py-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <input aria-label="编辑岗位名称" value={editTarget.draft.name}
                                onChange={(e) => setEditTarget({ ...editTarget, draft: { ...editTarget.draft, name: e.target.value } })}
                                className="px-2 py-1 rounded-lg border border-slate-200 text-xs focus-ring w-44" />
                              <select aria-label="编辑岗位序列" value={editTarget.draft.jobFamily}
                                onChange={(e) => setEditTarget({ ...editTarget, draft: { ...editTarget.draft, jobFamily: e.target.value } })}
                                className="px-2 py-1 rounded-lg border border-slate-200 text-xs focus-ring">
                                <option value="">序列（可选）</option>
                                {JOB_FAMILIES.map((f) => <option key={f} value={f}>{f}</option>)}
                              </select>
                              <select aria-label="编辑岗位职级下限" value={editTarget.draft.bandMin}
                                onChange={(e) => setEditTarget({ ...editTarget, draft: { ...editTarget.draft, bandMin: e.target.value } })}
                                className="px-2 py-1 rounded-lg border border-slate-200 text-xs focus-ring">
                                <option value="">职级下限</option>
                                {levelConfigs.map((c) => <option key={fullCode(c)} value={fullCode(c)}>{fullCode(c)}</option>)}
                              </select>
                              <select aria-label="编辑岗位职级上限" value={editTarget.draft.bandMax}
                                onChange={(e) => setEditTarget({ ...editTarget, draft: { ...editTarget.draft, bandMax: e.target.value } })}
                                className="px-2 py-1 rounded-lg border border-slate-200 text-xs focus-ring">
                                <option value="">职级上限</option>
                                {levelConfigs.map((c) => <option key={fullCode(c)} value={fullCode(c)}>{fullCode(c)}</option>)}
                              </select>
                              <button
                                onClick={() => {
                                  if (!editTarget.draft.name.trim()) return;
                                  onUpdatePosition(r.departmentId, r.positionId, {
                                    name: editTarget.draft.name.trim(),
                                    jobFamily: editTarget.draft.jobFamily || undefined,
                                    levelBandMin: editTarget.draft.bandMin || undefined,
                                    levelBandMax: editTarget.draft.bandMax || undefined,
                                    headcount: r.headcount,
                                  });
                                  setEditTarget(null);
                                }}
                                disabled={!editTarget.draft.name.trim()}
                                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-indigo-500 text-white font-medium hover:bg-indigo-600 disabled:opacity-40">
                                <Check className="w-3.5 h-3.5" />保存
                              </button>
                              <button onClick={() => setEditTarget(null)} className="flex items-center gap-1 px-2 py-1 rounded-lg text-slate-500 hover:bg-slate-100">
                                <X className="w-3.5 h-3.5" />取消
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                      {assignTarget === r.positionId && (
                        <tr className="bg-indigo-50/30" data-assign-row={r.positionId}>
                          <td colSpan={7} className="px-3 py-2">
                            <div className="flex items-start gap-3">
                              <div className="text-[11px] text-slate-500 max-h-40 overflow-y-auto rounded-lg border border-indigo-100 bg-white py-0.5 min-w-[280px]">
                                {candidatesOf(r.positionId).length === 0 && <div className="px-2 py-1 text-slate-400">没有可调入的员工</div>}
                                {candidatesOf(r.positionId).map((c) => (
                                  <button
                                    key={c.employee.id}
                                    onClick={() => { onAssignEmployee(c.employee.id, r.positionId); setAssignTarget(null); }}
                                    className="w-full text-left px-2 py-1 hover:bg-indigo-50 flex items-center gap-2"
                                    data-candidate={c.employee.id}
                                  >
                                    <span className="text-slate-700">{c.employee.name}</span>
                                    <span className="text-slate-400">（{c.employee.employeeId}）</span>
                                    <span className="ml-auto text-[10px] text-slate-400">
                                      现属 {c.deptName} › {c.curName}
                                      {c.sameDept && <span className="ml-1 text-amber-600">同部门</span>}
                                    </span>
                                  </button>
                                ))}
                              </div>
                              <div className="text-[11px] text-slate-400 leading-relaxed">
                                <p>「套岗」= 把该员工**调入本岗位所在部门**（从原部门移除）。</p>
                                <p>当前在岗：{occ.real.length ? occ.real.join('、') : '无'}</p>
                                <button onClick={() => setAssignTarget(null)} className="mt-1 text-slate-500 hover:underline">收起</button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </Fragment>
            ))}

            {/* —— 按岗位视图（同名跨部门聚合）—— */}
            {view === 'position' && nameGroups.map((g) => (
              <Fragment key={`n-${g.name}`}>
                <tr data-position-name-row={g.name} className="border-t border-slate-200 hover:bg-slate-50/60">
                  <td className="px-3 py-2">
                    <button
                      onClick={() => setExpandedNames((prev) => {
                        const next = new Set(prev);
                        if (next.has(g.name)) next.delete(g.name); else next.add(g.name);
                        return next;
                      })}
                      className="flex items-center gap-1.5 text-slate-800 hover:text-indigo-600"
                    >
                      {expandedNames.has(g.name) ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      {g.name}
                      {g.deptCount > 1 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 flex items-center gap-0.5" title={`同名岗位分布在 ${g.deptCount} 个部门，各自独立编制与在岗`}>
                          <Layers className="w-3 h-3" />分布在 {g.deptCount} 个部门
                        </span>
                      )}
                    </button>
                  </td>
                  <td className="px-2 py-2 text-slate-400">—</td>
                  <td className="px-2 py-2 text-right tabular-nums text-slate-700">{g.unconfigured > 0 ? <span className="text-slate-400" title={`${g.unconfigured} 个部门未配置编制`}>—</span> : g.headcount}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-slate-700">{g.occupied}</td>
                  <td className="px-2 py-2">
                    {g.pending > 0 ? <span className="text-[11px] font-medium text-amber-600">缺 {g.pending}</span>
                      : g.overflow > 0 ? <span className="text-[11px] font-medium text-red-600">超 {g.overflow}</span>
                      : g.unconfigured === g.rows.length ? <span className="text-[11px] text-slate-400">未配编制</span>
                      : <span className="text-[11px] font-medium text-emerald-600">满编</span>}
                  </td>
                  <td className="px-3 py-2 text-slate-500 text-[11px]">合计 {g.rows.length} 个岗位实体</td>
                  <td className="px-3 py-2 text-right text-[11px] text-slate-400">展开后可在各部门行内改编制 / 套岗</td>
                </tr>
                {expandedNames.has(g.name) && g.rows.map((r) => (
                  <tr key={`${g.name}-${r.positionId}`} data-subrow={r.positionId} className="border-t border-slate-100 bg-slate-50/40">
                    <td className="px-3 py-1.5 pl-8 text-slate-600">{r.deptPath}</td>
                    <td className="px-2 py-1.5 text-slate-500 whitespace-nowrap">{bandLabel(r)}</td>
                    <td className="px-2 py-1.5 text-right">{headcountCell(r.departmentId, r.positionId, r.headcount, r.headcountStatus)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-slate-700 whitespace-nowrap">{r.primaryOccupied}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{gapCell(r)}</td>
                    <td className="px-3 py-1.5 text-slate-600">
                      {occupantsOf(r.positionId).real.join('、') || <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-3 py-1.5 text-right whitespace-nowrap">
                      <button onClick={() => setAssignTarget(assignTarget === r.positionId ? null : r.positionId)}
                        className="px-2 py-0.5 rounded-md text-[11px] text-indigo-600 bg-indigo-50 hover:bg-indigo-100">套岗</button>
                      <button onClick={() => onArchivePosition(r.departmentId, r.positionId)}
                        className="ml-1 px-2 py-0.5 rounded-md text-[11px] text-red-600 bg-red-50 hover:bg-red-100">删除</button>
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <p className="pt-2 text-[10px] text-slate-400 leading-relaxed">
        {GAP_LIST_CALIBER}
        {totals.costMissing > 0 && ` 另有 ${totals.costMissing} 个待补岗位无法估算成本。`}
        已知缺口成本 {fmtCost(totals.gapCost)} 万元/月（仅含可估算部分）。
      </p>
    </SubPageShell>
  );
}
