// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { HealthPage } from './HealthDrawer';
import { DiagnosticReport } from './DiagnosticReport';
afterEach(cleanup);
it('页面发出项目级业务场景变更，报告开头写明当前解读场景', () => {
  const change = vi.fn();
  const { unmount } = render(<HealthPage open onClose={vi.fn()} departments={[]} onClearFocus={vi.fn()} onFocusDept={vi.fn()} onUpdateHeadcount={vi.fn()} onExportReport={vi.fn()} currentScenarioName="方案 A" scenarios={[]} onOpenScenarioDiff={vi.fn()} businessContext="normal" onBusinessContextChange={change} />);
  fireEvent.change(screen.getByRole('combobox', { name: '当前业务场景' }), { target: { value: 'efficiency' } });
  expect(change).toHaveBeenCalledWith('efficiency');
  unmount();
  render(<DiagnosticReport open onClose={vi.fn()} departments={[]} levelConfigs={[]} projectName="项目" scenarioName="方案 B" onToast={vi.fn()} businessContext="efficiency" />);
  expect(screen.getByText('本报告按【降本增效】场景解读')).toBeTruthy();
});
