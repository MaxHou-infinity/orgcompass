// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { HealthPage } from './HealthDrawer';
import { DiagnosticReport } from './DiagnosticReport';
import { DEFAULT_HEALTH_THRESHOLDS, resetHealthThresholds } from '../utils/analytics';
import { createProject } from '../utils/project';

afterEach(() => { cleanup(); resetHealthThresholds(); });

const baseProps = {
  open: true,
  onClose: vi.fn(),
  departments: [],
  onClearFocus: vi.fn(),
  onFocusDept: vi.fn(),
  onUpdateHeadcount: vi.fn(),
  onExportReport: vi.fn(),
  currentScenarioName: '方案 A',
  scenarios: createProject('演示').scenarios,
  onOpenScenarioDiff: vi.fn(),
};

/**
 * v2.5.2 页面重构（用户评审确认）：
 * 1. 业务场景 / 企业阶段基准 / 组织优化建议 / 阈值面板全部从正文移除；
 * 2. 编制缺口前置到第二屏；
 * 3. 指标由卡片改为一张表；
 * 4. 建议只在导出报告里，页面留 AI 位。
 */
it('页面不再出现业务场景、企业阶段基准、组织优化建议与阈值面板', () => {
  render(<HealthPage {...baseProps} />);
  expect(screen.queryByRole('combobox', { name: '当前业务场景' })).toBeNull();
  expect(screen.queryByText('企业阶段基准')).toBeNull();
  expect(screen.queryByText('组织优化建议')).toBeNull();
  expect(screen.queryByText('阈值设置')).toBeNull();
  // 诊断基准入口仍在（页脚 + 指标区）
  expect(document.querySelector('[aria-label="诊断基准"]')).toBeTruthy();
});

it('编制缺口排在结构指标之前，事实带第一屏可见', () => {
  render(<HealthPage {...baseProps} />);
  const labels = [...document.querySelectorAll('section[aria-label]')].map((s) => s.getAttribute('aria-label'));
  expect(labels).toContain('关键事实');
  expect(labels).toContain('编制与缺口');
  expect(labels).toContain('结构指标');
  expect(labels.indexOf('关键事实')).toBeLessThan(labels.indexOf('编制与缺口'));
  expect(labels.indexOf('编制与缺口')).toBeLessThan(labels.indexOf('结构指标'));
});

it('事实带呈现实际、编制、缺口与成本，缺口带方向语义', () => {
  const departments = [{
    id: 'd', name: '总部', level: 1, expanded: true, children: [], headcount: 5, leaderId: 'm',
    employees: [{ id: 'm', employeeId: 'M', name: '经理', level: 'L3', cost: 3 }],
  }];
  render(<HealthPage {...baseProps} departments={departments} />);
  const band = screen.getByRole('region', { name: '关键事实' });
  expect(band.textContent).toContain('实际人数');
  expect(band.textContent).toContain('编制');
  expect(band.textContent).toContain('缺口');
  expect(band.textContent).toContain('+4');
  expect(band.textContent).toContain('空岗');
  expect(band.textContent).toContain('月成本');
});

it('诊断基准三档互斥：选择成熟期按档位应用阈值', () => {
  const change = vi.fn();
  render(<HealthPage {...baseProps} healthThresholds={DEFAULT_HEALTH_THRESHOLDS} onHealthThresholdsChange={change} />);
  fireEvent.click(screen.getAllByRole('button', { name: /调整基准/ })[0]);
  const dialog = screen.getByRole('dialog', { name: '诊断基准' });
  expect(within(dialog).getByText('初创期')).toBeTruthy();
  expect(within(dialog).getByText('成长期')).toBeTruthy();
  expect(within(dialog).getByText('成熟期')).toBeTruthy();
  fireEvent.click(within(dialog).getByText('成熟期'));
  expect(change).toHaveBeenCalled();
  const next = change.mock.calls.at(-1)![0];
  expect(next.managementStage).toBe('mature');
  expect(next.chainHealthyMax).toBe(5);
  expect(next.vacancyHealthyMax).toBe(8);
});

it('指标改为表格：异常行带判读灯与「对照基准」，不再出现结论句', () => {
  render(<HealthPage {...baseProps} />);
  const section = screen.getByRole('region', { name: '结构指标' });
  expect(within(section).getByText('管理幅度')).toBeTruthy();
  expect(within(section).getByText('基准区间')).toBeTruthy();
  expect(within(section).getByText('灯号仅表示与当前基准的偏离，不构成建议')).toBeTruthy();
  expect(within(section).queryByText(/建议合并相邻小团队/)).toBeNull();
});

it('页面保留 AI 分析位，建议只出现在诊断报告里', () => {
  render(<HealthPage {...baseProps} />);
  expect(screen.getByRole('region', { name: 'AI 深度分析' })).toBeTruthy();
  cleanup();
  render(<DiagnosticReport open departments={[]} levelConfigs={[]} onClose={vi.fn()} onToast={vi.fn()} projectName="项目" scenarioName="场景" />);
  expect(screen.getByText('组织优化建议')).toBeTruthy();
  expect(screen.getByText(/对照基准：【成长期】/, { exact: false })).toBeTruthy();
});
