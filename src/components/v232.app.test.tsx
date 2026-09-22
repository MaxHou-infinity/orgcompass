// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as XLSX from 'xlsx';
import App from '../App';
import { createProject, loadProject, PROJECT_STORAGE_KEY } from '../utils/project';
import type { Department, Employee } from '../types';

/**
 * v2.3.2 **App 入口**集成回归。
 *
 * 为什么纯函数测试不够：`inheritPositionSetup` / `mergeOrgTemplates` 单测全绿，
 * 但如果 `handleEmployeeFileUpload` 忘了调用它们，用户侧的「编制被清零」依然存在。
 * 本文件从真实文件上传入口走完整条链路（File → 解析 → 建树 → 补充层 → 继承 → 落库）。
 */

const storage = new Map<string, string>();
const t = '2026-09-01T00:00:00.000Z';

/** 造一份带岗位的员工名册 xlsx（与 seed 的部门路径/岗位名一致，才能验证「继承」） */
function rosterFile(): File {
  const ws = XLSX.utils.aoa_to_sheet([
    ['姓名', '工号', '职级', '岗位', '一级部门', '二级部门'],
    ['张三', 'E001', 'L2.1', '前端工程师', '技术部', '研发部'],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '员工信息');
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new File([bytes], '员工信息.xlsx');
}

/** 造一份组织架构模板 xlsx：含「无人的空部门」与「部门负责人」 */
function templateFile(): File {
  const ws = XLSX.utils.aoa_to_sheet([
    ['一级部门', '二级部门', '部门级别', '部门负责人工号', '部门负责人'],
    ['技术部', '测试部', '2', '', ''],
    ['人力资源部', '', '1', '', ''],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '组织架构');
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new File([bytes], '组织架构.xlsx');
}

/** 已有数据：技术部/研发部下有一名员工，岗位「前端工程师」编制 = 5 */
function seedWithHeadcount() {
  const e: Employee = {
    id: 'e', name: '张三', employeeId: 'E001', level: 'L2.1',
    dept1: '技术部', dept2: '研发部', positionId: 'p1',
  };
  const tree: Department[] = [{
    id: 'd1', name: '技术部', level: 1, expanded: true, employees: [], positions: [],
    children: [{
      id: 'd2', name: '研发部', level: 2, expanded: true, employees: [e], children: [],
      positions: [{ id: 'p1', departmentId: 'd2', name: '前端工程师', headcount: 5, status: 'active', createdAt: t, updatedAt: t }],
    }],
  }];
  const p = createProject('v232 集成');
  Object.assign(p.scenarios[0], { departments: tree, allEmployeesFlat: [e], positionAssignments: [], assessments: [] });
  storage.set(PROJECT_STORAGE_KEY, JSON.stringify(p));
  return p;
}

/** 按名称在整棵树里查找部门（不假设排序位置） */
function findDept(tree: Department[], name: string): Department | undefined {
  for (const d of tree) {
    if (d.name === name) return d;
    const hit = findDept(d.children, name);
    if (hit) return hit;
  }
  return undefined;
}

function fileInputs(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll('input[type="file"]'));
}

/** 触发上传并等待异步解析完成（多轮微任务 + 计时器） */
async function upload(input: HTMLInputElement, file: File) {
  await act(async () => {
    fireEvent.change(input, { target: { files: [file] } });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
  });
}

const save = () => act(() => vi.advanceTimersByTime(850));

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
  // 走 Blob.arrayBuffer() 分支，避免 jsdom FileReader 与假计时器互相等待
  vi.stubGlobal('FileReader', undefined);
  vi.useFakeTimers();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('v2.3.2 App 入口：重导入不清零编制', () => {
  it('重传员工表后，已配置的编制 5 仍在（回退 App 层继承调用即失败）', async () => {
    seedWithHeadcount();
    const { container } = render(<App />);

    await upload(fileInputs(container)[0], rosterFile());

    // 已有数据 → 走「保留原场景」确认对话框
    const dialog = screen.getByRole('dialog', { name: '确认导入到新场景' });
    fireEvent.click(within(dialog).getByRole('button', { name: '保留原场景并导入' }));
    save();

    const p = loadProject()!;
    const current = p.scenarios.find((s) => s.id === p.currentScenarioId)!;
    const 研发部 = findDept(current.departments, '研发部')!;
    expect(研发部.positions).toHaveLength(1);
    expect(研发部.positions![0].name).toBe('前端工程师');
    // 旧实现：重导入走 find-or-create 主路径 → headcount 恒为 0
    expect(研发部.positions![0].headcount).toBe(5);
    // 人在新场景里仍然被套到该岗位
    expect(current.allEmployeesFlat[0].positionId).toBe(研发部.positions![0].id);
  });
});

describe('v2.3.2 App 入口：组织架构模板 = 补充层', () => {
  it('上传模板补空部门与负责人，且不重建员工、不清零编制、写入 .orgproj', async () => {
    seedWithHeadcount();
    const { container } = render(<App />);

    await upload(fileInputs(container)[1], templateFile());

    const dialog = screen.getByRole('dialog', { name: '应用组织架构模板（补充层）' });
    // 影响先展示再应用（沿用「重导先展示影响」的既有原则）
    expect(dialog.textContent).toContain('新增空部门');
    expect(dialog.textContent).toContain('员工、岗位、编制、评分与任职记录均不受影响');
    fireEvent.click(within(dialog).getByRole('button', { name: '确认执行' }));
    save();

    const p = loadProject()!;
    const current = p.scenarios.find((s) => s.id === p.currentScenarioId)!;
    const names: string[] = [];
    const walk = (ds: Department[]) => { for (const d of ds) { names.push(d.name); walk(d.children); } };
    walk(current.departments);
    expect(names).toContain('测试部');      // 空部门被补上
    expect(names).toContain('人力资源部');
    expect(names).toContain('研发部');      // 员工表结构保留

    // 编制未被清零（旧实现走 importWorkspace 重建 → 归 0）
    const 研发部 = findDept(current.departments, '研发部')!;
    expect(研发部.positions![0].headcount).toBe(5);
    // 员工仍在（旧实现会把员工 positionId 清空后重建）
    expect(current.allEmployeesFlat[0].name).toBe('张三');
    expect(current.allEmployeesFlat[0].positionId).toBe('p1');
    // 补充层被持久化（旧实现只存内存，关掉应用即丢失）
    expect(p.orgTemplates?.length).toBe(2);
  });

  it('重传同一模板：先收回上一份的空部门，结果不叠加，且徽标反映真实补充层状态', async () => {
    seedWithHeadcount();
    const { container } = render(<App />);
    const inputs = fileInputs(container);

    await upload(inputs[1], templateFile());
    fireEvent.click(within(screen.getByRole('dialog', { name: '应用组织架构模板（补充层）' })).getByRole('button', { name: '确认执行' }));
    save();
    // 直接问「组织架构那一行的上传控件」——避免与画布/弹窗里的同名文案撞车
    const orgRow = fileInputs(container)[1].closest('label');
    expect(orgRow?.textContent).toContain('已载入');

    // 第二份模板不再包含「人力资源部」
    const ws = XLSX.utils.aoa_to_sheet([
      ['一级部门', '二级部门', '部门级别'],
      ['技术部', '测试部', '2'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '组织架构');
    const second = new File([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], '组织架构2.xlsx');

    await upload(fileInputs(container)[1], second);
    const dialog = screen.getByRole('dialog', { name: '应用组织架构模板（补充层）' });
    expect(dialog.textContent).toContain('收回上一份模板留下的空部门');
    fireEvent.click(within(dialog).getByRole('button', { name: '确认执行' }));
    save();

    const p = loadProject()!;
    const current = p.scenarios.find((s) => s.id === p.currentScenarioId)!;
    const names: string[] = [];
    const walk = (ds: Department[]) => { for (const d of ds) { names.push(d.name); walk(d.children); } };
    walk(current.departments);
    expect(names).toContain('测试部');
    expect(names).not.toContain('人力资源部');
    expect(p.orgTemplates).toHaveLength(1);
  });
});
