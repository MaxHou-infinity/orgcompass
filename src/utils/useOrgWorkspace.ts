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
    return loadProject() ?? createProject('组织架构项目');
  });
  const [loadIssue] = useState(projectLoadIssue);
  const projectRef = useRef(project);
  useEffect(() => {
    projectRef.current = project;
  }, [project]);

  const levelConfigs = useLevelConfigs();
  const levelConfigsRef = useRef(levelConfigs);
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
        levelConfigs: target.levelConfigs,
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
          levelConfigs: remaining[0].levelConfigs,
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
    const next = { ...cur, currentScenarioId: created.id,
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

  /** 导入 .orgproj JSON 字符串。成功返回 true。 */
  const importProjectJson = useCallback(
    (json: string): boolean => {
      const parsed = parseProject(json);
      if (!parsed) return false;
      if (!persistProject(parsed)) return false;
      projectRef.current = parsed;
      setProjectState(parsed);
      const first = getCurrentScenario(parsed);
      loadSnapshot({
        departments: first.departments,
        allEmployeesFlat: first.allEmployeesFlat,
        levelConfigs: first.levelConfigs,
        canvas: first.canvas,
        assessments: first.assessments ?? [],
        competencyModel: structuredClone(first.competencyModel ?? DEFAULT_COMPETENCY_MODEL),
        positionAssignments: first.positionAssignments ?? [],
      });
      return true;
    },
    [loadSnapshot],
  );

  /** 清空当前工作区（重置，保留职级配置偏好）。v2.2.0：三字段重置为 空评估 / 默认模型 / 空时态表。 */
  const resetWorkspace = useCallback(() => {
    flushCurrent();
    replaceSnapshot({
      departments: [],
      allEmployeesFlat: [],
      assessments: [],
      competencyModel: structuredClone(DEFAULT_COMPETENCY_MODEL),
      positionAssignments: [],
    });
    setZoomState(100);
  }, [flushCurrent, replaceSnapshot]);

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

    exportProjectJson,
    importProjectJson,
    resetWorkspace,
    flushCurrent,
  };
}
