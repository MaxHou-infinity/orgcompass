import { expect, it } from 'vitest';
import type { Department, Employee } from '../types';
import { DEFAULT_JOB_FAMILY_TYPES, computeFunctionalSpans, DEFAULT_MANAGEMENT_RANGES } from './managementBenchmarks';
import { computeL2, DEFAULT_HEALTH_THRESHOLDS } from './analytics';
import { createProject, parseProject, serializeProject } from './project';

function fixture(family: string): Department[] {
  return Array.from({ length: 5 }, (_, i) => ({ id: `d${i}`, name: `不按部门名推断${i}`, level: 1, expanded: true, leaderId: `m${i}`, children: [],
    positions: [{ id: `pos${i}`, departmentId: `d${i}`, name: '业务人员', jobFamily: family, headcount: 20, status: 'active', createdAt: '', updatedAt: '' }],
    employees: [{ id: `m${i}`, employeeId: `M${i}`, name: `负责人${i}`, level: 'L4' },
      ...Array.from({ length: 20 }, (_, j): Employee => ({ id: `w${i}-${j}`, employeeId: `W${i}-${j}`, name: '员工', level: 'L2', positionId: `pos${i}` }))] }));
}

it('同样 20 人，客服经理健康，研发经理过宽；只改岗位序列即改变结论', () => {
  const roots = fixture('客服');
  expect(computeL2(roots).find((m) => m.key === 'span')?.status).toBe('healthy');
  const before = computeFunctionalSpans(roots).managers[0];
  expect(before).toMatchObject({ type: 'operational', directReports: 20, status: 'healthy' });
  roots[0].positions![0].jobFamily = '研发';
  expect(computeFunctionalSpans(roots).managers[0]).toMatchObject({ type: 'knowledge', directReports: 20, status: 'danger' });
  roots.forEach((d) => { d.positions![0].jobFamily = '研发'; });
  expect(computeL2(roots).find((m) => m.key === 'span')?.status).toBe('danger');
});

it('多数票、部门默认和知识型兜底可追溯，人数不足 3 的类型不参与总体评级', () => {
  const roots = fixture('未知序列');
  roots[0].defaultManagementType = 'expert';
  const result = computeFunctionalSpans(roots);
  expect(result.managers[0].type).toBe('expert');
  expect(result.defaultedReports).toBe(80);
  expect(result.types.find((t) => t.type === 'expert')).toMatchObject({ count: 1, status: 'nodata' });
  expect(result.types.find((t) => t.type === 'knowledge')).toMatchObject({ count: 4, median: 20, healthyShare: 0, status: 'danger' });
});

it('阶段×类型九组配置和序列映射可编辑，随项目保存；默认类型不凭部门名称猜', () => {
  const roots = fixture('自定义客服');
  const ranges = structuredClone(DEFAULT_MANAGEMENT_RANGES);
  ranges.mature.operational = { min: 5, max: 30, warnMin: 2, warnMax: 40 };
  const project = createProject('基准');
  project.healthThresholds = { ...DEFAULT_HEALTH_THRESHOLDS, managementStage: 'mature', managementRanges: ranges, jobFamilyTypes: { 自定义客服: 'operational' } };
  project.scenarios[0].departments = roots;
  const restored = parseProject(serializeProject(project))!;
  // v2.5.1：读取时合并新版默认序列映射，用户自定义项优先保留。
  expect(restored.healthThresholds).toEqual({ ...project.healthThresholds, jobFamilyTypes: { ...DEFAULT_JOB_FAMILY_TYPES, 自定义客服: 'operational' } });
  expect(computeL2(roots, restored.healthThresholds).find((m) => m.key === 'span')?.status).toBe('healthy');
  expect(computeFunctionalSpans(roots).managers.every((m) => m.type === 'knowledge')).toBe(true);
});
