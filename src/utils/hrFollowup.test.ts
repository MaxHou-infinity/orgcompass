import { describe, expect, it } from 'vitest';
import type { Department, Employee } from '../types';
import { computeHealthReport, computeL2, computeSpanBreakdown, DEFAULT_HEALTH_THRESHOLDS, generateDeptSuggestions, flattenDepartments } from './analytics';
import { DEFAULT_LEVELS } from './levels';
import { deriveManagementLoads } from './management';
import { INDUSTRY_TEMPLATES, loadIndustryTemplate } from './industryTemplates';

function organization(managers: number, staffPerManager: number): Department[] {
  return Array.from({ length: managers }, (_, i) => {
    const owner: Employee = { id: `m${i}`, employeeId: `M${i}`, name: `经理${i}`, level: 'L4' };
    return { id: `d${i}`, name: `部门${i}`, level: 1, expanded: true, leaderId: owner.id, children: [],
      employees: [owner, ...Array.from({ length: staffPerManager }, (_, j): Employee =>
        ({ id: `w${i}-${j}`, employeeId: `W${i}-${j}`, name: `员工${i}-${j}`, level: 'L2' }))] };
  });
}

describe('按有效关系统计，不以单条异常阻断全局', () => {
  it('缺失上级仅排除该人员，其余 39 人仍参与，局部有效建议不消失', () => {
    const roots = organization(5, 7);
    roots[0].employees[1].reportsToEmployeeId = 'missing';
    const result = deriveManagementLoads(roots);
    expect(result.unresolved).toBe(1);
    expect(result.loads.map((load) => load.reports.size)).toEqual([6, 7, 7, 7, 7]);
    const span = computeL2(roots, DEFAULT_HEALTH_THRESHOLDS).find((m) => m.key === 'span')!;
    expect(span).toMatchObject({ value: 7, status: 'healthy' });
    expect(span.spanBreakdown?.reporting?.excluded).toHaveLength(1);
    expect(span.dataWarning).toBeUndefined(); // 覆盖率 97.5%，按任务 A 不加角标
    roots[1].employees.push(...Array.from({ length: 10 }, (_, j): Employee =>
      ({ id: `extra${j}`, employeeId: `EX${j}`, name: `新增${j}`, level: 'L2' })));
    // v2.5.1：同类最宽者 17 人超过知识型关注上限 15，单点过宽不被中位数抹平 → 至少关注。
    expect(computeL2(roots, DEFAULT_HEALTH_THRESHOLDS).find((m) => m.key === 'span')?.status).toBe('warn');
    expect(generateDeptSuggestions(roots, DEFAULT_HEALTH_THRESHOLDS).some((s) => s.deptId === 'd1' && s.metricKey === 'span' && s.severity === 'critical')).toBe(true);
  });

  it('自指和同人多条矛盾上级被排除，明确有效的跨部门汇报保留', () => {
    const roots = organization(5, 7);
    const member = roots[0].employees[1];
    member.reportsToEmployeeId = member.id;
    roots[1].employees[1].reportsToEmployeeId = 'm2';
    roots[3].employees.push({ ...roots[0].employees[2], reportsToEmployeeId: 'm4' });
    roots[0].employees[2].reportsToEmployeeId = 'm1';
    const result = deriveManagementLoads(roots);
    expect(result.unresolved).toBe(2);
    expect(result.loads.find((l) => l.key === 'M2')?.reports.has('W1-0')).toBe(true);
    expect(computeSpanBreakdown(roots).median).not.toBeNull();
  });
});

describe('管理诊断小样本门槛', () => {
  it.each([[5, 4], [4, 9]])('%i 位管理者、每位 %i 人：保留数值，暂停组织级判读与合并建议', (managers, staff) => {
    const roots = organization(managers, staff);
    const metrics = computeL2(roots, DEFAULT_HEALTH_THRESHOLDS);
    for (const key of ['span', 'managerRatio']) {
      expect(metrics.find((m) => m.key === key)?.status).toBe('nodata');
      expect(metrics.find((m) => m.key === key)?.value).not.toBeNull();
    }
    expect(metrics.find((m) => m.key === 'depth')?.status).toBe(managers * (staff + 1) < 30 ? 'nodata' : 'healthy');
    expect(generateDeptSuggestions(roots).filter((s) => s.metricKey === 'span')).toEqual([]);
  });

  it('边界 30 人、5 位管理者进入判读，29 人或 4 位管理者不进入', () => {
    const roots = organization(5, 5);
    expect(computeL2(roots).find((m) => m.key === 'span')?.status).toBe('healthy');
    roots[0].employees.pop();
    expect(computeL2(roots).find((m) => m.key === 'span')?.status).toBe('nodata');
    expect(computeL2(organization(4, 10)).find((m) => m.key === 'span')?.status).toBe('nodata');
  });

  it('充足样本仍报警，不以新门槛掩盖真实异常', () => {
    const narrow = organization(10, 2); // 30 人、10 位管理者，占比 33.3%
    expect(computeL2(narrow).find((m) => m.key === 'managerRatio')).toMatchObject({ value: 33.3, status: 'danger' });
    expect(computeL2(organization(5, 15)).find((m) => m.key === 'span')).toMatchObject({ value: 15, status: 'warn' });
  });
});

describe('合成模板验收（v2.5.1：行业形态 + 预置问题）', () => {
  /** 每套模板只应命中自己的预置问题；其余总评指标健康，且全部越过小样本门槛（不靠 nodata 回避）。 */
  const intended: Record<string, Partial<Record<string, 'warn' | 'danger'>>> = {
    manufacturing: { depth: 'warn' },
    retail: { span: 'warn' },
    hospital: { gradeInversion: 'danger' },
    internet: { span: 'warn', managerRatio: 'warn' },
    education: { succession: 'warn' },
  };
  it.each(INDUSTRY_TEMPLATES)('$id 只命中预置问题，其余指标健康', (template) => {
    const source = JSON.stringify(template);
    const data = loadIndustryTemplate(template);
    const report = computeHealthReport(data.departments, DEFAULT_LEVELS, undefined, DEFAULT_HEALTH_THRESHOLDS);
    const expected = intended[template.id];
    for (const metric of report.l2.filter((m) => m.includedInOverall)) {
      expect([metric.key, metric.status]).toEqual([metric.key, expected[metric.key] ?? 'healthy']);
    }
    expect(report.summary.unavailable).toBe(0);
    expect(report.summary.red).toBe(Object.values(expected).filter((s) => s === 'danger').length);
    expect(report.reporting.coverage).toBe(1);
    expect(report.dataCompleteness.managementTypeDefaults).toBe(0);
    expect(report.dataCompleteness.unmappedJobFamilies).toEqual([]);
    expect(report.succession.configured).toBe(true);
    expect(data.allEmployeesFlat.length).toBeGreaterThanOrEqual(80);
    // 汇报关系全部来自模板显式数据；载入不改写、不推断。
    expect(data.allEmployeesFlat.filter((e) => !e.reportsToEmployeeId)).toHaveLength(1);
    expect(data.allEmployeesFlat.map((e) => e.reportsToEmployeeId)).toEqual(template.employees.map((e) => e.reportsToEmployeeId));
    expect(new Set(data.allEmployeesFlat.map((e) => e.name)).size).toBe(data.allEmployeesFlat.length);
    expect(template.description).toContain('预置问题');
    expect(JSON.stringify(template)).toBe(source);
    const next = loadIndustryTemplate(template);
    data.allEmployeesFlat[0].name = '修改';
    expect(next.allEmployeesFlat[0].name).not.toBe('修改');
  });

  it('各模板的预置问题能被具体定位', () => {
    const report = (id: string) => {
      const data = loadIndustryTemplate(INDUSTRY_TEMPLATES.find((t) => t.id === id)!);
      return { data, report: computeHealthReport(data.departments, DEFAULT_LEVELS, undefined, DEFAULT_HEALTH_THRESHOLDS) };
    };
    const mfg = report('manufacturing').report;
    expect(mfg.reportingChains.max).toBe(6);
    expect(mfg.reportingChains.p90).toBe(4);
    expect(mfg.l2.find((m) => m.key === 'depth')?.verdict).toContain('孤立深链');
    const operational = mfg.l2.find((m) => m.key === 'span')!.functionalSpans!.types.find((t) => t.type === 'operational')!;
    expect(operational.count).toBeGreaterThanOrEqual(3);
    expect(operational.median).toBeGreaterThanOrEqual(15);
    expect(operational.median).toBeLessThanOrEqual(25);
    const retail = report('retail').report;
    expect(retail.l2.find((m) => m.key === 'span')!.functionalSpans!.types.find((t) => t.type === 'knowledge')!.overloaded).toEqual([expect.objectContaining({ directReports: 16 })]);
    expect(retail.l2.find((m) => m.key === 'span')!.functionalSpans!.types.find((t) => t.type === 'operational')!.status).toBe('healthy');
    const hospital = report('hospital').report;
    expect(hospital.reportingChains.inversions.filter((i) => i.kind === 'inversion')).toEqual([expect.objectContaining({ managerLevel: 'L3.2', employeeLevel: 'E4.1' })]);
    const internet = report('internet').report;
    expect(internet.l2.find((m) => m.key === 'span')!.functionalSpans!.types.find((t) => t.type === 'knowledge')!.median).toBe(2);
    const education = report('education').report;
    expect(education.succession.vacantUncovered).toEqual([expect.objectContaining({ departmentName: '东校区' })]);
    expect(education.succession.risks.map((r) => r.departmentName)).toEqual(['东校区']);
  });
});

it('行业结构：制造/零售深层部门、零售门店网络、医院病区与操作型岗位族', () => {
  const demos = new Map(INDUSTRY_TEMPLATES.map((t) => [t.id, loadIndustryTemplate(t)]));
  const maxLevel = (id: string) => Math.max(...flattenDepartments(demos.get(id)!.departments).map((d) => d.level));
  expect(maxLevel('manufacturing')).toBe(5);
  expect(maxLevel('retail')).toBe(4);
  expect(maxLevel('hospital')).toBe(4);
  expect(maxLevel('internet')).toBe(2);
  expect(flattenDepartments(demos.get('retail')!.departments).filter((d) => d.name.endsWith('店'))).toHaveLength(26);
  expect(flattenDepartments(demos.get('hospital')!.departments).filter((d) => d.name.endsWith('病区'))).toHaveLength(4);
  const families = (id: string) => new Set(flattenDepartments(demos.get(id)!.departments).flatMap((d) => d.positions ?? []).map((p) => p.jobFamily));
  expect(families('manufacturing').has('生产')).toBe(true);
  expect(families('retail').has('门店')).toBe(true);
  expect(families('hospital').has('护理')).toBe(true);
  expect(new Set([...demos.values()].map((d) => d.allEmployeesFlat.length)).size).toBe(5);
});
