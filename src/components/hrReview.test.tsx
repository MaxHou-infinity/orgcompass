import { DEFAULT_MANAGEMENT_RANGES } from '../utils/managementBenchmarks';
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { HealthPage } from './HealthDrawer';
import { DiagnosticReport } from './DiagnosticReport';
import { OrganizationCostSummary } from './OrganizationCostSummary';
import { computeHealthReport, DEFAULT_HEALTH_THRESHOLDS, resetHealthThresholds, setHealthThresholds } from '../utils/analytics';
import { INDUSTRY_TEMPLATES, loadIndustryTemplate } from '../utils/industryTemplates';
import { createProject } from '../utils/project';

afterEach(() => { cleanup(); resetHealthThresholds(); vi.unstubAllGlobals(); });

it('健康度页面将缺失数据呈现为灰色，另列完整度且不报四项黄灯', () => {
  render(<HealthPage open onClose={vi.fn()} departments={[]} onClearFocus={vi.fn()} onFocusDept={vi.fn()}
    onUpdateHeadcount={vi.fn()} onExportReport={vi.fn()} currentScenarioName="空场景"
    scenarios={createProject('演示').scenarios} onOpenScenarioDiff={vi.fn()} />);
  expect(screen.getByRole('region', { name: '数据完整度' }).textContent).toContain('可计算指标 0/7');
  expect(screen.getByText('未判定 6')).toBeTruthy();
  expect(screen.getByText('黄 0')).toBeTruthy();
  expect(screen.getByText('整体暂不判定')).toBeTruthy();
});

it('小样本保留 50% 数值，但不显示为管理者比预警或健康结论', () => {
  const departments = [{ id: 'small', name: '小团队', level: 1, expanded: true, children: [], headcount: 2,
    leaderId: 'manager', employees: [
      { id: 'manager', employeeId: 'M', name: '经理', level: 'L4' },
      { id: 'worker', employeeId: 'W', name: '员工', level: 'L2' },
    ] }];
  render(<HealthPage open onClose={vi.fn()} departments={departments} onClearFocus={vi.fn()} onFocusDept={vi.fn()}
    onUpdateHeadcount={vi.fn()} onExportReport={vi.fn()} currentScenarioName="小样本"
    scenarios={createProject('演示').scenarios} onOpenScenarioDiff={vi.fn()} />);
  expect(screen.getAllByText('50%').length).toBeGreaterThan(0);
  expect(screen.getAllByText(/仅展示数值/).length).toBeGreaterThan(0);
  expect(screen.getByText('红 0')).toBeTruthy();
  expect(screen.getByText('未判定 5')).toBeTruthy();
  expect(screen.queryByText(/管理者占比合理/)).toBeNull();
});

it('诊断报告消费相同的无数据和完整度结果', () => {
  render(<DiagnosticReport open onClose={vi.fn()} departments={[]} levelConfigs={[]}
    projectName="演示" scenarioName="空场景" onToast={vi.fn()} />);
  expect(screen.getAllByText('暂不判定').length).toBeGreaterThan(0);
  expect(screen.getByRole('region', { name: '数据完整度' }).textContent).toContain('可计算指标 0/7');
  expect(screen.getByText('红0 黄0 绿0 · 未判定6')).toBeTruthy();
});

it('成本缺失在页面和报告共用组件中可见，不能呈现虚假的管理成本占比', () => {
  const report = computeHealthReport([{ id: 'd', name: '演示', level: 1, expanded: true, children: [],
    leaderId: 'm', employees: [
      { id: 'm', employeeId: 'M', name: '经理', level: 'L5', cost: 8 },
      { id: 'w', employeeId: 'W', name: '员工', level: 'L2' },
    ] }], []);
  render(<OrganizationCostSummary data={report.costBreakdown} />);
  const region = screen.getByRole('region', { name: '层级与管理者成本' });
  expect(region.textContent).toContain('另有 1 人缺少成本依据');
  expect(region.textContent).toContain('暂不计算管理者成本占比');
  expect(within(region).getByText(/管理者成本占比 —/)).toBeTruthy();
});

it('报告在关闭期间修改阈值，再打开时指标与建议使用同一份最新配置', () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  const { departments } = loadIndustryTemplate(INDUSTRY_TEMPLATES[0]);
  const props = { departments, levelConfigs: [], onClose: vi.fn(), projectName: '演示', scenarioName: '场景', onToast: vi.fn() };
  const { rerender } = render(<DiagnosticReport {...props} open={false} />);
  const ranges = structuredClone(DEFAULT_MANAGEMENT_RANGES);
  ranges.growth.knowledge = { min: 2, max: 4, warnMin: 1, warnMax: 6 };
  setHealthThresholds({ ...DEFAULT_HEALTH_THRESHOLDS, managementRanges: ranges });
  rerender(<DiagnosticReport {...props} open />);
  expect(screen.getAllByText('预警').length).toBeGreaterThan(0);
  expect(screen.getByLabelText('按管理类型的幅度').textContent).toContain('2–4');
});
