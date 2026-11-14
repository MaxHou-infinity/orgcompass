// @vitest-environment jsdom
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { DndContext, DragStartEvent, DragEndEvent } from '@dnd-kit/core';
import type { OrgChart } from './components/OrgChart';
import type { TopBar } from './components/TopBar';
import { createProject, persistProject, loadProject } from './utils/project';
import { HistoryStore, type HistorySnapshot } from './utils/history';
import type { Department } from './types';
import App from './App';
const captured = vi.hoisted(() => ({ chart: null as ComponentProps<typeof OrgChart> | null, bar: null as ComponentProps<typeof TopBar> | null, dnd: null as ComponentProps<typeof DndContext> | null }));
vi.mock('./components/OrgChart', async (original) => {
  const actual = await original<typeof import('./components/OrgChart')>();
  return { ...actual, OrgChart: (p: ComponentProps<typeof OrgChart>) => { captured.chart = p; return <actual.OrgChart {...p} />; } };
});
vi.mock('@dnd-kit/core', async (original) => {
  const actual = await original<typeof import('@dnd-kit/core')>();
  return { ...actual, DndContext: (p: ComponentProps<typeof DndContext>) => { captured.dnd = p; return <>{p.children}</>; }, DragOverlay: () => null };
});
vi.mock('./components/DepartmentCard', () => ({ DepartmentCard: () => null }));
vi.mock('./components/TopBar', () => ({ TopBar: (p: ComponentProps<typeof TopBar>) => { captured.bar = p; return null; } }));
vi.mock('./components/Sidebar', () => ({ Sidebar: () => null }));
const node = (id: string, level: number, children: Department[] = []): Department => ({ id, name: id, level, children, employees: [], expanded: true });
function tree() { return [node('A', 1, [node('B', 2, [node('C', 3)])]), node('X', 1, [node('Y', 2, [node('Z', 3)])])]; }
function move(id: string, target: string | null) { act(() => captured.chart!.onMoveDepartment!(id, target)); }
function undo() { act(() => captured.bar!.onUndo()); }
function redo() { act(() => captured.bar!.onRedo()); }
let store: HistoryStore<HistorySnapshot>;
function rememberStore(value: HistoryStore<HistorySnapshot>) { store = value; }
beforeEach(() => {
  vi.useFakeTimers();
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) });
  const p = createProject('synthetic move history'); p.scenarios[0].departments = tree(); persistProject(p);
  const original = HistoryStore.prototype.set;
  vi.spyOn(HistoryStore.prototype, 'set').mockImplementation(function(this: HistoryStore<HistorySnapshot>, next) { rememberStore(this); return original.call(this, next); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('C01 actual App callback → workspace → placement → HistoryStore', () => {
  it.each([['C', 'B'], ['A', null], ['A', 'C'], ['X', 'Z'], ['B', 'B']] as const)('no-op/rejected %s → %s preserves snapshot/depth/redo', (id, target) => {
    render(<App />);
    move('B', 'Z'); expect(store.undoDepth).toBe(1);
    undo(); expect(store.undoDepth).toBe(0); expect(store.redoDepth).toBe(1);
    const before = store.getSnapshot();
    move(id, target);
    expect(store.getSnapshot()).toBe(before);
    expect(store.undoDepth).toBe(0); expect(store.redoDepth).toBe(1);
    expect(captured.bar!.canUndo).toBe(false); expect(captured.bar!.canRedo).toBe(true);
    redo(); expect(store.undoDepth).toBe(1); expect(store.redoDepth).toBe(0);
    expect(captured.chart!.departments[1].children[0].children[0].children[0].children[0].level).toBe(5);
  });
  it('actual OrgChart onDragEnd guard rejects descendant/self before callback and allows legal upmove', () => {
    render(<App />);
    move('B', 'Z'); undo(); const before = store.getSnapshot();
    const drag = (source: Department, target: Department) => {
      act(() => captured.dnd!.onDragStart!({ active: { data: { current: { type: 'department', department: source } } } } as unknown as DragStartEvent));
      act(() => captured.dnd!.onDragEnd!({ over: { data: { current: { type: 'department', department: target } } } } as unknown as DragEndEvent));
    };
    const set = vi.spyOn(HistoryStore.prototype, 'set').mockClear();
    const a = before.departments[0], b = a.children[0], c = b.children[0];
    // The handler closure uses the original callback; Store.set is the observable mutation boundary.
    drag(a, c); drag(b, b); drag(before.departments[1], before.departments[1].children[0].children[0]);
    expect(set).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(before); expect(store.undoDepth).toBe(0); expect(store.redoDepth).toBe(1);
    drag(c, a); expect(set).toHaveBeenCalledTimes(1);
    expect(store.undoDepth).toBe(1); expect(store.redoDepth).toBe(0);
    expect(store.getSnapshot().departments[0].children.map(d => [d.id, d.level])).toEqual([['B', 2], ['C', 2]]);
  });
  it('legal deep/same-level/shallow/root moves use real undo/redo and save/reload', () => {
    const view = render(<App />);
    for (const [id, target] of [['B', 'Z'], ['B', 'A'], ['B', 'X'], ['C', 'A'], ['B', null]] as const) move(id, target);
    expect(store.undoDepth).toBe(5); const moved = structuredClone(store.getSnapshot().departments);
    undo(); expect(store.undoDepth).toBe(4); redo(); expect(store.undoDepth).toBe(5);
    expect(store.getSnapshot().departments).toEqual(moved);
    act(() => { vi.advanceTimersByTime(801); });
    expect(loadProject()!.scenarios[0].departments).toEqual(moved);
    view.unmount(); render(<App />); expect(captured.chart!.departments).toEqual(moved);
  });
});
