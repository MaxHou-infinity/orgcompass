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
    expect(computeL2(roots, DEFAULT_HEALTH_THRESHOLDS).find((m) => m.key === 'span')?.status).toBe('healthy'); // 按类型中位数判灯，个体超宽在部门建议中提示
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

describe('合成模板验收', () => {
  it.each(INDUSTRY_TEMPLATES)('$id 基础结构指标健康，新继任指标如实暴露未配置风险', (template) => {
    const source = JSON.stringify(template);
    const data = loadIndustryTemplate(template);
    const report = computeHealthReport(data.departments, [], undefined, DEFAULT_HEALTH_THRESHOLDS);
    expect(report.summary.overall).toBe('danger');
    expect(report.succession.unconfigured).toBeGreaterThanOrEqual(5);
    expect(report.l2.filter((metric) => ['span', 'depth', 'managerRatio', 'vacancy'].includes(metric.key)).every((metric) => metric.status === 'healthy')).toBe(true);
    expect(report.totals.totalGap).toBe(1);
    expect(generateDeptSuggestions(data.departments, DEFAULT_HEALTH_THRESHOLDS, DEFAULT_LEVELS).filter((s) => s.metricKey === 'span')).toHaveLength(0);
    expect(computeHealthReport(data.departments, DEFAULT_LEVELS).reportingChains.compressed).toHaveLength(0);
    for (const dept of flattenDepartments(data.departments)) {
      for (const employee of dept.employees) {
        const path = [employee.dept1, employee.dept2, employee.dept3, employee.dept4, employee.dept5, employee.dept6].filter(Boolean);
        expect(dept.name).toBe(path.at(-1));
      }
    }
    const roles = deriveManagementLoads(data.departments).roles;
    expect(roles.reportingKeys.size).toBe(1);
    expect(roles.managerKeys.size).toBe(roles.ownerKeys.size + 1);
    expect(report.l2.find((m) => m.key === 'span')?.spanBreakdown?.count).toBe(roles.managerKeys.size);
    // 载入只套岗/配编制，绝不把结构推断升级为显式关系。
    expect(data.allEmployeesFlat.filter((e) => e.reportsToEmployeeId)).toHaveLength(3);
    expect(data.allEmployeesFlat.map((e) => e.reportsToEmployeeId)).toEqual(template.employees.map((e) => e.reportsToEmployeeId));
    expect(JSON.stringify(template)).toBe(source);
    expect(deriveManagementLoads(data.departments).unresolved).toBe(0);
    const next = loadIndustryTemplate(template);
    data.allEmployeesFlat[0].name = '修改';
    expect(next.allEmployeesFlat[0].name).not.toBe('修改');
  });
});

it('行业结构显式保留制造/医院深层部门、零售门店网络及岗位族差异', () => {
  const demos = new Map(INDUSTRY_TEMPLATES.map((t) => [t.id, loadIndustryTemplate(t)]));
  for (const id of ['manufacturing', 'hospital']) {
    expect(Math.max(...flattenDepartments(demos.get(id)!.departments).map((d) => d.level))).toBe(4);
  }
  expect(flattenDepartments(demos.get('retail')!.departments).filter((d) => d.name.includes('示例门店'))).toHaveLength(4);
  expect(flattenDepartments(demos.get('manufacturing')!.departments).flatMap((d) => d.positions ?? []).some((p) => p.jobFamily === '产线')).toBe(true);
  expect(new Set([...demos.values()].map((d) => d.allEmployeesFlat.length)).size).toBeGreaterThan(2);
});
