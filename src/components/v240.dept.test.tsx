// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from '../App';
import { createProject, loadProject, PROJECT_STORAGE_KEY } from '../utils/project';
import type { Department, Employee } from '../types';

/**
 * V2.4.0 部门增删的界面行为（用户实测反馈）。
 *
 * 现象：从左侧「新建部门」建的部门**删不掉** —— 右键菜单只有「调整层级归属」。
 * 两条规则见 src/utils/v240.dept.test.ts；本文件守**界面到底给不给这条路**：
 *  ① 部门右键菜单里有「删除该部门」；
 *  ② 空部门 → 确认后真的从工作区消失；
 *  ③ 有员工的部门 → 弹出说明（列出是谁），且**不删除**；
 *  ④ 新建部门的「归属部门」下拉只列层级更浅的部门，切换层级会自动重置非法归属。
 */

const storage = new Map<string, string>();

const emp = (id: string, name: string): Employee => ({ id, name, employeeId: id, level: 'L1.1' });
const dept = (id: string, name: string, level: number, extra: Partial<Department> = {}): Department =>
  ({ id, name, level, expanded: true, children: [], employees: [], ...extra });

function seed(): void {
  const tree: Department[] = [
    dept('d1', '总部', 1, {
      children: [
        dept('d2', '研发中心', 2, { employees: [emp('e1', '张三')], children: [dept('d3', '后端组', 3)] }),
        dept('d4', '市场部', 2),
        dept('d5', '空部门', 2),
      ],
    }),
  ];
  const p = createProject('部门增删测试');
  Object.assign(p.scenarios[0], { departments: tree, allEmployeesFlat: [emp('e1', '张三')] });
  storage.set(PROJECT_STORAGE_KEY, JSON.stringify(p));
}

beforeEach(() => {
  storage.clear();
  storage.set('org-designer.onboarded', '1');
  storage.set('org-designer.display-hint', '1');
  seed();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.useFakeTimers();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const flush = () => { act(() => { vi.advanceTimersByTime(900); }); };
const save = () => { fireEvent.click(screen.getByRole('button', { name: '确认执行' })); flush(); };
const deptIds = () => {
  const out: string[] = [];
  const walk = (ds: Department[]) => { for (const d of ds) { out.push(d.id); walk(d.children); } };
  for (const s of loadProject()!.scenarios) walk(s.departments);
  return out;
};

/** 右键某个部门卡的表头，打开卡片菜单 */
function openDeptMenu(container: HTMLElement, deptId: string) {
  const card = container.querySelector(`[data-dept-id="${deptId}"]`) as HTMLElement;
  const header = card.querySelector('[data-dept-header]') as HTMLElement;
  fireEvent.contextMenu(header);
  return card;
}

describe('V2.4.0 部门右键菜单：删除入口', () => {
  it('菜单里有「删除该部门」（此前的缺陷：只有「调整层级归属」，部门建了就删不掉）', () => {
    const { container } = render(<App />);
    openDeptMenu(container, 'd5');
    expect(screen.getByRole('button', { name: /删除该部门/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /调整层级归属/ })).toBeTruthy();
  });

  it('空部门 → 先确认（说明不影响任何人员），确认后从工作区消失', () => {
    const { container } = render(<App />);
    openDeptMenu(container, 'd5');
    fireEvent.click(screen.getByRole('button', { name: /删除该部门/ }));
    const dialog = screen.getByRole('dialog', { name: '确认删除部门' });
    expect(dialog.textContent).toContain('空部门');
    expect(dialog.textContent).toContain('不影响任何人员');
    expect(deptIds()).toContain('d5');   // 确认前不动
    save();
    expect(deptIds()).not.toContain('d5');
  });

  it('取消则完全不改', () => {
    const { container } = render(<App />);
    openDeptMenu(container, 'd5');
    fireEvent.click(screen.getByRole('button', { name: /删除该部门/ }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '确认删除部门' })).getByRole('button', { name: '取消' }));
    flush();
    expect(deptIds()).toContain('d5');
  });

  it('仍有员工的部门 → 弹出说明（列出是谁）、要求先挪人，且**不删除**', () => {
    const { container } = render(<App />);
    openDeptMenu(container, 'd2');
    fireEvent.click(screen.getByRole('button', { name: /删除该部门/ }));
    const dialog = screen.getByRole('dialog', { name: /无法删除部门/ });
    expect(dialog.textContent).toContain('张三');
    expect(dialog.textContent).toContain('请先把他们挪到其他部门');
    expect(screen.queryByRole('dialog', { name: '确认删除部门' })).toBeNull();
    expect(deptIds()).toContain('d2');
  });

  it('还有子部门的部门 → 也拒绝（保护子树不被静默丢弃）', () => {
    const { container } = render(<App />);
    // 先把 d2 的员工挪走，只留子部门，验证"子部门"这条独立生效
    const p = loadProject()!;
    const sc = p.scenarios[0];
    const walk = (ds: Department[]): Department[] => ds.map((d) =>
      d.id === 'd2' ? { ...d, employees: [] } : { ...d, children: walk(d.children) });
    Object.assign(sc, { departments: walk(sc.departments), allEmployeesFlat: [] });
    storage.set(PROJECT_STORAGE_KEY, JSON.stringify(p));

    const { container: c2 } = render(<App />);
    openDeptMenu(c2, 'd2');
    fireEvent.click(screen.getByRole('button', { name: /删除该部门/ }));
    const dialog = screen.getByRole('dialog', { name: /无法删除部门/ });
    expect(dialog.textContent).toContain('子部门');
    expect(deptIds()).toContain('d2');
    void container;
  });
});

describe('V2.4.0 新建部门：归属只能选层级更浅的部门', () => {
  const openForm = () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /新建部门/ }));
  };
  const parentSelect = () => screen.getByRole('combobox', { name: '归属部门' }) as HTMLSelectElement;

  it('新建 L2：下拉只列 L1（同级 L2 与下级 L3 都不出现）', () => {
    openForm();
    fireEvent.change(screen.getByLabelText('部门层级'), { target: { value: '2' } });
    const values = Array.from(parentSelect().options).map((o) => o.value);
    expect(values).toContain('d1');       // L1 可归属
    expect(values).not.toContain('d2');   // 同级
    expect(values).not.toContain('d4');   // 同级
    expect(values).not.toContain('d3');   // 下级
    expect(values).toContain('root');     // 可以不指定
  });

  it('新建 L1：没有可归属的上级，只剩「暂不指定」', () => {
    openForm();
    const values = Array.from(parentSelect().options).map((o) => o.value);
    expect(values).toEqual(['root']);
    const hint = document.querySelector('[data-dept-parent-hint]') as HTMLElement;
    expect(hint.textContent).toContain('一级部门没有上级');
  });

  /**
   * 说明：逻辑层（App.handleCreateDepartment → validateParent）还有第二道防线，
   * 但它**从界面走不到** —— 下拉里根本没有非法选项（下面的断言证明了这一点），
   * DOM 对 `<select>` 的未知值也会直接拒绝赋值，所以无法从组件测试触发。
   * 该防线的正确性由 src/utils/v240.dept.test.ts 的 validateParent 用例覆盖；
   * 这里守的是"界面上根本选不到同级/下级"。
   */
  it('L1 的归属下拉里不存在任何 L2/L3 选项（同级下级从界面上就选不到）', () => {
    openForm();
    fireEvent.change(screen.getByLabelText('部门层级'), { target: { value: '1' } });
    const values = Array.from(parentSelect().options).map((o) => o.value);
    for (const illegal of ['d2', 'd3', 'd4']) {
      expect(values).not.toContain(illegal);
    }
  });

  it('合法归属（L2 挂 L1）→ 建出来并挂到父部门下', () => {
    openForm();
    fireEvent.change(screen.getByLabelText('部门层级'), { target: { value: '2' } });
    fireEvent.change(parentSelect(), { target: { value: 'd1' } });
    fireEvent.change(screen.getByLabelText('部门名称'), { target: { value: '新事业部' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    flush();
    const roots = loadProject()!.scenarios[0].departments;
    const created = roots[0].children.find((d) => d.name === '新事业部');
    expect(created).toBeTruthy();
  });

  it('切换层级后，原归属若变成同级/下级 → 自动退回「暂不指定」', () => {
    openForm();
    fireEvent.change(screen.getByLabelText('部门层级'), { target: { value: '2' } });
    fireEvent.change(parentSelect(), { target: { value: 'd1' } });   // L1 合法
    expect(parentSelect().value).toBe('d1');
    fireEvent.change(screen.getByLabelText('部门层级'), { target: { value: '6' } });
    expect(parentSelect().value).toBe('d1'); // L6 下 d1 仍合法
    fireEvent.change(screen.getByLabelText('部门层级'), { target: { value: '1' } });
    expect(parentSelect().value).toBe('root'); // L1 下任何父都不合法 → 退回
  });

  it('提示文案说明为什么选项变少（不得归属同级或下级）', () => {
    openForm();
    fireEvent.change(screen.getByLabelText('部门层级'), { target: { value: '3' } });
    const hint = document.querySelector('[data-dept-parent-hint]') as HTMLElement;
    expect(hint.textContent).toContain('只能归属层级更浅的部门');
    expect(hint.textContent).toContain('不得归属同级或下级部门');
  });
});
