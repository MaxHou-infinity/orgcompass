import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ProjectFile,
  LevelConfig,
  Employee,
  Department,
  ScenarioCanvas,
  Assessment,
  CompetencyModel,
  PositionAssignment,
  OrgTemplate,
  DEFAULT_COMPETENCY_MODEL,
} from '../types';
import {
  createProject,
  createScenario,
  cloneScenario,
  serializeProject,
  parseProject,
  loadProject,
  persistProject,
  projectLoadIssue,
  getCurrentScenario,
  // v2.3.1（F-12）：破坏性写入前的可恢复快照
  snapshotCurrentProject,
  readProjectBackup,
} from './project';
import { reconcilePlacementChange, seedLegacyAssignments } from './placement';
import { flattenPositions } from './positions';
import { useLevelConfigs, updateLevelConfigs } from './levels';
import { useHistoryState, HistorySnapshot } from './history';

export type SaveState = 'saved' | 'saving' | 'unsaved' | 'failed';

function formatTime(iso: string | null): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return null;
  }
}

/**
 * 工作区编排 Hook：把「项目文件 + 场景 + 实时快照 + 历史 + 自动保存 + 保存状态」
 * 收敛到一处，供 App 消费。纯逻辑（analytics/project/history）在单测中覆盖，本 Hook 为整合胶水。
 */
export function useOrgWorkspace() {
  const [project, setProjectState] = useState<ProjectFile>(() => {
    const loaded = loadProject() ?? createProject('组织架构项目');
    /*
     * v2.3.2：职级配置以**工作区文件**为准。
     * localStorage 里的职级键只是运行时缓存；刚导入过别人的 .orgproj、或手改过文件时，
     * 两者可能不一致 —— 这里在首屏渲染前对齐，避免先闪一帧错配色。
     * （放在 useState 初始化器里是为了「首次渲染就读到正确值」，effect 会晚一帧。）
     */
    if (loaded.levelConfigs) updateLevelConfigs(loaded.levelConfigs);
    return loaded;
  });
  const [loadIssue] = useState(projectLoadIssue);
  const projectRef = useRef(project);
  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  const levelConfigs = useLevelConfigs();
  const levelConfigsRef = useRef(levelConfigs);
  /**
   * v2.3.2：取某个项目的工作区级职级配置；旧项目缺省时退回运行时 store。
   * 切场景/删场景/导入都走它 —— 这样「颜色/标签/成本」不再随演练方案切换而变。
   */
  const workspaceLevelConfigsOf = (p: ProjectFile): LevelConfig[] => p.levelConfigs ?? levelConfigsRef.current;
  useEffect(() => {
    levelConfigsRef.current = levelConfigs;
  }, [levelConfigs]);

  const initialScenario = getCurrentScenario(project);

  const history = useHistoryState<HistorySnapshot>(
    {
      departments: initialScenario.departments,
      allEmployeesFlat: initialScenario.allEmployeesFlat,
      assessments: initialScenario.assessments ?? [],
      competencyModel: structuredClone(initialScenario.competencyModel ?? DEFAULT_COMPETENCY_MODEL),
      positionAssignments: initialScenario.positionAssignments ?? [],
    },
    50,
    // v2.3.1（Q-20）：人工复核确认是**合规留痕**，不能被一次 Ctrl+Z 无痕抹掉。
    // 撤销/重做落地前，把当前状态里存在、而目标快照里缺失的 not_competent 记录并回去；
    // 取消确认必须走显式「撤销确认」（带撤销人/时间/原因），保持 D04「原确认仍可查」。
    (restored, current) => {
      const byId = new Map(restored.positionAssignments.map((a) => [a.id, a]));
      let added = false;
      for (const a of current.positionAssignments) {
        if (a.status !== 'not_competent' || byId.has(a.id)) continue;
        byId.set(a.id, a);
        added = true;
      }
      return added ? { ...restored, positionAssignments: [...byId.values()] } : restored;
    },
  );
  const { state: live, getSnapshot, set: setSnapshot, replace: replaceSnapshot, undo, redo, canUndo, canRedo } = history;
  const { departments, allEmployeesFlat, assessments, competencyModel, positionAssignments } = live;
  const departmentsRef = useRef(departments);
  const employeesRef = useRef(allEmployeesFlat);
  const assessmentsRef = useRef(assessments);
  const competencyModelRef = useRef(competencyModel);
  const positionAssignmentsRef = useRef(positionAssignments);
  useEffect(() => {
    departmentsRef.current = departments;
    employeesRef.current = allEmployeesFlat;
    assessmentsRef.current = assessments;
    competencyModelRef.current = competencyModel;
    positionAssignmentsRef.current = positionAssignments;
  }, [departments, allEmployeesFlat, assessments, competencyModel, positionAssignments]);

  const [zoom, setZoomState] = useState<number>(initialScenario.canvas.zoom ?? 100);
  const zoomRef = useRef(zoom);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(() =>
    formatTime(initialScenario.updatedAt),
  );

  const dirtyTimer = useRef<number | null>(null);
  const firstRun = useRef(true);

  /** 把实时快照写回当前场景并持久化（不重置 saveState 计时）。 */
  const patchCurrentScenario = useCallback((): void => {
    const now = new Date().toISOString();
    const current = getSnapshot();
    departmentsRef.current = current.departments;
    employeesRef.current = current.allEmployeesFlat;
    assessmentsRef.current = current.assessments;
    competencyModelRef.current = current.competencyModel;
    positionAssignmentsRef.current = current.positionAssignments;
    const cur = projectRef.current;
    const next: ProjectFile = {
      ...cur,
      // v2.3.2：职级配置的真值在工作区级（场景里那份只是给旧版本读的兼容镜像）
      levelConfigs: levelConfigsRef.current,
      scenarios: cur.scenarios.map((s) =>
        s.id === cur.currentScenarioId
          ? {
              ...s,
              departments: departmentsRef.current,
              // v2.3 M4 修复：回写岗位扁平镜像，避免 Scenario.positions 长期为空/过期
              // （此前只保存 departments，导致依赖该镜像的消费者读到空岗位）
              positions: flattenPositions(departmentsRef.current),
              allEmployeesFlat: employeesRef.current,
              assessments: assessmentsRef.current,
              competencyModel: competencyModelRef.current,
              positionAssignments: positionAssignmentsRef.current,
              levelConfigs: levelConfigsRef.current,
              canvas: { ...s.canvas, zoom: zoomRef.current },
              updatedAt: now,
            }
          : s,
      ),
      meta: { ...cur.meta, updatedAt: now },
    };
    projectRef.current = next;
    setProjectState(next);
    const ok = persistProject(next);
    setSaveState(ok ? 'saved' : 'failed');
    setLastSavedAt(formatTime(now));
  }, [getSnapshot]);

  /** 强制保存当前场景（清空计时器 + 立即落盘）。 */
  const flushCurrent = useCallback((): ProjectFile => {
    if (dirtyTimer.current) {
      clearTimeout(dirtyTimer.current);
      dirtyTimer.current = null;
    }
    patchCurrentScenario();
    return projectRef.current;
  }, [patchCurrentScenario]);

  // 自动保存：任何会改 departments/allEmployeesFlat/zoom/levelConfigs/胜任度三字段 的动作 → debounce 800ms 落盘
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setSaveState('unsaved');
    if (dirtyTimer.current) clearTimeout(dirtyTimer.current);
    dirtyTimer.current = window.setTimeout(() => {
      setSaveState('saving');
      patchCurrentScenario();
    }, 800);
    return () => {
      if (dirtyTimer.current) clearTimeout(dirtyTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departments, allEmployeesFlat, zoom, levelConfigs, assessments, competencyModel, positionAssignments]);

  /**
   * v2.3.1（Q-09）：离开页面前把待写快照落盘。
   *
   * 旧实现只有 800ms debounce：编辑后 800ms 内关闭窗口/刷新/WebView 被系统回收 →
   * 最后一次编辑直接丢失（内存状态与磁盘不一致，且用户没有任何补救手段）。
   * 这里补 pagehide（覆盖刷新/关闭/前进后退）与 visibilitychange→hidden（覆盖切后台被杀）。
   */
  useEffect(() => {
    const flushPending = () => {
      if (dirtyTimer.current === null) return; // 无待写内容 → 不打扰
      clearTimeout(dirtyTimer.current);
      dirtyTimer.current = null;
      patchCurrentScenario();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushPending();
    };
    window.addEventListener('pagehide', flushPending);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flushPending);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [patchCurrentScenario]);

  /** —— 快照更新器（历史感知） —— */

  const setDepartments = useCallback(
    (fn: (prev: Department[]) => Department[]) => {
      setSnapshot((prev) => reconcilePlacementChange(prev, { ...prev, departments: fn(prev.departments) }, new Date().toISOString()));
    },
    [setSnapshot],
  );

  const setAllEmployeesFlat = useCallback(
    (fn: (prev: Employee[]) => Employee[]) => {
      setSnapshot((prev) => reconcilePlacementChange(prev, { ...prev, allEmployeesFlat: fn(prev.allEmployeesFlat) }, new Date().toISOString()));
    },
    [setSnapshot],
  );

  /** v2.2.0：评估长表（原始事实）更新器（历史感知，支持 fn|value） */
  const setAssessments = useCallback(
    (next: Assessment[] | ((prev: Assessment[]) => Assessment[])) => {
      setSnapshot((prev) => ({
        ...prev,
        assessments: typeof next === 'function' ? next(prev.assessments) : next,
      }));
    },
    [setSnapshot],
  );

  /** v2.2.0：胜任度模型更新器（历史感知，支持 fn|value） */
  const setCompetencyModel = useCallback(
    (next: CompetencyModel | ((prev: CompetencyModel) => CompetencyModel)) => {
      setSnapshot((prev) => ({
        ...prev,
        competencyModel: typeof next === 'function' ? next(prev.competencyModel) : next,
      }));
    },
    [setSnapshot],
  );

  /** v2.2.0：人岗时态关系表更新器（历史感知，支持 fn|value） */
  const setPositionAssignments = useCallback(
    (next: PositionAssignment[] | ((prev: PositionAssignment[]) => PositionAssignment[])) => {
      setSnapshot((prev) => ({
        ...prev,
        positionAssignments: typeof next === 'function' ? next(prev.positionAssignments) : next,
      }));
    },
    [setSnapshot],
  );

  const setBoth = useCallback(
    (fn: (prev: HistorySnapshot) => HistorySnapshot) => {
      setSnapshot((prev) => reconcilePlacementChange(prev, fn(prev), new Date().toISOString()));
    },
    [setSnapshot],
  );

  /** 载入一个场景快照到实时态（重置历史）。v2.2.0：三字段与 live 快照一一对应。 */
  const loadSnapshot = useCallback(
    (snap: {
      departments: Department[];
      allEmployeesFlat: Employee[];
      levelConfigs: LevelConfig[];
      canvas: ScenarioCanvas;
      assessments: Assessment[];
      competencyModel: CompetencyModel;
      positionAssignments: PositionAssignment[];
    }) => {
      departmentsRef.current = snap.departments;
      employeesRef.current = snap.allEmployeesFlat;
      assessmentsRef.current = snap.assessments;
      competencyModelRef.current = snap.competencyModel;
      positionAssignmentsRef.current = snap.positionAssignments;
      zoomRef.current = snap.canvas.zoom ?? 100;
      levelConfigsRef.current = snap.levelConfigs;
      replaceSnapshot({
        departments: snap.departments,
        allEmployeesFlat: snap.allEmployeesFlat,
        assessments: snap.assessments,
        competencyModel: snap.competencyModel,
        positionAssignments: snap.positionAssignments,
      });
      setZoomState(snap.canvas.zoom ?? 100);
      updateLevelConfigs(snap.levelConfigs);
    },
    [replaceSnapshot],
  );

  /** —— 场景操作 —— */

  const currentScenario = getCurrentScenario(project);

  const switchScenario = useCallback(
    (sceneId: string) => {
      const target = projectRef.current.scenarios.find((s) => s.id === sceneId);
      if (!target || target.id === projectRef.current.currentScenarioId) return;
      flushCurrent(); // 保存当前场景
      const next: ProjectFile = { ...projectRef.current, currentScenarioId: sceneId };
      projectRef.current = next;
      setProjectState(next);
      loadSnapshot({
        departments: target.departments,
        allEmployeesFlat: target.allEmployeesFlat,
        // v2.3.2：切场景**不换职级配置**（旧实现在这里用目标场景的旧快照覆盖，
        // 导致「我刚改的颜色一切场景就变回去」——Chromium 实测确认）
        levelConfigs: workspaceLevelConfigsOf(next),
        canvas: target.canvas,
        assessments: target.assessments ?? [],
        competencyModel: structuredClone(target.competencyModel ?? DEFAULT_COMPETENCY_MODEL),
        positionAssignments: target.positionAssignments ?? [],
      });
    },
    [flushCurrent, loadSnapshot],
  );

  const createNewScenario = useCallback(
    (name: string) => {
      flushCurrent();
      const snap = {
        departments: departmentsRef.current,
        allEmployeesFlat: employeesRef.current,
        levelConfigs: levelConfigsRef.current,
        canvas: { zoom: zoomRef.current },
        assessments: assessmentsRef.current,
        competencyModel: competencyModelRef.current,
        positionAssignments: positionAssignmentsRef.current,
      };
      const created = createScenario(name, snap);
      const next: ProjectFile = {
        ...projectRef.current,
        currentScenarioId: created.id,
        scenarios: [...projectRef.current.scenarios, created],
        meta: { ...projectRef.current.meta, updatedAt: new Date().toISOString() },
      };
      projectRef.current = next;
      setProjectState(next);
      persistProject(next);
      loadSnapshot({ ...created, assessments: created.assessments ?? [],
        competencyModel: created.competencyModel!, positionAssignments: created.positionAssignments ?? [] });
    },
    [flushCurrent, loadSnapshot],
  );

  const duplicateScenario = useCallback(
    (sceneId: string) => {
      flushCurrent();
      const target = projectRef.current.scenarios.find((s) => s.id === sceneId);
      if (!target) return;
      const copied = cloneScenario(target);
      const next: ProjectFile = {
        ...projectRef.current,
        scenarios: [...projectRef.current.scenarios, copied],
      };
      projectRef.current = next;
      setProjectState(next);
      persistProject(next);
    },
    [flushCurrent],
  );

  const renameScenario = useCallback(
    (sceneId: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const next: ProjectFile = {
        ...projectRef.current,
        scenarios: projectRef.current.scenarios.map((s) =>
          s.id === sceneId ? { ...s, name: trimmed, updatedAt: new Date().toISOString() } : s,
        ),
      };
      projectRef.current = next;
      setProjectState(next);
      persistProject(next);
    },
    [],
  );

  const deleteScenario = useCallback(
    (sceneId: string): boolean => {
      const cur = projectRef.current;
      if (cur.scenarios.length <= 1) return false; // 禁止删除最后一个
      const removingCurrent = cur.currentScenarioId === sceneId;
      const remaining = cur.scenarios.filter((s) => s.id !== sceneId);
      if (remaining.length === cur.scenarios.length) return false;
      const next: ProjectFile = {
        ...cur,
        scenarios: remaining,
        currentScenarioId: removingCurrent ? remaining[0].id : cur.currentScenarioId,
      };
      projectRef.current = next;
      setProjectState(next);
      persistProject(next);
      if (removingCurrent) {
        loadSnapshot({
          departments: remaining[0].departments,
          allEmployeesFlat: remaining[0].allEmployeesFlat,
          levelConfigs: workspaceLevelConfigsOf(next),
          canvas: remaining[0].canvas,
          assessments: remaining[0].assessments ?? [],
          competencyModel: structuredClone(remaining[0].competencyModel ?? DEFAULT_COMPETENCY_MODEL),
          positionAssignments: remaining[0].positionAssignments ?? [],
        });
      }
      return true;
    },
    [loadSnapshot],
  );

  const renameProject = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const next: ProjectFile = { ...projectRef.current, name: trimmed };
      projectRef.current = next;
      setProjectState(next);
      persistProject(next);
    },
    [],
  );

  /** 全量导入只在空场景填充；已有事实时生成独立场景，保留原场景全部关联。 */
  const importWorkspace = useCallback((name: string, tree: Department[], employees: Employee[]): boolean => {
    flushCurrent();
    const cur = projectRef.current;
    const old = getCurrentScenario(cur);
    const occupied = old.departments.length > 0 || old.allEmployeesFlat.length > 0
      || (old.assessments?.length ?? 0) > 0 || (old.positionAssignments?.length ?? 0) > 0;
    const now = new Date().toISOString();
    const created = createScenario(name, {
      departments: structuredClone(tree), allEmployeesFlat: structuredClone(employees),
      levelConfigs: structuredClone(levelConfigsRef.current), canvas: { zoom: 100 },
      competencyModel: structuredClone(competencyModelRef.current), assessments: [],
      positionAssignments: seedLegacyAssignments(employees, tree, [], now),
    }, now);
    if (!occupied) created.id = old.id;
    const next = { ...cur, levelConfigs: structuredClone(levelConfigsRef.current), currentScenarioId: created.id,
      scenarios: occupied ? [...cur.scenarios, created] : cur.scenarios.map((s) => s.id === old.id ? created : s),
      meta: { ...cur.meta, updatedAt: now } };
    if (!persistProject(next)) { setSaveState('failed'); return false; }
    projectRef.current = next;
    setProjectState(next);
    loadSnapshot({ ...created, assessments: [], competencyModel: created.competencyModel!, positionAssignments: created.positionAssignments! });
    return true;
  }, [flushCurrent, loadSnapshot]);

  /** —— 文件导入 / 导出 —— */

  /** 导出 .orgproj JSON 字符串 */
  const exportProjectJson = useCallback((): string => {
    flushCurrent();
    return serializeProject(projectRef.current);
  }, [flushCurrent]);

  /** 导入 .orgproj JSON 字符串。成功返回 true，并把导入前的工作区快照留档（v2.3.1 F-12）。 */
  const importProjectJson = useCallback(
    (json: string): boolean => {
      const parsed = parseProject(json);
      if (!parsed) return false;
      // 解析成功后才快照：避免「文件本身不可用」也写一份无意义快照。
      const snapshotted = snapshotCurrentProject('导入 .orgproj');
      if (!persistProject(parsed)) return false;
      if (!snapshotted) console.warn('导入前未能写入快照（可能无现存数据或存储不可用）');
      projectRef.current = parsed;
      setProjectState(parsed);
      const first = getCurrentScenario(parsed);
      loadSnapshot({
        departments: first.departments,
        allEmployeesFlat: first.allEmployeesFlat,
        // v2.3.2：导入的项目用它的工作区级职级配置（parseProject 已保证该字段存在）
        levelConfigs: workspaceLevelConfigsOf(parsed),
        canvas: first.canvas,
        assessments: first.assessments ?? [],
        competencyModel: structuredClone(first.competencyModel ?? DEFAULT_COMPETENCY_MODEL),
        positionAssignments: first.positionAssignments ?? [],
      });
      return true;
    },
    [loadSnapshot],
  );

  /** 恢复某一份历史快照（恢复前同样先给当前状态留一份快照）。 */
  const restoreProjectBackup = useCallback(
    (key: string): boolean => {
      const parsed = readProjectBackup(key);
      if (!parsed) return false;
      snapshotCurrentProject('恢复历史快照');
      if (!persistProject(parsed)) return false;
      projectRef.current = parsed;
      setProjectState(parsed);
      const first = getCurrentScenario(parsed);
      loadSnapshot({
        departments: first.departments,
        allEmployeesFlat: first.allEmployeesFlat,
        // v2.3.2：导入的项目用它的工作区级职级配置（parseProject 已保证该字段存在）
        levelConfigs: workspaceLevelConfigsOf(parsed),
        canvas: first.canvas,
        assessments: first.assessments ?? [],
        competencyModel: structuredClone(first.competencyModel ?? DEFAULT_COMPETENCY_MODEL),
        positionAssignments: first.positionAssignments ?? [],
      });
      return true;
    },
    [loadSnapshot],
  );

  /**
   * v2.3.2：设置工作区级「组织架构模板」（补充层数据源）并立即持久化。
   *
   * 为什么必须持久化：旧实现把 orgTemplates 只放在 App 的 React state 里（`App.tsx:200`），
   * 关闭应用再打开就归零 —— 用户会看到「负责人全没了」，而且下次重传员工表时模板已不存在，
   * 补充层的空部门与负责人**永久静默丢失**。它是数据来源配置，不属于某个场景快照。
   */
  const setOrgTemplates = useCallback((templates: OrgTemplate[]): boolean => {
    const now = new Date().toISOString();
    const next: ProjectFile = {
      ...projectRef.current,
      orgTemplates: templates.length > 0 ? templates : undefined,
      meta: { ...projectRef.current.meta, updatedAt: now },
    };
    projectRef.current = next;
    setProjectState(next);
    const ok = persistProject(next);
    setSaveState(ok ? 'saved' : 'failed');
    setLastSavedAt(formatTime(now));
    return ok;
  }, []);

  /** 清空当前工作区（重置，保留职级配置偏好）。v2.2.0：三字段重置为 空评估 / 默认模型 / 空时态表。
   *  v2.3.1（F-12）：清空前留一份可恢复快照。
   *  v2.3.2：补充层数据源（组织架构模板）一并清空，避免「清空后又冒出一批空部门/负责人」。 */
  const resetWorkspace = useCallback(() => {
    flushCurrent();
    snapshotCurrentProject('清空工作区');
    replaceSnapshot({
      departments: [],
      allEmployeesFlat: [],
      assessments: [],
      competencyModel: structuredClone(DEFAULT_COMPETENCY_MODEL),
      positionAssignments: [],
    });
    setOrgTemplates([]);
    setZoomState(100);
  }, [flushCurrent, replaceSnapshot, setOrgTemplates]);

  return {
    project,
    loadIssue,
    importWorkspace,
    currentScenario,
    currentScenarioId: project.currentScenarioId,
    zoom,
    setZoom: setZoomState,
    departments,
    allEmployeesFlat,
    assessments,
    competencyModel,
    positionAssignments,
    levelConfigs,
    saveState,
    lastSavedAt,

    setDepartments,
    setAllEmployeesFlat,
    setAssessments,
    setCompetencyModel,
    setPositionAssignments,
    setBoth,

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

    /** v2.3.2：工作区级组织架构模板（补充层数据源）读 / 写 */
    setOrgTemplates,

    exportProjectJson,
    importProjectJson,
    restoreProjectBackup,
    resetWorkspace,
    flushCurrent,
  };
}
