// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FunctionalSpanTable, ManagementSettings } from './FunctionalManagement';
import { computeFunctionalSpans } from '../utils/managementBenchmarks';
import { DEFAULT_HEALTH_THRESHOLDS } from '../utils/healthThresholds';
afterEach(cleanup);

it('按类型显示样本、区间和未判定；设置编辑发出完整阈值补丁', () => {
  render(<FunctionalSpanTable data={computeFunctionalSpans([])} />);
  const table = screen.getByLabelText('按管理类型的幅度');
  expect(table.textContent).toContain('操作型');
  expect(table.textContent).toContain('10–25');
  expect(table.textContent).toContain('暂不判定');
  cleanup();
  const change = vi.fn();
  render(<ManagementSettings thresholds={DEFAULT_HEALTH_THRESHOLDS} onChange={change} departments={[]} />);
  fireEvent.change(screen.getByLabelText('客服管理类型'), { target: { value: 'expert' } });
  expect(change.mock.calls[0][0].jobFamilyTypes.客服).toBe('expert');
  fireEvent.change(screen.getByLabelText('growth-knowledge-max'), { target: { value: '11' } });
  expect(change.mock.calls[1][0].managementRanges.growth.knowledge.max).toBe(11);
  fireEvent.change(screen.getByLabelText('growth-knowledge-max'), { target: { value: '1' } });
  expect(screen.getByRole('alert').textContent).toContain('健康下限');
  expect(change).toHaveBeenCalledTimes(2);
});
