import { describe, expect, it } from 'vitest';
import type { Department, Employee, LevelConfig, Position } from '../types';
import { collectAllSuggestions, computeHealthReport, DEFAULT_HEALTH_THRESHOLDS } from './analytics';
import { computeFunctionalSpans, DEFAULT_JOB_FAMILY_TYPES, JOB_FAMILY_OPTIONS } from './managementBenchmarks';
import { computeReportingChains } from './reportingChains';
import { computeSuccession } from './succession';
import { BUSINESS_CONTEXTS } from './businessContext';
import { levelRank } from './level';
import { DEFAULT_LEVELS } from './levels';
import { normalizeHealthThresholds } from './healthThresholds';
import { createProject, parseProject, serializeProject } from './project';

const pos = (id: string, deptId: string, extra: Partial<Position> = {}): Position =>
  ({ id, departmentId: deptId, name: id, headcount: 1, status: 'active', createdAt: '', updatedAt: '', ...extra });
const dept = (id: string, employees: Employee[], children: Department[] = [], extra: Partial<Department> = {}): Department =>
  ({ id, name: id, level: 1, children, employees, expanded: true, ...extra });
const person = (id: string, extra: Partial<Employee> = {}): Employee => ({ id, employeeId: id, name: id, level: 'L2.1', ...extra });

describe('v2.5.1 #1 继任未录入 → 未配置（nodata）', () => {
  const roots = () => Array.from({ length: 6 }, (_, i) => dept(`d${i}`, [person(`m${i}`, { positionId: `p${i}` }), person(`w${i}`)], [],
    { leaderId: `m${i}`, positions: [pos(`p${i}`, `d${i}`)] }));
  it('范围内没有任何继任人：nodata、值为空、计入完整度', () => {
    const report = computeHealthReport(roots(), [], undefined, DEFAULT_HEALTH_THRESHOLDS);
    const metric = report.l2.find((m) => m.key === 'succession')!;
    expect(metric).toMatchObject({ status: 'nodata', value: null });
    expect(metric.verdict).toContain('未配置');
    expect(report.dataCompleteness.successionUnconfigured).toBe(6);
    expect(collectAllSuggestions(report, roots(), DEFAULT_HEALTH_THRESHOLDS, []).find((x) => x.id === 'm-succession')?.severity).toBe('info');
  });
  it('录入任意一条后才按覆盖率判灯（1/6 → 预警）', () => {
    const data = roots();
    data[0].positions![0].successors = [{ employeeId: 'w0', readiness: 'ready_now' }];
    expect(computeSuccession(data, [], DEFAULT_HEALTH_THRESHOLDS)).toMatchObject({ configured: true, status: 'danger' });
  });
  it('关键岗位空缺且无继任：即便覆盖率健康也至少关注', () => {
    const data = roots();
    data.forEach((d, i) => { d.positions![0].successors = [{ employeeId: `w${i}`, readiness: 'ready_1_2y' }]; });
    data.push(dept('vacant', [person('x')], [], { leaderType: 'vacant', positions: [pos('pv', 'vacant', { isCritical: true })] }));
    const result = computeSuccession(data, [], DEFAULT_HEALTH_THRESHOLDS);
    expect(result.coverage).toBeCloseTo(85.7, 1);
    expect(result.status).toBe('warn');
    expect(result.vacantUncovered).toHaveLength(1);
  });
});

describe('v2.5.1 #2 岗位序列映射与应用一致', () => {
  const team = (family: string, size: number) => [dept('d', [person('mgr'), ...Array.from({ length: size }, (_, i) => person(`w${i}`, { positionId: 'job' }))], [],
    { leaderId: 'mgr', positions: [pos('job', 'd', { jobFamily: family, headcount: size })] })];
  it('销售团队 15 人 = 操作型且健康；技术团队 15 人 = 知识型过宽', () => {
    expect(computeFunctionalSpans(team('销售', 15)).managers[0]).toMatchObject({ type: 'operational', status: 'healthy' });
    expect(computeFunctionalSpans(team('技术', 15)).managers[0]).toMatchObject({ type: 'knowledge', status: 'warn' });
    expect(computeFunctionalSpans(team('法务', 4)).managers[0]).toMatchObject({ type: 'expert', status: 'healthy' });
  });
  it('应用下拉中的每个序列都有默认映射；职能/管理按知识型', () => {
    for (const family of JOB_FAMILY_OPTIONS) expect(DEFAULT_JOB_FAMILY_TYPES[family]).toBeDefined();
    expect(DEFAULT_JOB_FAMILY_TYPES['职能']).toBe('knowledge');
    expect(DEFAULT_JOB_FAMILY_TYPES['管理']).toBe('knowledge');
    for (const f of ['客服', '门店', '生产', '仓储']) expect(DEFAULT_JOB_FAMILY_TYPES[f]).toBe('operational');
  });
  it('未映射序列不猜测：计入完整度并列出取值', () => {
    const result = computeFunctionalSpans(team('外星序列', 6));
    expect(result.defaultedReports).toBe(6);
    expect(result.unmappedFamilies).toEqual(['外星序列']);
    const report = computeHealthReport(team('外星序列', 6), [], undefined, DEFAULT_HEALTH_THRESHOLDS);
    expect(report.dataCompleteness.unmappedJobFamilies).toEqual(['外星序列']);
  });
  it('旧项目保存的旧映射在读取时补齐新默认项，用户自定义优先', () => {
    const t = normalizeHealthThresholds({ jobFamilyTypes: { 研发: 'operational' } });
    expect(t.jobFamilyTypes!['销售']).toBe('operational');
    expect(t.jobFamilyTypes!['研发']).toBe('operational');
  });
});

describe('v2.5.1 #3 可比职级值', () => {
  const pair = (managerLevel: string, reportLevel: string) => [dept('d', [person('B', { level: managerLevel }), person('S', { level: reportLevel, reportsToEmployeeId: 'B' })], [], { leaderId: 'B' })];
  const kinds = (roots: Department[], levels: LevelConfig[]) => computeReportingChains(roots, levels).inversions.map((i) => i.kind);
  it('跨序列按资历：E3.1 向 L3.1 汇报为平级，E3.2 向 L3.1 汇报为倒挂，L3.1 向 E3.2 汇报正常', () => {
    expect(kinds(pair('L3.1', 'E3.1'), DEFAULT_LEVELS)).toEqual(['equal']);
    expect(kinds(pair('L3.1', 'E3.2'), DEFAULT_LEVELS)).toEqual(['inversion']);
    expect(kinds(pair('E3.2', 'L3.1'), DEFAULT_LEVELS)).toEqual([]);
  });
  it('调整职级列表顺序不改变结论；P10 > P9', () => {
    const levels: LevelConfig[] = [{ code: 'P', number: '9', label: 'P9', color: '#000000' }, { code: 'P', number: '10', label: 'P10', color: '#000000' }];
    expect(kinds(pair('P9', 'P10'), levels)).toEqual(['inversion']);
    expect(kinds(pair('P9', 'P10'), [...levels].reverse())).toEqual(['inversion']);
    expect(kinds(pair('P10', 'P9'), [...levels].reverse())).toEqual([]);
    expect(kinds(pair('L3.1', 'E3.2'), [...DEFAULT_LEVELS].reverse())).toEqual(['inversion']);
  });
  it('显式可比值优先于编号（如 E 序列整体高半级）', () => {
    const levels = DEFAULT_LEVELS.map((l) => l.code === 'E' ? { ...l, rank: Number(l.number) + 0.5 } : l);
    expect(kinds(pair('L3.2', 'E3.1'), levels)).toEqual(['inversion']);
    expect(levelRank({ number: '4.1' })).toBe(4.1);
  });
  it('旧文件缺 rank 时按编号推导、往返不写回；显式 rank 随项目保存', () => {
    const project = createProject('职级');
    project.levelConfigs = [{ code: 'L', number: '2', label: 'a', color: '#000000' }, { code: 'E', number: '2', label: 'b', color: '#000000', rank: 2.5 }];
    const restored = parseProject(serializeProject(project))!;
    expect(restored.levelConfigs![0].rank).toBeUndefined();
    expect(restored.levelConfigs![1].rank).toBe(2.5);
  });
});

describe('v2.5.1 #4 降本节省按管理溢价', () => {
  const fixture = () => Array.from({ length: 6 }, (_, i) => dept(`d${i}`, [
    person(`m${i}`, { level: 'L4.1', cost: 5, positionId: `p${i}` }),
    ...Array.from({ length: 4 }, (_, j) => person(`w${i}-${j}`, { cost: j === 0 ? 2.4 : 2, positionId: `s${i}` })),
  ], [], { leaderId: `m${i}`, positions: [pos(`p${i}`, `d${i}`), pos(`s${i}`, `d${i}`, { jobFamily: '技术', headcount: 4 })] }));
  it('默认：经理转专业岗，节省 = 经理成本 − 团队最高专业岗成本，并标注假设', () => {
    const roots = fixture();
    const report = computeHealthReport(roots, [], undefined, DEFAULT_HEALTH_THRESHOLDS, { businessContext: 'efficiency' });
    const merge = collectAllSuggestions(report, roots, DEFAULT_HEALTH_THRESHOLDS, []).find((s) => s.id.startsWith('efficiency-merge'))!;
    expect(merge.expectedImpact).toContain('转为专业岗、不离岗');
    expect(merge.expectedImpact).toContain('5.0 万元 − 专业岗等效成本 2.4 万元');
    expect(merge.expectedImpact).toContain('月成本约减少 2.6 万元');
    expect(merge.expectedImpact).toContain('全员 30→30');
  });
  it('团队成本缺失时不给节省数字', () => {
    const roots = fixture();
    for (const d of roots) delete d.employees[2].cost;
    const report = computeHealthReport(roots, [], undefined, DEFAULT_HEALTH_THRESHOLDS, { businessContext: 'efficiency' });
    expect(collectAllSuggestions(report, roots, DEFAULT_HEALTH_THRESHOLDS, []).some((s) => s.id.startsWith('efficiency-merge'))).toBe(false);
  });
  it('假设可配置并随项目保存', () => {
    const project = createProject('假设');
    project.healthThresholds = { ...DEFAULT_HEALTH_THRESHOLDS, efficiencySavingsAssumption: 'leave' };
    expect(parseProject(serializeProject(project))!.healthThresholds?.efficiencySavingsAssumption).toBe('leave');
    expect(normalizeHealthThresholds({ efficiencySavingsAssumption: 'bogus' }).efficiencySavingsAssumption).toBe('toIC');
  });
});

describe('v2.5.1 #5 场景决定总评指标；扩张场景的管理者梯队', () => {
  it('按规格表：降本含幅度，扩张含继任/空岗/梯队/幅度，孵化只看幅度与汇报链', () => {
    expect(BUSINESS_CONTEXTS.efficiency.focus).toEqual(expect.arrayContaining(['managerRatio', 'depth', 'span']));
    expect(BUSINESS_CONTEXTS.expansion.focus).toEqual(expect.arrayContaining(['succession', 'vacancy', 'managerPipeline', 'span']));
    expect(BUSINESS_CONTEXTS.incubation.focus).toEqual(['span', 'depth']);
  });
  const org = (successors: boolean) => Array.from({ length: 6 }, (_, i) => dept(`d${i}`, [
    person(`m${i}`, { positionId: `p${i}` }), ...Array.from({ length: 2 }, (_, j) => person(`w${i}-${j}`, { positionId: `s${i}` }))], [],
  { leaderId: `m${i}`, positions: [pos(`p${i}`, `d${i}`, successors && i < 2 ? { successors: [{ employeeId: `w${i}-0`, readiness: 'ready_now' }] } : {}), pos(`s${i}`, `d${i}`, { jobFamily: '技术', headcount: 2 })] }));
  it('降本场景幅度偏窄计入总评；扩张场景偏窄不计入，但梯队 2/6 预警计入', () => {
    const efficiency = computeHealthReport(org(true), [], undefined, DEFAULT_HEALTH_THRESHOLDS, { businessContext: 'efficiency' });
    const span = efficiency.l2.find((m) => m.key === 'span')!;
    expect(span.includedInOverall).toBe(true);
    const expansion = computeHealthReport(org(true), [], undefined, DEFAULT_HEALTH_THRESHOLDS, { businessContext: 'expansion' });
    const pipeline = expansion.l2.find((m) => m.key === 'managerPipeline')!;
    expect(pipeline).toMatchObject({ value: 0.33, status: 'danger', includedInOverall: true });
    expect(expansion.l2.find((m) => m.key === 'managerPipeline' )?.verdict).toContain('近期可接后备');
  });
  it('梯队：无继任录入 → nodata（不推断）；管理岗少于样本门槛 → nodata', () => {
    const none = computeHealthReport(org(false), [], undefined, DEFAULT_HEALTH_THRESHOLDS, { businessContext: 'expansion' });
    expect(none.l2.find((m) => m.key === 'managerPipeline')).toMatchObject({ status: 'nodata', value: null });
    const small = computeHealthReport(org(true).slice(0, 3), [], undefined, DEFAULT_HEALTH_THRESHOLDS, { businessContext: 'expansion' });
    expect(small.l2.find((m) => m.key === 'managerPipeline')?.status).toBe('nodata');
  });
});

describe('v2.5.1 #6 汇报链分位数不含顶层负责人', () => {
  it('CEO 本人链长 0 不参与 P50/P90/分布', () => {
    const ceo = person('ceo');
    const managers = Array.from({ length: 3 }, (_, i) => person(`m${i}`, { reportsToEmployeeId: 'ceo' }));
    const ics = Array.from({ length: 3 }, (_, i) => person(`ic${i}`, { reportsToEmployeeId: `m${i}` }));
    const result = computeReportingChains([dept('root', [ceo, ...managers, ...ics], [], { leaderId: 'ceo' })]);
    expect(result.distribution.map((d) => d.length)).toEqual([1, 2]);
    expect(result.p50).toBe(1);
    expect(result.p90).toBe(2);
    expect(result.count).toBe(7);
  });
});
