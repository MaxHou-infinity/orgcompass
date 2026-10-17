import { describe, expect, it } from 'vitest';
import type { Department, Employee } from '../types';
import { computeHealthReport, computeL2, DEFAULT_HEALTH_THRESHOLDS, generateDeptSuggestions } from './analytics';
import { deriveManagementLoads } from './management';
import { normalizeHealthThresholds } from './healthThresholds';
import { createProject, parseProject, serializeProject } from './project';

export function coverageFixture(excluded: number, teams = 5): Department[] {
  let remaining = excluded;
  return Array.from({ length: teams }, (_, i) => {
    const size = 100 / teams;
    const employees: Employee[] = Array.from({ length: size }, (_, j) => {
      const invalid = j > 0 && remaining-- > 0;
      return { id: `p-${i}-${j}`, employeeId: `E-${i}-${j}`, name: `人员${i}-${j}`, level: 'L2',
        ...(invalid ? { reportsToEmployeeId: 'missing' } : {}) };
    });
    return { id: `d${i}`, name: `部门${i}`, level: 1, children: [], expanded: true, leaderId: employees[0].id, employees };
  });
}

describe('任务 A 汇报覆盖率', () => {
  it.each([[3, 0.97, false, false], [10, 0.9, true, false], [25, 0.75, false, true]])('%i 人异常：覆盖率 %f，角标 %s，停判 %s', (excluded, coverage, warning, suspended) => {
    const roots = coverageFixture(excluded);
    const report = computeHealthReport(roots, [], undefined, DEFAULT_HEALTH_THRESHOLDS);
    const span = report.l2.find((m) => m.key === 'span')!;
    expect(report.reporting.coverage).toBe(coverage);
    expect(report.reporting.excluded).toHaveLength(excluded);
    expect(Boolean(span.dataWarning)).toBe(warning);
    expect(span.status === 'nodata').toBe(suspended);
    expect(span.value).not.toBeNull();
    if (!suspended) expect(span.status).toBe(computeL2(coverageFixture(0), DEFAULT_HEALTH_THRESHOLDS).find((m) => m.key === 'span')?.status);
    if (excluded === 3) expect(span.verdict).not.toContain('已剔除');
    if (excluded === 10) expect(span.verdict).toContain('结果可能偏乐观');
    if (excluded === 25) expect(span.verdict).toContain('超过 20%');
  });

  it('恰好 95% 不提醒，恰好 80% 继续判灯并提醒；部门 50% 不生成幅度动作', () => {
    const roots = coverageFixture(5, 10);
    const span = computeL2(roots).find((m) => m.key === 'span')!;
    expect(span.status).not.toBe('nodata');
    expect(span.dataWarning).toBeUndefined();
    const suggestions = generateDeptSuggestions(roots);
    expect(suggestions.some((s) => s.deptId === 'd0' && s.title.includes('汇报数据不完整'))).toBe(true);
    expect(suggestions.some((s) => s.deptId === 'd0' && s.metricKey === 'span' && s.severity !== 'info')).toBe(false);
    const boundary = computeL2(coverageFixture(20)).find((m) => m.key === 'span')!;
    expect(boundary.status).not.toBe('nodata');
    expect(boundary.dataWarning).toBeTruthy();
  });

  it('小样本先于覆盖率，文案不同时指责两种原因', () => {
    const roots = coverageFixture(18).slice(0, 1);
    const span = computeL2(roots).find((m) => m.key === 'span')!;
    expect(span.status).toBe('nodata');
    expect(span.verdict).toContain('样本');
    expect(span.verdict).not.toContain('超过 20%');
    expect(span.dataWarning).toBeUndefined();
  });

  it('循环、自指、缺失、冲突和同名异常均可追溯，重复及虚拟记录不扩大分母', () => {
    const roots = coverageFixture(0);
    const people = roots[0].employees;
    people[1].reportsToEmployeeId = people[2].id;
    people[2].reportsToEmployeeId = people[1].id;
    people[3].reportsToEmployeeId = people[3].id;
    people[4].reportsToEmployeeId = 'missing';
    people[5].reportsToEmployeeId = '同名';
    people[6].name = people[7].name = '同名';
    roots[1].employees.push({ ...people[8], reportsToEmployeeId: people[0].id });
    people[8].reportsToEmployeeId = roots[1].employees[0].id;
    roots[0].employees.push({ ...people[9] }, { ...people[9], id: 'virtual', isVirtual: true });
    const result = deriveManagementLoads(roots);
    expect(result.total).toBe(100);
    expect(result.excluded.map((e) => e.reason).sort()).toEqual(['循环汇报', '循环汇报', '自己汇报给自己', '引用不存在', '重名无法匹配', '冲突汇报'].sort());
    expect(result.excluded.every((e) => e.employeeId && e.deptId && e.name)).toBe(true);
  });

  it('设置校验并随项目往返保存，旧项目不凭空添加自定义阈值', () => {
    const project = createProject('覆盖率');
    expect(parseProject(serializeProject(project))?.healthThresholds).toBeUndefined();
    project.healthThresholds = { ...DEFAULT_HEALTH_THRESHOLDS, reportingCoverageWarn: 0.98, reportingCoverageMin: 0.85 };
    expect(parseProject(serializeProject(project))?.healthThresholds).toEqual(project.healthThresholds);
    expect(normalizeHealthThresholds({ reportingCoverageWarn: 2, reportingCoverageMin: 3 })).toMatchObject({ reportingCoverageWarn: 0.95, reportingCoverageMin: 0.8 });
  });
});
