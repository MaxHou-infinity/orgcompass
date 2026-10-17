import type { Department, LevelConfig } from '../types';
import type { HealthReport, HealthSuggestion } from './analytics';
import { computeFunctionalSpans } from './managementBenchmarks';
import { BUSINESS_CONTEXTS } from './businessContext';
import { employeeCost, hasEmployeeCost } from './cost';
import { deriveManagementLoads, reportingCoverage } from './management';

export function contextualSuggestions(suggestions: HealthSuggestion[], report: HealthReport, roots: Department[], levels: LevelConfig[]): HealthSuggestion[] {
  const context = report.businessContext;
  const policy = BUSINESS_CONTEXTS[context];
  const result = suggestions.map((suggestion) => {
    const metric = report.l2.find((m) => m.key === suggestion.metricKey);
    const row = report.l3.find((row) => row.deptId === suggestion.deptId);
    const evidence = row ? `${row.name}：实际 ${row.actual} 人，编制 ${row.headcount ?? '未配置'}，缺口 ${row.gap ?? '未知'}。`
      : metric ? `${metric.label} ${metric.value === null || metric.value === undefined ? '暂无数值' : `${metric.value}${metric.unit}`}；${metric.verdict}` : suggestion.detail;
    return { ...suggestion, evidence, expectedImpact: `拟改善${metric?.label ?? (suggestion.metricKey === 'span' ? '管理幅度' : '配置完整度')}；方案未确定前不量化变化。`, detail: `${suggestion.detail} ${policy.advice}` };
  });
  if (context !== 'efficiency') return result;
  const thresholds = report.effectiveThresholds;
  const functional = computeFunctionalSpans(roots, thresholds.managementStage, thresholds.managementRanges, thresholds.jobFamilyTypes);
  const graph = deriveManagementLoads(roots);
  if (graph.total < 30 || graph.roles.managerKeys.size < 5 || (graph.coverage ?? 0) < (thresholds.reportingCoverageMin ?? 0.8)) return result;
  const departments = new Map<string, Department>();
  const visit = (list: Department[]) => list.forEach((d) => { departments.set(d.id, d); visit(d.children); });
  visit(roots);
  const eligible = functional.managers.filter((manager) => manager.deptIds.every((id) => {
    const dept = departments.get(id);
    return dept && (reportingCoverage(roots, dept).coverage ?? 0) >= (thresholds.reportingCoverageMin ?? 0.8);
  }) && manager.directReports > 0 && manager.directReports < manager.range.min && graph.roles.managerKeys.has(manager.key));
  for (let i = 0; i < eligible.length; i++) for (let j = i + 1; j < eligible.length; j++) {
    const a = eligible[i], b = eligible[j];
    if (a.type !== b.type || graph.parentByKey.get(a.key) !== graph.parentByKey.get(b.key)) continue;
    const union = new Set([...a.reports, ...b.reports]);
    union.delete(a.key); union.delete(b.key);
    if (union.size > a.range.max || a.reports.has(b.key) || b.reports.has(a.key)) continue;
    const person = graph.employeesByKey.get(b.key);
    if (!person || !hasEmployeeCost(person, levels) || graph.total <= 1) continue;
    const managerCost = employeeCost(person, levels);
    const managers = graph.roles.managerKeys.size;
    const assumption = thresholds.efficiencySavingsAssumption ?? 'toIC';
    let saving: number;
    let basis: string;
    let totalAfter: number;
    if (assumption === 'toIC') {
      // v2.5.1 默认假设：被合并的经理转为专业岗（不离岗），只节省“管理溢价”。
      // 专业岗等效成本 = 其原团队中最高的已知专业岗月成本（保守取高，避免高估节省）；任一成本缺失则不给数字。
      const team = [...b.reports].map((key) => graph.employeesByKey.get(key)).filter((e): e is NonNullable<typeof e> => !!e && !graph.roles.managerKeys.has(graph.roles.personKey(e)));
      if (team.length === 0 || team.some((e) => !hasEmployeeCost(e, levels))) continue;
      const icEquivalent = Math.max(...team.map((e) => employeeCost(e, levels)));
      saving = Math.round((managerCost - icEquivalent) * 10) / 10;
      if (saving <= 0) continue;
      basis = `假设 ${b.name} 转为专业岗、不离岗：节省管理溢价 = 本人月成本 ${managerCost.toFixed(1)} 万元 − 专业岗等效成本 ${icEquivalent.toFixed(1)} 万元（取其原团队最高专业岗成本）`;
      totalAfter = graph.total;
    } else {
      saving = managerCost;
      basis = `假设取消 ${b.name} 的管理岗且其本人离岗（不是转岗），节省其全部月成本 ${managerCost.toFixed(1)} 万元`;
      totalAfter = graph.total - 1;
    }
    const from = managers / graph.total * 100;
    const to = (managers - 1) / totalAfter * 100;
    result.push({ id: `efficiency-merge-${a.key}-${b.key}`, severity: 'major', metricKey: 'span', deptId: a.deptIds[0], deptName: a.deptNames.join('/'),
      title: `合并方案测算：${a.name}与${b.name}的团队`,
      evidence: `两位管理者分别直管 ${a.directReports}/${b.directReports} 人，合并去重 ${union.size} 人（${a.name}的${a.type === 'operational' ? '操作型' : a.type === 'expert' ? '专家型' : '知识型'}健康区间 ${a.range.min}–${a.range.max} 人）。`,
      expectedImpact: `${basis}；全员 ${graph.total}→${totalAfter}，管理者 ${managers}→${managers - 1}，管理者比 ${from.toFixed(1)}%→${to.toFixed(1)}%，月成本约减少 ${saving.toFixed(1)} 万元。测算假设可在阈值设置中切换。`,
      detail: '这是待评审方案的条件测算，尚未执行；需确认职责承接、继任与人员安排。' });
    return result; // 一次给出一个可核对方案，避免叠加互斥节省。
  }
  return result;
}
