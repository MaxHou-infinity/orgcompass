// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DepartmentCard } from './DepartmentCard';
import { computePositionSummary } from '../utils/analytics';
import { DEFAULT_LEVELS } from '../utils/levels';
import type { Department, Employee, Position } from '../types';

/**
 * V2.4.0：岗位行「调整编制时输入框左右跳动」的回归。
 *
 * 现象（用户实测）：把岗位编制从 0 调到 1 / 2 时，状态文字在
 * 「未配编制」(40px) ↔「缺 1」(17.8px) 之间变宽变窄，而右侧这一簇是右对齐（`ml-auto`）的，
 * 变化量全部转嫁到左侧 → **Chromium 实测编制输入框横向位移 22.2px**，点上下箭头调数字时框会左右跳。
 *
 * 修法：给簇内两块**会随内容变宽**的文字预留固定宽度（`w-11` + `shrink-0`），整簇宽度恒定。
 * jsdom 量不到像素，所以这里守的是「定宽」这个结构事实（同 v232.card 的防换行守卫思路）。
 */

afterEach(cleanup);

const position: Position = {
  id: 'p1', departmentId: 'd1', name: '行政专员 - Administrator',
  headcount: 0, status: 'active', createdAt: 't', updatedAt: 't',
};
const employee: Employee = {
  id: 'e1', name: '张三', employeeId: 'E001', level: 'L1.1', dept1: '技术部', positionId: 'p1',
};

/** 用指定编制渲染一张带 1 个在岗员工的部门卡（在岗=1，便于构造 满编/缺 N/未配编制 三态） */
function renderWithHeadcount(headcount: number) {
  const pos = { ...position, headcount };
  const dept: Department = {
    id: 'd1', name: '技术部', level: 1, expanded: true,
    children: [], employees: [employee], positions: [pos],
  };
  const { container } = render(
    <DepartmentCard
      department={dept}
      onToggleExpand={vi.fn()}
      onUpdateDepartment={vi.fn()}
      onUpdateLeader={vi.fn()}
      onUpdateLeaderType={vi.fn()}
      onDeleteEmployee={vi.fn()}
      onCreateVirtualFromEmployee={vi.fn()}
      onChangeDepartmentLevel={vi.fn()}
      onSetTargetLevel={vi.fn()}
      onMoveMultiple={vi.fn()}
      allDepartments={[dept]}
      allEmployees={[employee]}
      positionSummaries={computePositionSummary([pos], [employee], DEFAULT_LEVELS)}
    />,
  );
  return container;
}

describe('V2.4.0 编制输入框不得随状态文案左右跳动', () => {
  it('状态文字定宽 + 右对齐（否则宽度变化会把输入框顶走）', () => {
    for (const [headcount, expected] of [[0, '未配编制'], [1, '满编'], [3, '缺 2'], [0, '未配编制']] as const) {
      const container = renderWithHeadcount(headcount);
      const status = screen.getByText(expected);
      expect(status.className).toContain('w-11'); // 按最长的「未配编制」留位
      expect(status.className).toContain('shrink-0');
      expect(status.className).toContain('text-right');
      void container;
      cleanup();
    }
  });

  it('「在岗 N」胶囊同样定宽（在岗 1 与在岗 11 不能挤走输入框）', () => {
    renderWithHeadcount(1);
    const chip = screen.getByText('在岗 1');
    expect(chip.className).toContain('w-11');
    expect(chip.className).toContain('shrink-0');
    expect(chip.className).toContain('text-center');
  });

  it('编制输入框自身定宽且不收缩（w-11 + shrink-0）', () => {
    renderWithHeadcount(1);
    const input = screen.getByLabelText(`${position.name} 编制`);
    expect(input.className).toContain('w-11');
    expect(input.className).toContain('shrink-0');
  });

  it('右侧数字簇整体不可压缩（被压缩时数字会被挤成竖排 —— v2.3.2 已修过一次）', () => {
    renderWithHeadcount(1);
    const input = screen.getByLabelText(`${position.name} 编制`);
    const cluster = input.parentElement as HTMLElement;
    expect(cluster.className).toContain('shrink-0');
    expect(cluster.className).toContain('whitespace-nowrap');
  });

  it('三种状态的数字都可读（未把状态藏起来换布局稳定）', () => {
    renderWithHeadcount(0);
    expect(screen.getByText('未配编制')).toBeTruthy();
    cleanup();
    renderWithHeadcount(1);
    expect(screen.getByText('满编')).toBeTruthy();
    cleanup();
    renderWithHeadcount(3);
    expect(screen.getByText('缺 2')).toBeTruthy();
  });
});
