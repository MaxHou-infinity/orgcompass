import { exportCanvas } from './utils/exportCanvas';
import { useRef, useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { AppModal } from './components/AppModal';
import { Sidebar } from './components/Sidebar';
import { OrgChart } from './components/OrgChart';
import { TopBar } from './components/TopBar';
import { LevelManagerModal } from './components/LevelManagerModal';
import { HealthDrawer } from './components/HealthDrawer';
import { ProjectModal } from './components/ProjectModal';
import { DiagnosticReport } from './components/DiagnosticReport';
import { ScenarioDiffView } from './components/ScenarioDiffView';
import { ManagementReport } from './components/ManagementReport';
import { SearchModal } from './components/SearchModal';
import { PositionOpsModal } from './components/PositionOpsModal';
import { OnboardingOverlay } from './components/OnboardingOverlay';
import { UnassignedEmployeesDrawer } from './components/UnassignedEmployeesDrawer';
import { CompetencyDrawer } from './components/CompetencyDrawer';
import { BatchAssessmentModal, NewAssessment } from './components/BatchAssessmentModal';
import { CompetencyDetailModal } from './components/CompetencyDetailModal';
import { CompetencyModelModal } from './components/CompetencyModelModal';
import { GapListModal } from './components/GapListModal';
import { computeUnassignedEmployees } from './utils/analytics';
import { SearchHighlight } from './components/SearchContext';
import { Employee, Department, OrgTemplate, Position, Assessment, COMPETENCY_SCALE, LeaderType } from './types';
import { expandDepartments, SearchMatch } from './utils/search';
import { computePositionSummary } from './utils/analytics';
import { computeMatchStates } from './utils/match';
import { flattenAllPositions } from './components/positionUtils';
import { uid, decodeStoredProject, PROJECT_STORAGE_KEY, listProjectBackups } from './utils/project';
import { assignPrimary, indexPlacements, inspectPlacements, seedLegacyAssignments } from './utils/placement';
import { moveEmployeesBetween } from './utils/departments';
import { findIndustryTemplate, loadIndustryTemplate } from './utils/industryTemplates';
import {
  parseEmployeeExcel,
  parseOrgTemplateExcel,
  parseAssessmentExcel,
  resolveAssessmentEmployees,
  buildDepartmentTree,
  exportToExcel,
  generateSampleEmployeeTemplate,
  generateSampleOrgTemplate,
  getImportErrorMessage,
} from './utils/excel';
import {
  computeCompetencyStates,
  buildLeadershipDossier,
  listAssessmentHistory,
  benchmarkFor,
  revisionChainIssue,
  currentRevisionEndpoint,
  computeManagerIdSet,
  localDayOf,
  CompetencySummary,
  CompetencyScopeContext,
} from './utils/competency';
import { confirmedNotCompetentSet, listReviewEvents } from './utils/assignment';
import {
  buildGapListExcelBytes,
  buildGapListRows,
  summarizeGapList,
} from './utils/gapList';
import { BOARD_FILTER_LABEL, type BoardDerivation } from './utils/boardScope';
import { saveTextFile, saveFile } from './utils/tauri';
import { useOrgWorkspace } from './utils/useOrgWorkspace';

const EMPTY_HIGHLIGHT: SearchHighlight = { deptIds: new Set(), empIds: new Set() };

// 测试数据
const TEST_EMPLOYEES = [
  { name: '张三', employeeId: 'E001', level: 'L1.1', dept1: '技术部', dept2: '研发组', dept3: '后端', dept4: '', dept5: '', dept6: '' },
  { name: '李四', employeeId: 'E002', level: 'L2.1', dept1: '技术部', dept2: '研发组', dept3: '后端', dept4: '', dept5: '', dept6: '' },
  { name: '王五', employeeId: 'E003', level: 'L3.1', dept1: '技术部', dept2: '研发组', dept3: '前端', dept4: '', dept5: '', dept6: '' },
  { name: '赵六', employeeId: 'E004', level: 'L1.2', dept1: '技术部', dept2: '测试组', dept3: '功能测试', dept4: '', dept5: '', dept6: '' },
  { name: '钱七', employeeId: 'E005', level: 'L2.2', dept1: '技术部', dept2: '测试组', dept3: '自动化测试', dept4: '', dept5: '', dept6: '' },
  { name: '孙八', employeeId: 'E006', level: 'L3.2', dept1: '技术部', dept2: '运维组', dept3: '运维', dept4: '', dept5: '', dept6: '' },
  { name: '周九', employeeId: 'E007', level: 'E3.1', dept1: '销售部', dept2: '华东区', dept3: '', dept4: '', dept5: '', dept6: '' },
  { name: '吴十', employeeId: 'E008', level: 'E3.2', dept1: '销售部', dept2: '华北区', dept3: '', dept4: '', dept5: '', dept6: '' },
  { name: '郑十一', employeeId: 'E009', level: 'L4.1', dept1: '销售部', dept2: '华南区', dept3: '', dept4: '', dept5: '', dept6: '' },
  { name: '陈十二', employeeId: 'E010', level: 'L5', dept1: '人力资源部', dept2: '招聘组', dept3: '', dept4: '', dept5: '', dept6: '' },
];

const TEST_ORG: OrgTemplate[] = [
  { dept1: '技术部', dept2: '研发组', dept3: '后端', dept4: '', dept5: '', dept6: '', deptLevel: '1', leaderId: 'E001', leaderName: '张三' },
  { dept1: '技术部', dept2: '研发组', dept3: '前端', dept4: '', dept5: '', dept6: '', deptLevel: '2', leaderId: 'E003', leaderName: '王五' },
  { dept1: '技术部', dept2: '测试组', dept3: '功能测试', dept4: '', dept5: '', dept6: '', deptLevel: '2', leaderId: 'E004', leaderName: '赵六' },
  { dept1: '技术部', dept2: '测试组', dept3: '自动化测试', dept4: '', dept5: '', dept6: '', deptLevel: '2', leaderId: 'E005', leaderName: '钱七' },
  { dept1: '技术部', dept2: '运维组', dept3: '运维', dept4: '', dept5: '', dept6: '', deptLevel: '2', leaderId: 'E006', leaderName: '孙八' },
  { dept1: '销售部', dept2: '华东区', dept3: '', dept4: '', dept5: '', dept6: '', deptLevel: '2', leaderId: 'E007', leaderName: '周九' },
  { dept1: '销售部', dept2: '华北区', dept3: '', dept4: '', dept5: '', dept6: '', deptLevel: '2', leaderId: 'E008', leaderName: '吴十' },
  { dept1: '销售部', dept2: '华南区', dept3: '', dept4: '', dept5: '', dept6: '', deptLevel: '2', leaderId: 'E009', leaderName: '郑十一' },
  { dept1: '人力资源部', dept2: '招聘组', dept3: '', dept4: '', dept5: '', dept6: '', deptLevel: '1', leaderId: 'E010', leaderName: '陈十二' },
];

// 查找部门辅助函数（模块级纯函数，不依赖组件状态）
function findDept(depts: Department[], id: string): Department | null {
  for (const dept of depts) {
    if (dept.id === id) return dept;
    const found = findDept(dept.children, id);
    if (found) return found;
  }
  return null;
}

/** 递归对部门树内所有同 id 员工应用补丁（岗位套岗/取消套岗等跨部门一致更新用）。 */
function mapEmployeesInDepts(
  depts: Department[],
  empId: string,
  patch: (e: Employee) => Employee,
): Department[] {
  return depts.map((d) => ({
    ...d,
    employees: d.employees.map((e) => (e.id === empId ? patch(e) : e)),
    children: mapEmployeesInDepts(d.children, empId, patch),
  }));
}

/** 部门 id → 祖先链（含自身，根在前）；不存在返回 null（供画布定位展开祖先）。 */
function findDeptChain(depts: Department[], id: string): string[] | null {
  const walk = (list: Department[], path: string[]): string[] | null => {
    for (const d of list) {
      const next = [...path, d.id];
      if (d.id === id) return next;
      const child = walk(d.children, next);
      if (child) return child;
    }
    return null;
  };
  return walk(depts, []);
}

export default function App() {
  const ws = useOrgWorkspace();
  const {
    departments,
    allEmployeesFlat,
    zoom,
    setZoom,
    levelConfigs,
    setDepartments,
    setBoth,
    assessments,
    competencyModel,
    positionAssignments,
    setAssessments,
    setCompetencyModel,
    undo,
    redo,
    canUndo,
    canRedo,
    switchScenario,
    createNewScenario,
    duplicateScenario,
    renameScenario,
    deleteScenario,
    renameProject,
    exportProjectJson,
    importProjectJson,
    restoreProjectBackup,
    resetWorkspace,
    project,
    currentScenario,
    importWorkspace,
    loadIssue,
    saveState,
    lastSavedAt,
    flushCurrent,
  } = ws;

  const [pendingImport, setPendingImport] = useState<{
    name: string; departments: Department[]; employees: Employee[]; templates?: OrgTemplate[]; scenarioId: string;
  } | null>(null);
  const [pendingAction, setPendingAction] = useState<{ title: string; description: string; apply: () => void; scenarioId: string } | null>(null);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [levelManagerOpen, setLevelManagerOpen] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  const [healthFocusDeptId, setHealthFocusDeptId] = useState<string | undefined>();
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  // v2.0.9：场景差异比较 + 管理层报告（运行时派生，不新增持久化字段）
  const [scenarioDiffOpen, setScenarioDiffOpen] = useState(false);
  const [diffBaselineId, setDiffBaselineId] = useState<string>('');
  const [diffTargetId, setDiffTargetId] = useState<string>('');
  const [mgmtReportOpen, setMgmtReportOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchHighlight, setSearchHighlight] = useState<SearchHighlight>(EMPTY_HIGHLIGHT);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [unassignedOpen, setUnassignedOpen] = useState(false);
  // v2.1.1：岗位操作弹窗（顶部菜单「岗位」入口）
  const [positionOpsOpen, setPositionOpsOpen] = useState(false);
  // —— v2.2.0 胜任度：看板抽屉 / 批量评估 / 详情 / 维度配置 ——
  const [competencyOpen, setCompetencyOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [detailEmpId, setDetailEmpId] = useState<string | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  /** v2.3 M4：岗位缺口清单（当前场景直读） */
  const [gapListOpen, setGapListOpen] = useState(false);
  // v2.0.3 修复：保存"当前组织架构模板"，员工上传时用它重建以保留模板负责人/层级结构
  const [orgTemplates, setOrgTemplates] = useState<OrgTemplate[]>([]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  // v2.0.5 修复：用 ref 读取最新 allEmployeesFlat / orgTemplates，避免导入 handler 闭包捕获旧值（模板载入后导入不快/不刷新的根因）
  const allEmployeesRef = useRef(allEmployeesFlat);
  useEffect(() => { allEmployeesRef.current = allEmployeesFlat; }, [allEmployeesFlat]);
  const orgTemplatesRef = useRef(orgTemplates);
  useEffect(() => { orgTemplatesRef.current = orgTemplates; }, [orgTemplates]);
  const currentSceneRef = useRef(project.currentScenarioId);
  currentSceneRef.current = project.currentScenarioId;

  // 首次进入引导：localStorage 标记，默认未看过则展示（v2.0.3 P2-6）
  useEffect(() => {
    try {
      if (typeof localStorage === 'undefined') return;
      const seen = localStorage.getItem('org-designer.onboarded');
      if (!seen) {
        setOnboardingOpen(true);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const dismissOnboarding = useCallback(() => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('org-designer.onboarded', '1');
    } catch {
      /* ignore */
    }
    setOnboardingOpen(false);
  }, []);


  // v2.3.1（Q-27）：定时器必须可清理。旧实现每次都新建 timer 且不清理上一个 →
  // 连续操作时「上一条 toast 的 timer」会提前把新 toast 清掉，关键提示（如「N 条被拒绝」）闪现即逝。
  const toastTimerRef = useRef<number | null>(null);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToast(null);
    }, 2200);
  }, []);
  useEffect(() => () => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
  }, []);

  // v2.0.7 首次进入引导：画布默认显示岗位/职级，提示可在左侧「画布显示」开关
  useEffect(() => {
    try {
      if (typeof localStorage === 'undefined') return;
      if (!localStorage.getItem('org-designer.display-hint')) {
        localStorage.setItem('org-designer.display-hint', '1');
        const t = window.setTimeout(() => showToast('画布已默认显示 岗位/职级；可在左侧「画布显示」开关'), 700);
        return () => window.clearTimeout(t);
      }
    } catch {
      /* ignore */
    }
  }, [showToast]);

  // 撤销/重做键盘：Ctrl/Cmd+Z 撤销，Ctrl/Cmd+Shift+Z（或 Ctrl+Y）重做
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      // Ctrl/Cmd+F → 应用级搜索
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      } else if (((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z') || ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'y')) {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [undo, redo]);

  const stageImport = useCallback((name: string, tree: Department[], employees: Employee[], templates?: OrgTemplate[]) => {
    if (currentSceneRef.current !== project.currentScenarioId) { showToast('读取期间场景已变化，请重新导入'); return; }
    if (!employees.length && !tree.length) { showToast('文件无有效数据，当前场景未改变'); return; }
    const apply = () => {
      if (!importWorkspace(name, tree, employees)) { showToast('保存失败，导入未应用'); return; }
      setOrgTemplates(templates ?? []);
      showToast(`已导入「${name}」，原场景已保留`);
    };
    if (departments.length || allEmployeesFlat.length || assessments.length || positionAssignments.length) {
      setPendingImport({ name, departments: tree, employees, templates, scenarioId: project.currentScenarioId });
    } else apply();
  }, [departments.length, allEmployeesFlat.length, assessments.length, positionAssignments.length, importWorkspace, project.currentScenarioId, showToast]);

  /** —— 文件操作 —— */
  const handleEmployeeFileUpload = useCallback(async (file: File) => {
    try {
      const parsedEmployees = await parseEmployeeExcel(file);
      // 用已保存的组织模板（若有）重建，保留模板的部门层级与负责人结构
      const tree = buildDepartmentTree(parsedEmployees, orgTemplatesRef.current);
      stageImport(file.name, tree, parsedEmployees, orgTemplatesRef.current);
    } catch (error) {
      console.error('解析员工文件失败:', error);
      showToast(getImportErrorMessage(error));
    }
  }, [stageImport, showToast]);

  const handleOrgTemplateUpload = useCallback(async (file: File) => {
    try {
      const templates = await parseOrgTemplateExcel(file);
      // 保存模板，供后续员工上传时重建结构
      const employees = allEmployeesRef.current.map((e) => ({ ...e, positionId: undefined }));
      const tree = buildDepartmentTree(employees, templates);
      stageImport(file.name, tree, employees, templates);
    } catch (error) {
      console.error('解析组织架构文件失败:', error);
      showToast(getImportErrorMessage(error));
    }
  }, [stageImport, showToast]);

  /** —— 部门/员工操作（历史感知） —— */
  const handleToggleExpand = useCallback((id: string) => {
    setDepartments((prev) => {
      const toggle = (depts: Department[]): Department[] => {
        return depts.map((dept) => {
          if (dept.id === id) return { ...dept, expanded: !dept.expanded };
          if (dept.children.length > 0) return { ...dept, children: toggle(dept.children) };
          return dept;
        });
      };
      return toggle(prev);
    });
  }, [setDepartments]);

  const handleUpdateDepartment = useCallback((id: string, name: string) => {
    setDepartments((prev) => {
      const update = (depts: Department[]): Department[] => {
        return depts.map((dept) => {
          if (dept.id === id) return { ...dept, name };
          if (dept.children.length > 0) return { ...dept, children: update(dept.children) };
          return dept;
        });
      };
      return update(prev);
    });
  }, [setDepartments]);

  const handleUpdateLeader = useCallback((deptId: string, employee: Employee | null) => {
    setDepartments((prev) => {
      const update = (depts: Department[]): Department[] => {
        return depts.map((dept) => {
          if (dept.id === deptId) {
            return {
              ...dept,
              leaderId: employee?.employeeId || undefined,
              leaderName: employee?.name || undefined,
            };
          }
          if (dept.children.length > 0) return { ...dept, children: update(dept.children) };
          return dept;
        });
      };
      return update(prev);
    });
  }, [setDepartments]);

  /**
   * v2.3.1（Q-07）：设置负责人类型。
   *
   * `leaderType` 自 v2.1.1 起已建模、已持久化、已被管理者比与空缺提示消费，
   * 但全仓**没有任何写入点** → 「副职/挂名精确剔除」与「负责人空缺」对真实用户数据永远不可达
   * （analytics 只能靠「负责人不在名册」推断外部，工号笔误即被静默剔除）。
   * 这里补上写入口，让已承诺的口径真正生效。
   */
  const handleUpdateLeaderType = useCallback((deptId: string, leaderType: LeaderType | undefined) => {
    setDepartments((prev) => {
      const update = (depts: Department[]): Department[] =>
        depts.map((dept) => {
          if (dept.id === deptId) {
            const next = { ...dept };
            if (leaderType === undefined) delete next.leaderType;
            else next.leaderType = leaderType;
            return next;
          }
          if (dept.children.length > 0) return { ...dept, children: update(dept.children) };
          return dept;
        });
      return update(prev);
    });
  }, [setDepartments]);

  const requestMoveEmployees = useCallback((empIds: string[], toDeptId: string) => {
    const index = indexPlacements(departments);
    if (!index.departments.has(toDeptId)) return;
    const impacted = allEmployeesFlat.filter((e) => empIds.includes(e.id) && e.positionId
      && index.positions.get(e.positionId)?.departmentId !== toDeptId);
    const apply = () => setDepartments((prev) => moveEmployeesBetween(prev, empIds, toDeptId));
    if (impacted.length) {
      setPendingAction({ title: '确认调整人员部门',
        description: `${impacted.map((e) => e.name).join('、')} 将移入「${index.departments.get(toDeptId)!.name}」，并结束原岗位关系。评分与任职历史保留，可撤销本次调整。`,
        apply, scenarioId: project.currentScenarioId });
    } else apply();
  }, [departments, allEmployeesFlat, setDepartments, project.currentScenarioId]);
  const handleMoveEmployee = useCallback((empId: string, _fromDeptId: string, toDeptId: string) => {
    requestMoveEmployees([empId], toDeptId);
  }, [requestMoveEmployees]);
  const handleMoveMultiple = useCallback((empIds: string[], toDeptId: string) => {
    requestMoveEmployees(empIds, toDeptId);
  }, [requestMoveEmployees]);

  /** 未入架构员工（v2.0.5）：全量员工 vs 树内已挂载员工的差值 */
  const unassignedEmployees = useMemo(
    () => computeUnassignedEmployees(allEmployeesFlat, departments),
    [allEmployeesFlat, departments],
  );

  // —— v2.1.1 岗位化：部门树为唯一真值，拍平岗位供 analytics 岗位级汇总/状态机消费 ——
  const allPositions = useMemo(() => flattenAllPositions(departments), [departments]);
  const positionSummaries = useMemo(
    () => computePositionSummary(allPositions, allEmployeesFlat, levelConfigs),
    [allPositions, allEmployeesFlat, levelConfigs],
  );
  // —— v2.2.0 胜任度：派生纯函数（运行时算、不落库） ——
  // 已人工确认不胜任集合（PositionAssignment.status==='not_competent'）→ computeMatchStates 第三参
  const confirmedNotCompetent = useMemo(
    () => confirmedNotCompetentSet(positionAssignments, allEmployeesFlat),
    [positionAssignments, allEmployeesFlat],
  );
  const matchStates = useMemo(
    () => computeMatchStates(allEmployeesFlat, allPositions, confirmedNotCompetent, positionAssignments, departments),
    [allEmployeesFlat, allPositions, confirmedNotCompetent, positionAssignments, departments],
  );
  const placementIssues = useMemo(() => inspectPlacements(allEmployeesFlat, departments, positionAssignments, assessments), [allEmployeesFlat, departments, positionAssignments, assessments]);
  const unresolvedOverflow = useMemo(() => [...new Map(matchStates.filter((m) => m.overflowUnresolved)
    .map((m) => [m.positionId, `${allPositions.find((p) => p.id === m.positionId)?.name ?? m.positionId}：岗位超额 ${m.positionOverflow} 人，缺可信入岗顺序，具体人员需判断`])).values()], [matchStates, allPositions]);
  // 全量员工 → CompetencySummary（每个员工一条；未评/不可算也有完整度占位，不伪装绿/红）
  // v2.3 M2：按「当前分类应评维度 + 人岗适用范围（relationId/岗位核对）」取数
  const managerIds = useMemo(() => {
    // v2.3.1（Q-33）：与批量评估共用同一份判定实现，避免「按干部评分、按员工算完整度」的双实现漂移。
    return computeManagerIdSet(departments, allEmployeesFlat);
  }, [allEmployeesFlat, departments]);

  const activePrimaryByEmployee = useMemo(() => {
    const m = new Map<string, import('./types').PositionAssignment>();
    for (const a of positionAssignments) {
      if (a.type !== 'primary' || a.status !== 'active' || a.endDate) continue;
      if (!m.has(a.employeeId)) m.set(a.employeeId, a);
    }
    return m;
  }, [positionAssignments]);

  const competencyContextFor = useCallback(
    (e: Employee): CompetencyScopeContext => {
      const relation = activePrimaryByEmployee.get(e.id);
      return {
        expectedGroup: managerIds.has(e.id) ? 'leadership' : 'staff',
        ...(relation ? { currentRelationId: relation.id } : {}),
        ...(e.positionId ? { currentPositionId: e.positionId } : {}),
        assignments: positionAssignments,
      };
    },
    [activePrimaryByEmployee, managerIds, positionAssignments],
  );

  const competencySummaries = useMemo(() => {
    const m = new Map<string, CompetencySummary>();
    for (const c of computeCompetencyStates(assessments, allEmployeesFlat, competencyModel, competencyContextFor)) {
      m.set(c.employeeId, c);
    }
    return m;
  }, [assessments, allEmployeesFlat, competencyModel, competencyContextFor]);

  // 详情弹窗数据（按 detailEmpId 查 summary/dossier/history/position）
  const detailEmployee = useMemo(
    () => (detailEmpId ? allEmployeesFlat.find((e) => e.id === detailEmpId) ?? null : null),
    [detailEmpId, allEmployeesFlat],
  );
  const detailSummary = useMemo(
    () => (detailEmpId ? competencySummaries.get(detailEmpId) ?? null : null),
    [detailEmpId, competencySummaries],
  );
  const detailPosition = useMemo(
    () => (detailEmployee?.positionId ? allPositions.find((p) => p.id === detailEmployee.positionId) ?? null : null),
    [detailEmployee, allPositions],
  );
  const detailDossier = useMemo(
    () =>
      detailEmpId && detailEmployee
        ? buildLeadershipDossier(assessments, detailEmpId, competencyModel, detailEmployee.targetLevel, competencyContextFor(detailEmployee))
        : null,
    [detailEmpId, assessments, competencyModel, detailEmployee, competencyContextFor],
  );
  const detailHistory = useMemo(
    () => (detailEmpId ? listAssessmentHistory(assessments, detailEmpId, competencyModel) : []),
    [detailEmpId, assessments, competencyModel],
  );
  /** v2.3 M2：该员工的全部人工复核事件（含已撤销与历史确认） */
  const detailReviews = useMemo(
    () => (detailEmpId ? listReviewEvents(positionAssignments, assessments, detailEmpId) : []),
    [detailEmpId, positionAssignments, assessments],
  );
  /** v2.3 M2：该员工的任职记录（详情弹窗按 relationId 关联复核） */
  const detailAssignments = useMemo(
    () => (detailEmpId ? positionAssignments.filter((a) => a.employeeId === detailEmpId) : []),
    [detailEmpId, positionAssignments],
  );
  const detailMatch = useMemo(
    () => matchStates.find((r) => r.employeeId === detailEmpId),
    [matchStates, detailEmpId],
  );
  const resolveEmployeeName = useCallback(
    (id: string) => allEmployeesFlat.find((e) => e.id === id)?.name ?? id,
    [allEmployeesFlat],
  );

  /** 将未入架构员工排入指定部门（历史感知） */
  const handlePlaceEmployee = useCallback(
    (empId: string, deptId: string) => {
      const emp = allEmployeesFlat.find((e) => e.id === empId);
      if (!emp) return;
      setDepartments((prev) => {
        const add = (depts: Department[]): Department[] => {
          return depts.map((dept) => {
            if (dept.id === deptId) return { ...dept, employees: [...dept.employees, emp] };
            if (dept.children.length > 0) return { ...dept, children: add(dept.children) };
            return dept;
          });
        };
        return add(prev);
      });
    },
    [allEmployeesFlat, setDepartments],
  );

  /** 设置/清除员工目标职级（v2.0.5：员工层职级差距红黄绿） */
  const handleSetTargetLevel = useCallback(
    (empId: string, target: string) => {
      const t = target.trim();
      setBoth((prev) => {
        const updateEmp = (e: Employee) => (e.id === empId ? { ...e, targetLevel: t ? t : undefined } : e);
        const updateDepts = (depts: Department[]): Department[] =>
          depts.map((d) => ({
            ...d,
            employees: d.employees.map(updateEmp),
            children: updateDepts(d.children),
          }));
        return {
          ...prev,
          departments: updateDepts(prev.departments),
          allEmployeesFlat: prev.allEmployeesFlat.map(updateEmp),
        };
      });
      showToast(t ? `已设置目标职级 ${t}` : '已清除目标职级');
    },
    [setBoth, showToast],
  );

  /** —— v2.1.1 岗位 CRUD / 套岗 —— */

  /** 新建岗位（挂在某部门直属岗位列表）。v2.1.1 起接受富字段（名称/序列/职级带宽/编制数）。 */
  const handleCreatePosition = useCallback(
    (deptId: string, fields: { name: string; jobFamily?: string; levelBandMin?: string; levelBandMax?: string; headcount?: number }) => {
      const trimmed = fields.name.trim();
      if (!trimmed) return;
      const now = new Date().toISOString();
      const pos: Position = {
        id: uid('pos'),
        departmentId: deptId,
        name: trimmed,
        jobFamily: fields.jobFamily,
        levelBandMin: fields.levelBandMin,
        levelBandMax: fields.levelBandMax,
        headcount: typeof fields.headcount === 'number' && Number.isFinite(fields.headcount) ? fields.headcount : 0,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
      setDepartments((prev) => {
        const add = (depts: Department[]): Department[] =>
          depts.map((d) => {
            if (d.id === deptId) return { ...d, positions: [...(d.positions ?? []), pos] };
            if (d.children.length > 0) return { ...d, children: add(d.children) };
            return d;
          });
        return add(prev);
      });
      showToast(`已创建岗位「${trimmed}」`);
    },
    [setDepartments, showToast],
  );

  /** 设置岗位编制（headcount<=0 → 视为无编制）。 */
  const handleSetPositionHeadcount = useCallback(
    (deptId: string, positionId: string, headcount: number) => {
      const v = Math.max(0, Math.round(Number.isFinite(headcount) ? headcount : 0));
      setDepartments((prev) => {
        const update = (depts: Department[]): Department[] =>
          depts.map((d) => {
            if (d.id === deptId) {
              return {
                ...d,
                positions: (d.positions ?? []).map((p) =>
                  p.id === positionId ? { ...p, headcount: v, updatedAt: new Date().toISOString() } : p,
                ),
              };
            }
            if (d.children.length > 0) return { ...d, children: update(d.children) };
            return d;
          });
        return update(prev);
      });
    },
    [setDepartments],
  );

  /** 员工套岗到指定岗位（主岗）。同步更新 allEmployeesFlat 与所有部门员工列表（跨部门一致）。 */
  const handleAssignEmployeeToPosition = useCallback((empId: string, positionId: string) => {
    setBoth((prev) => assignPrimary(prev, empId, positionId));
    showToast('已更新主岗与所属部门，本次调整即刻生效');
  }, [setBoth, showToast]);

  /** 取消员工套岗（清空 positionId）。 */
  const handleRemoveAssignment = useCallback(
    (empId: string) => {
      const patch = (e: Employee) => (e.id === empId ? { ...e, positionId: undefined } : e);
      setBoth((prev) => ({
        ...prev,
        departments: mapEmployeesInDepts(prev.departments, empId, patch),
        allEmployeesFlat: prev.allEmployeesFlat.map(patch),
      }));
      showToast('已取消套岗');
    },
    [setBoth, showToast],
  );

  /** 为某岗位创建「兼岗」虚拟副本（回指真人员工 primaryEmployeeId）。 */
  const handleCreateVirtualForPosition = useCallback(
    (deptId: string, positionId: string, empId: string) => {
      const source = allEmployeesRef.current.find((e) => e.id === empId && !e.isVirtual);
      if (!source || allEmployeesRef.current.some((e) => e.isVirtual && e.primaryEmployeeId === empId && e.positionId === positionId)) return;
      const virtual: Employee = {
        ...source,
        id: uid('virtual'),
        isVirtual: true,
        positionId,
        assignmentType: 'secondary',
        primaryEmployeeId: source.id,
      };
      setBoth((prev) => {
        const add = (depts: Department[]): Department[] =>
          depts.map((d) => {
            if (d.id === deptId) return { ...d, employees: [...d.employees, virtual] };
            if (d.children.length > 0) return { ...d, children: add(d.children) };
            return d;
          });
        return { ...prev, departments: add(prev.departments), allEmployeesFlat: [...prev.allEmployeesFlat, virtual] };
      });
      showToast(`已为 ${source.name} 创建兼岗`);
    },
    [setBoth, showToast],
  );

  /** 抽屉/套岗：把员工排入「某部门 + 某岗位」（移动式：先从旧部门移出，再挂入目标部门并套岗）。 */
  const handlePlaceEmployeeToPosition = useCallback((empId: string, _deptId: string, positionId: string) => {
    handleAssignEmployeeToPosition(empId, positionId);
  }, [handleAssignEmployeeToPosition]);

  const handleArchivePosition = useCallback((deptId: string, positionId: string) => {
    const p = indexPlacements(departments).positions.get(positionId);
    if (!p) return;
    const affected = allEmployeesFlat.filter((e) => e.positionId === positionId);
    setPendingAction({ title: '确认归档岗位', scenarioId: project.currentScenarioId,
      description: `归档「${p.name}」将结束 ${affected.length} 条当前主岗/兼岗关系${affected.length ? `（${affected.map((e) => e.name).join('、')}）` : ''}。人员保留在名册，评分与任职历史保留，可撤销。`,
      apply: () => setDepartments((prev) => {
        const walk = (list: Department[]): Department[] => list.map((d) => ({ ...d,
          positions: d.id === deptId ? d.positions?.map((x) => x.id === positionId ? { ...x, status: 'archived' as const, updatedAt: new Date().toISOString() } : x) : d.positions,
          children: walk(d.children) }));
        return walk(prev);
      }),
    });
  }, [departments, allEmployeesFlat, project.currentScenarioId, setDepartments]);

  /** 手动刷新画布：按当前 员工 + 组织模板 重新生成部门树（修复导入后画布不刷新） */
  const handleRefreshCanvas = useCallback(() => {
    // 画布由当前部门树实时派生；刷新不能拿旧导入表覆盖已编辑的岗位与人员。
    setDepartments((prev) => [...prev]);
    showToast('画布已刷新');
  }, [setDepartments, showToast]);

  /** 搜索结果跳转：展开命中祖先链 + 滚动定位到实体 */
  const handleSearchJump = useCallback((match: SearchMatch) => {
    setDepartments((prev) => expandDepartments(prev, new Set(match.ancestry)));
    const attr = match.type === 'department' ? 'data-dept-id' : 'data-emp-id';
    window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[${attr}="${match.id}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    }, 80);
  }, [setDepartments]);

  // 搜索弹窗关闭 / 清空高亮：用稳定回调（useCallback），避免引用变化导致 SearchModal
  // 的 effect 反复重置 query，从而清空用户已输入的中文关键词。
  const handleSearchClose = useCallback(() => {
    setSearchOpen(false);
    setSearchHighlight(EMPTY_HIGHLIGHT);
  }, []);

  // Enter 定位后关闭弹窗但保留命中高亮（用于显示“定位选中态”）
  const handleSearchCloseKeepHighlight = useCallback(() => {
    setSearchOpen(false);
  }, []);

  const handleSearchClearHighlight = useCallback(() => {
    setSearchHighlight(EMPTY_HIGHLIGHT);
  }, []);

  /** 载入内置行业模板（v2.0.3 P1-4） */
  const handleLoadIndustryTemplate = useCallback(
    (id: string) => {
      const tpl = findIndustryTemplate(id);
      if (!tpl) return;
      const built = loadIndustryTemplate(tpl);
      stageImport(tpl.name, built.departments, built.allEmployeesFlat, tpl.orgTemplates);
    },
    [stageImport],
  );

  const handleDeleteEmployee = useCallback((deptId: string, empId: string) => {
    setBoth((prev) => {
      const wasVirtual = prev.allEmployeesFlat.find((e) => e.id === empId)?.isVirtual;
      const remove = (depts: Department[]): Department[] => {
        return depts.map((dept) => {
          if (dept.id === deptId) return { ...dept, employees: dept.employees.filter((e) => e.id !== empId) };
          if (dept.children.length > 0) return { ...dept, children: remove(dept.children) };
          return dept;
        });
      };
      return {
        ...prev,
        departments: remove(prev.departments),
        allEmployeesFlat: wasVirtual ? prev.allEmployeesFlat.filter((e) => e.id !== empId) : prev.allEmployeesFlat,
      };
    });
  }, [setBoth]);

  // 移动部门（调整层级结构）- 支持拖到根级别
  const handleMoveDepartment = useCallback((deptId: string, targetDeptId: string | null) => {
    setDepartments((prev) => {
      let movedDept: Department | undefined;
      const removeDept = (depts: Department[]): Department[] => {
        return depts
          .map((dept) => {
            if (dept.id === deptId) {
              movedDept = dept;
              return null;
            }
            if (dept.children.length > 0) return { ...dept, children: removeDept(dept.children) };
            return dept;
          })
          .filter((d): d is Department => d !== null);
      };
      let newDepts = removeDept(prev);
      if (movedDept === undefined) return prev;

      if (!targetDeptId || targetDeptId === 'root') {
        const updatedDept: Department = { ...movedDept, level: 1, parentId: undefined };
        const updateChildLevels = (depts: Department[], baseLevel: number): Department[] => {
          return depts.map((dept) => {
            if (dept.id === updatedDept.id) return { ...dept, level: baseLevel };
            if (dept.children.length > 0) return { ...dept, children: updateChildLevels(dept.children, baseLevel + 1) };
            return dept;
          });
        };
        return [...newDepts, updateChildLevels([updatedDept], 1)[0]];
      }

      const targetDept = findDept(newDepts, targetDeptId);
      if (!targetDept) return prev;
      const newLevel = targetDept.level + 1;
      const updatedDept: Department = { ...movedDept, level: newLevel, parentId: targetDept.id };
      const addToTarget = (depts: Department[]): Department[] => {
        return depts.map((dept) => {
          if (dept.id === targetDeptId) return { ...dept, children: [...dept.children, updatedDept] };
          if (dept.children.length > 0) return { ...dept, children: addToTarget(dept.children) };
          return dept;
        });
      };
      newDepts = addToTarget(newDepts);
      const updateChildLevels = (depts: Department[]): Department[] => {
        return depts.map((dept) => {
          if (dept.id === updatedDept.id) return { ...dept, level: newLevel };
          if (dept.children.length > 0) return { ...dept, children: updateChildLevels(dept.children) };
          return dept;
        });
      };
      return updateChildLevels(newDepts);
    });
  }, [setDepartments]);

  const handleCreateVirtualFromEmployee = useCallback((deptId: string, empId: string) => {
    const source = allEmployeesFlat.find((e) => e.id === empId && !e.isVirtual);
    if (!source) return;
    const virtual: Employee = { ...source, id: uid('virtual'), isVirtual: true, primaryEmployeeId: source.id, positionId: undefined, assignmentType: 'secondary' };
    setBoth((prev) => {
      const add = (depts: Department[]): Department[] => {
        return depts.map((dept) => {
          if (dept.id === deptId) return { ...dept, employees: [...dept.employees, virtual] };
          if (dept.children.length > 0) return { ...dept, children: add(dept.children) };
          return dept;
        });
      };
      return { ...prev, departments: add(prev.departments), allEmployeesFlat: [...prev.allEmployeesFlat, virtual] };
    });
    showToast(`已创建 ${source.name} 的兼岗`);
  }, [allEmployeesFlat, setBoth, showToast]);

  const handleExportPng = useCallback(async () => {
    if (!canvasRef.current) return;
    try {
      const canvas = await exportCanvas(canvasRef.current, '#F9FAFB');
      const dataUrl = canvas.toDataURL('image/png');
      const base64 = dataUrl.split(',')[1];
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const ok = await saveFile('组织架构图.png', bytes, 'image/png');
      if (ok) showToast('PNG 已导出');
      else showToast('已取消导出');
    } catch (error) {
      console.error('导出PNG失败:', error);
      const detail = error instanceof Error ? error.message : String(error);
      // v2.3.1（Q-26）：与其余 41 处反馈统一走 toast（原生 alert 会中断桌面端交互、且样式不可控）
      showToast(`导出 PNG 失败：${detail}`);
    }
  }, [showToast]);

  const handleExportExcel = useCallback(async () => {
    try {
      await exportToExcel(departments);
      showToast('Excel 已导出');
    } catch (error) {
      console.error('导出Excel失败:', error);
      showToast(`导出 Excel 失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }, [departments, showToast]);

  // 缩放：按钮 + 画布滚轮共用同一增量逻辑（50-200 边界钳制，取整避免浮点误差如 99.9999%）
  const clampZoom = useCallback((z: number) => Math.min(Math.max(Math.round(z), 50), 200), []);
  const handleZoomChange = useCallback((next: number) => setZoom(clampZoom(next)), [clampZoom, setZoom]);
  const handleZoomIn = useCallback(() => setZoom((z) => clampZoom(z + 10)), [clampZoom, setZoom]);
  const handleZoomOut = useCallback(() => setZoom((z) => clampZoom(z - 10)), [clampZoom, setZoom]);

  const handleDownloadEmployeeTemplate = useCallback(async () => {
    try {
      await generateSampleEmployeeTemplate();
    } catch (error) {
      console.error('下载员工信息模板失败:', error);
      showToast(`下载员工信息模板失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }, [showToast]);

  const handleDownloadOrgTemplate = useCallback(async () => {
    try {
      await generateSampleOrgTemplate();
    } catch (error) {
      console.error('下载组织架构模板失败:', error);
      showToast(`下载组织架构模板失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  }, [showToast]);

  // 创建新部门
  const handleCreateDepartment = useCallback((name: string, level: number, parentId: string | null, leaderId?: string, leaderName?: string) => {
    const newDept: Department = {
      id: `dept-${Date.now()}`,
      name,
      level,
      parentId: parentId || undefined,
      children: [],
      employees: [],
      expanded: true,
      leaderId,
      leaderName,
    };
    setDepartments((prev) => {
      if (!parentId || parentId === 'root') return [...prev, newDept];
      const addToParent = (depts: Department[]): Department[] => {
        return depts.map((dept) => {
          if (dept.id === parentId) return { ...dept, children: [...dept.children, newDept] };
          if (dept.children.length > 0) return { ...dept, children: addToParent(dept.children) };
          return dept;
        });
      };
      return addToParent(prev);
    });
  }, [setDepartments]);

  // 调整部门层级归属
  const handleChangeDepartmentLevel = useCallback((deptId: string, newLevel: number, newParentId: string | null) => {
    setDepartments((prev) => {
      let targetDept: Department | undefined;
      const findAndRemove = (depts: Department[]): Department[] => {
        for (let i = 0; i < depts.length; i++) {
          if (depts[i].id === deptId) {
            targetDept = depts[i];
            return [...depts.slice(0, i), ...depts.slice(i + 1)];
          }
          if (depts[i].children.length > 0) {
            const newChildren = findAndRemove(depts[i].children);
            if (targetDept) return [...depts.slice(0, i), { ...depts[i], children: newChildren }, ...depts.slice(i + 1)];
          }
        }
        return depts;
      };
      const newDepts = findAndRemove(prev);
      if (!targetDept) return prev;
      const updatedDept: Department = { ...targetDept, level: newLevel, parentId: newParentId || undefined };
      const updateChildLevels = (depts: Department[], baseLevel: number): Department[] => {
        return depts.map((dept) => ({ ...dept, level: baseLevel, children: updateChildLevels(dept.children, baseLevel + 1) }));
      };
      if (!newParentId) return [...newDepts, ...updateChildLevels([updatedDept], newLevel)];
      const addToParent = (depts: Department[]): Department[] => {
        return depts.map((dept) => {
          if (dept.id === newParentId) return { ...dept, children: [...dept.children, ...updateChildLevels([updatedDept], dept.level + 1)] };
          if (dept.children.length > 0) return { ...dept, children: addToParent(dept.children) };
          return dept;
        });
      };
      return addToParent(newDepts);
    });
  }, [setDepartments]);

  /** 编制人数（健康度 L3 可编辑）；headcount<=0 → 视为未配置（undefined） */
  const handleUpdateHeadcount = useCallback((deptId: string, value: number) => {
    setDepartments((prev) => {
      const update = (depts: Department[]): Department[] => {
        return depts.map((dept) => {
          if (dept.id === deptId) {
            const v = Math.round(value);
            return { ...dept, headcount: v > 0 ? v : undefined };
          }
          if (dept.children.length > 0) return { ...dept, children: update(dept.children) };
          return dept;
        });
      };
      return update(prev);
    });
  }, [setDepartments]);

  const handleReset = useCallback(() => {
    if (confirm('确定要清空所有组织数据吗？（职级配置保留）')) {
      resetWorkspace();
      showToast('工作区已清空');
    }
  }, [resetWorkspace, showToast]);

  const handleLoadTestData = useCallback(() => {
    const employees: Employee[] = TEST_EMPLOYEES.map((e) => ({
      id: e.employeeId,
      name: e.name,
      employeeId: e.employeeId,
      level: e.level,
      dept1: e.dept1,
      dept2: e.dept2,
      dept3: e.dept3,
      dept4: e.dept4,
      dept5: e.dept5,
      dept6: e.dept6,
    }));
    stageImport('示例数据', buildDepartmentTree(employees, TEST_ORG), employees, TEST_ORG);
  }, [stageImport]);

  // 数据备份（导出 .orgproj）
  const handleExportProject = useCallback(async () => {
    try {
      const json = exportProjectJson();
      const ok = await saveTextFile('组织架构项目.orgproj', json, 'application/json');
      showToast(ok ? '已导出 .orgproj 项目文件' : '已取消导出');
    } catch (error) {
      console.error('导出项目文件失败:', error);
      showToast('导出项目文件失败');
    }
  }, [exportProjectJson, showToast]);

  // 导入 .orgproj
  const handleImportProject = useCallback((json: string) => {
    try {
      const ok = importProjectJson(json);
      showToast(ok ? '已导入项目文件（原工作区已留快照，可在项目管理中恢复）' : '导入失败：文件格式无效或保存失败');
    } catch (error) { showToast(error instanceof Error ? error.message : '项目读取失败'); }
  }, [importProjectJson, showToast]);

  // v2.3.1（F-12）：从历史快照恢复
  const handleRestoreBackup = useCallback((key: string) => {
    try {
      const ok = restoreProjectBackup(key);
      showToast(ok ? '已恢复到所选快照（恢复前状态也已留快照）' : '恢复失败：该快照无法读取');
    } catch (error) { showToast(error instanceof Error ? error.message : '恢复快照失败'); }
  }, [restoreProjectBackup, showToast]);

  const handleOpenReport = useCallback(() => {
    flushCurrent();
    setHealthOpen(false);
    setReportOpen(true);
  }, [flushCurrent]);

  const handleOpenHealth = useCallback(() => {
    setHealthFocusDeptId(undefined);
    setHealthOpen(true);
  }, []);

  // —— v2.2.0 胜任度接线 ——

  /** 看板「点击部门卡 → 画布定位」：展开祖先链 + 滚动到节点（与差异视图 handleLocateDept 同心智）。 */
  const handleCompetencyFocusDept = useCallback(
    (deptId: string) => {
      const chain = findDeptChain(departments, deptId);
      if (!chain) {
        showToast('该部门不在当前场景组织中，无法定位');
        return;
      }
      setDepartments((prev) => expandDepartments(prev, new Set(chain)));
      window.setTimeout(() => {
        document
          .querySelector<HTMLElement>(`[data-dept-id="${deptId}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      }, 80);
    },
    [departments, setDepartments, showToast],
  );

  /** 批量评估保存（v2.3 M2）：
   *  - 显式适用范围：岗位评价绑定当前在职关系 relationId，通用评价不带岗位；
   *  - 同日再次录入 → 保留旧分并写入 revisionOf 修订链（F03：不再「先写入者获胜」）；
   *  - 无效修订链（跨人/跨维度/跨角色/跨时点/循环/分叉）整条拒绝，原数据不变（A18）。 */
  const handleSaveAssessments = useCallback(
    (rows: NewAssessment[]) => {
      const now = new Date().toISOString();
      const created: Assessment[] = [];
      const issues: string[] = [];
      let revisions = 0;
      let unchanged = 0;
      let invalid = 0;
      for (const r of rows) {
        const relation = activePrimaryByEmployee.get(r.employeeId);
        const relationId =
          r.scope === 'position' && relation && r.positionId && relation.positionId === r.positionId
            ? relation.id
            : undefined;
        const candidate = {
          employeeId: r.employeeId,
          positionId: r.positionId,
          scope: r.scope,
          relationId,
          dimension: r.dimension,
          assessorRole: r.assessorRole,
          assessedAt: r.assessedAt,
        };
        const pool = [...assessments, ...created];
        const endpoint = currentRevisionEndpoint(pool, candidate);
        if (endpoint && endpoint.score === r.score && endpoint.requirement === r.requirement) {
          unchanged += 1; // 同一时点同一内容 → 不重复写入（原记录保留）
          continue;
        }
        const record: Assessment = {
          id: uid('asm'),
          employeeId: r.employeeId,
          ...(r.positionId ? { positionId: r.positionId } : {}),
          scope: r.scope,
          ...(relationId ? { relationId } : {}),
          dimension: r.dimension,
          score: r.score,
          scale: COMPETENCY_SCALE,
          requirement: r.requirement,
          assessorRole: r.assessorRole,
          ...(r.assessorId ? { assessorId: r.assessorId } : {}),
          ...(r.enteredBy ? { enteredBy: r.enteredBy } : {}),
          assessedAt: r.assessedAt,
          // v2.3.1（F-08）：显式记录评估自然日，作为同日判定的唯一键
          assessmentDay: localDayOf(r.assessedAt),
          source: r.source,
          ...(r.note ? { note: r.note } : {}),
          ...(endpoint ? { revisionOf: endpoint.id, revisionNote: '同日修改评分，显式关联被修订记录' } : {}),
          createdAt: now,
          updatedAt: now,
        };
        const issue = revisionChainIssue(pool, record);
        if (issue) {
          invalid += 1;
          issues.push(`${r.dimension}：${issue}`);
          continue;
        }
        if (endpoint) revisions += 1;
        created.push(record);
      }
      if (created.length > 0) setAssessments((prev) => [...prev, ...created]);
      const parts = [`已保存 ${created.length} 条评分`];
      if (revisions > 0) parts.push(`其中 ${revisions} 条为同日修订（旧分保留）`);
      if (unchanged > 0) parts.push(`${unchanged} 条与当前有效记录一致，未重复写入`);
      if (invalid > 0) parts.push(`${invalid} 条被拒绝：${issues.slice(0, 3).join('；')}`);
      showToast(parts.join('；'));
    },
    [assessments, activePrimaryByEmployee, setAssessments, showToast],
  );

  /** Excel 评分导入：parseAssessmentExcel(file, model) 解析 → 解析员工标识 → 快照 requirement → 写入。
   *  未知员工/格式冲突报错不静默（对齐 ux §1.5）。 */
  const handleImportAssessmentExcel = useCallback(
    async (file: File) => {
      try {
        const rows = await parseAssessmentExcel(file, competencyModel);
        if (currentSceneRef.current !== project.currentScenarioId) { showToast('读取期间场景已变化，请重新导入'); return; }
        if (rows.length === 0) {
          showToast('评分文件无有效数据，请检查格式');
          return;
        }
        const resolved = resolveAssessmentEmployees(rows, allEmployeesFlat);
        const now = new Date().toISOString();
        const created: Assessment[] = [];
        const skipped: string[] = [];
        for (const [index, row] of rows.entries()) {
          const emp = resolved[index];
          const position = emp.positionId ? allPositions.find((p) => p.id === emp.positionId) : undefined;
          const assessedAt = row.assessedAt
            ? new Date(`${row.assessedAt}T12:00:00`).toISOString()
            : now;
          const relation = activePrimaryByEmployee.get(emp.id);
          const relationId =
            emp.positionId && relation && relation.positionId === emp.positionId ? relation.id : undefined;
          for (const [dimKey, score] of Object.entries(row.scores)) {
            const candidate = {
              employeeId: emp.id,
              positionId: emp.positionId,
              scope: (emp.positionId ? 'position' : 'general') as Assessment['scope'],
              relationId,
              dimension: dimKey,
              assessorRole: 'supervisor' as const,
              assessedAt,
            };
            const pool = [...assessments, ...created];
            const endpoint = currentRevisionEndpoint(pool, candidate);
            // 重新导入评分不得悄悄变成覆盖动作（契约 §4.2.6）：
            // 同一时点已存在内容不同的记录且无显式修订关系 → 报冲突，由用户决定，不自动改写。
            if (endpoint && endpoint.score !== score) {
              skipped.push(`${emp.name}·${dimKey}：同一评估时点已有 ${endpoint.score} 分，导入值 ${score} 分存在冲突待核对`);
              continue;
            }
            if (endpoint && endpoint.score === score) continue; // 内容一致 → 折叠，不重复写入
            created.push({
              id: uid('asm'),
              employeeId: emp.id,
              ...(emp.positionId ? { positionId: emp.positionId } : {}),
              scope: emp.positionId ? 'position' : 'general',
              ...(relationId ? { relationId } : {}),
              dimension: dimKey,
              score,
              scale: COMPETENCY_SCALE,
              requirement: benchmarkFor(emp, position),
              assessorRole: 'supervisor',
              ...(row.assessorName ? { assessorId: row.assessorName } : {}),
              assessedAt,
              assessmentDay: localDayOf(assessedAt),
              source: 'import',
              ...(row.note ? { note: row.note } : {}),
              createdAt: now,
              updatedAt: now,
            });
          }
        }
        const conflictNote = skipped.length > 0
          ? ` 另有 ${skipped.length} 条同时间冲突未写入，需人工核对：${skipped.slice(0, 3).join('；')}`
          : '';
        if (created.length === 0) {
          showToast(`没有可写入的评分。${conflictNote}`.trim());
          return;
        }
        setPendingAction({ title: '确认评分导入', scenarioId: project.currentScenarioId,
          description: `已唯一匹配 ${new Set(resolved.map((e) => e.id)).size} 名员工，共 ${created.length} 条评分。对象：${resolved.slice(0, 8).map((e) => `${e.name}（${e.employeeId || '无工号'}）`).join('、')}。所有评分在确认后一次性写入。${conflictNote}`,
          apply: () => { setAssessments((prev) => [...prev, ...created]); showToast(`已导入 ${created.length} 条评分${conflictNote}`); setBatchOpen(false); },
        });
      } catch (error) {
        console.error('解析评分表失败:', error);
        showToast(getImportErrorMessage(error));
      }
    },
    [competencyModel, allEmployeesFlat, allPositions, setAssessments, showToast, project.currentScenarioId, assessments, activePrimaryByEmployee],
  );

  /** v2.3 M4：导出岗位缺口清单（消费看板同一份派生结果，界面与 Excel 逐行一致） */
  const handleExportGapList = useCallback(
    async (board: BoardDerivation) => {
      try {
        const scenarioName = currentScenario?.name ?? '场景';
        const rows = buildGapListRows(board, scenarioName);
        const summary = summarizeGapList(rows);
        const bytes = await buildGapListExcelBytes({
          rows,
          summary,
          meta: {
            projectName: project.name,
            scenarioName,
            scopeLabel: board.scopeLabel,
            filterLabel: BOARD_FILTER_LABEL[board.filter],
            generatedAt: new Date().toLocaleString('zh-CN', { dateStyle: 'long', timeStyle: 'short' }),
          },
        });
        const ok = await saveFile(
          `岗位缺口清单-${scenarioName}.xlsx`,
          bytes,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
        showToast(ok ? '岗位缺口清单 Excel 已导出' : '已取消导出');
      } catch (error) {
        console.error('导出岗位缺口清单失败:', error);
        showToast('导出岗位缺口清单失败');
      }
    },
    [currentScenario, project.name, showToast],
  );

  /** HRBP 人工确认 / 撤销 not_competent（v2.3 M2 完整复核留痕）：
   *  - 确认保存：关系 ID、员工/岗位引用、确认人、确认时间、依据说明、引用的评分记录；
   *  - 撤销保存：对应确认 ID、撤销人、撤销时间、原因，原确认事实仍保留；
   *  - 复核绑定具体人岗关系，不改变任职状态；系统不自动下结论。 */
  const handleConfirmNotCompetent = useCallback(
    (empId: string, confirmed: boolean, payload: { reviewer: string; reason?: string }) => {
      const now = new Date().toISOString();
      // v2.3.1（Q-19）：先在**当前状态**上判定前置条件，失败时给出可行动提示而不是假报成功。
      // 旧实现在 setBoth 的 updater 里 `return prev`，而 toast 无条件报「已确认/已撤销，留痕」——
      // 用户会以为合规记录已写入，实际状态未变（可复现：画布与名册岗位引用不一致时点确认，
      // 或对 legacy 无 relationId 的确认点撤销）。
      const precheckRecords = seedLegacyAssignments(allEmployeesFlat, departments, positionAssignments, now, false);
      const precheckEmp = allEmployeesFlat.find((e) => !e.isVirtual && e.id === empId);
      const precheckActive = precheckRecords.filter(
        (a) => a.employeeId === empId && a.positionId === precheckEmp?.positionId && a.type === 'primary' && a.status === 'active' && !a.endDate,
      );
      if (precheckActive.length !== 1) {
        showToast('无法执行：该员工当前没有唯一的在任主岗，请先在画布/名册核对人岗关系');
        return;
      }
      const precheckRelation = precheckActive[0];
      if (!confirmed) {
        const current = precheckRecords.find(
          (a) => a.status === 'not_competent' && a.relationId === precheckRelation.id && !a.revokedAt,
        );
        if (!current) {
          showToast('没有可撤销的确认：该员工在当前岗位没有生效中的人工确认');
          return;
        }
      } else if (precheckRecords.some(
        (a) => a.status === 'not_competent' && a.relationId === precheckRelation.id && !a.revokedAt,
      )) {
        showToast('无需重复确认：该员工在当前岗位已有生效中的人工确认');
        return;
      }
      setBoth((prev) => {
        const records = seedLegacyAssignments(prev.allEmployeesFlat, prev.departments, prev.positionAssignments, now, false);
        const emp = prev.allEmployeesFlat.find((e) => !e.isVirtual && e.id === empId);
        const active = records.filter((a) => a.employeeId === empId && a.positionId === emp?.positionId && a.type === 'primary' && a.status === 'active' && !a.endDate);
        if (active.length !== 1) return prev;
        const relation = active[0];
        // 确认依据：当时该员工在该岗位适用范围内的有效 supervisor 评分记录
        const basis = assessments
          .filter((a) => a.employeeId === empId && a.assessorRole === 'supervisor'
            && (!a.positionId || a.positionId === relation.positionId))
          .map((a) => a.id);
        if (!confirmed) {
          const current = records.find((a) => a.status === 'not_competent' && a.relationId === relation.id && !a.revokedAt);
          if (!current) return prev;
          return { ...prev, positionAssignments: records.map((a) =>
            a.id === current.id
              ? { ...a, revokedAt: now, revokedBy: payload.reviewer, ...(payload.reason ? { revokeReason: payload.reason } : {}), updatedAt: now }
              : a) };
        }
        if (records.some((a) => a.status === 'not_competent' && a.relationId === relation.id && !a.revokedAt)) return prev;
        return { ...prev, positionAssignments: [...records, {
          id: uid('asg'), employeeId: empId, positionId: relation.positionId, type: 'primary' as const,
          status: 'not_competent' as const, relationId: relation.id, source: 'operation' as const,
          positionName: relation.positionName, departmentName: relation.departmentName,
          confirmedBy: payload.reviewer, confirmedAt: now,
          ...(payload.reason ? { reviewNote: payload.reason } : {}),
          ...(basis.length > 0 ? { reviewAssessmentIds: basis } : {}),
          createdAt: now, updatedAt: now,
        }] };
      });
      showToast(confirmed ? `已确认不胜任（复核人：${payload.reviewer}，留痕）` : `已撤销确认（撤销人：${payload.reviewer}，原确认保留）`);
    },
    [setBoth, showToast, assessments, allEmployeesFlat, departments, positionAssignments],
  );

  // —— v2.0.9 场景差异比较 ——

  /** 打开差异视图：flushCurrent 确保快照已落盘（S2 实时性）；基线 = 第一个场景，目标 = 当前场景。 */
  const handleOpenScenarioDiff = useCallback(() => {
    setHealthOpen(false);
    flushCurrent();
    const first = project.scenarios[0];
    const baselineId = first?.id ?? '';
    const cur = project.currentScenarioId;
    const targetId =
      cur && cur !== baselineId
        ? cur
        : (project.scenarios.find((s) => s.id !== baselineId)?.id ?? '');
    setDiffBaselineId(baselineId);
    setDiffTargetId(targetId);
    setScenarioDiffOpen(true);
  }, [flushCurrent, project]);

  const handleSelectDiffBaseline = useCallback(
    (id: string) => {
      setDiffBaselineId(id);
      setDiffTargetId((prev) =>
        prev === id ? (project.scenarios.find((s) => s.id !== id)?.id ?? prev) : prev,
      );
    },
    [project],
  );

  const handleSelectDiffTarget = useCallback(
    (id: string) => {
      setDiffTargetId(id);
      setDiffBaselineId((prev) =>
        prev === id ? (project.scenarios.find((s) => s.id !== id)?.id ?? prev) : prev,
      );
    },
    [project],
  );

  /** 基线/目标场景对象（选择器状态兜底：id 失效时回退第一个场景） */
  const baselineScenario = useMemo(
    () => project.scenarios.find((s) => s.id === diffBaselineId) ?? project.scenarios[0],
    [project, diffBaselineId],
  );
  const targetScenario = useMemo(
    () => project.scenarios.find((s) => s.id === diffTargetId) ?? currentScenario ?? project.scenarios[0],
    [project, diffTargetId, currentScenario],
  );

  /** 差异点回画布定位（部门）：展开祖先链 + 滚动到节点；不在当前场景 → toast 提示。 */
  const handleLocateDept = useCallback(
    (deptId: string) => {
      const chain = findDeptChain(departments, deptId);
      if (!chain) {
        showToast('该部门不在当前场景组织中，无法定位');
        return;
      }
      setDepartments((prev) => expandDepartments(prev, new Set(chain)));
      window.setTimeout(() => {
        document
          .querySelector<HTMLElement>(`[data-dept-id="${deptId}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      }, 80);
    },
    [departments, setDepartments, showToast],
  );

  /** 差异点回画布定位（员工）：按工号/记录 id 找到当前所属部门并定位；未入架构 → toast 提示。 */
  const handleLocateEmployee = useCallback(
    (employeeId: string) => {
      const findIn = (depts: Department[]): { emp: Employee; deptId: string } | null => {
        for (const d of depts) {
          const emp = d.employees.find((e) => e.id === employeeId || e.employeeId === employeeId);
          if (emp) return { emp, deptId: d.id };
          const childHit = findIn(d.children);
          if (childHit) return childHit;
        }
        return null;
      };
      const found = findIn(departments);
      if (!found) {
        showToast('该员工未在当前场景架构中，无法定位');
        return;
      }
      const chain = findDeptChain(departments, found.deptId);
      setDepartments((prev) => expandDepartments(prev, new Set(chain)));
      const recordId = found.emp.id;
      window.setTimeout(() => {
        document
          .querySelector<HTMLElement>(`[data-emp-id="${recordId}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      }, 80);
    },
    [departments, setDepartments, showToast],
  );

  const handleUndo = useCallback(() => {
    undo();
    showToast('已撤销');
  }, [undo, showToast]);

  const handleRedo = useCallback(() => {
    redo();
    showToast('已重做');
  }, [redo, showToast]);

  if (loadIssue) return <div role="alert" className="p-8 space-y-4 text-slate-800">
    <h1 className="text-xl font-semibold">项目未载入，原自动保存已保留</h1><p>{loadIssue}</p>
    <button className="rounded-lg bg-indigo-600 px-4 py-2 text-white" onClick={async () => {
      const raw = localStorage.getItem(PROJECT_STORAGE_KEY);
      if (raw) await saveTextFile('原自动保存备份.orgproj', decodeStoredProject(raw) ?? raw, 'application/json');
    }}>导出原自动保存</button><p>请使用兼容版本打开备份；当前窗口不编辑或覆盖原数据。</p>
  </div>;

  return (
    <div className="workspace-shell flex flex-col h-screen">
      {(placementIssues.length > 0 || unresolvedOverflow.length > 0) && <button onClick={() => setIssuesOpen(true)}
        className="shrink-0 bg-amber-50 border-b border-amber-200 px-5 py-2 text-left text-sm text-amber-900">
        人岗核对：{placementIssues.length} 项数据问题 · {unresolvedOverflow.length} 个超额岗位待判断（查看明细）
      </button>}
      <AppModal open={issuesOpen} onClose={() => setIssuesOpen(false)} title="人岗核对明细">
        <ul className="space-y-2 text-sm text-slate-700">{[...placementIssues, ...unresolvedOverflow].map((issue, i) => <li key={i}>{issue}</li>)}</ul>
      </AppModal>
      <AppModal open={pendingImport !== null} onClose={() => setPendingImport(null)} title="确认导入到新场景" footer={<>
        <button className="px-3 py-2" onClick={() => setPendingImport(null)}>取消</button>
        <button className="rounded-lg bg-indigo-600 px-3 py-2 text-white" onClick={() => {
          if (!pendingImport || pendingImport.scenarioId !== project.currentScenarioId) { setPendingImport(null); showToast('场景已变化，请重新导入'); return; }
          if (importWorkspace(pendingImport.name, pendingImport.departments, pendingImport.employees)) {
            setOrgTemplates(pendingImport.templates ?? []); setPendingImport(null); showToast('已导入新场景，原场景已完整保留');
          } else showToast('保存失败，导入未应用');
        }}>保留原场景并导入</button>
      </>}>
        {pendingImport && <div className="space-y-3 text-sm text-slate-700">
          <p>文件/模板：{pendingImport.name}</p>
          <p>新场景：{pendingImport.employees.filter((e) => !e.isVirtual).length} 名员工，{indexPlacements(pendingImport.departments).departments.size} 个部门，{indexPlacements(pendingImport.departments).positions.size} 个岗位。</p>
          <p>原场景「{currentScenario.name}」的 {allEmployeesFlat.filter((e) => !e.isVirtual).length} 名员工、{assessments.length} 条评分和 {positionAssignments.length} 条关系/确认记录全部保留。</p>
          <p>新场景复用模型和职级配置；不复制原人员的评分、任职与确认。导入日期不作为到岗日期。</p>
          {inspectPlacements(pendingImport.employees, pendingImport.departments).length > 0 && <p role="alert">新数据存在人岗关联问题，导入后需核对：{inspectPlacements(pendingImport.employees, pendingImport.departments).slice(0, 5).join('；')}</p>}
        </div>}
      </AppModal>
      <AppModal open={pendingAction !== null} onClose={() => setPendingAction(null)} title={pendingAction?.title ?? '确认操作'} footer={<>
        <button className="px-3 py-2" onClick={() => setPendingAction(null)}>取消</button>
        <button className="rounded-lg bg-indigo-600 px-3 py-2 text-white" onClick={() => {
          if (pendingAction?.scenarioId === project.currentScenarioId) pendingAction.apply();
          else showToast('场景已变化，请重新操作');
          setPendingAction(null);
        }}>确认执行</button>
      </>}><p className="text-sm text-slate-700">{pendingAction?.description}</p></AppModal>
      <TopBar
        projectName={project.name}
        scenarios={project.scenarios}
        currentScenarioId={project.currentScenarioId}
        onSwitchScenario={switchScenario}
        onCreateScenario={createNewScenario}
        onRenameScenario={renameScenario}
        onDeleteScenario={deleteScenario}
        onDuplicateScenario={duplicateScenario}
        onManageScenarios={() => setProjectModalOpen(true)}
        saveState={saveState}
        lastSavedAt={lastSavedAt}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onOpenHealth={handleOpenHealth}
        onOpenScenarioDiff={handleOpenScenarioDiff}
        canCompare={project.scenarios.length >= 2}
        hasData={departments.length > 0}
        onDownloadEmployeeTemplate={handleDownloadEmployeeTemplate}
        onDownloadOrgTemplate={handleDownloadOrgTemplate}
        onManageLevels={() => setLevelManagerOpen(true)}
        zoom={zoom}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onOpenSearch={() => setSearchOpen(true)}
        onLoadIndustryTemplate={handleLoadIndustryTemplate}
        onOpenPositionOps={() => setPositionOpsOpen(true)}
        onOpenCompetency={() => setCompetencyOpen(true)}
        onOpenGapList={() => setGapListOpen(true)}
      />

      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          onEmployeeFileUpload={handleEmployeeFileUpload}
          onOrgTemplateUpload={handleOrgTemplateUpload}
          onExportPng={handleExportPng}
          onExportExcel={handleExportExcel}
          onReset={handleReset}
          onLoadTestData={handleLoadTestData}
          onCreateDepartment={handleCreateDepartment}
          onOpenHealth={handleOpenHealth}
          onOpenReport={handleOpenReport}
          onExportProject={handleExportProject}
          departments={departments}
          hasData={departments.length > 0}
          hasEmployees={allEmployeesFlat.length > 0}
          hasOrgTemplate={departments.length > 0}
          onRefreshCanvas={handleRefreshCanvas}
        />

        <main
          ref={mainRef}
          className="workspace-canvas flex-1 min-w-0 overflow-auto p-6"
        >
          <OrgChart
            departments={departments}
            onToggleExpand={handleToggleExpand}
            onUpdateDepartment={handleUpdateDepartment}
            onUpdateLeader={handleUpdateLeader}
            onUpdateLeaderType={handleUpdateLeaderType}
            onMoveEmployee={handleMoveEmployee}
            onMoveMultiple={handleMoveMultiple}
            onMoveDepartment={handleMoveDepartment}
            onChangeDepartmentLevel={handleChangeDepartmentLevel}
            onDeleteEmployee={handleDeleteEmployee}
            onCreateVirtualFromEmployee={handleCreateVirtualFromEmployee}
            allEmployees={allEmployeesFlat}
            zoom={zoom}
            canvasRef={canvasRef}
            zoomContainerRef={mainRef}
            onZoomChange={handleZoomChange}
            onDownloadTemplate={handleDownloadEmployeeTemplate}
            onLoadTestData={handleLoadTestData}
            onLoadIndustryTemplate={() => handleLoadIndustryTemplate('internet')}
            searchHighlight={searchHighlight}
            onSetTargetLevel={handleSetTargetLevel}
            positionSummaries={positionSummaries}
            matchStates={matchStates}
            onSetPositionHeadcount={handleSetPositionHeadcount}
            onRemoveAssignment={handleRemoveAssignment}
            competencySummaries={competencySummaries}
            onOpenCompetencyDetail={(empId) => setDetailEmpId(empId)}
          />
        </main>
      </div>

      {unassignedEmployees.length > 0 && departments.length > 0 && (
        <button
          onClick={() => setUnassignedOpen(true)}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[80] flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-50/95 backdrop-blur border border-amber-300/70 text-amber-800 shadow-lg text-sm font-medium hover:bg-amber-100 transition-colors animate-fadeInUp"
        >
          <AlertTriangle className="w-4 h-4" />
          {unassignedEmployees.length} 名员工未进入架构
          <span className="text-xs text-amber-600 underline underline-offset-2">查看并排入</span>
        </button>
      )}

      {toast && (
        // v2.3.1（Q-28）：toast 是导入/保存/导出/冲突拒绝的唯一反馈通道，必须有 live region，
        // 否则读屏用户完全感知不到（全仓此前 aria-live = 0）。
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[120] px-4 py-2.5 rounded-xl bg-slate-900/90 text-white text-sm font-medium shadow-xl animate-fadeInUp"
        >
          {toast}
        </div>
      )}

      <LevelManagerModal open={levelManagerOpen} onClose={() => setLevelManagerOpen(false)} />

      <HealthDrawer
        open={healthOpen}
        onClose={() => setHealthOpen(false)}
        departments={departments}
        focusDeptId={healthFocusDeptId}
        onClearFocus={() => setHealthFocusDeptId(undefined)}
        onFocusDept={(id) => setHealthFocusDeptId(id)}
        onUpdateHeadcount={handleUpdateHeadcount}
        onSetPositionHeadcount={handleSetPositionHeadcount}
        positionSummaries={positionSummaries}
        onExportReport={handleOpenReport}
        currentScenarioName={currentScenario?.name ?? "场景"}
        scenarios={project.scenarios}
        onOpenScenarioDiff={handleOpenScenarioDiff}
      />

      <ProjectModal
        open={projectModalOpen}
        onClose={() => setProjectModalOpen(false)}
        project={project}
        currentScenarioId={project.currentScenarioId}
        onRenameProject={renameProject}
        onCreateScenario={createNewScenario}
        onRenameScenario={renameScenario}
        onDeleteScenario={deleteScenario}
        onDuplicateScenario={duplicateScenario}
        onSwitchScenario={switchScenario}
        onImport={handleImportProject}
        onExport={handleExportProject}
        onListBackups={listProjectBackups}
        onRestoreBackup={handleRestoreBackup}
      />

      <DiagnosticReport
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        departments={departments}
        levelConfigs={levelConfigs}
        positionSummaries={positionSummaries}
        projectName={project.name}
        scenarioName={currentScenario?.name ?? "场景"}
        onToast={showToast}
      />

      {scenarioDiffOpen && baselineScenario && targetScenario && (
        <ScenarioDiffView
          open={scenarioDiffOpen}
          onClose={() => setScenarioDiffOpen(false)}
          baseline={baselineScenario}
          target={targetScenario}
          scenarios={project.scenarios}
          onSelectBaseline={handleSelectDiffBaseline}
          onSelectTarget={handleSelectDiffTarget}
          onLocateDept={handleLocateDept}
          onLocateEmployee={handleLocateEmployee}
          onExportReport={() => setMgmtReportOpen(true)}
        />
      )}

      {mgmtReportOpen && baselineScenario && targetScenario && (
        <ManagementReport
          open={mgmtReportOpen}
          onClose={() => setMgmtReportOpen(false)}
          baseline={baselineScenario}
          target={targetScenario}
          projectName={project.name}
          levelConfigs={levelConfigs}
          onLocateDept={handleLocateDept}
          onLocateEmployee={handleLocateEmployee}
          onToast={showToast}
        />
      )}

      <SearchModal
        open={searchOpen}
        onClose={handleSearchClose}
        departments={departments}
        onHighlight={setSearchHighlight}
        onClearHighlight={handleSearchClearHighlight}
        onJump={handleSearchJump}
        onCloseKeepHighlight={handleSearchCloseKeepHighlight}
      />

      <UnassignedEmployeesDrawer
        open={unassignedOpen}
        onClose={() => setUnassignedOpen(false)}
        unassignedEmployees={unassignedEmployees}
        departments={departments}
        allEmployees={allEmployeesFlat}
        positionSummaries={positionSummaries}
        matchStates={matchStates}
        onPlaceEmployee={handlePlaceEmployee}
        onPlaceEmployeeToPosition={handlePlaceEmployeeToPosition}
        onAssignEmployeeToPosition={handleAssignEmployeeToPosition}
        onToast={showToast}
      />

      <OnboardingOverlay
        open={onboardingOpen}
        onClose={dismissOnboarding}
        onDownloadTemplate={handleDownloadEmployeeTemplate}
        onLoadTemplate={handleLoadIndustryTemplate}
      />

      <PositionOpsModal
        open={positionOpsOpen}
        onClose={() => setPositionOpsOpen(false)}
        departments={departments}
        allEmployees={allEmployeesFlat}
        levelConfigs={levelConfigs}
        positionSummaries={positionSummaries}
        onCreatePosition={handleCreatePosition}
        onSetPositionHeadcount={handleSetPositionHeadcount}
        onAssignEmployeeToPosition={handleAssignEmployeeToPosition}
        onCreateVirtualForPosition={handleCreateVirtualForPosition}
        onArchivePosition={handleArchivePosition}
      />

      {/* —— v2.2.0 胜任度：看板抽屉 / 批量评估 / 详情 / 维度配置 —— */}
      <CompetencyDrawer
        open={competencyOpen}
        onClose={() => setCompetencyOpen(false)}
        competencySummaries={competencySummaries}
        matchStates={matchStates}
        departments={departments}
        allEmployees={allEmployeesFlat}
        allPositions={allPositions}
        onFocusDept={handleCompetencyFocusDept}
        onOpenDetail={(empId) => setDetailEmpId(empId)}
        onStartBatch={() => setBatchOpen(true)}
        onOpenModelConfig={() => setModelOpen(true)}
        assessments={assessments}
        competencyModel={competencyModel}
        positionAssignments={positionAssignments}
        levelConfigs={levelConfigs}
        onExportGapList={handleExportGapList}
        confirmedNotCompetent={confirmedNotCompetent}
      />

      {/* v2.3 M4：岗位缺口清单（当前场景直读；与看板同一派生口径） */}
      <GapListModal
        open={gapListOpen}
        onClose={() => setGapListOpen(false)}
        projectName={project.name}
        scenario={currentScenario}
        onLocateDept={handleCompetencyFocusDept}
        onToast={showToast}
      />

      <BatchAssessmentModal
        open={batchOpen}
        onClose={() => setBatchOpen(false)}
        departments={departments}
        allEmployees={allEmployeesFlat}
        allPositions={allPositions}
        competencyModel={competencyModel}
        assessments={assessments}
        onSave={handleSaveAssessments}
        onImportExcel={handleImportAssessmentExcel}
      />

      <CompetencyDetailModal
        open={detailEmpId !== null}
        onClose={() => setDetailEmpId(null)}
        employee={detailEmployee}
        position={detailPosition}
        summary={detailSummary}
        dossier={detailDossier}
        history={detailHistory}
        matchStatus={detailMatch?.status}
        resolveName={resolveEmployeeName}
        assignments={detailAssignments}
        reviews={detailReviews}
        onReview={handleConfirmNotCompetent}
      />

      <CompetencyModelModal
        open={modelOpen}
        onClose={() => setModelOpen(false)}
        model={competencyModel}
        assessments={assessments}
        onSave={(m) => {
          setCompetencyModel(m);
          showToast('维度配置已保存');
        }}
      />
    </div>
  );
}
