import { describe, expect, it } from 'vitest';
import type { Department, Employee, Position } from '../types';
import {
  computeHealthReport, computeL2, computeL3, computeSpanBreakdown, computeManagerBreakdown,
  DEFAULT_HEALTH_THRESHOLDS, generateSuggestions, generateDeptSuggestions, getStagePresetThresholds,
} from './analytics';
import { computeManagerIdSet } from './competency';
import { INDUSTRY_TEMPLATES, loadIndustryTemplate } from './industryTemplates';
import { deriveManagementLoads } from './management';
import { computeScenarioDiff } from './scenarioDiff';
import { createProject, parseProject, serializeProject } from './project';

const employee = (id: string, extra: Partial<Employee> = {}): Employee =>
  ({ id, employeeId: `E-${id}`, name: id, level: 'L2.2', ...extra });
const dept = (id: string, employees: Employee[], extra: Partial<Department> = {}): Department =>
  ({ id, name: id, employees, children: [], level: 1, expanded: true, ...extra });
const position = (id: string, departmentId: string, headcount: number, extra: Partial<Position> = {}): Position =>
  ({ id, departmentId, name: id, headcount, status: 'active', createdAt: '2026-10-16', updatedAt: '2026-10-16', ...extra });

describe('HR 评审：汇报线与管理者口径', () => {
  it('无负责人子组中的人员归到最近负责人，不从直管中消失', () => {
    const manager = employee('manager');
    const roots = [dept('root', [manager], { leaderId: manager.employeeId,
      children: [dept('unled', [employee('a')], { children: [dept('deep', [employee('b')])] })] })];
    expect(computeSpanBreakdown(roots).distribution).toMatchObject([{ deptId: 'root', deptName: 'root', directReports: 2 }]);
    expect(generateDeptSuggestions(roots).find((s) => s.id === 'd-root-span0')).toBeUndefined();
  });

  it('明确跨部门汇报优先于部门树推断，同人不会同时计给两位经理', () => {
    const a = employee('a'), b = employee('b');
    const roots = [dept('A', [a, employee('worker', { reportsToEmployeeId: b.employeeId })], { leaderId: a.id }),
      dept('B', [b], { leaderId: b.id })];
    const rows = computeSpanBreakdown(roots).distribution;
    expect(rows.find((r) => r.deptId === 'A')?.directReports).toBe(0);
    expect(rows.find((r) => r.deptId === 'B')?.directReports).toBe(1);
  });

  it('同人兼任两个正职按一位经理合并负荷，不把自己算作下属', () => {
    const m = employee('m');
    const roots = [dept('A', [m, employee('a')], { leaderId: m.id, children: [
      dept('B', [employee('b')], { leaderId: m.employeeId }),
    ] })];
    expect(computeSpanBreakdown(roots)).toMatchObject({ count: 1, median: 2, max: 2 });
    expect(computeManagerBreakdown(roots).multiDeptManagers).toBe(1);
  });

  it('正职和有明确下属的组长共用一个集合，副职无带人事实时不冒充正职', () => {
    const owner = employee('owner'), lead = employee('lead'), deputy = employee('deputy');
    const worker = employee('worker', { reportsToEmployeeId: lead.employeeId });
    const roots = [dept('A', [owner, lead, worker], { leaderId: owner.id }),
      dept('B', [deputy], { leaderId: deputy.id, leaderType: 'deputy' })];
    const ids = computeManagerIdSet(roots, [owner, lead, worker, deputy]);
    expect([...ids].sort()).toEqual(['lead', 'owner']);
    expect(computeManagerBreakdown(roots)).toMatchObject({ internalManagers: ids.size, departmentOwners: 1, reportingManagers: 1 });
    const sameDept = generateDeptSuggestions(roots).filter((s) => s.deptId === 'A' && s.metricKey === 'span');
    expect(sameDept).toHaveLength(0); // 小样本不生成裁撤/合并式组织建议
    expect(computeL2(roots).find((m) => m.key === 'span')?.value).not.toBeNull();
  });

  it('同名歧义和无效显式上级保持未知，不静默猜测到本部门负责人', () => {
    const m = employee('m');
    const roots = [dept('A', [m, employee('a', { reportsToEmployeeId: 'missing' })], { leaderId: m.id }),
      dept('B', [employee('b', { name: '同名' }), employee('c', { name: '同名' })], { leaderName: '同名' })];
    expect(computeManagerIdSet(roots, roots.flatMap((d) => d.employees))).toEqual(new Set(['m']));
    expect(deriveManagementLoads(roots).loads.find((l) => l.key === m.employeeId)?.reports.size).toBe(0);
    expect(deriveManagementLoads(roots).unresolved).toBe(1);
    expect(computeL2(roots).find((m) => m.key === 'span')).toMatchObject({ value: 0, status: 'nodata' });
  });
});

describe('HR 评审：缺失数据与建议', () => {
  it('空组织四项灰色，红黄绿均为零，整体不作健康结论', () => {
    const report = computeHealthReport([], []);
    expect(report.l2.every((m) => m.status === 'nodata' && m.value === null)).toBe(true);
    expect(report.summary).toMatchObject({ red: 0, yellow: 0, green: 0, unavailable: 4, overall: 'nodata' });
    expect(report.dataCompleteness.availableMetrics).toBe(0);
    expect(generateSuggestions(report.l2).every((s) => s.severity === 'info')).toBe(true);
  });

  it('有名册但未设置管理关系时，管理者比不是虚假的 0% 健康', () => {
    const metrics = computeL2([dept('A', [employee('a')])]);
    expect(metrics.find((m) => m.key === 'managerRatio')).toMatchObject({ value: null, status: 'nodata' });
  });

  it('建议跟随本次自定义阈值，而不偷用默认值或持久化中的另一份值', () => {
    const thresholds = { ...getStagePresetThresholds('mature'), spanHealthyMin: 6, spanHealthyMax: 11 };
    const metrics = [{ key: 'span' as const, label: '管理幅度', value: 20, unit: '人', status: 'danger' as const, verdict: '超过配置' }];
    expect(generateSuggestions(metrics, thresholds)[0].detail).toContain('6-11');
    expect(generateSuggestions(metrics, thresholds)[0].detail).not.toContain('3-8');
  });

  it('超编的负空岗率不会再建议补招', () => {
    const metrics = computeL2([dept('A', [employee('a'), employee('b')], { headcount: 1 })]);
    const suggestion = generateSuggestions(metrics).find((s) => s.metricKey === 'vacancy')!;
    expect(suggestion.title).toContain('超编');
    expect(suggestion.detail).not.toContain('严重缺编');
  });

  it('缺少指标的场景不被场景对比渲染为整体健康', () => {
    const project = createProject('演示');
    const a = { ...project.scenarios[0], departments: [dept('A', [employee('a')])] };
    expect(computeScenarioDiff(a, { ...a, id: 'other' }).overall.comparable).toBe(false);
  });
});

describe('HR 评审：成本与演示数据', () => {
  it('层级成本每人只计一次，成本缺失时不伪造管理者成本占比', () => {
    const m = employee('m', { cost: 8 });
    const w = employee('w', { cost: 2 });
    const roots = [dept('root', [m], { leaderId: m.id, children: [dept('child', [w], { level: 2 })] })];
    const complete = computeHealthReport(roots, []).costBreakdown;
    expect(complete).toMatchObject({ knownCost: 10, managerKnownCost: 8, unknownEmployees: 0, managerCostShare: 80 });
    expect(complete.layers.map((l) => l.knownCost)).toEqual([8, 2]);
    const missing = computeHealthReport([dept('A', [m, employee('unknown')], { leaderId: m.id })], []).costBreakdown;
    expect(missing.unknownEmployees).toBe(1);
    expect(missing.managerCostShare).toBeNull();
  });
  it('昂贵的管理岗不会抬高另一个岗位的招聘缺口成本', () => {
    const roots = [dept('A', [employee('boss', { positionId: 'manager', cost: 20 }), employee('staff', { positionId: 'staff', cost: 2 })], {
      positions: [position('manager', 'A', 1), position('staff', 'A', 3, { levelBandMin: 'L2.2' })],
    })];
    const row = computeL3(roots, [{ code: 'L', number: '2.2', label: '示例', color: '#123456', cost: 2 }])[0];
    expect(row).toMatchObject({ gap: 2, gapCost: 4 });
    expect(row.gapCostBasis).toContain('逐岗位');
    expect(row.headcountSource).toContain('不从上级继承');
  });

  it('历史部门编制保留明确标注的降级算法，缺成本时保持未知', () => {
    const row = computeL3([dept('legacy', [employee('a', { cost: 2 })], { headcount: 3 })], [])[0];
    expect(row.gapCost).toBe(4);
    expect(row.gapCostBasis).toContain('降级估算');
    expect(computeL3([dept('empty', [], { headcount: 3 })], [])[0].gapCost).toBeNull();
    expect(computeL3([dept('partial', [employee('a', { cost: 2 }), employee('unknown')], { headcount: 3 })], [])[0].gapCost).toBeNull();
  });

  it.each(INDUSTRY_TEMPLATES.map((t) => [t.id, t] as const))('%s 模板完整套岗、配编制且重复载入互不污染', (_id, template) => {
    const data = loadIndustryTemplate(template);
    expect(data.allEmployeesFlat.length).toBeGreaterThanOrEqual(20);
    expect(data.allEmployeesFlat.length).toBeLessThanOrEqual(65);
    expect(data.allEmployeesFlat.every((e) => e.positionId)).toBe(true);
    expect(template.employees.every((e) => !e.positionId)).toBe(true);
    const report = computeHealthReport(data.departments, [], undefined, DEFAULT_HEALTH_THRESHOLDS);
    expect(report.dataCompleteness.availableMetrics).toBe(4);
    expect(report.l2.find((m) => m.key === 'vacancy')?.value).not.toBeNull();
    const project = createProject('演示');
    Object.assign(project.scenarios[0], { departments: data.departments, allEmployeesFlat: data.allEmployeesFlat });
    expect(parseProject(serializeProject(project))?.version).toBe(4);
    const next = loadIndustryTemplate(template);
    expect(next.allEmployeesFlat[0]).not.toBe(data.allEmployeesFlat[0]);
  });
});
