// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useOrgWorkspace } from './useOrgWorkspace';
import * as projectModule from './project';
import type { Assessment, PositionAssignment, CompetencyModel } from '../types';

// React 18 的 act 需要在 jsdom 下显式声明
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT_STORAGE_KEY = 'org-designer.project.v2';

/**
 * useOrgWorkspace SaveState 状态机单测（v2.0.3 P2）。
 *
 * 验证自动保存状态机：saved →(编辑) unsaved →(800ms debounce) saving → saved。
 * - saving 在 800ms 回调内同步被 saved 覆盖，实际渲染不可见，故断言 saved/unsaved/failed。
 * - fake timers 控制 800ms 窗口，验证 debounce 未满 800ms 不落盘。
 * - 用 Map-backed localStorage stub，避免 Node 实验性 localStorage 在该环境不可用的问题。
 */
describe('useOrgWorkspace SaveState 状态机', () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      removeItem: (k: string) => storage.delete(k),
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('初始状态为 saved', () => {
    const { result } = renderHook(() => useOrgWorkspace());
    expect(result.current.saveState).toBe('saved');
  });

  it('编辑变更 → 立即 unsaved，未满 800ms 不落盘，满 800ms 落盘为 saved', () => {
    const { result } = renderHook(() => useOrgWorkspace());

    // 变更 zoom 触发自动保存依赖
    act(() => {
      result.current.setZoom(150);
    });
    expect(result.current.saveState).toBe('unsaved');

    // 未满 800ms 仍保持 unsaved（debounce 未触发）
    act(() => {
      vi.advanceTimersByTime(799);
    });
    expect(result.current.saveState).toBe('unsaved');

    // 满 800ms → 触发保存并落盘
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.saveState).toBe('saved');
    expect(storage.get(PROJECT_STORAGE_KEY)).toBeTruthy();
  });

  it('连续变更重置 debounce：距最后一次变更满 800ms 才落盘', () => {
    const { result } = renderHook(() => useOrgWorkspace());

    act(() => {
      result.current.setZoom(110); // 起点 A
    });
    act(() => {
      vi.advanceTimersByTime(500); // 距 A 500ms
    });
    expect(result.current.saveState).toBe('unsaved');

    act(() => {
      result.current.setZoom(120); // 再次变更，重置计时为起点 B
    });
    act(() => {
      vi.advanceTimersByTime(799); // 距 B 799ms
    });
    expect(result.current.saveState).toBe('unsaved'); // 计时被重置，仍未触发

    act(() => {
      vi.advanceTimersByTime(1); // 距 B 800ms
    });
    expect(result.current.saveState).toBe('saved');
  });

  it('persistProject 失败 → saveState 变为 failed', () => {
    const spy = vi.spyOn(projectModule, 'persistProject').mockReturnValue(false);
    const { result } = renderHook(() => useOrgWorkspace());

    act(() => {
      result.current.setZoom(150);
    });
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(result.current.saveState).toBe('failed');
    spy.mockRestore();
  });
});

/** 构造一条评估记录（原始事实，缺省业务能力 4 分） */
function asm(partial: Partial<Assessment> = {}): Assessment {
  return {
    id: 'asm-1',
    employeeId: 'e1',
    dimension: 'business',
    score: 4,
    scale: { min: 1, max: 5 },
    requirement: 3,
    assessorRole: 'supervisor',
    assessedAt: '2026-01-10T00:00:00.000Z',
    source: 'manual',
    createdAt: '2026-01-10T00:00:00.000Z',
    updatedAt: '2026-01-10T00:00:00.000Z',
    ...partial,
  };
}

/** 构造一条人岗时态关系记录 */
function pasg(partial: Partial<PositionAssignment> = {}): PositionAssignment {
  return {
    id: 'asg-1',
    employeeId: 'e1',
    positionId: 'p1',
    type: 'primary',
    startDate: '2026-01-01',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

/** 自定义胜任度模型（单维） */
const customModel: CompetencyModel = {
  dimensions: [
    { key: 'business', label: '业务能力', definition: '岗位专业深度', weight: 1, group: 'staff', order: 1, enabled: true },
  ],
};

describe('useOrgWorkspace v2.2.0 胜任度三字段', () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      removeItem: (k: string) => storage.delete(k),
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('初始三字段：空评估 / 默认模型 / 空时态表', () => {
    const { result } = renderHook(() => useOrgWorkspace());
    expect(result.current.assessments).toEqual([]);
    expect(result.current.positionAssignments).toEqual([]);
    expect(result.current.competencyModel.dimensions).toHaveLength(6);
    // 与当前场景缺省一致（场景未显式携带时取默认模型，不丢数据）
    expect(result.current.currentScenario.competencyModel?.dimensions).toHaveLength(6);
  });

  it('三字段更新器（fn|value）更新 live，自动保存后写入场景（保存→场景一致）', () => {
    const { result } = renderHook(() => useOrgWorkspace());
    act(() => {
      result.current.setAssessments((prev) => [...prev, asm()]);
      result.current.setPositionAssignments([pasg()]);
      result.current.setCompetencyModel(customModel);
    });
    expect(result.current.assessments).toHaveLength(1);
    expect(result.current.positionAssignments).toHaveLength(1);
    expect(result.current.competencyModel.dimensions).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(800); // 自动保存 → patchCurrentScenario 落盘
    });
    const scenario = result.current.project.scenarios[0];
    expect(scenario.assessments).toHaveLength(1);
    expect(scenario.assessments![0].score).toBe(4);
    expect(scenario.positionAssignments).toHaveLength(1);
    expect(scenario.competencyModel!.dimensions).toHaveLength(1);
  });

  it('导出→重导入（序列化→sanitize→loadSnapshot）三字段不丢', () => {
    const { result } = renderHook(() => useOrgWorkspace());
    act(() => {
      result.current.setAssessments([asm()]);
    });
    act(() => {
      vi.advanceTimersByTime(800);
    });
    let json = '';
    act(() => { json = result.current.exportProjectJson(); });
    act(() => {
      result.current.importProjectJson(json);
    });
    expect(result.current.assessments).toHaveLength(1);
    expect(result.current.assessments[0].employeeId).toBe('e1');
  });

  it('场景切换：新场景复制三字段，切回原场景恢复一致（不丢数据）', () => {
    const { result } = renderHook(() => useOrgWorkspace());
    const origId = result.current.currentScenarioId;
    act(() => {
      result.current.setAssessments([asm()]);
      result.current.setPositionAssignments([pasg()]);
      result.current.setCompetencyModel(customModel);
    });
    act(() => {
      result.current.createNewScenario('方案B');
    });
    const newId = result.current.currentScenarioId;
    expect(newId).not.toBe(origId);
    expect(result.current.assessments).toHaveLength(1);

    act(() => {
      result.current.switchScenario(origId);
    });
    expect(result.current.assessments).toHaveLength(1);
    expect(result.current.positionAssignments).toHaveLength(1);
    expect(result.current.competencyModel.dimensions).toHaveLength(1);

    act(() => {
      result.current.switchScenario(newId);
    });
    expect(result.current.assessments).toHaveLength(1);
    expect(result.current.positionAssignments).toHaveLength(1);
  });

  it('三字段更新历史感知：undo/redo 完整恢复', () => {
    const { result } = renderHook(() => useOrgWorkspace());
    act(() => {
      result.current.setCompetencyModel(customModel);
      result.current.setAssessments([asm()]);
    });
    expect(result.current.competencyModel.dimensions).toHaveLength(1);
    expect(result.current.assessments).toHaveLength(1);

    // 第一次 undo：回退最近一次变更（assessments），模型保持自定义
    act(() => {
      result.current.undo();
    });
    expect(result.current.competencyModel.dimensions).toHaveLength(1);
    expect(result.current.assessments).toEqual([]);

    // 第二次 undo：回退到初始默认模型
    act(() => {
      result.current.undo();
    });
    expect(result.current.competencyModel.dimensions).toHaveLength(6);
    expect(result.current.assessments).toEqual([]);

    act(() => {
      result.current.redo();
    });
    expect(result.current.competencyModel.dimensions).toHaveLength(1);
    expect(result.current.assessments).toEqual([]);

    act(() => {
      result.current.redo();
    });
    expect(result.current.competencyModel.dimensions).toHaveLength(1);
    expect(result.current.assessments).toHaveLength(1);
  });
});
