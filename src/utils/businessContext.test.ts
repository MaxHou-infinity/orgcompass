import { expect, it } from 'vitest';
import type { Department, Employee } from '../types';
import { computeHealthReport, collectAllSuggestions, DEFAULT_HEALTH_THRESHOLDS } from './analytics';
import { effectiveBusinessThresholds } from './businessContext';
import { createProject, cloneScenario, parseProject, serializeProject } from './project';

function fixture(knownCost = true): Department[] {
  return Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, name: `团队${i}`, level: 1, expanded: true, leaderId: `m${i}`, children: [],
    positions: [
      { id: `p${i}`, name: '负责人', departmentId: `d${i}`, headcount: 1, status: 'active' as const, createdAt: '', updatedAt: '', successors: [{ employeeId: `w${i}-0`, readiness: 'ready_now' as const }] },
      { id: `s${i}`, name: '工程师', departmentId: `d${i}`, jobFamily: '研发', headcount: 4, status: 'active' as const, createdAt: '', updatedAt: '' },
    ], employees: [
      { id: `m${i}`, employeeId: `M${i}`, name: `经理${i}`, level: 'L4', positionId: `p${i}`, ...(knownCost ? { cost: 3 } : {}) },
      ...Array.from({ length: 4 }, (_, j): Employee => ({ id: `w${i}-${j}`, employeeId: `W${i}-${j}`, name: '员工', level: 'L2', positionId: `s${i}`, ...(knownCost ? { cost: 1 } : {}) })),
    ] }));
}
it('同数据扩张不报偏窄，降本提示窄幅团队并给出条件成本及管理者比测算', () => {
  const roots = fixture();
  const expansion = computeHealthReport(roots, [], undefined, DEFAULT_HEALTH_THRESHOLDS, { businessContext: 'expansion' });
  const efficiency = computeHealthReport(roots, [], undefined, DEFAULT_HEALTH_THRESHOLDS, { businessContext: 'efficiency' });
  expect(expansion.l2.find((m) => m.key === 'span')?.status).toBe('healthy');
  expect(expansion.summary.overall).toBe('healthy');
  expect(efficiency.l2.find((m) => m.key === 'span')?.status).toBe('warn');
  const suggestions = collectAllSuggestions(efficiency, roots, DEFAULT_HEALTH_THRESHOLDS, []);
  const merge = suggestions.find((s) => s.id.startsWith('efficiency-merge'))!;
  expect(merge.evidence).toContain('4/4');
  // v2.5.1 默认假设：经理转专业岗，只节省管理溢价 3.0 − 1.0 = 2.0；全员不变，管理者 6→5。
  expect(merge.expectedImpact).toContain('转为专业岗、不离岗');
  expect(merge.expectedImpact).toContain('管理溢价');
  expect(merge.expectedImpact).toContain('20.0%→16.7%');
  expect(merge.expectedImpact).toContain('月成本约减少 2.0 万元');
  // 可切换为“离岗”假设：节省全部成本，全员 30→29。
  const leave = collectAllSuggestions(computeHealthReport(roots, [], undefined, { ...DEFAULT_HEALTH_THRESHOLDS, efficiencySavingsAssumption: 'leave' }, { businessContext: 'efficiency' }),
    roots, { ...DEFAULT_HEALTH_THRESHOLDS, efficiencySavingsAssumption: 'leave' }, []).find((s) => s.id.startsWith('efficiency-merge'))!;
  expect(leave.expectedImpact).toContain('本人离岗（不是转岗）');
  expect(leave.expectedImpact).toContain('20.0%→17.2%');
  expect(leave.expectedImpact).toContain('月成本约减少 3.0 万元');
  expect(suggestions.every((s) => s.evidence && s.expectedImpact)).toBe(true);
  expect(collectAllSuggestions(expansion, roots).some((s) => s.title.includes('偏窄'))).toBe(false);
});
it('未知成本不输出零成本节省，小样本不生成裁撤测算', () => {
  const roots = fixture(false);
  const report = computeHealthReport(roots, [], undefined, DEFAULT_HEALTH_THRESHOLDS, { businessContext: 'efficiency' });
  expect(collectAllSuggestions(report, roots).some((s) => s.id.startsWith('efficiency-merge'))).toBe(false);
  const small = fixture().slice(0, 2);
  const smallReport = computeHealthReport(small, [], undefined, DEFAULT_HEALTH_THRESHOLDS, { businessContext: 'efficiency' });
  expect(collectAllSuggestions(smallReport, small).some((s) => s.id.startsWith('efficiency-merge'))).toBe(false);
});
it('业务场景为项目级属性，方案切换/复制不建立另一份业务场景，派生不改写原阈值', () => {
  const project = createProject('场景');
  project.businessContext = 'efficiency';
  project.scenarios.push(cloneScenario(project.scenarios[0]));
  project.currentScenarioId = project.scenarios[1].id;
  const restored = parseProject(serializeProject(project))!;
  expect(restored.businessContext).toBe('efficiency');
  expect(restored.scenarios).toHaveLength(2);
  const base = structuredClone(DEFAULT_HEALTH_THRESHOLDS);
  const original = JSON.stringify(base);
  expect(effectiveBusinessThresholds(base, 'efficiency').managerHealthyMax).toBe(12);
  expect(effectiveBusinessThresholds(base, 'expansion').vacancyHealthyMax).toBe(15);
  expect(JSON.stringify(base)).toBe(original);
});

it('部门建议与报告使用同一职级成本依据，不把已知缺口成本说成未知', () => {
  const roots = fixture(false);
  roots[0].positions![1].headcount = 5;
  const levels = [{ code: 'L', number: '2', label: '员工', color: '#000000', cost: 2 }, { code: 'L', number: '4', label: '经理', color: '#000000', cost: 5 }];
  const report = computeHealthReport(roots, levels);
  const suggestions = collectAllSuggestions(report, roots, DEFAULT_HEALTH_THRESHOLDS, levels);
  const vacancy = suggestions.find((s) => s.deptId === 'd0' && s.metricKey === 'vacancy');
  expect(vacancy?.detail).toContain('缺口成本约 2w');
  expect(report.l3.find((row) => row.deptId === 'd0')?.gapCost).toBe(2);
});
it('全局覆盖率足够时，也不把局部数据残缺的团队列入合并收益测算', () => {
  const roots = fixture();
  for (const employee of roots[0].employees.slice(1, 4)) employee.reportsToEmployeeId = 'missing';
  const report = computeHealthReport(roots, [], undefined, DEFAULT_HEALTH_THRESHOLDS, { businessContext: 'efficiency' });
  expect(report.reporting.coverage).toBe(0.9);
  const merge = collectAllSuggestions(report, roots).find((s) => s.id.startsWith('efficiency-merge'));
  expect(merge).toBeTruthy();
  expect(merge?.title).not.toContain('经理0');
});

it('建议沿用新的职能与继任口径，不再引用旧全局幅度区间', () => {
  const roots = fixture();
  for (const dept of roots) dept.positions![0].successors = [];
  const report = computeHealthReport(roots, []);
  const suggestions = collectAllSuggestions(report, roots);
  const span = suggestions.find((s) => s.id === 'm-span');
  expect(span?.detail).toContain('知识型');
  expect(span?.detail).toContain('5–10');
  // v2.5.1：一个继任人都没录入 → 未配置（nodata），提示补数据，不是 0% 红灯。
  expect(report.l2.find((m) => m.key === 'succession')).toMatchObject({ status: 'nodata', value: null });
  const succession = suggestions.find((s) => s.id === 'm-succession');
  expect(succession?.severity).toBe('info');
  expect(succession?.detail).toContain('未配置');
});
