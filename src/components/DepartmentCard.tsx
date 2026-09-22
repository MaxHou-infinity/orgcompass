import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, ChevronUp, User, Users, Building2, Briefcase } from 'lucide-react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { Department, Employee, MatchStatus, LeaderType } from '../types';
import { useLevelConfigs, getLevelColor } from '../utils/levels';
import { withAlpha } from '../utils/level';
import { useSearchHighlight } from './SearchContext';
import { employeeLevelGap } from '../utils/analytics';
import { PositionSummary } from '../utils/analytics';
import { MatchResult } from '../utils/match';
import { useDisplaySettings } from '../utils/displaySettings';
import { TargetLevelModal } from './TargetLevelModal';
import { COMPETENCY_STYLE, COMPETENCY_LABEL, CompetencyStatus, fmt } from '../utils/statusUI';
import type { CompetencySummary } from '../utils/competency';
import { describeLevelGap, levelGapBadge, type DeptLevelGap } from '../utils/deptLevel';

interface DepartmentCardProps {
  department: Department;
  onToggleExpand: (id: string) => void;
  onUpdateDepartment: (id: string, name: string) => void;
  onUpdateLeader: (deptId: string, employee: Employee | null) => void;
  /** v2.3.1（Q-07）：负责人类型写入口 */
  onUpdateLeaderType: (deptId: string, leaderType: LeaderType | undefined) => void;
  onDeleteEmployee: (deptId: string, empId: string) => void;
  onCreateVirtualFromEmployee: (deptId: string, empId: string) => void;
  onChangeDepartmentLevel: (deptId: string, newLevel: number, newParentId: string | null) => void;
  allEmployees: Employee[];
  /** 当前选中的员工 id（批量操作用） */
  selectedEmpIds?: Set<string>;
  /** 点击员工切换选中（additive=Shift 加成选） */
  onToggleSelectEmp?: (empId: string, additive: boolean) => void;
  onSetTargetLevel: (empId: string, target: string) => void;
  onMoveMultiple: (empIds: string[], toDeptId: string) => void;
  allDepartments: Department[];
  /** v2.0.11：成员列表是否「展开全部」；缺省 false = 收起（紧凑卡，不滚动） */
  membersExpanded?: boolean;
  /** v2.0.11：切换成员列表展开/收起 */
  onToggleMembers?: (deptId: string) => void;
  // —— v2.1.1 岗位化（卡片为纯展示；新建/套岗/兼岗走顶部「岗位」入口）——
  positionSummaries?: PositionSummary[];
  matchStates?: MatchResult[];
  onSetPositionHeadcount?: (deptId: string, positionId: string, headcount: number) => void;
  onRemoveAssignment?: (empId: string) => void;
  // —— v2.2.0 胜任度三信号 ——
  /** 胜任度汇总（computeCompetencyStates 输出，key = Employee.id；缺省 = 全员「未评」灰环，不隐藏） */
  competencySummaries?: Map<string, CompetencySummary>;
  /** 点击员工标签胜任度环（或右键「查看胜任度」）→ 打开胜任度详情 */
  onOpenCompetencyDetail?: (empId: string) => void;
  /**
   * v2.3.2：层级断档信息（该部门声明层级 ≠ 父层级 + 1，即向上无归属）。
   * 由 `computeLevelGaps` 派生传入 —— 卡片不自己猜父级，避免两处口径漂移。
   */
  levelGap?: DeptLevelGap;
}

/** 套岗状态点（placed/unassigned/overstaffed/not_competent）。
 *  v2.2.0：not_competent 由胜任度红灯派生为真实状态 → 灰 → 红空心环
 *  （border-red-400 + bg-red-50 空心，与 overstaffed 红实心点区分，design §8.2 = visual §3.5）。 */
const MATCH_DOT: Record<MatchStatus, { dot: string; text: string; label: string; title: string }> = {
  placed: { dot: 'bg-emerald-500', text: 'text-emerald-600', label: '已套岗', title: '已套岗位' },
  unassigned: { dot: 'bg-amber-500', text: 'text-amber-600', label: '未套岗', title: '未套岗位' },
  overstaffed: { dot: 'bg-red-500', text: 'text-red-600', label: '超编', title: '岗位超编' },
  not_competent: { dot: 'bg-red-50 border border-red-400', text: 'text-red-700', label: '不胜任', title: '不胜任（胜任度低于要求，已确认）' },
};

/**
 * 岗位文字的展示口径（v2.3.2）。
 *
 * v2.3.2 之前，员工表「岗位」列留空会被导入层写成字符串 `'NA'`，画布上真的渲染出 "NA" ——
 * 把「用户没填」显示成了「岗位叫 NA」。导入层已改为不落该值，但**历史数据里仍存着 'NA'**，
 * 因此在展示层统一把它当作「未填」，让旧项目文件也能立刻恢复干净（不需要用户重导一次）。
 */
function displayTitle(title?: string): string | undefined {
  const v = title?.trim();
  return v && v !== 'NA' ? v : undefined;
}

/** 岗位卡「岗位」区（v2.1.1，纯展示）：展示本部门直属岗位 + 编制/在岗/缺口。
 *  新建/套岗/建虚拟兼岗操作用户从顶部菜单「岗位」入口进入（已从卡片解耦）。 */
function PositionSection({
  dept,
  summaryById,
  onSetPositionHeadcount,
}: {
  dept: Department;
  summaryById: Map<string, PositionSummary>;
  onSetPositionHeadcount?: (deptId: string, positionId: string, headcount: number) => void;
}) {
  const positions = dept.positions ?? [];
  const total = positions.length;

  return (
    <div className="px-3 pb-2 border-b border-slate-100">
      <div className="flex items-center justify-between mb-1.5">
        <span className="flex items-center gap-1 text-xs text-gray-500">
          <Briefcase className="w-3 h-3 shrink-0" />
          岗位 ({total})
        </span>
      </div>

      {positions.length === 0 ? (
        <div className="text-[11px] text-slate-400 text-center py-1.5">暂无岗位（顶部「岗位」可新建）</div>
      ) : (
        <div className="space-y-1">
          {positions.map((pos) => {
            const s = summaryById.get(pos.id);
            const frozen = pos.status === 'frozen';
            const assignedCount = s?.assignedCount ?? 0;
            const gap = s?.gap ?? null;
            return (
              <div key={pos.id} className="rounded-lg border border-slate-100 bg-white/60 p-1.5">
                <div className="flex items-center gap-1">
                  <Briefcase className="w-3 h-3 shrink-0 text-slate-400" />
                  {/*
                    v2.3.2：岗位名可以很长（「中文名 - English Full Title」，实测最长 374px）。
                    它必须**能让位**给右侧数字：`min-w-0` 才允许 flex 子项收缩到小于内容宽度，
                    `truncate` 负责省略号，`title` 保证悬停可读全文。
                    旧实现缺 `min-w-0`，于是长岗位名把右侧数字挤成每行一个字（竖排），
                    岗位行实测被撑到 74px（布局按 40px 估算）→ 子部门被摆进父卡内部、引导线被盖住。
                  */}
                  <span
                    className="min-w-0 flex-1 truncate text-xs font-medium text-slate-700"
                    title={pos.name}
                  >
                    {pos.name}
                  </span>
                  {frozen && (
                    <span className="shrink-0 text-[10px] px-1 rounded bg-slate-100 text-slate-500" title="编制已冻结，不计缺口">
                      冻结
                    </span>
                  )}
                  {/* 右侧数字簇**整体不可压缩**：它是「这个岗位到底几个人」的唯一答案，不能被挤掉 */}
                  <span className="ml-auto flex shrink-0 items-center gap-1 whitespace-nowrap">
                    {/*
                      v2.3.2：在岗人数 = 员工表里该部门下「岗位」列同名的员工自动汇总（在岗）。
                      此前它只是「/ 在岗 N」的小灰字，被挤成竖排后用户只看到编制输入框里的 0，
                      误以为岗位数量算错了。现在把在岗提到编制之前、做成有色胶囊。
                    */}
                    <span
                      className="text-[10px] px-1 py-0.5 rounded font-medium bg-indigo-50 text-indigo-700 tabular-nums"
                      title={`在岗 ${assignedCount} 人：按员工表里本部门下「岗位」列与本岗位同名的员工自动汇总`}
                    >
                      在岗 {assignedCount}
                    </span>
                    <input
                      type="number"
                      min="0"
                      value={pos.headcount}
                      onChange={(e) => {
                        const v = e.target.value === '' ? 0 : Number(e.target.value);
                        onSetPositionHeadcount?.(dept.id, pos.id, Number.isFinite(v) ? v : 0);
                      }}
                      aria-label={`${pos.name} 编制`}
                      title="岗位编制（可编辑）。员工信息表不含编制列，所以新导入的岗位编制默认为 0，需要在这里按实际编制填写"
                      className="w-11 shrink-0 px-1 py-0.5 rounded border border-slate-200 text-right text-xs tabular-nums focus-ring"
                    />
                    <span className={`text-[10px] font-medium ${gap === null ? 'text-slate-400' : gap > 0 ? 'text-amber-600' : gap < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                      {gap === null ? (frozen ? '冻结' : '未配编制') : gap > 0 ? `缺 ${gap}` : gap < 0 ? `超 ${Math.abs(gap)}` : '满编'}
                    </span>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DraggableEmployee({ 
  employee,
  selected,
  onSelect,
  matchStatus,
  getEmpName,
  competencySummaries,
  onOpenCompetencyDetail,
}: { 
  employee: Employee;
  selected?: boolean;
  onSelect?: (empId: string, additive: boolean) => void;
  matchStatus?: MatchStatus;
  getEmpName?: (id: string) => string;
  competencySummaries?: Map<string, CompetencySummary>;
  onOpenCompetencyDetail?: (empId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: employee.id,
    data: employee,
  });

  const levelConfigs = useLevelConfigs();
  const levelColor = getLevelColor(levelConfigs, employee.level);
  const highlight = useSearchHighlight();
  const isSearchHit = highlight.empIds.has(employee.id);
  const { showLevel, showTitle } = useDisplaySettings();
  const match = matchStatus ? MATCH_DOT[matchStatus] : null;
  const primaryName = employee.isVirtual && employee.primaryEmployeeId ? getEmpName?.(employee.primaryEmployeeId) : null;

  // —— v2.2.0 胜任度环（三信号同框：左匹配点实心 / 右胜任度环空心 / 右职级差距 +N，能力在前、职级在后）——
  // 未评 = 中性灰空心环 + 「未评」，显式呈现、绝不隐藏（隐藏 = 黑盒，ux §2.1）。
  const competencySummary = competencySummaries?.get(employee.id);
  const competencyStatus: CompetencyStatus = competencySummary?.overall ? competencySummary.overall.status : 'unrated';
  const competencyScore = competencySummary?.overall ? fmt(competencySummary.overall.score) : '—';
  // 阈值 = 加权要求分：overall.gap = Σ(requirement×权重) − score（仅展示，不判灯），故 requirement = score + gap。
  const competencyThreshold = competencySummary?.overall ? fmt(competencySummary.overall.score + competencySummary.overall.gap) : '—';
  const competencyStyle = COMPETENCY_STYLE[competencyStatus];
  
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      data-emp-id={employee.id}
      onClick={(e) => {
        // 阻止拖拽/点击冒泡到卡片的空白选中
        e.stopPropagation();
        onSelect?.(employee.id, e.shiftKey);
      }}
      className={`employee-tag flex flex-col gap-0.5 px-2 py-1 rounded-lg text-xs cursor-move hover:shadow-sm transition-shadow ${
        isDragging ? 'opacity-50' : ''
      } ${selected ? 'ring-2 ring-indigo-400 bg-indigo-50/80' : ''} ${
        isSearchHit ? 'ring-2 ring-amber-400 bg-amber-50/70' : ''
      }`}
      /* v2.3.2：用 withAlpha 而不是裸拼 `color + '40'` —— 非法颜色值会拼出非法 CSS 并被静默丢弃 */
      style={{ backgroundColor: withAlpha(levelColor, '40') }}
    >
      <div className="flex items-center gap-1">
        <User className="w-3 h-3" style={{ color: levelColor }} />
        {match && (
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${match.dot}`}
            title={`${match.label} · ${match.title}`}
          />
        )}
        <span className="truncate">{employee.name}</span>
        {/* 胜任度环（空心环 + 图标；点击 → 胜任度详情；onPointerDown 阻断拖拽起点，避免与 dnd 冲突） */}
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onOpenCompetencyDetail?.(employee.id);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onOpenCompetencyDetail?.(employee.id);
            }
          }}
          className={`inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border-2 text-[9px] font-bold leading-none shrink-0 cursor-pointer ${competencyStyle.ring} ${competencyStyle.text}`}
          title={`胜任度 · ${COMPETENCY_LABEL[competencyStatus]} · 综合 ${competencyScore} · 阈值 ${competencyThreshold}`}
          aria-label={`胜任度：${COMPETENCY_LABEL[competencyStatus]}`}
        >
          {competencyStyle.glyph}
        </span>
        {(() => {
          const gap = employeeLevelGap(employee);
          if (!gap) return null;
          const cls =
            gap.status === 'healthy'
              ? 'bg-emerald-100 text-emerald-600'
              : gap.status === 'warn'
                ? 'bg-amber-100 text-amber-600'
                : 'bg-red-100 text-red-600';
          return (
            <span
              className={`text-[10px] px-1 rounded font-medium ${cls}`}
              title={`目标 ${employee.targetLevel} · ${gap.label}`}
            >
              {gap.gap > 0 ? `+${gap.gap}` : gap.gap}
            </span>
          );
        })()}
        {employee.isVirtual && (
          <span className="text-[10px] text-blue-500 font-medium">(兼)</span>
        )}
      </div>
      {(primaryName || showLevel || (showTitle && displayTitle(employee.title))) && (
        <div className="flex items-center gap-1 pl-1">
          {primaryName && (
            <span className="text-[10px] text-blue-500 truncate" title={`兼岗归属：${primaryName}`}>
              {primaryName}
            </span>
          )}
          {showTitle && displayTitle(employee.title) ? (
            <span className="text-[10px] text-slate-500 truncate">{displayTitle(employee.title)}</span>
          ) : null}
          {showLevel && employee.level ? (
            <span className="text-[10px] shrink-0 px-1 rounded bg-white/70 border border-slate-200 text-slate-600">{employee.level}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}

function flattenDeptOptions(depts: Department[]): { id: string; name: string; level: number }[] {
  const out: { id: string; name: string; level: number }[] = [];
  const walk = (list: Department[]) => {
    for (const d of list) {
      out.push({ id: d.id, name: d.name, level: d.level });
      walk(d.children);
    }
  };
  walk(depts);
  return out;
}

function EmployeeList({ 
  employees, 
  onDelete,
  canDelete,
  selectedEmpIds,
  onSelect,
  onCreateVirtual,
  onMoveMultiple,
  departments,
  currentDeptId,
  matchStateById,
  getEmpName,
  onRemoveAssignment,
  onOpenTargetLevel,
  competencySummaries,
  onOpenCompetencyDetail,
}: { 
  employees: Employee[];
  onDelete: (empId: string) => void;
  canDelete: boolean;
  selectedEmpIds?: Set<string>;
  onSelect?: (empId: string, additive: boolean) => void;
  onCreateVirtual?: (empId: string) => void;
  onMoveMultiple?: (empIds: string[], toDeptId: string) => void;
  departments: Department[];
  currentDeptId?: string;
  matchStateById?: Map<string, MatchResult>;
  getEmpName?: (id: string) => string;
  onRemoveAssignment?: (empId: string) => void;
  onOpenTargetLevel?: (emp: Employee) => void;
  competencySummaries?: Map<string, CompetencySummary>;
  onOpenCompetencyDetail?: (empId: string) => void;
}) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; empId: string } | null>(null);
  const [showMove, setShowMove] = useState(false);
  const deptOptions = flattenDeptOptions(departments).filter((d) => d.id !== currentDeptId);
  
  useEffect(() => {
    const handleClick = () => { setContextMenu(null); setShowMove(false); };
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, []);
  
  const handleContextMenu = (e: React.MouseEvent, empId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (canDelete) {
      setContextMenu({ x: e.clientX, y: e.clientY, empId });
      setShowMove(false);
    }
  };
  
  return (
    <div className="relative">
      {employees.map(emp => (
        <div
          key={emp.id}
          onContextMenu={(e) => handleContextMenu(e, emp.id)}
        >
          <DraggableEmployee employee={emp} selected={selectedEmpIds?.has(emp.id)} onSelect={onSelect} matchStatus={matchStateById?.get(emp.id)?.status} getEmpName={getEmpName} competencySummaries={competencySummaries} onOpenCompetencyDetail={onOpenCompetencyDetail} />
          {contextMenu?.empId === emp.id && (
            createPortal(
              <div
                className="fixed bg-white border border-gray-200 rounded-lg shadow-xl py-1 z-50 min-w-[200px] max-w-[280px]"
                style={{ left: contextMenu.x, top: contextMenu.y }}
                onClick={(e) => e.stopPropagation()}
              >
                {selectedEmpIds?.has(emp.id) && (
                  <button
                    className="w-full px-4 py-1.5 text-left text-sm hover:bg-gray-100 text-slate-700 truncate whitespace-nowrap"
                    onClick={() => {
                      onCreateVirtual?.(emp.id);
                      setContextMenu(null);
                    }}
                  >
                    创建虚拟员工（兼岗）
                  </button>
                )}
                {selectedEmpIds?.has(emp.id) && (
                  <button
                    className="w-full px-4 py-1.5 text-left text-sm hover:bg-gray-100 text-slate-700 truncate whitespace-nowrap flex items-center justify-between"
                    onClick={() => setShowMove((v) => !v)}
                  >
                    移动其他部门
                    <span className="text-gray-400">{showMove ? '▲' : '▼'}</span>
                  </button>
                )}
                {showMove && contextMenu?.empId === emp.id && deptOptions.length > 0 && (
                  <div className="max-h-40 overflow-y-auto border-t border-gray-100 py-1">
                    {deptOptions.map((d) => (
                      <button
                        key={d.id}
                        className="w-full px-4 py-1 text-left text-sm hover:bg-gray-100 text-slate-700 truncate whitespace-nowrap"
                        onClick={() => {
                          const moveIds = selectedEmpIds && selectedEmpIds.has(emp.id) ? Array.from(selectedEmpIds) : [emp.id];
                          onMoveMultiple?.(moveIds, d.id);
                          setContextMenu(null);
                          setShowMove(false);
                        }}
                      >
                        {'　'.repeat(Math.min(d.level - 1, 3))}{d.name}
                      </button>
                    ))}
                  </div>
                )}
                <button
                  className="w-full px-4 py-1.5 text-left text-sm hover:bg-gray-100 text-slate-700 truncate whitespace-nowrap"
                  onClick={() => {
                    onOpenTargetLevel?.(emp);
                    setContextMenu(null);
                  }}
                >
                  设置目标职级
                </button>
                {onOpenCompetencyDetail && (
                  <button
                    className="w-full px-4 py-1.5 text-left text-sm hover:bg-gray-100 text-slate-700 truncate whitespace-nowrap"
                    onClick={() => {
                      onOpenCompetencyDetail(emp.id);
                      setContextMenu(null);
                    }}
                  >
                    查看胜任度
                  </button>
                )}
                {emp.positionId && (
                  <button
                    className="w-full px-4 py-1.5 text-left text-sm hover:bg-gray-100 text-slate-700 truncate whitespace-nowrap"
                    onClick={() => {
                      onRemoveAssignment?.(emp.id);
                      setContextMenu(null);
                    }}
                  >
                    取消套岗
                  </button>
                )}
                <button
                  className="w-full px-4 py-1.5 text-left text-sm hover:bg-gray-100 text-red-500 truncate whitespace-nowrap"
                  onClick={() => {
                    onDelete(emp.id);
                    setContextMenu(null);
                  }}
                >
                  删除员工
                </button>
              </div>,
              document.body,
            )
          )}
        </div>
      ))}
    </div>
  );
}

export function DepartmentCard({
  department,
  onToggleExpand,
  onUpdateDepartment,
  onUpdateLeader,
  onUpdateLeaderType,
  onDeleteEmployee,
  onCreateVirtualFromEmployee,
  onChangeDepartmentLevel,
  onSetTargetLevel,
  onMoveMultiple,
  allDepartments,
  allEmployees,
  selectedEmpIds,
  onToggleSelectEmp,
  membersExpanded = false,
  onToggleMembers,
  positionSummaries = [],
  matchStates = [],
  onSetPositionHeadcount,
  onRemoveAssignment,
  competencySummaries,
  onOpenCompetencyDetail,
  levelGap,
}: DepartmentCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(department.name);
  const [showLeaderSearch, setShowLeaderSearch] = useState(false);
  const [leaderSearch, setLeaderSearch] = useState('');
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPos, setContextMenuPos] = useState({ x: 0, y: 0 });
  const [showLevelMenu, setShowLevelMenu] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const levelConfigs = useLevelConfigs();
  const highlight = useSearchHighlight();
  const isSearchHit = highlight.deptIds.has(department.id);
  const { showLevel, showTitle } = useDisplaySettings();
  const leader = allEmployees.find((e) => e.employeeId === department.leaderId && !e.isVirtual);

  // —— v2.1.1 岗位化：把扁平汇总/匹配状态镜像为 id→数据 查表（部门卡岗位区 / 员工状态点用） ——
  const summaryById = useMemo(
    () => new Map<string, PositionSummary>(positionSummaries.map((p) => [p.positionId, p])),
    [positionSummaries],
  );
  const matchById = useMemo(
    () => new Map<string, MatchResult>(matchStates.map((r) => [r.employeeId, r])),
    [matchStates],
  );
  const getEmpName = useCallback((id: string) => allEmployees.find((e) => e.id === id)?.name ?? '', [allEmployees]);

  // —— v2.1.1 应用内弹窗（替代原生 window.prompt）：目标职级 / 新建岗位 ——
  const [targetLevelEmp, setTargetLevelEmp] = useState<Employee | null>(null);
  
  // 部门拖拽
  const { attributes: deptAttributes, listeners: deptListeners, setNodeRef: setDeptRef, isDragging: isDeptDragging } = useDraggable({
    id: `dept-drag-${department.id}`,
    data: { type: 'department', department },
    // v2.1.1：本卡打开「新建岗位/目标职级」弹窗时禁用拖拽 —— 否则弹窗内原生 <select>
    // 交互的指针移动会被 dnd-kit PointerSensor 误判为对卡的拖拽（用户反馈）。
    disabled: !!targetLevelEmp,
  });
  
  const { setNodeRef, isOver } = useDroppable({
    id: `dept-${department.id}`,
    data: { type: 'department', department },
  });
  
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);
  
  const handleDoubleClick = () => {
    setIsEditing(true);
    setEditName(department.name);
  };
  
  const handleNameSubmit = () => {
    if (editName.trim() && editName !== department.name) {
      onUpdateDepartment(department.id, editName.trim());
    }
    setIsEditing(false);
  };
  
  const handleLeaderClick = () => {
    setShowLeaderSearch(!showLeaderSearch);
  };
  
  const filteredEmployees = allEmployees.filter(emp =>
    emp.name.toLowerCase().includes(leaderSearch.toLowerCase()) ||
    emp.employeeId.toLowerCase().includes(leaderSearch.toLowerCase())
  );
  
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenuPos({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  };
  
  useEffect(() => {
    const handleClick = () => setShowContextMenu(false);
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, []);
  
  /**
   * 部门层级配色（唯一来源，v2.3.2 定稿）：**只染表头，不染卡身**。
   *
   * 为什么统一成「白卡 + 层级色表头」：
   * - 一~三级本来就是这个样子（卡身白、表头带层级色），四级往下此前是「整卡淡蓝 + 左侧色条」，
   *   同一张画布上并存两套视觉语言，层级读起来要记两套规则；
   * - 深层的卡片数量最多（真实数据 10 张卡里 5 张在五、六级且并排），整卡大面积上色会让画布变花，
   *   并且和真正重要的信号抢注意力：靛蓝的「在岗 N」胶囊、琥珀色的断档/缺口提示、胜任度灯；
   * - 四级往下整卡上色本身是兜底 class 的副作用（见 index.css 的说明），不是设计决定。
   *
   * ⚠️ 同时必须遵守的不变量：**卡身不透明**。引导线画在卡片下层，父卡的连线按设计从卡内起画、
   * 靠卡面遮住上半段 —— 卡身一旦半透明，连线就会纵穿整张卡片（v2.3.2 已修过一次）。
   * 因此这里不再给卡身任何底色类，遮挡层统一由 `.department-card` 的白色底提供，
   * 由 `src/utils/v232.surface.test.ts` 守住。
   *
   * 色板：一靛蓝 → 二翠绿 → 三琥珀 → 四天青 → 五紫 → 六玫红；
   * 七级及以上（手工创建可超过 6 级）落中性灰，不再无限扩色板。
   */
  const LEVEL_HEADER_BG: Record<number, string> = {
    1: 'bg-gradient-to-r from-indigo-500/10 to-transparent',
    2: 'bg-gradient-to-r from-emerald-500/10 to-transparent',
    3: 'bg-gradient-to-r from-amber-500/10 to-transparent',
    4: 'bg-gradient-to-r from-sky-500/10 to-transparent',
    5: 'bg-gradient-to-r from-purple-500/10 to-transparent',
    6: 'bg-gradient-to-r from-rose-500/10 to-transparent',
  };
  /** 7 级及以上 */
  const FALLBACK_HEADER_BG = 'bg-gradient-to-r from-slate-400/10 to-transparent';

  return (
    <div
      ref={(node) => {
        setNodeRef(node);
        setDeptRef(node);
      }}
      {...deptAttributes}
      {...deptListeners}
      data-dept-id={department.id}
      className={`flex flex-col department-card rounded-2xl shadow-soft border-0 cursor-move ${
        isOver ? 'ring-2 ring-indigo-400' : ''
      } ${isSearchHit ? 'ring-2 ring-amber-400' : ''
      } ${isDeptDragging ? 'opacity-50 scale-95' : ''}`}
      style={{ 
        minWidth: 220,
        fontSize: '14px',
        // 拖拽/负责人搜索下拉打开时抬高本卡层级，避免被扁平的子部门卡（DOM 顺序在后）遮住。
        // 负责人搜索下拉是卡内流式元素，若不抬高父卡层级，后代生成的子部门卡会绘制在其上方。
        zIndex: isDeptDragging ? 1000 : (showLeaderSearch ? 30 : 1),
        position: 'relative'
      }}
    >
      {/* 部门头部 */}
      <div
        onContextMenu={handleContextMenu}
        data-dept-header={department.level}
        className={`flex items-center justify-between px-4 py-3 ${LEVEL_HEADER_BG[department.level] ?? FALLBACK_HEADER_BG} rounded-t-2xl`}
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {department.children.length > 0 ? (
            <button
              onClick={() => onToggleExpand(department.id)}
              className="p-1 hover:bg-white/50 rounded-lg transition-colors"
            >
              {department.expanded ? (
                <ChevronDown className="w-4 h-4 text-gray-600" />
              ) : (
                <ChevronRight className="w-4 h-4 text-gray-600" />
              )}
            </button>
          ) : (
            <div className="w-6" />
          )}
          
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={handleNameSubmit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleNameSubmit();
                if (e.key === 'Escape') setIsEditing(false);
              }}
              className="flex-1 px-2 py-1 border border-indigo-300 rounded-lg text-sm focus-ring"
            />
          ) : (
            <span 
              className="font-bold text-gray-800 truncate cursor-pointer hover:text-indigo-600 transition-colors"
              onDoubleClick={handleDoubleClick}
              title={`${department.name}｜双击可编辑名称`}
            >
              {department.name}
            </span>
          )}
        </div>
        
        {/* 层级标记 + v2.3.2 层级断档标记：把「为什么这条线是虚线」在卡上解释清楚 */}
        <span className="flex items-center gap-1 ml-2 shrink-0">
          {levelGap && (
            <span
              role="status"
              data-level-gap="1"
              title={describeLevelGap(levelGap)}
              className="text-[10px] px-1 py-0.5 rounded font-medium bg-amber-100 text-amber-700 border border-amber-300 cursor-help"
            >
              {levelGapBadge(levelGap)}
            </span>
          )}
          <span className="text-xs text-gray-400">L{department.level}</span>
        </span>
      </div>
      
      {/* 负责人 */}
      <div className="px-3 py-2 border-b border-gray-100">
        <div className="flex items-center gap-2 whitespace-nowrap">
          <span className="text-xs text-gray-500 shrink-0">负责人:</span>
          <button
            onClick={handleLeaderClick}
            title={`${department.leaderName || ''}${leader && (showTitle || showLevel) ? ' · ' + [(showTitle && displayTitle(leader.title)) ? displayTitle(leader.title) : null, (showLevel && leader.level) ? leader.level : null].filter(Boolean).join(' · ') : ''}`}
            className="text-sm text-blue-600 hover:underline flex items-center gap-1 min-w-0 overflow-hidden"
          >
            <User className="w-3 h-3 shrink-0" />
            <span className="truncate">
              {department.leaderName || '点击选择'}
              {leader && (showTitle || showLevel) ? ` · ${[(showTitle && displayTitle(leader.title)) ? displayTitle(leader.title) : null, (showLevel && leader.level) ? leader.level : null].filter(Boolean).join(' · ')}` : ''}
            </span>
          </button>
          {/* v2.3.1（Q-07）：负责人类型写入口。此前 leaderType 无任何写入点 →
              「副职/挂名精确剔除」与「负责人空缺」对真实数据不可达。 */}
          <select
            aria-label="负责人类型"
            title="负责人类型：正职计入管理者比分子；副职/代理/外部仅展示；空缺用于标记岗位在编但暂无在任负责人"
            value={department.leaderType ?? (department.leaderId || department.leaderName ? 'owner' : '')}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => {
              const v = e.target.value;
              onUpdateLeaderType(department.id, v === '' ? undefined : (v as LeaderType));
            }}
            className="ml-auto shrink-0 text-[10px] px-1 py-0.5 rounded border border-gray-200 text-gray-600 bg-white focus-ring"
          >
            <option value="">未标注</option>
            <option value="owner">正职</option>
            <option value="deputy">副职</option>
            <option value="acting">代理</option>
            <option value="external">外部/挂名</option>
            <option value="vacant">空缺</option>
          </select>
        </div>
        
        {showLeaderSearch && (
          <div className="mt-2 p-2 bg-gray-50 rounded">
            <input
              type="text"
              placeholder="搜索员工..."
              value={leaderSearch}
              onChange={(e) => setLeaderSearch(e.target.value)}
              className="w-full px-2 py-1 border border-gray-300 rounded text-sm mb-2"
            />
            <div className="max-h-32 overflow-y-auto space-y-1">
              <button
                onClick={() => {
                  onUpdateLeader(department.id, null);
                  setShowLeaderSearch(false);
                  setLeaderSearch('');
                }}
                className="w-full text-left px-2 py-1 text-sm text-gray-500 hover:bg-gray-100 rounded"
              >
                清除负责人
              </button>
              {filteredEmployees.slice(0, 10).map(emp => (
                <button
                  key={emp.id}
                  onClick={() => {
                    onUpdateLeader(department.id, emp);
                    setShowLeaderSearch(false);
                    setLeaderSearch('');
                  }}
                  className="w-full text-left px-2 py-1 text-sm hover:bg-gray-100 rounded flex items-center gap-2"
                >
                  <div
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: getLevelColor(levelConfigs, emp.level) }}
                  />
                  {emp.name} ({emp.employeeId})
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      
      {/* v2.1.1 岗位区（可折叠，沿组织树向下钻：每部门展示其直属岗位） */}
      {(department.positions?.length ?? 0) > 0 && (
        <PositionSection
          dept={department}
          summaryById={summaryById}
          onSetPositionHeadcount={onSetPositionHeadcount}
        />
      )}

      {/* 员工列表（v2.0.11：收起/展开全部，替代 max-h-40 滚动；成员多时卡高由布局动态估算） */}
      <div className="px-3 py-2">
        <div className="flex items-center justify-between gap-1 text-xs text-gray-500 mb-2">
          <div className="flex items-center gap-1 min-w-0">
            <Users className="w-3 h-3 shrink-0" />
            <span className="truncate">成员 ({department.employees.length})</span>
          </div>
          {department.employees.length > 0 && onToggleMembers && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleMembers(department.id);
              }}
              className={`shrink-0 flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-[11px] font-medium hover:bg-indigo-50 ${
                membersExpanded ? 'text-indigo-600' : 'text-slate-400 hover:text-indigo-600'
              }`}
              title={membersExpanded ? '收起成员列表' : '展开全部成员'}
            >
              {membersExpanded ? '收起' : '展开全部'}
              {membersExpanded ? (
                <ChevronUp className="w-3 h-3" />
              ) : (
                <ChevronDown className="w-3 h-3" />
              )}
            </button>
          )}
        </div>
        {department.employees.length === 0 ? (
          <div className="text-xs text-gray-400 text-center py-2">拖拽员工到这里</div>
        ) : membersExpanded ? (
          <div className="space-y-1">
            <EmployeeList
              employees={department.employees}
              onDelete={(empId) => onDeleteEmployee(department.id, empId)}
              canDelete={true}
              selectedEmpIds={selectedEmpIds}
              onSelect={onToggleSelectEmp}
              onCreateVirtual={(empId) => onCreateVirtualFromEmployee(department.id, empId)}
              onMoveMultiple={onMoveMultiple}
              departments={allDepartments}
              currentDeptId={department.id}
              matchStateById={matchById}
              getEmpName={getEmpName}
              onRemoveAssignment={(empId) => onRemoveAssignment?.(empId)}
              onOpenTargetLevel={(emp) => setTargetLevelEmp(emp)}
              competencySummaries={competencySummaries}
              onOpenCompetencyDetail={onOpenCompetencyDetail}
            />
          </div>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleMembers?.(department.id);
            }}
            className="w-full text-xs text-slate-400 hover:text-indigo-600 text-center py-1.5 rounded-md hover:bg-indigo-50/60 transition-colors"
            title="展开全部成员"
          >
            已收起 · 共 {department.employees.length} 人，点此展开查看全部
          </button>
        )}
      </div>
      
      {/* 右键菜单 - portal 到 document.body，避免被画布 transform:scale 的坐标系污染。
          position:fixed 在 transform 祖先内会以其为参照系而非视口，导致坐标错乱（菜单跑到画布右侧）。
          用 createPortal 渲染到 body，clientX/clientY 才按视口正确生效。 */}
      {showContextMenu &&
        createPortal(
          <div
            className="fixed bg-white border border-gray-200 rounded-lg shadow-xl py-1 min-w-[180px]"
            style={{ zIndex: 99999, left: contextMenuPos.x, top: contextMenuPos.y }}
            ref={cardRef}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100 flex items-center gap-2"
              onClick={(e) => {
                e.stopPropagation();
                setShowLevelMenu(!showLevelMenu);
              }}
            >
              <Building2 className="w-4 h-4 text-indigo-500" />
              调整层级归属
              <span className="ml-auto text-gray-400">{showLevelMenu ? '▲' : '▼'}</span>
            </button>

            {showLevelMenu && (
              <div className="border-t border-gray-100 py-1">
                <button
                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    onChangeDepartmentLevel(department.id, 1, null);
                    setShowContextMenu(false);
                    setShowLevelMenu(false);
                  }}
                >
                  设为 L1 (一级部门)
                </button>
                <button
                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    onChangeDepartmentLevel(department.id, 2, null);
                    setShowContextMenu(false);
                    setShowLevelMenu(false);
                  }}
                >
                  设为 L2 (二级部门)
                </button>
                <button
                  className="w-full px-4 py-2 text-left text-sm hover:bg-gray-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    onChangeDepartmentLevel(department.id, 3, null);
                    setShowContextMenu(false);
                    setShowLevelMenu(false);
                  }}
                >
                  设为 L3 (三级部门)
                </button>
              </div>
            )}

          </div>,
          document.body,
        )}

        {/* v2.1.1 应用内弹窗：目标职级 / 新建岗位（替代原生 window.prompt） */}
        <TargetLevelModal
          open={!!targetLevelEmp}
          employee={targetLevelEmp}
          levelConfigs={levelConfigs}
          onConfirm={(empId, target) => onSetTargetLevel(empId, target ?? '')}
          onClose={() => setTargetLevelEmp(null)}
        />
    </div>
  );
}
