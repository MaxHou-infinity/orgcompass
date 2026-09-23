import { Building2, Settings2, Minus, Plus, Undo2, Redo2, Activity, Search, GitCompare, Briefcase, Target } from 'lucide-react';
import { Scenario } from '../types';
import { SaveState } from '../utils/useOrgWorkspace';
import { ScenarioSwitcher } from './ScenarioSwitcher';
import { APP_VERSION } from '../version';

interface TopBarProps {
  scenarios: Scenario[];
  currentScenarioId: string;
  onSwitchScenario: (id: string) => void;
  onCreateScenario: (name: string) => void;
  onRenameScenario: (id: string, name: string) => void;
  onDeleteScenario: (id: string) => void;
  onDuplicateScenario: (id: string) => void;
  onManageScenarios: () => void;
  saveState: SaveState;
  lastSavedAt: string | null;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onOpenHealth: () => void;
  onOpenScenarioDiff: () => void;
  /** 场景差异比较需要 ≥2 个场景 */
  canCompare: boolean;
  hasData: boolean;
  onManageLevels: () => void;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onOpenSearch: () => void;
  /** V2.4.0：打开「岗位与编制」子界面（合并原「岗位操作」+「缺口清单」） */
  onOpenPositionBoard: () => void;
  /** v2.2.0：打开「胜任度」看板抽屉（评估/看板/维度配置入口） */
  onOpenCompetency: () => void;
}

function SaveIndicator({ saveState, lastSavedAt }: { saveState: SaveState; lastSavedAt: string | null }) {
  switch (saveState) {
    case 'unsaved':
      return <span className="inline-flex items-center gap-1 text-[10px] text-amber-600"><span className="w-1.5 h-1.5 rounded-full bg-amber-500" />未保存更改</span>;
    case 'saving':
      return <span className="inline-flex items-center gap-1 text-[10px] text-slate-500"><span className="w-1.5 h-1.5 rounded-full bg-slate-400 animate-pulse" />保存中…</span>;
    case 'failed':
      return <span className="inline-flex items-center gap-1 text-[10px] text-red-600"><span className="w-1.5 h-1.5 rounded-full bg-red-500" />保存失败</span>;
    case 'saved':
    default:
      return <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />已保存{lastSavedAt ? ` ${lastSavedAt}` : ''}</span>;
  }
}

export function TopBar({
  scenarios,
  currentScenarioId,
  onSwitchScenario,
  onCreateScenario,
  onRenameScenario,
  onDeleteScenario,
  onDuplicateScenario,
  onManageScenarios,
  saveState,
  lastSavedAt,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onOpenHealth,
  onOpenScenarioDiff,
  canCompare,
  hasData,
  onManageLevels,
  zoom,
  onZoomIn,
  onZoomOut,
  onOpenSearch,
  onOpenPositionBoard,
  onOpenCompetency,
}: TopBarProps) {
  return (
    <>
    <header className="workspace-header">
      {/*
          V2.4.0：顶部栏从两行合并为一行。
          - 删掉「版本号徽标」与「项目名」：项目名是 createProject 的默认值「组织架构项目」，
            用户从未设置过它，显示出来只是噪音（用户明确要求去掉）；版本号移入品牌 title。
          - 原来的第二行（工具条）整体并入本行，顶部高度减半。
        */}
        <div className="workspace-brand" title={`组织罗盘 OrgCompass v${APP_VERSION}`}>
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white shadow-md shrink-0">
            <Building2 className="w-4.5 h-4.5" />
          </div>
          <div className="leading-tight">
            <div className="text-[15px] font-bold text-slate-900 tracking-tight">组织罗盘</div>
            <div className="text-[10px] text-slate-500 tracking-wide">OrgCompass</div>
          </div>
        </div>

        <SaveIndicator saveState={saveState} lastSavedAt={lastSavedAt} />

        <ScenarioSwitcher
          scenarios={scenarios}
          currentScenarioId={currentScenarioId}
          onSwitch={onSwitchScenario}
          onCreate={onCreateScenario}
          onRename={onRenameScenario}
          onDelete={onDeleteScenario}
          onDuplicate={onDuplicateScenario}
          onManage={onManageScenarios}
        />

      <nav className="workspace-actions" aria-label="组织编辑">

        {/* V2.4.0：「岗位操作」与「缺口清单」合并为同一个页面级子界面 ——
            两者本来是同一份数据的两种看法（一个只读、一个写入），分开会出现「在 A 看、去 B 改」。 */}
        <button
          onClick={onOpenPositionBoard}
          disabled={!hasData}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="岗位与编制：全部岗位 / 编制与缺口 / 新增·编辑·删除 / 套岗 / 导出"
        >
          <Briefcase className="w-4 h-4" />
          岗位与编制
        </button>

        {/* v2.2.0：胜任度入口（看板/批量评估/维度配置；无数据时禁用） */}
        <button
          onClick={onOpenCompetency}
          disabled={!hasData}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="胜任度：评估/看板/维度配置"
        >
          <Target className="w-4 h-4" />
          胜任度
        </button>
      </nav>

      {/* 右区：搜索 + 健康度 + 场景对比 + 缩放 + 撤销/重做 + 职级管理（靠右推） */}
      <nav className="workspace-actions workspace-tools" aria-label="分析与视图">
        <button
          onClick={onOpenSearch}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-800 transition-colors"
          title="搜索 (Ctrl+F)"
        >
          <Search className="w-4 h-4" />
          搜索
        </button>

        <button
          onClick={onOpenHealth}
          disabled={!hasData}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="组织健康度"
        >
          <Activity className="w-4 h-4" />
          健康度
        </button>

        <button
          onClick={onOpenScenarioDiff}
          disabled={!canCompare}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title={canCompare ? '基线 vs 目标场景 差异比较' : '先复制一个场景再对比'}
        >
          <GitCompare className="w-4 h-4" />
          场景对比
        </button>

        <div className="flex items-center gap-0.5 px-1 py-0.5 rounded-lg bg-slate-100/80 border border-slate-200/60">
          <button
            onClick={onZoomOut}
            disabled={zoom <= 50}
            className="flex items-center justify-center w-7 h-7 rounded-md text-slate-600 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            aria-label="缩小"
            title="缩小"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <span className="text-xs font-semibold text-slate-700 w-10 text-center tabular-nums">
            {zoom}%
          </span>
          <button
            onClick={onZoomIn}
            disabled={zoom >= 200}
            className="flex items-center justify-center w-7 h-7 rounded-md text-slate-600 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            aria-label="放大"
            title="放大"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        <button
          onClick={onUndo}
          disabled={!canUndo}
          className="flex items-center justify-center w-9 h-9 rounded-lg text-slate-600 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          aria-label="撤销"
          title="撤销 (Ctrl+Z)"
        >
          <Undo2 className="w-4 h-4" />
        </button>
        <button
          onClick={onRedo}
          disabled={!canRedo}
          className="flex items-center justify-center w-9 h-9 rounded-lg text-slate-600 hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          aria-label="重做"
          title="重做 (Ctrl+Shift+Z)"
        >
          <Redo2 className="w-4 h-4" />
        </button>

        <button
          onClick={onManageLevels}
          className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-800 transition-colors"
        >
          <Settings2 className="w-4 h-4" />
          职级管理
        </button>
      </nav>
    </header>
    </>
  );
}
