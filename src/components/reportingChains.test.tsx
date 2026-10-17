// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ReportingChainsPanel } from './ReportingChainsPanel';
import { computeReportingChains } from '../utils/reportingChains';
it('分布、倒挂与最长链可见，点击人员发出定位请求', () => {
  const data = computeReportingChains([{ id: 'd', name: '部门', level: 1, expanded: true, leaderId: 'm', children: [], employees: [
    { id: 'm', employeeId: 'M', name: '上级', level: 'P9' }, { id: 'w', employeeId: 'W', name: '下级', level: 'P10', reportsToEmployeeId: 'm' },
  ] }], [{ code: 'P', number: '9', label: '', color: '#000000' }, { code: 'P', number: '10', label: '', color: '#000000' }]);
  const focus = vi.fn();
  render(<ReportingChainsPanel data={data} onFocusEmployee={focus} />);
  expect(screen.getByRole('img', { name: '汇报链长度分布柱状图' })).toBeTruthy();
  expect(screen.getByText(/倒挂：/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '下级' }));
  expect(focus).toHaveBeenCalledWith('w', 'd');
});
