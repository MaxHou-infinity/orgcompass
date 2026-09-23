// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PositionBoardPage } from './PositionBoardPage';
import {
  GAP_LIST_FILTER_LABEL,
  GAP_LIST_HIDDEN_FILTERS,
  gapListVisibleFilters,
  filterGapListRows,
  buildGapListRows,
  type GapListRow,
} from '../utils/gapList';
import { deriveBoard } from '../utils/boardScope';
import { createProject } from '../utils/project';

/**
 * V2.4.0：「编制冻结」筛选项从界面隐藏。
 *
 * 背景：`Position.status = 'frozen'` 全仓**没有任何写入点** ——
 * 唯一写 status 的动作是「归档岗位」，只写 `'archived'`；新建/导入建岗一律 `'active'`。
 * 所以这个筛选项对真实用户永远匹配 0 行（用户实测：15 个岗位全 active，筛「编制冻结」得 0/15），
 * 点进去只有空列表、也不解释为什么，属于误导性反馈。
 *
 * **本次只隐藏界面入口，不动数据层**：过滤函数、标签映射、汇总计数与导出列全部保留，
 * 待将来补上「冻结 / 解冻编制」的操作后再恢复。下面的用例把这两件事都锁住。
 */

afterEach(cleanup);

function scenarioWithPositions() {
  const t = '2026-09-01T00:00:00.000Z';
  const p = createProject('缺口清单测试');
  Object.assign(p.scenarios[0], {
    departments: [{
      id: 'd1', name: '技术部', level: 1, expanded: true, employees: [], children: [],
      positions: [
        { id: 'p1', departmentId: 'd1', name: '前端工程师', headcount: 3, status: 'active', createdAt: t, updatedAt: t },
        { id: 'p2', departmentId: 'd1', name: '后端工程师', headcount: 0, status: 'active', createdAt: t, updatedAt: t },
      ],
    }],
    allEmployeesFlat: [],
  });
  return p.scenarios[0];
}

describe('V2.4.0 缺口清单「编制冻结」筛选项隐藏', () => {
  it('界面提供的筛选项不含「编制冻结」，其余照常提供且顺序不变', () => {
    expect(gapListVisibleFilters()).not.toContain('frozen');
    expect(gapListVisibleFilters()).toEqual(['all', 'pending', 'overflow', 'unconfigured', 'balanced']);
    expect(GAP_LIST_HIDDEN_FILTERS.has('frozen')).toBe(true);
  });

  it('筛选项标签仍然存在（将来恢复时不用重建文案）', () => {
    expect(GAP_LIST_FILTER_LABEL.frozen).toBe('编制冻结');
  });

  it('数据层逻辑原样保留：frozen 过滤与标签映射仍可用（只是界面不暴露）', () => {
    // 只变一个字段，所以直接用具名参数构造，避免 Partial + 展开把可选性带进结果类型
    const rowAt = (headcountStatusLabel: GapListRow['headcountStatusLabel']): GapListRow => ({
      scenario: '基线', deptPath: '技术部', position: 'P', levelBand: '—', statusLabel: '正常',
      headcountStatusLabel, headcount: 1, primaryOccupied: 1, secondaryRelations: 0,
      pendingCount: 0, overflowCount: 0,
      costStatusLabel: '已估算', costBasis: '职级成本映射', unitCost: null, gapCost: null,
    });
    const rows = [rowAt('已配置'), rowAt('编制冻结'), rowAt('未配置编制')];
    expect(filterGapListRows(rows, 'frozen')).toHaveLength(1);
    expect(filterGapListRows(rows, 'unconfigured')).toHaveLength(1);
    expect(filterGapListRows(rows, 'all')).toHaveLength(3);
  });

  it('「岗位与编制」页面里不再渲染「编制冻结」按钮，其余筛选项仍在', () => {
    const scenario = scenarioWithPositions();
    // V2.4.0：缺口清单已并入页面级「岗位与编制」（不再是弹窗），筛选口径不变
    render(
      <PositionBoardPage
        onBack={vi.fn()} projectName="测试" scenario={scenario}
        departments={scenario.departments} allEmployees={scenario.allEmployeesFlat}
        assessments={[]} competencyModel={{ dimensions: [] }} positionAssignments={[]}
        levelConfigs={scenario.levelConfigs} positionSummaries={[]}
        onSetPositionHeadcount={vi.fn()} onCreatePosition={vi.fn()} onUpdatePosition={vi.fn()}
        onArchivePosition={vi.fn()} onAssignEmployee={vi.fn()} onToast={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: '编制冻结' })).toBeNull();
    for (const label of ['有待补', '有超额', '未配置编制', '真实满编']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
  });

  it('隐藏筛选项不影响清单本身：该场景仍如实产出「未配置编制」行', () => {
    const scenario = scenarioWithPositions();
    const board = deriveBoard({
      departments: scenario.departments,
      allEmployees: scenario.allEmployeesFlat,
      allPositions: scenario.positions ?? [],
      assessments: [], competencyModel: { dimensions: [] }, positionAssignments: [],
      levelConfigs: scenario.levelConfigs, competencySummaries: new Map(), matchStates: [],
      scopeDeptId: null, includeChildren: true,
    });
    const rows = buildGapListRows(board, scenario.name);
    expect(rows).toHaveLength(2);
    // 编制 0 的岗位归「未配置编制」，不会被误报成「编制冻结」
    expect(rows.filter((r) => r.headcountStatusLabel === '未配置编制')).toHaveLength(1);
    expect(rows.filter((r) => r.headcountStatusLabel === '编制冻结')).toHaveLength(0);
  });
});
