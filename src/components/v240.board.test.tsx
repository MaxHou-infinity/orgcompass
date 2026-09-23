// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { PositionBoardPage } from './PositionBoardPage';
import { DEFAULT_LEVELS } from '../utils/levels';
import type { Department, Employee, Position, Scenario } from '../types';

/**
 * V2.4.0「岗位与编制」页面级子界面。
 *
 * 合并了原「岗位操作」弹窗与「缺口清单」弹窗（两者本来是同一份数据的两种看法：
 * 一个只读、一个写入，分开会出现「在 A 看、去 B 改」）。本文件锁住用户明确提出的五件事：
 *  ① 看到组织内**所有**岗位；② 人数标记清晰且编制可就地改；
 *  ③ 新增 / 编辑 / 删除岗位；④ 套岗（候选人要能看出现在在哪）；
 *  ⑤ 删除岗位后「无明确岗位」员工**持续可见**（不是一次性 toast）；
 *  ⑥ 一个岗位名对应多个部门时的两种看法（按部门 / 按岗位聚合）。
 */

afterEach(cleanup);

const T = '2026-09-01T00:00:00.000Z';
const pos = (id: string, deptId: string, name: string, headcount = 0, extra: Partial<Position> = {}): Position =>
  ({ id, departmentId: deptId, name, headcount, status: 'active', createdAt: T, updatedAt: T, ...extra });
const emp = (id: string, name: string, positionId?: string, extra: Partial<Employee> = {}): Employee =>
  ({ id, name, employeeId: `E${id}`, level: 'L1.1', positionId, ...extra });

/** 两个部门 + 一个跨部门同名岗位（真实数据里就有这种形态：15 个实体只有 13 个名字） */
function fixture(departments: Department[], employees: Employee[]) {
  const scenario = { id: 's1', name: '基线', departments, allEmployeesFlat: employees, levelConfigs: DEFAULT_LEVELS,
    positions: [], assessments: [], positionAssignments: [], competencyModel: { dimensions: [] } } as unknown as Scenario;
  const handlers = {
    onBack: vi.fn(), onSetPositionHeadcount: vi.fn(), onCreatePosition: vi.fn(),
    onUpdatePosition: vi.fn(), onArchivePosition: vi.fn(), onAssignEmployee: vi.fn(), onToast: vi.fn(),
  };
  render(
    <PositionBoardPage
      projectName="测试项目" scenario={scenario}
      departments={departments} allEmployees={employees}
      assessments={[]} competencyModel={{ dimensions: [] }} positionAssignments={[]}
      levelConfigs={DEFAULT_LEVELS} positionSummaries={[]}
      onLocateDept={vi.fn()} {...handlers}
    />,
  );
  return handlers;
}

const twoDepts = (): { departments: Department[]; employees: Employee[] } => {
  const employees = [emp('e1', '张三', 'p1'), emp('e2', '李四'), emp('e3', '王五', 'p3')];
  const departments: Department[] = [
    { id: 'd1', name: '技术部', level: 1, expanded: true, children: [], employees: [employees[0], employees[1]],
      positions: [pos('p1', 'd1', '前端工程师', 2), pos('p2', 'd1', '后端工程师', 1)] },
    { id: 'd2', name: '市场部', level: 1, expanded: true, children: [], employees: [employees[2]],
      positions: [pos('p3', 'd2', '前端工程师', 1), pos('p4', 'd2', '市场专员', 0)] },
  ];
  return { departments, employees };
};

const page = () => document.querySelector('[data-page="position-board"]') as HTMLElement;

describe('V2.4.0 岗位与编制：列出全部岗位与人数', () => {
  it('列出范围内所有岗位（含空岗位），并给出编制/在岗/缺口三列', () => {
    const { departments, employees } = twoDepts();
    fixture(departments, employees);
    for (const name of ['前端工程师', '后端工程师', '市场专员']) {
      expect(within(page()).getAllByText(name).length).toBeGreaterThan(0);
    }
    expect(page().querySelectorAll('[data-position-row]')).toHaveLength(4);
    expect(within(page()).getByText('在岗')).toBeTruthy();
    expect(within(page()).getByText('缺口')).toBeTruthy();
  });

  it('汇总条给出岗位/编制/在岗/待补/超额/未配置', () => {
    const { departments, employees } = twoDepts();
    fixture(departments, employees);
    const txt = page().textContent!;
    expect(txt).toContain('编制合计');
    expect(txt).toContain('在岗合计');
    expect(txt).toContain('待补人数');
    expect(txt).toContain('未配置编制');
  });

  it('每行显示在岗人员姓名（用户要知道"这个岗位现在是谁"）', () => {
    const { departments, employees } = twoDepts();
    fixture(departments, employees);
    const row = page().querySelector('[data-position-row="p1"]') as HTMLElement;
    expect(row.textContent).toContain('张三');
  });

  it('缺岗/超编按编制与在岗算出（前端工程师 d1：编制 2 / 在岗 1 → 缺 1）', () => {
    const { departments, employees } = twoDepts();
    fixture(departments, employees);
    expect((page().querySelector('[data-position-row="p1"]') as HTMLElement).textContent).toContain('缺 1');
    // 编制 0 → 未配编制，不判超编
    expect((page().querySelector('[data-position-row="p4"]') as HTMLElement).textContent).toContain('未配编制');
  });
});

describe('V2.4.0 编制可就地编辑', () => {
  it('改编制调用写入回调（并带上部门与岗位 id）', () => {
    const { departments, employees } = twoDepts();
    const h = fixture(departments, employees);
    const input = page().querySelector('[data-position-row="p2"] input[type="number"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '5' } });
    expect(h.onSetPositionHeadcount).toHaveBeenCalledWith('d1', 'p2', 5);
  });
});

describe('V2.4.0 新增 / 编辑 / 删除岗位', () => {
  it('新增岗位：必须选目标部门 + 填名称，提交带上完整字段', () => {
    const { departments, employees } = twoDepts();
    const h = fixture(departments, employees);
    fireEvent.click(within(page()).getByRole('button', { name: /新增岗位/ }));
    const row = page().querySelector('[data-create-position-row]') as HTMLElement;
    expect(row).toBeTruthy();
    fireEvent.change(within(row).getByLabelText('新岗位目标部门'), { target: { value: 'd2' } });
    fireEvent.change(within(row).getByLabelText('新岗位名称'), { target: { value: '品牌经理' } });
    fireEvent.change(within(row).getByLabelText('新岗位编制'), { target: { value: '2' } });
    fireEvent.click(within(row).getByRole('button', { name: '创建' }));
    expect(h.onCreatePosition).toHaveBeenCalledWith('d2', expect.objectContaining({ name: '品牌经理', headcount: 2 }));
  });

  it('名称为空时「创建」不可点（不允许建无名岗位）', () => {
    const { departments, employees } = twoDepts();
    fixture(departments, employees);
    fireEvent.click(within(page()).getByRole('button', { name: /新增岗位/ }));
    const row = page().querySelector('[data-create-position-row]') as HTMLElement;
    expect((within(row).getByRole('button', { name: '创建' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('编辑岗位：行内展开表单，保存带上名称/序列/带宽', () => {
    const { departments, employees } = twoDepts();
    const h = fixture(departments, employees);
    const row = page().querySelector('[data-position-row="p2"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: '编辑' }));
    const edit = page().querySelector('[data-edit-position-row="p2"]') as HTMLElement;
    fireEvent.change(within(edit).getByLabelText('编辑岗位名称'), { target: { value: '后端高级工程师' } });
    fireEvent.click(within(edit).getByRole('button', { name: '保存' }));
    expect(h.onUpdatePosition).toHaveBeenCalledWith('d1', 'p2', expect.objectContaining({ name: '后端高级工程师' }));
  });

  it('删除岗位：入口存在且调用归档回调（影响确认由 App 统一负责）', () => {
    const { departments, employees } = twoDepts();
    const h = fixture(departments, employees);
    const row = page().querySelector('[data-position-row="p2"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: '删除' }));
    expect(h.onArchivePosition).toHaveBeenCalledWith('d1', 'p2');
  });
});

describe('V2.4.0 套岗：候选人要能看出现在在哪', () => {
  it('展开候选人面板，每人显示「现属 部门 › 岗位」', () => {
    const { departments, employees } = twoDepts();
    fixture(departments, employees);
    const row = page().querySelector('[data-position-row="p2"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: '套岗' }));
    const panel = page().querySelector('[data-assign-row="p2"]') as HTMLElement;
    expect(panel).toBeTruthy();
    const cand = panel.querySelector('[data-candidate="e3"]') as HTMLElement;
    expect(cand.textContent).toContain('王五');
    expect(cand.textContent).toContain('市场部'); // 现属部门
    expect(cand.textContent).toContain('前端工程师'); // 现属岗位
  });

  it('选中候选人触发套岗回调', () => {
    const { departments, employees } = twoDepts();
    const h = fixture(departments, employees);
    const row = page().querySelector('[data-position-row="p2"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: '套岗' }));
    const panel = page().querySelector('[data-assign-row="p2"]') as HTMLElement;
    fireEvent.click(panel.querySelector('[data-candidate="e1"]') as HTMLElement);
    expect(h.onAssignEmployee).toHaveBeenCalledWith('e1', 'p2');
  });

  it('已在本岗位的人不出现在候选人里（避免无意义的"再套一次"）', () => {
    const { departments, employees } = twoDepts();
    fixture(departments, employees);
    const row = page().querySelector('[data-position-row="p1"]') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: '套岗' }));
    const panel = page().querySelector('[data-assign-row="p1"]') as HTMLElement;
    expect(panel.querySelector('[data-candidate="e1"]')).toBeNull(); // 张三已在此岗位
  });
});

describe('V2.4.0 删除岗位后的「无明确岗位」持续提示', () => {
  it('岗位被删除（归档）后，挂靠的人以常驻提示位列出（不是一次性 toast）', () => {
    const employees = [emp('e1', '张三', 'gone'), emp('e2', '李四')];
    const departments: Department[] = [
      { id: 'd1', name: '技术部', level: 1, expanded: true, children: [], employees,
        positions: [pos('p9', 'd1', '在岗岗位', 1)] },
    ];
    fixture(departments, employees);
    const banner = document.querySelector('[data-positionless-banner]') as HTMLElement;
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('2 名员工处于无明确岗位状态');
    expect(banner.textContent).toContain('张三'); // 岗位已删除
    expect(banner.textContent).toContain('李四'); // 从未套岗
    expect(banner.textContent).toContain('岗位已删除');
    expect(banner.textContent).toContain('未套岗');
  });

  it('全员都有有效岗位时不出现该提示（正常组织零噪音）', () => {
    const employees = [emp('e1', '张三', 'p1')];
    const departments: Department[] = [
      { id: 'd1', name: '技术部', level: 1, expanded: true, children: [], employees,
        positions: [pos('p1', 'd1', '前端工程师', 1)] },
    ];
    fixture(departments, employees);
    expect(document.querySelector('[data-positionless-banner]')).toBeNull();
  });
});

describe('V2.4.0 一个岗位名对应多个部门（双视图）', () => {
  const crossDept = () => twoDepts(); // 「前端工程师」在 d1 与 d2 各有一个实体

  it('按部门视图：一行 = 一个岗位实体（同名也分两行，靠部门分组区分）', () => {
    const { departments, employees } = crossDept();
    fixture(departments, employees);
    expect(page().querySelectorAll('[data-position-row]')).toHaveLength(4);
    expect(within(page()).getAllByText('前端工程师')).toHaveLength(2);
  });

  it('按岗位视图：同名跨部门**合并成一行**并标注「分布在 N 个部门」', () => {
    const { departments, employees } = crossDept();
    fixture(departments, employees);
    fireEvent.click(within(page()).getByRole('button', { name: '按岗位' }));
    const nameRows = page().querySelectorAll('[data-position-name-row]');
    expect(nameRows).toHaveLength(3); // 前端工程师（合并）+ 后端工程师 + 市场专员
    const merged = page().querySelector('[data-position-name-row="前端工程师"]') as HTMLElement;
    expect(merged.textContent).toContain('分布在 2 个部门');
    // 聚合行给出合计口径
    expect(merged.textContent).toContain('合计 2 个岗位实体');
    expect(merged.textContent).toContain('1'); // 在岗合计（张三在 d1 前端）
  });

  it('按岗位视图：展开后能看到各部门明细行（各自的编制与在岗）', () => {
    const { departments, employees } = crossDept();
    fixture(departments, employees);
    fireEvent.click(within(page()).getByRole('button', { name: '按岗位' }));
    const merged = page().querySelector('[data-position-name-row="前端工程师"]') as HTMLElement;
    fireEvent.click(within(merged).getByRole('button', { name: /前端工程师/ }));
    const subs = page().querySelectorAll('[data-subrow]');
    expect(subs).toHaveLength(2);
    expect(page().textContent).toContain('技术部');
    expect(page().textContent).toContain('市场部');
  });

  it('单部门岗位不显示「分布」标签（避免噪音）', () => {
    const { departments, employees } = crossDept();
    fixture(departments, employees);
    fireEvent.click(within(page()).getByRole('button', { name: '按岗位' }));
    const only = page().querySelector('[data-position-name-row="市场专员"]') as HTMLElement;
    expect(only.textContent).not.toContain('分布在');
  });
});

describe('V2.4.0 筛选与返回', () => {
  it('按「未配置编制」筛选只留编制 0 的岗位', () => {
    const { departments, employees } = twoDepts();
    fixture(departments, employees);
    fireEvent.click(within(page()).getByRole('button', { name: '未配置编制' }));
    expect(page().querySelectorAll('[data-position-row]')).toHaveLength(1);
    expect(page().querySelector('[data-position-row="p4"]')).toBeTruthy();
  });

  it('「返回画布」调用返回回调', () => {
    const { departments, employees } = twoDepts();
    const h = fixture(departments, employees);
    fireEvent.click(within(page()).getByRole('button', { name: /返回画布/ }));
    expect(h.onBack).toHaveBeenCalled();
  });

  it('范围内没有岗位时给出可行动的空白态', () => {
    fixture([{ id: 'd1', name: '空部门', level: 1, expanded: true, children: [], employees: [], positions: [] }], []);
    expect(page().textContent).toContain('还没有岗位');
  });
});
