// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from '../App';
import { VirtualAssignmentModal } from './VirtualAssignmentModal';
import { createProject, loadProject, PROJECT_STORAGE_KEY } from '../utils/project';
import { findDeptById } from '../utils/departments';
import type { Department, Employee } from '../types';

/**
 * V2.4.0：虚拟员工（兼岗）新流程。
 *
 * 旧实现的三个缺陷（用户实测 + 代码核对）：
 *  ① 入口挂在员工**现属部门**的右键菜单上 → 副本被加进同一部门 → 同一部门出现两次同一个人；
 *  ② `positionId: undefined` → 这条兼岗没有岗位（缺口清单里算未套岗，任何岗位的在岗数也不计它）；
 *  ③ 无任何确认/核对界面 → 创建完只有一句 toast。
 *
 * 新规则（用户确认）：目标部门 ≠ 现属部门；目标岗位必填且来自目标部门；目标部门没有岗位时可顺手新建。
 */

const storage = new Map<string, string>();
const T = '2026-09-01T00:00:00.000Z';

function pos(id: string, deptId: string, name: string, headcount = 0) {
  return { id, departmentId: deptId, name, headcount, status: 'active' as const, createdAt: T, updatedAt: T };
}

/** 技术部（张三 / 前端工程师） + 市场部（市场专员） + 空部门「新事业部」（无岗位，用于测"顺手新建"） */
function seed(): void {
  const zhangsan: Employee = { id: 'e1', name: '张三', employeeId: 'E001', level: 'L1.1', positionId: 'p1' };
  const lisi: Employee = { id: 'e2', name: '李四', employeeId: 'E002', level: 'L2.1', positionId: 'p2' };
  const tree: Department[] = [
    {
      id: 'd1', name: '技术部', level: 1, expanded: true, employees: [zhangsan], children: [],
      positions: [pos('p1', 'd1', '前端工程师', 2)],
    },
    {
      id: 'd2', name: '市场部', level: 1, expanded: true, employees: [lisi], children: [],
      positions: [pos('p2', 'd2', '市场专员', 1)],
    },
    { id: 'd3', name: '新事业部', level: 1, expanded: true, employees: [], children: [], positions: [] },
  ];
  const p = createProject('虚拟员工测试');
  Object.assign(p.scenarios[0], { departments: tree, allEmployeesFlat: [zhangsan, lisi] });
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

const save = () => { fireEvent.click(screen.getByRole('button', { name: '创建兼岗' })); };

function currentScenario() {
  const p = loadProject()!;
  return p.scenarios.find((s) => s.id === p.currentScenarioId)!;
}

/**
 * 打开某员工的右键菜单并点「创建虚拟员工（兼岗）」。
 * 注意三步前置条件（都在实现里）：① 成员列表默认收起，需先「展开全部」；
 * ② 右键菜单项只在员工**处于选中态**时渲染；③ 菜单走 createPortal 挂到 body。
 */
function openVirtualFlow(employeeName: string) {
  const { container } = render(<App />);
  for (const btn of Array.from(container.querySelectorAll('button'))) {
    if (btn.textContent?.trim() === '展开全部') fireEvent.click(btn);
  }
  const tags = Array.from(container.querySelectorAll('[data-emp-id]'));
  const tag = tags.find((el) => el.textContent?.includes(employeeName));
  expect(tag, `未找到员工 ${employeeName} 的卡片`).toBeTruthy();
  fireEvent.click(tag!);          // 选中
  fireEvent.contextMenu(tag!);    // 右键
  fireEvent.click(screen.getByRole('button', { name: '创建虚拟员工（兼岗）' }));
  return container;
}

describe('V2.4.0 虚拟员工：弹窗行为', () => {
  const baseProps = () => {
    const p = createProject('t');
    Object.assign(p.scenarios[0], {
      departments: [
        { id: 'd1', name: '技术部', level: 1, expanded: true, employees: [], children: [], positions: [pos('p1', 'd1', '前端工程师')] },
        { id: 'd2', name: '市场部', level: 1, expanded: true, employees: [], children: [], positions: [pos('p2', 'd2', '市场专员')] },
        { id: 'd3', name: '空部门', level: 1, expanded: true, employees: [], children: [], positions: [] },
      ],
    });
    return {
      open: true,
      onClose: vi.fn(),
      draft: { employeeId: 'e1', currentDeptId: 'd1' },
      departments: p.scenarios[0].departments,
      employees: [{ id: 'e1', name: '张三', employeeId: 'E001', level: 'L1.1', positionId: 'p1' } as Employee],
      onConfirm: vi.fn(),
    };
  };

  it('显示源员工与现属部门›岗位（让用户确认"这是在给谁建兼岗"）', () => {
    const props = baseProps();
    render(<VirtualAssignmentModal {...props} />);
    expect(screen.getByText('张三')).toBeTruthy();
    expect(screen.getByText(/现属：技术部 › 前端工程师/)).toBeTruthy();
  });

  it('目标部门下拉**排除**本人现属部门', () => {
    render(<VirtualAssignmentModal {...baseProps()} />);
    const select = screen.getByLabelText('目标部门') as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value);
    expect(values).not.toContain('d1'); // 技术部 = 现属部门
    expect(values).toContain('d2');
    expect(values).toContain('d3');
  });

  it('目标岗位必填：未选岗位时「创建兼岗」不可点', () => {
    render(<VirtualAssignmentModal {...baseProps()} />);
    expect((screen.getByRole('button', { name: '创建兼岗' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('目标部门没有岗位时可「顺手新建」，填了名称即可提交', () => {
    const props = baseProps();
    render(<VirtualAssignmentModal {...props} />);
    fireEvent.change(screen.getByLabelText('目标部门'), { target: { value: 'd3' } });
    expect(screen.getByText(/该部门还没有岗位/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /顺手新建一个/ }));
    fireEvent.change(screen.getByLabelText('新岗位名称'), { target: { value: '运营专员' } });
    expect((screen.getByRole('button', { name: '创建兼岗' }) as HTMLButtonElement).disabled).toBe(false);
    save();
    expect(props.onConfirm).toHaveBeenCalledWith({
      employeeId: 'e1', deptId: 'd3', newPosition: { name: '运营专员', headcount: undefined },
    });
  });

  it('选已有岗位提交时只带 positionId（不误建新岗位）', () => {
    const props = baseProps();
    render(<VirtualAssignmentModal {...props} />);
    fireEvent.change(screen.getByLabelText('目标部门'), { target: { value: 'd2' } });
    fireEvent.change(screen.getByLabelText('目标岗位'), { target: { value: 'p2' } });
    save();
    expect(props.onConfirm).toHaveBeenCalledWith({ employeeId: 'e1', deptId: 'd2', positionId: 'p2' });
  });

  it('切换目标部门会清空已选岗位（避免把 A 部门的岗位带到 B 部门）', () => {
    render(<VirtualAssignmentModal {...baseProps()} />);
    fireEvent.change(screen.getByLabelText('目标部门'), { target: { value: 'd2' } });
    fireEvent.change(screen.getByLabelText('目标岗位'), { target: { value: 'p2' } });
    fireEvent.change(screen.getByLabelText('目标部门'), { target: { value: 'd3' } });
    expect((screen.getByRole('button', { name: '创建兼岗' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('员工未入架构（无现属部门）时，所有部门都可选', () => {
    const props = baseProps();
    render(<VirtualAssignmentModal {...props} draft={{ employeeId: 'e1' }} />);
    const select = screen.getByLabelText('目标部门') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toContain('d1');
    expect(screen.queryByText(/已排除本人现属部门/)).toBeNull();
  });
});

describe('V2.4.0 虚拟员工：App 端到端', () => {
  it('右键 → 创建虚拟员工（兼岗）→ 选已有岗位 → 落到目标部门、绑定该岗位、回指本人', () => {
    openVirtualFlow('张三');
    const dialog = screen.getByRole('dialog', { name: '创建虚拟员工（兼岗）' });
    fireEvent.change(within(dialog).getByLabelText('目标部门'), { target: { value: 'd2' } });
    fireEvent.change(within(dialog).getByLabelText('目标岗位'), { target: { value: 'p2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建兼岗' }));
    fireEvent.click(document.querySelector('body')!); // 关闭动画/portal
    act(() => { vi.advanceTimersByTime(900); });

    const sc = currentScenario();
    const market = findDeptById(sc.departments, 'd2')!;
    const virtuals = market.employees.filter((e) => e.isVirtual);
    expect(virtuals).toHaveLength(1);
    expect(virtuals[0]).toMatchObject({ primaryEmployeeId: 'e1', positionId: 'p2', assignmentType: 'secondary' });
    // 原部门不重复出现同一个人
    const tech = findDeptById(sc.departments, 'd1')!;
    expect(tech.employees.filter((e) => e.primaryEmployeeId === 'e1')).toHaveLength(0);
    expect(tech.employees.map((e) => e.id)).toEqual(['e1']);
  });

  it('目标部门没有岗位时可顺手新建：岗位与兼岗副本在同一次变更里落地', () => {
    openVirtualFlow('张三');
    const dialog = screen.getByRole('dialog', { name: '创建虚拟员工（兼岗）' });
    fireEvent.change(within(dialog).getByLabelText('目标部门'), { target: { value: 'd3' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /顺手新建一个/ }));
    fireEvent.change(within(dialog).getByLabelText('新岗位名称'), { target: { value: '运营专员' } });
    fireEvent.change(within(dialog).getByLabelText('新岗位编制'), { target: { value: '2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建兼岗' }));
    act(() => { vi.advanceTimersByTime(900); });

    const newDept = findDeptById(currentScenario().departments, 'd3')!;
    expect(newDept.positions).toHaveLength(1);
    expect(newDept.positions![0]).toMatchObject({ name: '运营专员', headcount: 2, status: 'active' });
    const virtual = newDept.employees.find((e) => e.isVirtual)!;
    expect(virtual.positionId).toBe(newDept.positions![0].id);
  });

  it('硬护栏：即使 UI 传了现属部门，落地前也会被拒（同一部门不出现两次）', () => {
    openVirtualFlow('张三');
    const dialog = screen.getByRole('dialog', { name: '创建虚拟员工（兼岗）' });
    // 下拉里根本没有 d1（现属部门），这里直接确认"下拉项不含它"这一事实
    const values = Array.from((within(dialog).getByLabelText('目标部门') as HTMLSelectElement).options).map((o) => o.value);
    expect(values).not.toContain('d1');
    // 且落库后技术部仍只有 1 个「张三」
    expect(findDeptById(currentScenario().departments, 'd1')!.employees).toHaveLength(1);
  });

  it('「建虚拟兼岗」入口已从岗位界面消失（能力已迁移到虚拟员工流程）', async () => {
    const { container } = render(<App />);
    // V2.4.0：原「岗位操作」弹窗已并入页面级「岗位与编制」
    fireEvent.click(screen.getByRole('button', { name: '岗位与编制' }));
    const page = container.querySelector('[data-page="position-board"]') as HTMLElement;
    expect(page).toBeTruthy();
    expect(within(page).queryByRole('button', { name: '建虚拟兼岗' })).toBeNull();
    expect(within(page).getAllByRole('button', { name: '套岗' }).length).toBeGreaterThan(0);
  });
});
