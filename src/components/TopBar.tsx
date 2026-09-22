import { useState, useRef, useEffect } from 'react';
import { ChevronDown, FileSpreadsheet, Building2, Settings2, Minus, Plus, Undo2, Redo2, Activity, Search, LayoutTemplate, GitCompare, Briefcase, Target, ClipboardList } from 'lucide-react';
import { Scenario } from '../types';
import { OrgTemplate } from '../types';
import { SaveState } from '../utils/useOrgWorkspace';
import { ScenarioSwitcher } from './ScenarioSwitcher';
import { INDUSTRY_TEMPLATES } from '../utils/industryTemplates';
import { APP_VERSION } from '../version';

/** 从行业模板的 orgTemplate 提取「一级部门 → 二级部门」结构，供悬停图例渲染。 */
function templateLegend(orgs: Pick<OrgTemplate, 'dept1' | 'dept2' | 'deptLevel' | 'leaderName'>[]) {
  const map = new Map<string, { name: string; level: number; leaderName?: string; children: string[] }>();
  for (const o of orgs) {
    const l1 = o.dept1;
    const l2 = o.dept2;
    if (!l1) continue;
    let entry = map.get(l1);
    if (!entry) {
      entry = { name: l1, level: Number(o.deptLevel) || 1, leaderName: o.leaderName, children: [] };
      map.set(l1, entry);
    }
    if (l2 && !entry.children.includes(l2)) entry.children.push(l2);
  }
  return Array.from(map.values());
}

interface TopBarProps {
  projectName: string;
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
  onDownloadEmployeeTemplate: () => void;
  onDownloadOrgTemplate: () => void;
  onManageLevels: () => void;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onOpenSearch: () => void;
  onLoadIndustryTemplate: (id: string) => void;
  /** v2.1.1：打开「岗位操作」弹窗（新建/套岗/建虚拟兼岗） */
  onOpenPositionOps: () => void;
  /** v2.2.0：打开「胜任度」看板抽屉（评估/看板/维度配置入口） */
  onOpenCompetency: () => void;
  /** v2.3 M4：打开「岗位缺口清单」（当前场景直接查看与导出） */
  onOpenGapList: () => void;
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
  projectName,
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
  onDownloadEmployeeTemplate,
  onDownloadOrgTemplate,
  onManageLevels,
  zoom,
  onZoomIn,
  onZoomOut,
  onOpenSearch,
  onLoadIndustryTemplate,
  onOpenPositionOps,
  onOpenCompetency,
  onOpenGapList,
}: TopBarProps) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [hoverTemplateId, setHoverTemplateId] = useState<string | null>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const templatesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (toolsRef.current && !toolsRef.current.contains(e.target as Node)) {
        setToolsOpen(false);
      }
      if (templatesRef.current && !templatesRef.current.contains(e.target as Node)) {
        setTemplatesOpen(false);
      }
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  return (
    <>
    <header className="workspace-header">
      {/* 左区：品牌 + 项目名 + 场景切换 + 保存状态 */}
      <div className="workspace-context">
        <div className="flex items-center gap-3 shrink-0">
          <div className="w-9 h-9 rounded-lg bg-indigo-600 flex items-center justify-center text-white shadow-md">
            <Building2 className="w-5 h-5" />
          </div>
          <div className="leading-tight">
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-bold text-slate-900 tracking-tight">组织罗盘</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-600 font-medium">v{APP_VERSION}</span>
            </div>
            <div className="text-[10px] text-slate-500 tracking-wide">OrgCompass</div>
          </div>
        </div>

        <div className="workspace-save">
          <span className="text-sm font-medium text-slate-700 truncate max-w-48" title={projectName}>{projectName}</span>
          <SaveIndicator saveState={saveState} lastSavedAt={lastSavedAt} />
        </div>

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

      </div>
      <div className="workspace-toolbar">
      <nav className="workspace-actions" aria-label="组织编辑">
        {/* 工具模板 子菜单 */}
        <div className="relative" ref={toolsRef}>
          <button
            aria-expanded={toolsOpen}
            onClick={() => { setToolsOpen((v) => !v); setTemplatesOpen(false); }}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-indigo-50 text-indigo-700 text-sm font-medium hover:bg-indigo-100 transition-all"
          >
            <FileSpreadsheet className="w-4 h-4" />
            工具模板
            <ChevronDown className={`w-4 h-4 transition-transform ${toolsOpen ? 'rotate-180' : ''}`} />
          </button>

          {toolsOpen && (
            <div className="absolute left-0 top-full mt-2 w-64 rounded-2xl bg-white/90 backdrop-blur-xl border border-slate-100 shadow-xl p-2 z-50 animate-fadeInUp">
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-slate-500">
                下载 Excel 模板
              </div>
              <button
                onClick={() => {
                  setToolsOpen(false);
                  onDownloadEmployeeTemplate();
                }}
                className="w-full flex items-start gap-3 px-3 py-2.5 rounded-xl hover:bg-indigo-50 transition-colors text-left"
              >
                <span className="w-9 h-9 rounded-lg grid place-items-center bg-indigo-50 text-indigo-500 shrink-0">
                  <FileSpreadsheet className="w-4 h-4" />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-slate-800">员工信息模板</span>
                  <span className="block text-xs text-slate-500 mt-0.5 leading-snug">含姓名/工号/职级/岗位/一~六级部门（上传即可生成架构图）</span>
                </span>
              </button>
              <button
                onClick={() => {
                  setToolsOpen(false);
                  onDownloadOrgTemplate();
                }}
                className="w-full flex items-start gap-3 px-3 py-2.5 rounded-xl hover:bg-emerald-50 transition-colors text-left"
              >
                <span className="w-9 h-9 rounded-lg grid place-items-center bg-emerald-50 text-emerald-500 shrink-0">
                  <Building2 className="w-4 h-4" />
                </span>
                <span>
                  <span className="block text-sm font-semibold text-slate-800">组织架构模板<span className="ml-1 text-[10px] font-medium text-emerald-600 bg-emerald-50 px-1 py-0.5 rounded">补充</span></span>
                  <span className="block text-xs text-slate-500 mt-0.5 leading-snug">可选：补「无人的空部门」与「部门负责人」</span>
                </span>
              </button>
            </div>
          )}
        </div>

        {/* 行业模板 下拉 */}
        <div className="relative" ref={templatesRef}>
          <button
            aria-expanded={templatesOpen}
            onClick={() => { setTemplatesOpen((v) => !v); setToolsOpen(false); }}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-800 transition-colors"
          >
            <LayoutTemplate className="w-4 h-4" />
            行业模板
            <ChevronDown className={`w-4 h-4 transition-transform ${templatesOpen ? 'rotate-180' : ''}`} />
          </button>
          {templatesOpen && (
            <div className="absolute left-0 top-full mt-2 w-[560px] max-w-[calc(100vw-32px)] rounded-2xl bg-white/90 backdrop-blur-xl border border-slate-100 shadow-xl p-2 z-50 animate-fadeInUp flex gap-2">
              <div className="flex-1">
                <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-slate-500">
                  一键载入示例组织（移到模板看右侧图例）
                </div>
                {INDUSTRY_TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      setTemplatesOpen(false);
                      setHoverTemplateId(null);
                      onLoadIndustryTemplate(t.id);
                    }}
                    onMouseEnter={() => setHoverTemplateId(t.id)}
                    onFocus={() => setHoverTemplateId(t.id)}
                    className={`w-full flex items-start gap-3 px-3 py-2.5 rounded-xl transition-colors text-left ${
                      hoverTemplateId === t.id ? 'bg-indigo-50' : 'hover:bg-indigo-50'
                    }`}
                  >
                    <span
                      className="w-9 h-9 rounded-lg grid place-items-center shrink-0 text-white"
                      style={{ backgroundColor: t.accent }}
                    >
                      <LayoutTemplate className="w-4 h-4" />
                    </span>
                    <span>
                      <span className="block text-sm font-semibold text-slate-800">{t.name}</span>
                      <span className="block text-xs text-slate-500 mt-0.5 leading-snug">{t.description}</span>
                    </span>
                  </button>
                ))}
              </div>
              {/* 悬停图例 */}
              <div className="hidden sm:block w-56 shrink-0 rounded-xl border border-slate-100 bg-slate-50/60 p-3 overflow-y-auto max-h-80">
                {(() => {
                  const t = INDUSTRY_TEMPLATES.find((x) => x.id === hoverTemplateId);
                  if (!t) return <div className="text-[11px] text-slate-500">将光标移到左侧模板查看组织结构图例</div>;
                  const levels = templateLegend(t.orgTemplates);
                  return (
                    <div>
                      <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">组织结构图例</div>
                      <div className="space-y-1">
                        {levels.map((lv) => (
                          <div key={lv.name}>
                            <div className={`text-[12px] font-medium ${lv.level === 1 ? 'text-indigo-600' : 'text-slate-600'} pl-${lv.level === 1 ? '0' : '3'}`}>
                              {lv.level === 1 ? '┌ ' : '└ '}{lv.name}
                              {lv.leaderName && <span className="text-[10px] text-slate-500"> · {lv.leaderName}</span>}
                            </div>
                            {lv.children.map((c) => (
                              <div key={c} className="text-[11px] text-slate-500 pl-5">└ {c}</div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}
        </div>

        <button
          onClick={onOpenPositionOps}
          disabled={!hasData}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="岗位操作：新建岗位 / 套岗 / 建虚拟兼岗"
        >
          <Briefcase className="w-4 h-4" />
          岗位
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

        {/* v2.3 M4：岗位缺口清单（当前场景直读，不要求先建第二个场景） */}
        <button
          onClick={onOpenGapList}
          disabled={!hasData}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="岗位缺口清单：编制/占用/待补/超额与成本依据，可直接导出"
        >
          <ClipboardList className="w-4 h-4" />
          缺口清单
        </button>
      </nav>

      {/* 右区：缩放 + 撤销/重做 + 健康度 + 职级管理 */}
      <nav className="workspace-actions" aria-label="分析与视图">
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
      </div>
    </header>
    </>
  );
}
