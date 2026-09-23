// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { DepartmentCard } from './DepartmentCard';
import { OrgChart } from './OrgChart';
import { buildDepartmentTree } from '../utils/excel';
import { computeLevelGaps } from '../utils/deptLevel';
import type { Department, Employee } from '../types';

/**
 * v2.3.2 层级断档的**画布可见性**回归。
 *
 * 设计约定（用户确认）：断档是「父子跨级」的关系异常，所以
 * ① 连接线画成琥珀色虚线（不占布局空间，且缩放后仍易辨识）；
 * ② 部门卡头部给出「缺 L2」胶囊 + 可解释 tooltip（让用户知道为什么断、怎么修）；
 * ③ 诊断报告里有一条可行动建议（见 v232.import.test.ts）。
 * 本文件锁住 ①② 的渲染契约 —— 去掉任一信号都会失败。
 */

afterEach(cleanup);

/** 断档样例：一级部门「技术部」+ 三级部门「前端组」（二级留空） */
function gappedTree(): Department[] {
  const employees: Employee[] = [{
    id: 'e1', name: '张三', employeeId: 'E001', level: 'L2.1',
    dept1: '技术部', dept2: '', dept3: '前端组',
  }];
  return buildDepartmentTree(employees, []);
}

function chartProps(departments: Department[]) {
  return {
    departments,
    onToggleExpand: vi.fn(),
    onUpdateDepartment: vi.fn(),
    onUpdateLeader: vi.fn(),
    onUpdateLeaderType: vi.fn(),
    onMoveEmployee: vi.fn(),
    onMoveMultiple: vi.fn(),
    onMoveDepartment: vi.fn(),
    onChangeDepartmentLevel: vi.fn(),
    onDeleteEmployee: vi.fn(),
    onCreateVirtualFromEmployee: vi.fn(),
    onSetTargetLevel: vi.fn(),
    allEmployees: [],
    zoom: 100,
    canvasRef: createRef<HTMLDivElement>(),
    zoomContainerRef: createRef<HTMLDivElement>(),
    onZoomChange: vi.fn(),
    onDownloadTemplate: vi.fn(),
    onOpenSamplePicker: vi.fn(),
    onDeleteDepartment: vi.fn(),
  };
}

describe('v2.3.2 层级断档在画布上可见', () => {
  it('脱离真实种子的前置检查：样例确实是断档（否则本文件会变成假阳性）', () => {
    const gaps = computeLevelGaps(gappedTree());
    expect(gaps.size).toBe(1);
    expect([...gaps.values()][0].missingLevels).toEqual([2]);
  });

  it('部门卡：显示「缺 L2」胶囊，且 tooltip 解释原因与修法（不是只有一个无字图标）', () => {
    const tree = gappedTree();
    const gap = [...computeLevelGaps(tree).values()][0];
    render(<DepartmentCard department={tree[0].children[0]} levelGap={gap} {...{
      onToggleExpand: vi.fn(), onUpdateDepartment: vi.fn(), onUpdateLeader: vi.fn(),
      onUpdateLeaderType: vi.fn(), onDeleteEmployee: vi.fn(), onCreateVirtualFromEmployee: vi.fn(),
      onChangeDepartmentLevel: vi.fn(), onSetTargetLevel: vi.fn(), onMoveMultiple: vi.fn(),
      allDepartments: tree, allEmployees: [],
    }} />);

    const badge = screen.getByRole('status');
    expect(badge.textContent).toBe('缺 L2');
    // 可解释性：说明缺哪一级、当前挂在哪、以及怎么修
    const title = badge.getAttribute('title') ?? '';
    expect(title).toContain('前端组（L3）');
    expect(title).toContain('技术部（L1）');
    expect(title).toContain('缺少 L2 部门');
  });

  it('部门卡：无断档时不渲染任何异常标记（正常结构零噪音）', () => {
    const tree = buildDepartmentTree(
      [{ id: 'e1', name: '张三', employeeId: 'E001', level: 'L1.1', dept1: '技术部', dept2: '研发部' }], [],
    );
    render(<DepartmentCard department={tree[0]} {...{
      onToggleExpand: vi.fn(), onUpdateDepartment: vi.fn(), onUpdateLeader: vi.fn(),
      onUpdateLeaderType: vi.fn(), onDeleteEmployee: vi.fn(), onCreateVirtualFromEmployee: vi.fn(),
      onChangeDepartmentLevel: vi.fn(), onSetTargetLevel: vi.fn(), onMoveMultiple: vi.fn(),
      allDepartments: tree, allEmployees: [],
    }} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(document.querySelector('[data-level-gap]')).toBeNull();
  });

  it('画布：断档父子的连接线画成琥珀色虚线，其余连线仍是实线', () => {
    const tree = gappedTree();
    const { container } = render(<OrgChart {...chartProps(tree)} />);

    // 只在「连接线层」里断言，避免把图标 svg 的 path 混进来
    const connectors = container.querySelector('[data-org-connectors]');
    expect(connectors).not.toBeNull();
    const paths = Array.from(connectors!.querySelectorAll('path'));
    expect(paths.length).toBeGreaterThan(0);

    const dashed = paths.filter((p) => p.getAttribute('stroke-dasharray'));
    // 技术部 → 前端组 这一段（垂直段）必须存在且为虚线
    expect(dashed).toHaveLength(1);
    expect(dashed[0].getAttribute('stroke')).toBe('#F59E0B');

    // 主干与总线仍是实线（否则「全虚线」就失去了区分度）
    const solid = paths.filter((p) => !p.getAttribute('stroke-dasharray'));
    expect(solid.length).toBeGreaterThan(0);
    expect(solid.every((p) => p.getAttribute('stroke') === '#CBD5E1')).toBe(true);
  });

  it('画布：层级连续时没有任何虚线（不误报）', () => {
    const tree = buildDepartmentTree(
      [{ id: 'e1', name: '张三', employeeId: 'E001', level: 'L1.1', dept1: '技术部', dept2: '研发部' }], [],
    );
    const { container } = render(<OrgChart {...chartProps(tree)} />);
    const connectors = container.querySelector('[data-org-connectors]');
    expect(connectors).not.toBeNull();
    const paths = Array.from(connectors!.querySelectorAll('path'));
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.some((p) => p.getAttribute('stroke-dasharray'))).toBe(false);
  });
});

describe('v2.3.2 岗位文字：历史 NA 残渣在展示层按「未填」处理', () => {
  const props = (tree: Department[]) => ({
    onToggleExpand: vi.fn(), onUpdateDepartment: vi.fn(), onUpdateLeader: vi.fn(),
    onUpdateLeaderType: vi.fn(), onDeleteEmployee: vi.fn(), onCreateVirtualFromEmployee: vi.fn(),
    onChangeDepartmentLevel: vi.fn(), onSetTargetLevel: vi.fn(), onMoveMultiple: vi.fn(),
    allDepartments: tree, allEmployees: [],
    // 成员列表默认收起 → 不展开就看不到员工标签，断言会变成假阴性
    membersExpanded: true, onToggleMembers: vi.fn(),
  });

  it('员工卡：title="NA"（旧数据残留）不再渲染出 "NA"', () => {
    const employees: Employee[] = [
      { id: 'e1', name: '张三', employeeId: 'E001', level: 'L2.1', dept1: '技术部', title: 'NA' },
    ];
    const tree = buildDepartmentTree(employees, []);
    const { container } = render(<DepartmentCard department={tree[0]} {...props(tree)} />);
    expect(container.textContent).toContain('张三');
    expect(container.textContent).not.toContain('NA');
  });

  it('员工卡：真实岗位文字照常显示（不误伤）', () => {
    const employees: Employee[] = [
      { id: 'e1', name: '张三', employeeId: 'E001', level: 'L2.1', dept1: '技术部', title: '前端工程师' },
    ];
    const tree = buildDepartmentTree(employees, []);
    const { container } = render(<DepartmentCard department={tree[0]} {...props(tree)} />);
    expect(container.textContent).toContain('前端工程师');
  });
});
