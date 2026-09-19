// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from '../App';
import { createProject, loadProject, PROJECT_STORAGE_KEY } from '../utils/project';
import { HistoryStore } from '../utils/history';
import { deriveBoard } from '../utils/boardScope';
import { DEFAULT_COMPETENCY_MODEL } from '../types';
import type { Department, Employee, PositionAssignment } from '../types';

/**
 * —— v2.3.1 复核留痕与反馈诚实性回归（审计报告 Q-19 / Q-20 / Q-03）——
 */

const storage = new Map<string, string>();
const t = '2026-09-01T00:00:00.000Z';

/**
 * 故意制造「名册岗位引用与画布冲突」：树内是 pa（有生效关系），名册写的是 pb。
 * 注意：不能只让名册「缺失」—— v2.3.1 F-09 会在载入时以树为准补齐缺失值，
 * 因此只有**真实冲突**（两边都有值但不一致）才会留下这种数据态，这也是 inspectPlacements 会报警的形态。
 */
function seedMismatch(): void {
  const treeEmp: Employee = { id: 'e', name: 'M2员工', employeeId: 'E01', level: 'L1', positionId: 'pa' };
  const tree: Department[] = [{
    id: 'a', name: '研发部', level: 1, employees: [treeEmp], leaderId: 'nobody', children: [], expanded: true,
    positions: [{ id: 'pa', departmentId: 'a', name: '岗位A', headcount: 2, status: 'active', createdAt: t, updatedAt: t }],
  }];
  const p = createProject('复核测试');
  Object.assign(p.scenarios[0], {
    departments: tree,
    // 名册与树冲突（已知可达的数据态，inspectPlacements 会报「画布与名册的岗位引用不一致」）
    allEmployeesFlat: [{ ...treeEmp, positionId: 'pb' }],

    positionAssignments: [{ id: 'rel', employeeId: 'e', positionId: 'pa', type: 'primary', status: 'active', source: 'legacy', createdAt: t, updatedAt: t }],
    assessments: [],
  });
  storage.set(PROJECT_STORAGE_KEY, JSON.stringify(p));
}

beforeEach(() => {
  storage.clear();
  storage.set('org-designer.onboarded', '1');
  storage.set('org-designer.display-hint', '1');
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  vi.useFakeTimers();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const save = () => {
  const raw = storage.get(PROJECT_STORAGE_KEY);
  if (raw) storage.set(PROJECT_STORAGE_KEY, raw);
};

describe('v2.3.1 Q-19：无法写入时必须说真话，不得假报成功', () => {
  it('前置条件不满足（无唯一在任主岗）→ 提示无法执行，且不写入任何确认记录', () => {
    seedMismatch();
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '胜任度' }));
    const drawer = screen.getByRole('dialog', { name: '胜任度看板' });
    fireEvent.click(within(drawer).getByRole('button', { name: /研发部\s*1 人/ }));
    fireEvent.click(within(drawer).getByTitle('展开员工'));
    fireEvent.click(within(drawer).getByRole('button', { name: '查看 M2员工 的胜任度详情' }));
    const detail = screen.getByRole('dialog', { name: /胜任度详情/ });

    fireEvent.change(within(detail).getByRole('textbox', { name: '复核人' }), { target: { value: '复核人A' } });
    fireEvent.change(within(detail).getByRole('textbox', { name: '确认依据说明' }), { target: { value: '依据' } });
    fireEvent.click(within(detail).getByRole('button', { name: '确认不胜任' }));

    // ← v2.3.0：这里会 toast「已确认不胜任（复核人：复核人A，留痕）」，而状态其实没变
    const toasts = screen.getAllByRole('status').map((el) => el.textContent ?? '').join(' | ');
    expect(toasts).toContain('无法执行');
    expect(toasts).not.toContain('已确认不胜任');
    save();
    const records = loadProject()!.scenarios[0].positionAssignments!;
    expect(records.some((a) => a.status === 'not_competent')).toBe(false);
  });
});

describe('v2.3.1 Q-20：Ctrl+Z 不得无痕抹掉人工复核留痕', () => {
  const snap = (records: PositionAssignment[]) => ({
    departments: [] as Department[],
    allEmployeesFlat: [] as Employee[],
    assessments: [],
    competencyModel: DEFAULT_COMPETENCY_MODEL,
    positionAssignments: records,
  });

  it('preserve 钩子把当前状态里的复核记录并回目标快照', () => {
    const review: PositionAssignment = {
      id: 'confirm',
      employeeId: 'e',
      positionId: 'pa',
      type: 'primary',
      status: 'not_competent',
      confirmedBy: '复核人A',
      confirmedAt: t,
      createdAt: t,
      updatedAt: t,
    };
    const preserve = (restored: ReturnType<typeof snap>, current: ReturnType<typeof snap>) => {
      const byId = new Map(restored.positionAssignments.map((a) => [a.id, a]));
      let added = false;
      for (const a of current.positionAssignments) {
        if (a.status !== 'not_competent' || byId.has(a.id)) continue;
        byId.set(a.id, a);
        added = true;
      }
      return added ? { ...restored, positionAssignments: [...byId.values()] } : restored;
    };
    // 场景：S0（无确认）→ 确认写入 S1 → 立刻 Ctrl+Z
    const store = new HistoryStore(snap([]), 10, preserve);
    store.set(snap([review]));
    store.undo();
    expect(store.getSnapshot().positionAssignments.some((a) => a.id === 'confirm')).toBe(true);
  });

  it('没有 preserve 钩子时确实会丢（说明该钩子是必要保护）', () => {
    const review: PositionAssignment = {
      id: 'confirm', employeeId: 'e', positionId: 'pa', type: 'primary', status: 'not_competent',
      confirmedBy: '复核人A', confirmedAt: t, createdAt: t, updatedAt: t,
    };
    const store = new HistoryStore(snap([]), 10);
    store.set(snap([review]));
    store.undo();
    expect(store.getSnapshot().positionAssignments.some((a) => a.id === 'confirm')).toBe(false);
  });
});

describe('v2.3.1 Q-03：看板派生不得因名册缺失而抛 TypeError', () => {
  it('画布里有员工但名册缺失时，deriveBoard 正常返回（成本走「无法估算」）', () => {
    // 树内有名册里没有的成员（名册丢失/不同步的一种真实数据态），
    // 该员工会进入岗位占用行，但按 id 在 allEmployees 里查不到。
    const ghost: Employee = { id: 'ghost', name: '幽灵', employeeId: 'E9', level: 'L1', positionId: 'p1' };
    const dept: Department = {
      id: 'd1', name: '研发部', level: 1, expanded: true, children: [], employees: [ghost],
      positions: [{ id: 'p1', departmentId: 'd1', name: '岗位1', headcount: 3, status: 'active', createdAt: t, updatedAt: t }],
    };
    const rows = deriveBoard({
      departments: [dept],
      allEmployees: [],
      assessments: [],
      competencyModel: DEFAULT_COMPETENCY_MODEL,
      positionAssignments: [],
      levelConfigs: [],
      competencySummaries: new Map(),
      matchStates: [],
      scopeDeptId: null,
      includeChildren: true,
    });
    expect(rows.positions).toHaveLength(1);
    expect(rows.positions[0].gapCost).toBeNull(); // ← v2.3.0 此处 `!` 断言抛 TypeError
  });
});
