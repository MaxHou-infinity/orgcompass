import { expect, it } from 'vitest';
import type { Department, Employee, LevelConfig } from '../types';
import { computeReportingChains } from './reportingChains';
import { computeL2 } from './analytics';

function fixture(): Department[] {
  const managers: Employee[] = Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, employeeId: `M${i}`, name: `经理${i}`, level: i === 0 ? 'P10' : 'P9', ...(i ? { reportsToEmployeeId: `m${i - 1}` } : {}) }));
  const workers: Employee[] = Array.from({ length: 95 }, (_, i) => ({ id: `w${i}`, employeeId: `W${i}`, name: `员工${i}`, level: 'P10', reportsToEmployeeId: 'm4' }));
  return [{ id: 'root', name: '一级', level: 1, expanded: true, leaderId: 'm0', employees: managers.slice(0, 2), children: [
    { id: 'mid', name: '二级', level: 2, expanded: true, leaderId: 'm2', employees: managers.slice(2, 4), children: [
      { id: 'leaf', name: '三级', level: 3, expanded: true, leaderId: 'm4', employees: [managers[4], ...workers], children: [] },
    ] },
  ] }];
}
const levels: LevelConfig[] = [{ code: 'P', number: '9', label: '九级', color: '#000000' }, { code: 'P', number: '10', label: '十级', color: '#000000' }];

it('部门三层但人员汇报五层，P90=5 判关注；最长前五含完整人名', () => {
  const roots = fixture();
  const chains = computeReportingChains(roots, levels);
  expect(chains).toMatchObject({ p50: 5, p90: 5, max: 5, count: 100, incomplete: 0 });
  expect(chains.longest).toHaveLength(5);
  expect(chains.longest[0].names).toHaveLength(6);
  expect(chains.longest[0].names.at(-1)).toBe('经理0');
  expect(computeL2(roots).find((m) => m.key === 'depth')).toMatchObject({ label: '汇报链长度', value: 5, status: 'warn', depthBreakdown: { max: 3 } });
});

it('P10/P9 按配置顺序比较；未配置不猜，平级提示与倒挂分开', () => {
  const result = computeReportingChains(fixture(), levels);
  expect(result.inversions.find((pair) => pair.employeeId === 'w0')).toMatchObject({ employeeLevel: 'P10', managerLevel: 'P9', kind: 'inversion' });
  expect(result.inversions.some((pair) => pair.kind === 'equal')).toBe(true);
  expect(computeReportingChains(fixture(), []).inversions).toEqual([]);
  expect(computeReportingChains(fixture(), []).missingLevels).toBe(100);
});

it('循环不截断为短而健康的链；链途经异常人员时标明不完整', () => {
  const roots = fixture();
  roots[0].employees[1].reportsToEmployeeId = 'm2';
  const result = computeReportingChains(roots, levels);
  expect(result.incomplete).toBe(99);
  expect(computeL2(roots).find((m) => m.key === 'depth')?.status).toBe('nodata');
});
