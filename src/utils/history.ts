import { useMemo, useRef, useSyncExternalStore } from 'react';
import type { Assessment, CompetencyModel, Department, Employee, PositionAssignment } from '../types';

/**
 * 撤销 / 重做历史栈（纯逻辑 + React 适配）。
 *
 * 以「快照」存整份状态（如 departments 树 + allEmployeesFlat），简单可靠。
 * - 栈深可限制（默认 50）。
 * - 每次用户 mutate 前压栈；新动作会清空 redo 栈（标准行为）。
 * - undo / redo 后用新引用替换 present，触发 useSyncExternalStore 重渲染。
 */

export class HistoryStore<T> {
  private past: T[] = [];
  private present: T;
  private future: T[] = [];
  private limit: number;
  private listeners = new Set<() => void>();

  /**
   * v2.3.1（Q-20）：`preserve(restored, current)` 在撤销/重做落地前做一次合并，
   * 用于让「不可回退的事实」（如人工复核确认记录）不被一次 Ctrl+Z 无痕抹掉 ——
   * 复核事实是合规留痕，删除必须走显式撤销确认（带撤销人/时间/原因），不能靠编辑器快捷键。
   */
  constructor(initial: T, limit = 50, private preserve?: (restored: T, current: T) => T) {
    this.present = initial;
    this.limit = limit;
  }

  /** 订阅（供 useSyncExternalStore） */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** 快照：present（每次变更引用变化，触发重渲染） */
  getSnapshot = (): T => this.present;

  private emit = (): void => {
    for (const l of this.listeners) l();
  };

  /**
   * 提交一个新快照（用户 mutate）。
   * 先把当前 present 压入 past（超限裁剪），再用新值替换 present，并清空 redo。
   */
  set(next: T | ((prev: T) => T)): void {
    const resolved = typeof next === 'function' ? (next as (p: T) => T)(this.present) : next;
    if (resolved === this.present) return; // no-op，避免空历史
    this.past.push(this.present);
    if (this.past.length > this.limit) this.past.shift();
    this.present = resolved;
    this.future = [];
    this.emit();
  }

  /** 非历史提交：直接替换 present 并清空历史（如场景切换 / 载入快照 / 重置）。 */
  replace(next: T): void {
    this.present = next;
    this.past = [];
    this.future = [];
    this.emit();
  }

  undo(): void {
    if (this.past.length === 0) return;
    const prev = this.past.pop()!;
    this.future.push(this.present);
    // v2.3.1（Q-20）：撤销前允许「保留不可回退的事实」（人工复核留痕）。
    this.present = this.preserve ? this.preserve(prev, this.present) : prev;
    this.emit();
  }

  redo(): void {
    if (this.future.length === 0) return;
    const next = this.future.pop()!;
    this.past.push(this.present);
    this.present = this.preserve ? this.preserve(next, this.present) : next;
    this.emit();
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  clearRedo(): void {
    this.future = [];
    this.emit();
  }

  get undoDepth(): number {
    return this.past.length;
  }

  get redoDepth(): number {
    return this.future.length;
  }
}

/** 撤销/重做快照实体（App 用它容纳 departments + allEmployeesFlat + v2.2.0 场景三字段）
 *  - assessments / competencyModel / positionAssignments 与场景级 `.orgproj` 字段一一对应，
 *    快照必须是完整事实集（不得丢弃三字段），派生值（Gap/灯号/总分）不落快照、运行时算。 */
export interface HistorySnapshot {
  departments: Department[];
  allEmployeesFlat: Employee[];
  /** v2.2.0：扁平评估长表（原始事实；派生不落库） */
  assessments: Assessment[];
  /** v2.2.0：场景级胜任度模型（维度集合；live 与场景一致） */
  competencyModel: CompetencyModel;
  /** v2.2.0：人岗时态关系表（追加式历史 + 人工确认落点） */
  positionAssignments: PositionAssignment[];
}

/**
 * React 适配：以 `useSyncExternalStore` 订阅一个 HistoryStore，并暴露常用 setter。
 * @param initial 初始快照
 * @param limit 栈深上限
 */
export function useHistoryState<S>(
  initial: S,
  limit = 50,
  /** v2.3.1（Q-20）：撤销/重做前的事实保留钩子（见 HistoryStore.preserve） */
  preserve?: (restored: S, current: S) => S,
) {
  const storeRef = useRef<HistoryStore<S> | null>(null);
  const preserveRef = useRef(preserve);
  preserveRef.current = preserve;
  if (!storeRef.current) {
    storeRef.current = new HistoryStore<S>(initial, limit, (restored, current) =>
      preserveRef.current ? preserveRef.current(restored, current) : restored,
    );
  }
  const store = storeRef.current;

  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  // v2.3.1（Q-25）：这几个方法必须保持**稳定引用**。
  // `store.set.bind(store)` 每次渲染都会产生新函数，而 App 的全局键盘 effect 依赖 [undo, redo] →
  // 每次无关重渲染都重新 addEventListener/removeEventListener（实测 20 次重渲染 = 20 次绑定）。
  // store 实例在组件生命周期内不变，因此这里可以安全地用 useMemo 固定身份。
  const actions = useMemo(
    () => ({
      /** 提交新快照（入历史栈） */
      set: store.set.bind(store),
      /** 替换快照（清空历史，用于载入/重置） */
      replace: store.replace.bind(store),
      undo: store.undo.bind(store),
      redo: store.redo.bind(store),
    }),
    [store],
  );

  return {
    state,
    getSnapshot: store.getSnapshot,
    set: actions.set,
    replace: actions.replace,
    undo: actions.undo,
    redo: actions.redo,
    canUndo: store.canUndo(),
    canRedo: store.canRedo(),
    undoDepth: store.undoDepth,
    redoDepth: store.redoDepth,
  };
}
