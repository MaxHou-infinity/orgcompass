// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ReportingQuality } from './ReportingQuality';
import { DiagnosticReport } from './DiagnosticReport';
import { HealthPage } from './HealthDrawer';
import type { Department } from '../types';
import { computeHealthReport, DEFAULT_HEALTH_THRESHOLDS } from '../utils/analytics';

afterEach(cleanup);
const roots: Department[] = Array.from({ length: 5 }, (_, i) => ({
  id: `d${i}`, name: `部门${i}`, level: 1, expanded: true, leaderId: `p${i}-0`, children: [],
  employees: Array.from({ length: 20 }, (_, j) => ({ id: `p${i}-${j}`, employeeId: `E${i}-${j}`, name: `人员${i}-${j}`, level: 'L2',
    ...(i === 0 && j > 0 && j <= 10 ? { reportsToEmployeeId: 'missing' } : {}) })),
}));

it('完整度列出覆盖率、姓名、部门与原因，点击传递真实人员和部门 id', () => {
  const focus = vi.fn();
  render(<ReportingQuality data={computeHealthReport(roots, []).reporting} onFocusEmployee={focus} />);
  const region = screen.getByRole('region', { name: '汇报线覆盖率' });
  expect(region.textContent).toContain('90.0%');
  expect(within(region).getAllByText('引用不存在')).toHaveLength(10);
  fireEvent.click(within(region).getByRole('button', { name: '人员0-1' }));
  expect(focus).toHaveBeenCalledWith('p0-1', 'd0');
});

it('页面显示中档不完整角标，诊断报告显示同一覆盖率和排除清单', () => {
  const props = { open: true, departments: roots, onClose: vi.fn(), onClearFocus: vi.fn(), onFocusDept: vi.fn(),
    onUpdateHeadcount: vi.fn(), onExportReport: vi.fn(), currentScenarioName: '测试', scenarios: [], onOpenScenarioDiff: vi.fn(), healthThresholds: DEFAULT_HEALTH_THRESHOLDS };
  const { unmount } = render(<HealthPage {...props} />);
  expect(screen.getByText('⚠ 数据不完整')).toBeTruthy();
  expect(screen.getByRole('region', { name: '汇报线覆盖率' }).textContent).toContain('90.0%');
  unmount();
  render(<DiagnosticReport open departments={roots} levelConfigs={[]} onClose={vi.fn()} onToast={vi.fn()} projectName="项目" scenarioName="测试" healthThresholds={DEFAULT_HEALTH_THRESHOLDS} />);
  expect(screen.getByRole('region', { name: '汇报线覆盖率' }).textContent).toContain('人员0-1');
  expect(screen.getByRole('region', { name: '汇报线覆盖率' }).textContent).toContain('90.0%');
});
