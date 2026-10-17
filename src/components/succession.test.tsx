// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SuccessionPanel } from './SuccessionPanel';
import { computeSuccession } from '../utils/succession';
import type { Department } from '../types';
it('关键属性可取消、候选准备度可保存；不自动填写继任人', () => {
  const departments: Department[] = [{ id: 'd', name: '研发', level: 1, expanded: true, leaderId: 'm', children: [],
    employees: [{ id: 'm', employeeId: 'M', name: '经理', level: 'L4', positionId: 'p' }, { id: 'w', employeeId: 'W', name: '候选', level: 'L2' }],
    positions: [{ id: 'p', departmentId: 'd', name: '经理岗', headcount: 1, status: 'active', createdAt: '', updatedAt: '' }] }];
  const update = vi.fn();
  render(<SuccessionPanel departments={departments} data={computeSuccession(departments)} onUpdatePlans={update} />);
  expect(screen.getByText(/未配置继任人 1 个关键岗位/)).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox', { name: '研发/经理岗关键岗位' }));
  expect(update).toHaveBeenLastCalledWith([{ departmentId: 'd', positionId: 'p', patch: { isCritical: false } }]);
  fireEvent.change(screen.getByLabelText('继任岗位'), { target: { value: 'p' } });
  fireEvent.change(screen.getByLabelText('继任人'), { target: { value: 'w' } });
  fireEvent.change(screen.getByLabelText('继任准备度'), { target: { value: 'ready_1_2y' } });
  fireEvent.click(screen.getByRole('button', { name: '保存继任人' }));
  expect(update).toHaveBeenLastCalledWith([{ departmentId: 'd', positionId: 'p', patch: { successors: [{ employeeId: 'w', readiness: 'ready_1_2y' }] } }]);
});
