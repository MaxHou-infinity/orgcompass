import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  computeTreeDepth,
  computeL1,
  computeL2,
  computeL3,
  computeHealthReport,
  flattenDepartments,
  HEALTH_STATUS_LABEL,
  generateSuggestions,
  generateDeptSuggestions,
  collectAllSuggestions,
  computeUnassignedEmployees,
  employeeLevelGap,
  DEFAULT_HEALTH_THRESHOLDS,
  getHealthThresholds,
  setHealthThresholds,
  resetHealthThresholds,
  HealthThresholds,
  L2Metric,
  STAGE_PRESETS,
  DEFAULT_STAGE,
  getStagePresetThresholds,
  setStagePreset,
  METRIC_CALIBER_NOTES,
  metricCaliberNote,
  isHeadcountUnset,
  directReports,
  computeSpanBreakdown,
  computeDepthBreakdown,
  computeManagerBreakdown,
  spanStatusWithBreakdown,
  depthStatusWithBreakdown,
  SpanBreakdown,
  DepthBreakdown,
  deptHeadcount,
  computePositionSummary,
  computeMatchStates,
  MatchResult,
} from './analytics';
import { Employee, Department, LevelConfig, Position } from '../types';

/** 便捷构造员工 */
function emp(id: string, level: string, opts: Partial<Employee> = {}): Employee {
  return { id, name: `员工${id}`, employeeId: id, level, ...opts };
}

/** 便捷构造部门（不带头count） */
function dept(
  id: string,
  name: string,
  level: number,
  opts: Partial<Department> = {},
): Department {
  return {
    id,
    name,
    level,
    parentId: opts.parentId,
    children: opts.children ?? [],
    employees: opts.employees ?? [],
    expanded: true,
    headcount: opts.headcount,
    leaderId: opts.leaderId,
    leaderName: opts.leaderName,
    leaderType: opts.leaderType,
    positions: opts.positions ?? [],
  };
}

/** 便捷构造岗位（v2.1.1） */
function pos(id: string, departmentId: string, name: string, opts: Partial<Position> = {}): Position {
  const now = new Date().toISOString();
  return {
    id,
    departmentId,
    name,
    headcount: opts.headcount ?? 1,
    status: opts.status ?? 'active',
    levelBandMin: opts.levelBandMin,
    levelBandMax: opts.levelBandMax,
    createdAt: opts.createdAt ?? now,
    updatedAt: opts.updatedAt ?? now,
  };
}

/** 便捷构造员工（带套岗外键 positionId 可选） */
function empAssigned(id: string, level: string, positionId: string, opts: Partial<Employee> = {}): Employee {
  return { id, name: `员工${id}`, employeeId: id, level, positionId, ...opts };
}

const COSTS: LevelConfig[] = [
  { code: 'L', number: '1.1', label: '初级', color: '#FFCC99', cost: 2 },
  { code: 'L', number: '2.1', label: '高级', color: '#CCFF99', cost: 3 },
  { code: 'L', number: '3.2', label: '经理', color: '#9999FF', cost: 5 },
];

/** 构造一条 depth 层深链（根 level=1 ... 叶子 level=depth） */
function chain(depth: number): Department {
  let node = dept(`n${depth}`, `D${depth}`, depth);
  for (let i = depth - 1; i >= 1; i--) {
    node = dept(`n${i}`, `D${i}`, i, { children: [node] });
  }
  return node;
}

describe('computeTreeDepth（层级深度）', () => {
  it('空树深度为 0', () => {
    expect(computeTreeDepth([])).toBe(0);
  });
  it('单根无子 → 1', () => {
    expect(computeTreeDepth([dept('a', 'A', 1)])).toBe(1);
  });
  it('三层嵌套 → 3', () => {
    const c = dept('c', 'C', 3);
    const b = dept('b', 'B', 2, { children: [c] });
    const a = dept('a', 'A', 1, { children: [b] });
    expect(computeTreeDepth([a])).toBe(3);
  });
  it('取最深路径（不等深兄弟）', () => {
    const leaf = dept('leaf', 'Leaf', 4);
    const deep = dept('deep', 'Deep', 2, { children: [dept('d2', 'D2', 3, { children: [leaf] })] });
    const shallow = dept('shallow', 'Shallow', 2);
    const root = dept('root', 'Root', 1, { children: [deep, shallow] });
    expect(computeTreeDepth([root])).toBe(4);
  });
});

describe('computeL1（一级部门概览）', () => {
  it('汇总子树人数与编制', () => {
    const leafEmp = [emp('e1', 'L1.1'), emp('e2', 'L1.1')];
    const leaf = dept('leaf', '研发组', 2, { employees: leafEmp, headcount: 3 });
    const root = dept('tech', '技术部', 1, { children: [leaf], headcount: 5 });
    const rows = computeL1([root]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('技术部');
    expect(rows[0].actual).toBe(2); // 子树 2 人
    expect(rows[0].headcount).toBe(8); // 子树编制 = 根 5 + 叶子 3
    expect(rows[0].levelDistribution['L1.1']).toBe(2);
  });

  it('未配置编制 → headcount null 且状态为关注', () => {
    const root = dept('tech', '技术部', 1, { employees: [emp('e1', 'L1.1')] });
    const rows = computeL1([root]);
    expect(rows[0].headcount).toBeNull();
    expect(rows[0].status).toBe('warn');
  });
});

describe('computeL2（红黄绿阈值 + 判读）', () => {
  it('管理幅度绿：有负责人部门直管中位数 3-8 人 → 健康', () => {
    // 2 个有负责人的部门，各 4 名直属员工 => 直管数 [4,4]，中位数 = 4 → healthy
    const m1 = dept('m1', 'M1', 1, { leaderId: 'L01', leaderName: '领导A', employees: [emp('a', 'L2.1'), emp('b', 'L2.1'), emp('c', 'L2.1'), emp('d', 'L2.1')] });
    const m2 = dept('m2', 'M2', 1, { leaderId: 'L02', leaderName: '领导B', employees: [emp('e', 'L2.1'), emp('f', 'L2.1'), emp('g', 'L2.1'), emp('h', 'L2.1')] });
    const l2 = computeL2([m1, m2]);
    const span = l2.find((x) => x.key === 'span')!;
    expect(span.value).toBeCloseTo(4, 0);
    expect(span.status).toBe('healthy');
    expect(span.verdict).toContain('管理幅度适中');
  });

  it('管理幅度只计直属下属（非整棵子树）', () => {
    // 部门 A 有负责人，直属 2 人，但带一个 20 人、未设负责人的子部门：
    // 直管 = 2 + 下一层有负责人子部门数(0) = 2 → 中位数 2 → 关注
    const child = dept('a1', 'A1', 2, { employees: Array.from({ length: 20 }, (_, i) => emp(`c${i}`, 'L1.1')) });
    const a = dept('a', 'A', 1, { leaderId: 'L01', leaderName: '领导A', employees: [emp('x', 'L2.1'), emp('y', 'L2.1')], children: [child] });
    const l2 = computeL2([a]);
    const span = l2.find((x) => x.key === 'span')!;
    expect(span.value).toBeCloseTo(2, 0);
    expect(span.status).toBe('warn');
  });

  it('管理者比健康阈值 ≤15%（负责人须在名册内才计内部）', () => {
    // 2 名内部管理者（leaderId 在员工名册内）+ 5 名非管理员工
    const m1 = dept('m1', 'M1', 1, {
      leaderId: 'L01',
      leaderName: '领导A',
      employees: [emp('l01', 'L2.1', { employeeId: 'L01', name: '领导A' }), emp('e1', 'L2.1'), emp('e2', 'L2.1')],
    });
    const reporter = dept('m2', 'M2', 1, {
      leaderId: 'L02',
      leaderName: '领导B',
      employees: [emp('l02', 'L2.1', { employeeId: 'L02', name: '领导B' }), emp('e3', 'L2.1'), emp('e4', 'L2.1'), emp('e5', 'L2.1')],
    });
    const l2 = computeL2([m1, reporter]);
    const ratio = l2.find((x) => x.key === 'managerRatio')!;
    // totalEmployees=7（含 2 名管理者）, internalManagers=2 => 2/7 ≈ 28.6% -> danger(>25)
    expect(ratio.value).toBeCloseTo(28.6, 1);
    expect(ratio.status).toBe('danger');
    expect(ratio.managerBreakdown).toEqual({
      internalManagers: 2,
      externalManagers: 0,
      multiDeptManagers: 0,
      totalEmployees: 7,
      nonManagerEmployees: 5,
      vacantLeaderDepts: 0,
    });
  });

  it('空岗率绿色 ≤10%（编制 40，实际 36）', () => {
    const root = dept('tech', '技术部', 1, { headcount: 40, employees: [emp('e1', 'L1.1')] });
    const leaf = dept('leaf', '组', 2, { children: [], employees: Array.from({ length: 35 }, (_, i) => emp(`e${i + 2}`, 'L1.1')) });
    root.children = [leaf];
    const l2 = computeL2([root]);
    const vac = l2.find((x) => x.key === 'vacancy')!;
    // 编制40，实际36 => 10% → healthy
    expect(vac.value).toBeCloseTo(10, 0);
    expect(vac.status).toBe('healthy');
  });

  it('未配置编制 → 空岗率 null + 关注', () => {
    const root = dept('tech', '技术部', 1, { employees: [emp('e1', 'L1.1')] });
    const l2 = computeL2([root]);
    const vac = l2.find((x) => x.key === 'vacancy')!;
    expect(vac.value).toBeNull();
    expect(vac.status).toBe('warn');
    expect(vac.verdict).toContain('未配置编制');
  });

  it('无负责人 → 管理幅度 null + 关注', () => {
    const root = dept('tech', '技术部', 1, { employees: [emp('e1', 'L1.1')] });
    const l2 = computeL2([root]);
    const span = l2.find((x) => x.key === 'span')!;
    expect(span.value).toBeNull();
    expect(span.status).toBe('warn');
  });
});

describe('computeL3（编制 vs 实际 vs 缺口 + 成本）', () => {
  it('正缺口 = 空岗，缺口成本 = 缺口 × 平均成本', () => {
    const leaf = dept('leaf', '研发组', 2, { employees: [emp('e1', 'L1.1', { isVirtual: false })], headcount: 2 });
    const root = dept('tech', '技术部', 1, { children: [leaf], headcount: 5 });
    const rows = computeL3([root], COSTS);
    const tech = rows.find((r) => r.deptId === 'tech')!;
    expect(tech.actual).toBe(1);
    expect(tech.headcount).toBe(7); // 5 + 2
    expect(tech.gap).toBe(6);
    expect(tech.avgCost).toBe(2); // 1 人 L1.1 成本 2
    expect(tech.actualCost).toBe(2);
    expect(tech.gapCost).toBe(12); // 6 × 2
    expect(tech.status).toBe('danger'); // 大空岗
  });

  it('负缺口 = 超编 + 预警', () => {
    const root = dept('tech', '技术部', 1, {
      headcount: 2,
      employees: [emp('e1', 'L1.1'), emp('e2', 'L1.1'), emp('e3', 'L1.1')],
    });
    const rows = computeL3([root], COSTS);
    expect(rows[0].gap).toBe(-1);
    expect(rows[0].status).toBe('danger');
  });

  it('未配置编制 → headcount null、gap null、状态关注', () => {
    const root = dept('tech', '技术部', 1, { employees: [emp('e1', 'L1.1')] });
    const rows = computeL3([root], COSTS);
    expect(rows[0].headcount).toBeNull();
    expect(rows[0].gap).toBeNull();
    expect(rows[0].status).toBe('warn');
  });

  it('员工个人成本覆盖职级成本映射', () => {
    // L1.1 职级成本为 2，但该员工个人 cost=5 → 实际成本/平均成本按个人 5
    const root = dept('tech', '技术部', 1, { employees: [emp('e1', 'L1.1', { cost: 5 })] });
    const rows = computeL3([root], COSTS);
    expect(rows[0].actualCost).toBe(5);
    expect(rows[0].avgCost).toBe(5);
  });
});

describe('computeHealthReport（主入口 + 汇总）', () => {
  it('覆盖全公司口径汇总', () => {
    const techLeaf = dept('tl', '研发组', 2, { employees: [emp('e1', 'L1.1'), emp('e2', 'L2.1')], headcount: 2 });
    const tech = dept('tech', '技术部', 1, { children: [techLeaf], headcount: 5 });
    const sales = dept('sales', '销售部', 1, { employees: [emp('e3', 'L3.2', { isVirtual: false })], headcount: 3 });
    const report = computeHealthReport([tech, sales], COSTS);
    // totalEmployees = 3 (2 + 1)
    expect(report.totals.totalEmployees).toBe(3);
    // totalDepartments
    expect(report.totals.totalDepartments).toBe(3);
    // totalHeadcount = (5+2) + 3 = 10, totalGap = 10 - 3 = 7
    expect(report.totals.totalGap).toBe(7);
    expect(report.l1).toHaveLength(2);
    expect(report.l2).toHaveLength(4);
    expect(report.summary.overall).toBeDefined();
  });

  it('全部部门未配置编制 → totalGap 为 null（显示“未配置”，不伪装成超编/空岗）', () => {
    const a = dept('a', 'A', 1, { employees: [emp('x', 'L1.1')] });
    const b = dept('b', 'B', 1, { employees: [emp('y', 'L1.1'), emp('z', 'L2.1')] });
    const report = computeHealthReport([a, b], COSTS);
    expect(report.totals.configuredHeadcount).toBe(0);
    expect(report.totals.totalGap).toBeNull();
  });

  it('聚焦单个 L1 → scope 只算该子树', () => {
    const a = dept('a', 'A', 1, { children: [dept('a1', 'A1', 2, { employees: [emp('x', 'L1.1')] })], headcount: 3 });
    const b = dept('b', 'B', 1, { employees: [emp('y', 'L1.1')], headcount: 1 });
    const report = computeHealthReport([a, b], COSTS, 'a');
    expect(report.scopeDeptId).toBe('a');
    expect(report.l1.map((r) => r.deptId)).toEqual(['a']);
    expect(report.totals.totalEmployees).toBe(1);
  });
});

describe('辅助', () => {
  it('flattenDepartments 扁平化所有部门', () => {
    const c = dept('c', 'C', 3);
    const b = dept('b', 'B', 2, { children: [c] });
    const a = dept('a', 'A', 1, { children: [b] });
    expect(flattenDepartments([a]).map((d) => d.id)).toEqual(['a', 'b', 'c']);
  });
  it('状态文案映射', () => {
    expect(HEALTH_STATUS_LABEL.healthy).toBe('健康');
    expect(HEALTH_STATUS_LABEL.warn).toBe('关注');
    expect(HEALTH_STATUS_LABEL.danger).toBe('预警');
  });
});

describe('computeL1 边界', () => {
  it('空树返回空数组', () => {
    expect(computeL1([])).toEqual([]);
  });

  it('单部门无子节点：汇总自身人数/编制/职级分布', () => {
    const root = dept('tech', '技术部', 1, {
      employees: [emp('e1', 'L1.1'), emp('e2', 'L2.1')],
      headcount: 2,
    });
    const rows = computeL1([root]);
    expect(rows).toHaveLength(1);
    expect(rows[0].deptId).toBe('tech');
    expect(rows[0].actual).toBe(2);
    expect(rows[0].headcount).toBe(2);
    expect(rows[0].levelDistribution).toEqual({ 'L1.1': 1, 'L2.1': 1 });
  });

  it('编制为 0（=未配置）→ headcount null，状态为关注', () => {
    const root = dept('tech', '技术部', 1, { employees: [emp('e1', 'L1.1')], headcount: 0 });
    const rows = computeL1([root]);
    // sumHeadcountSubtree 只累加 headcount>0；编制为 0 视为无有效编制 → 返回 null
    expect(rows[0].headcount).toBeNull();
    // 未配置编制 → 无法判空岗 → 关注
    expect(rows[0].status).toBe('warn');
  });

  it('number 型 headcount 非法（NaN/Infinity）不累加，子树未配置则返回 null', () => {
    const root = dept('tech', '技术部', 1, { headcount: Number.NaN });
    const rows = computeL1([root]);
    expect(rows[0].headcount).toBeNull();
    expect(rows[0].status).toBe('warn');
  });
});

describe('computeL2 边界', () => {
  it('空树：depth=0 判中性/关注（不作层级健康），span/vacancy/managerRatio 均为 null', () => {
    const l2 = computeL2([]);
    expect(l2).toHaveLength(4);
    const depth = l2.find((x) => x.key === 'depth')!;
    expect(depth.value).toBe(0);
    expect(depth.status).toBe('warn');
    expect(depth.verdict).toContain('无法评估层级');
    for (const key of ['span', 'vacancy', 'managerRatio'] as const) {
      expect(l2.find((x) => x.key === key)!.value).toBeNull();
    }
  });

  it('层级深度阈值：≤4 健康、5-6 关注、>6 预警', () => {
    expect(computeL2([chain(4)]).find((x) => x.key === 'depth')!.status).toBe('healthy');
    expect(computeL2([chain(5)]).find((x) => x.key === 'depth')!.status).toBe('warn');
    expect(computeL2([chain(6)]).find((x) => x.key === 'depth')!.status).toBe('warn');
    expect(computeL2([chain(7)]).find((x) => x.key === 'depth')!.status).toBe('danger');
  });

  it('管理幅度阈值：3-8 健康、1-2 与 9-12 关注、<1 或 >12 预警', () => {
    // 1 个有负责人的部门 + 1 名直属员工 → 平均直管 = 1/1 = 1 → warn（1-2 关注）
    const only = dept('m', 'M', 1, { leaderId: 'L1', leaderName: '领导', employees: [emp('a', 'L1.1')] });
    expect(computeL2([only]).find((x) => x.key === 'span')!.status).toBe('warn');

    // 2 个有负责人的部门，各 2 名直属员工 → 平均直管 = (2+2)/2 = 2 → warn
    const m1 = dept('m1', 'M1', 1, { leaderId: 'L1', leaderName: '领导A', employees: [emp('a', 'L1.1'), emp('b', 'L1.1')] });
    const m2 = dept('m2', 'M2', 1, { leaderId: 'L2', leaderName: '领导B', employees: [emp('c', 'L1.1'), emp('d', 'L1.1')] });
    expect(computeL2([m1, m2]).find((x) => x.key === 'span')!.status).toBe('warn');

    // 有负责人但 0 直属员工 → 平均直管 = 0 → <1 → 预警
    const empty = dept('e', 'E', 1, { leaderId: 'L3', leaderName: '领导C', employees: [] });
    expect(computeL2([empty]).find((x) => x.key === 'span')!.status).toBe('danger');
  });

  it('管理者比阈值：≤15 健康、≤25 关注、>25 预警（内部负责人计分子，分母含管理者）', () => {
    // 1 名内部管理者（leaderId=L1 且在名册内）+ 4 名非管理员工 → 1/5=20% → warn 边界
    const w = dept('w', 'W', 1, {
      leaderId: 'L1',
      leaderName: '领导',
      employees: [emp('l1', 'L2.1', { employeeId: 'L1', name: '领导' }), emp('e1', 'L1.1'), emp('e2', 'L1.1'), emp('e3', 'L1.1'), emp('e4', 'L1.1')],
    });
    const wRatio = computeL2([w]).find((x) => x.key === 'managerRatio')!;
    expect(wRatio.value).toBeCloseTo(20, 0);
    expect(wRatio.status).toBe('warn');

    // 1 名内部管理者 + 1 名非管理员工 → 1/2=50% → danger
    const d = dept('d', 'D', 1, {
      leaderId: 'L2',
      leaderName: '领导',
      employees: [emp('l2', 'L2.1', { employeeId: 'L2', name: '领导' }), emp('x', 'L1.1')],
    });
    const dRatio = computeL2([d]).find((x) => x.key === 'managerRatio')!;
    expect(dRatio.value).toBeCloseTo(50, 0);
    expect(dRatio.status).toBe('danger');
  });

  it('空岗率阈值：≤10 健康、≤20 关注、>20 预警', () => {
    // 编制 9、实际 5 → (9-5)/9=44.4% → danger
    const root = dept('t', 'T', 1, { headcount: 9, employees: Array.from({ length: 5 }, (_, i) => emp(`e${i}`, 'L1.1')) });
    const vac = computeL2([root]).find((x) => x.key === 'vacancy')!;
    expect(vac.value).toBeCloseTo(44.4, 1);
    expect(vac.status).toBe('danger');
  });

  it('无任何部门/员工/编制 → 全部不可计算指标为 null', () => {
    const l2 = computeL2([dept('empty', '空部门', 1, {})]);
    expect(l2.find((x) => x.key === 'span')!.value).toBeNull();
    expect(l2.find((x) => x.key === 'depth')!.value).toBe(1); // 单节点自身层级为 1
    expect(l2.find((x) => x.key === 'managerRatio')!.value).toBeNull();
    expect(l2.find((x) => x.key === 'vacancy')!.value).toBeNull();
  });
});

describe('computeL3 边界', () => {
  it('空树返回空数组', () => {
    expect(computeL3([], COSTS)).toEqual([]);
  });

  it('缺编（正缺口）状态：缺口≤10% 健康、≤20% 关注、>20% 预警', () => {
    // 编制 10、实际 9 → 缺口 1 → 10% → healthy
    const ok = dept('ok', 'OK', 1, { headcount: 10, employees: Array.from({ length: 9 }, (_, i) => emp(`e${i}`, 'L1.1')) });
    expect(computeL3([ok], COSTS)[0].status).toBe('healthy');

    // 编制 10、实际 8 → 缺口 2 → 20% → warn
    const w = dept('w', 'W', 1, { headcount: 10, employees: Array.from({ length: 8 }, (_, i) => emp(`e${i}`, 'L1.1')) });
    expect(computeL3([w], COSTS)[0].status).toBe('warn');

    // 编制 10、实际 7 → 缺口 3 → 30% → danger
    const d = dept('d', 'D', 1, { headcount: 10, employees: Array.from({ length: 7 }, (_, i) => emp(`e${i}`, 'L1.1')) });
    expect(computeL3([d], COSTS)[0].status).toBe('danger');
  });

  it('gapCost 在无成本配置时按 0 计（avgCost=0）', () => {
    // 员工职级未配置任何 cost → avgCost=0，gapCost=0，但缺口存在
    const root = dept('t', 'T', 1, { headcount: 3, employees: [emp('e1', 'ZZ1')] });
    const row = computeL3([root], COSTS)[0];
    expect(row.gap).toBe(2);
    expect(row.avgCost).toBe(0);
    expect(row.gapCost).toBe(0);
    expect(row.actualCost).toBe(0);
  });

  it('编制为 0（=未配置）→ headcount null、缺口 null、状态关注', () => {
    const root = dept('t', 'T', 1, { headcount: 0, employees: [emp('e1', 'L1.1'), emp('e2', 'L1.1')] });
    const row = computeL3([root], COSTS)[0];
    // sumHeadcountSubtree 只累加 headcount>0；编制为 0 → 无有效编制 → headcount=null
    expect(row.headcount).toBeNull();
    expect(row.gap).toBeNull();
    expect(row.status).toBe('warn');
  });

  it('超编梯度：轻微超编关注、严重超编预警', () => {
    // headcount=10, actual=11 → gap=-1, 超编占比=1/11≈9% ≤20% → warn（关注）
    const slight = dept('s', 'S', 1, { headcount: 10, employees: Array.from({ length: 11 }, (_, i) => emp(`e${i}`, 'L1.1')) });
    // headcount=10, actual=15 → gap=-5, 超编占比=5/15≈33% >20% → danger（预警）
    const severe = dept('sv', 'SV', 1, { headcount: 10, employees: Array.from({ length: 15 }, (_, i) => emp(`g${i}`, 'L1.1')) });
    expect(computeL3([slight], COSTS)[0].status).toBe('warn');
    expect(computeL3([severe], COSTS)[0].status).toBe('danger');
  });
});

describe('口径一致性（L1 与 L3 对同一部门状态一致，回归 t4）', () => {
  it('未配置编制（0 与 undefined）→ L1 与 L3 均判关注（消除 L1 关注/L3 超编矛盾）', () => {
    // headcount=0 → 视为无有效编制 → 两者都 warn
    const zero = dept('zero', 'Z', 1, { headcount: 0, employees: [emp('a', 'L1.1'), emp('b', 'L1.1')] });
    expect(computeL1([zero])[0].status).toBe('warn');
    expect(computeL3([zero], COSTS)[0].status).toBe('warn');
    // 完全未配置 headcount → 两者都 warn
    const none = dept('none', 'N', 1, { employees: [emp('c', 'L1.1')] });
    expect(computeL1([none])[0].status).toBe('warn');
    expect(computeL3([none], COSTS)[0].status).toBe('warn');
  });

  it('满编 → L1 与 L3 均判健康', () => {
    const full = dept('full', 'F', 1, { headcount: 3, employees: [emp('a', 'L1.1'), emp('b', 'L1.1'), emp('c', 'L1.1')] });
    expect(computeL1([full])[0].status).toBe('healthy');
    expect(computeL3([full], COSTS)[0].status).toBe('healthy');
  });

  it('空岗与超编 → L1 与 L3 状态一致（共用 deptStatus）', () => {
    // 空岗：编制 10、实际 4 → 60% 空岗 → danger
    const vac = dept('vac', 'V', 1, { headcount: 10, employees: Array.from({ length: 4 }, (_, i) => emp(`e${i}`, 'L1.1')) });
    expect(computeL1([vac])[0].status).toBe('danger');
    expect(computeL3([vac], COSTS)[0].status).toBe('danger');
    // 超编：编制 5、实际 6 → 缺口占比 16.7% ≤20% → warn
    const over = dept('over', 'O', 1, { headcount: 5, employees: Array.from({ length: 6 }, (_, i) => emp(`e${i}`, 'L1.1')) });
    expect(computeL1([over])[0].status).toBe('warn');
    expect(computeL3([over], COSTS)[0].status).toBe('warn');
  });
});

describe('computeHealthReport 边界', () => {
  it('空树：各项为空且 totals 归零', () => {
    const report = computeHealthReport([], COSTS);
    expect(report.l1).toEqual([]);
    expect(report.l2).toHaveLength(4);
    expect(report.l3).toEqual([]);
    expect(report.totals.totalEmployees).toBe(0);
    expect(report.totals.totalDepartments).toBe(0);
    // 空树无任何配置编制 → totalGap 为 null（未配置），而非 0
    expect(report.totals.totalGap).toBeNull();
    expect(report.totals.totalCost).toBe(0);
    expect(report.totals.configuredHeadcount).toBe(0);
  });

  it('聚焦不存在的部门 id → 回退全公司口径', () => {
    const a = dept('a', 'A', 1, { employees: [emp('x', 'L1.1')], headcount: 1 });
    const b = dept('b', 'B', 1, { employees: [emp('y', 'L1.1')], headcount: 1 });
    const report = computeHealthReport([a, b], COSTS, 'no-such-id');
    expect(report.scopeDeptId).toBe('no-such-id');
    expect(report.totals.totalEmployees).toBe(2);
    expect(report.l1).toHaveLength(2);
  });

  it('虚拟兼岗不计入实际人数与成本，但计入职级分布', () => {
    const root = dept('t', 'T', 1, {
      headcount: 2,
      employees: [emp('real', 'L1.1'), emp('virt', 'L2.1', { isVirtual: true })],
    });
    const report = computeHealthReport([root], COSTS);
    expect(report.totals.totalEmployees).toBe(1); // 虚拟排除
    const l1 = report.l1[0];
    expect(l1.actual).toBe(1);
    expect(l1.levelDistribution).toEqual({ 'L1.1': 1, 'L2.1': 1 }); // 分布含虚拟
    const l3 = report.l3[0];
    expect(l3.actualCost).toBe(2); // 仅 real (L1.1 cost 2)
  });
});

describe('generateSuggestions（指标级建议，P1-3）', () => {
  it('健康指标不产生建议', () => {
    // 8 人 + 编制 8（满编）+ 1 管理者（12.5%）→ 四项均为健康
    const root = dept('tech', '技术部', 1, {
      leaderId: 'L1',
      leaderName: '领导',
      headcount: 8,
      employees: Array.from({ length: 8 }, (_, i) => emp(`e${i}`, 'L1.1')),
    });
    const l2 = computeL2([root]);
    expect(l2.every((m) => m.status === 'healthy')).toBe(true);
    expect(generateSuggestions(l2)).toEqual([]);
  });

  it('空岗指标预警 → 生成招聘建议', () => {
    const root = dept('t', 'T', 1, { headcount: 40, employees: Array.from({ length: 20 }, (_, i) => emp(`e${i}`, 'L1.1')) });
    const l2 = computeL2([root]);
    const s = generateSuggestions(l2);
    const vacS = s.find((x) => x.metricKey === 'vacancy' && x.severity === 'critical');
    expect(vacS).toBeDefined();
    expect(vacS!.title).toContain('招聘');
  });

  it('管理幅度预警 → 生成优化汇报线建议', () => {
    const only = dept('m', 'M', 1, { leaderId: 'L1', leaderName: '领导', employees: [] });
    const l2 = computeL2([only]);
    const s = generateSuggestions(l2);
    const spanS = s.find((x) => x.metricKey === 'span');
    expect(spanS).toBeDefined();
    expect(spanS!.detail).toContain('管理幅度');
  });
});

describe('generateDeptSuggestions（部门级建议，P1-3）', () => {
  it('空岗部门 → 生成带部门名的补编建议', () => {
    const root = dept('tech', '技术部', 1, { headcount: 10, employees: Array.from({ length: 4 }, (_, i) => emp(`e${i}`, 'L1.1')) });
    const s = generateDeptSuggestions([root]);
    const vacS = s.find((x) => x.deptId === 'tech' && x.title.includes('空岗'));
    expect(vacS).toBeDefined();
    expect(vacS!.deptName).toBe('技术部');
    expect(vacS!.severity).toBe('critical'); // 60% 空岗
  });

  it('规模偏窄的管理部门 → 建议合并小组', () => {
    const root = dept('tech', '技术部', 1, { leaderId: 'L01', leaderName: '领导', employees: [emp('a', 'L1.1')] });
    const s = generateDeptSuggestions([root]);
    const spanS = s.find((x) => x.metricKey === 'span' && x.title.includes('偏窄'));
    expect(spanS).toBeDefined();
    expect(spanS!.detail).toContain('合并');
  });

  it('未配置编制 → 提示补充编制（info）', () => {
    const root = dept('tech', '技术部', 1, { employees: [emp('a', 'L1.1')] });
    const s = generateDeptSuggestions([root]);
    const nohc = s.find((x) => x.title.includes('未配置编制'));
    expect(nohc).toBeDefined();
    expect(nohc!.severity).toBe('info');
  });
});

describe('collectAllSuggestions（合并指标+部门建议）', () => {
  it('合并并按严重级排序', () => {
    const root = dept('tech', '技术部', 1, { headcount: 10, employees: Array.from({ length: 4 }, (_, i) => emp(`e${i}`, 'L1.1')), leaderId: 'L0', leaderName: '领导' });
    const report = computeHealthReport([root], COSTS);
    const all = collectAllSuggestions(report, [root]);
    expect(all.length).toBeGreaterThan(0);
    const sevRank = { critical: 0, major: 1, minor: 2, info: 3 } as const;
    for (let i = 1; i < all.length; i++) {
      expect(sevRank[all[i].severity]).toBeGreaterThanOrEqual(sevRank[all[i - 1].severity]);
    }
  });
});

describe('阈值可配置化（P2-7）', () => {
  it('computeL2 支持自定义空岗率阈值', () => {
    const root = dept('t', 'T', 1, { headcount: 20, employees: Array.from({ length: 4 }, (_, i) => emp(`e${i}`, 'L1.1')) });
    const custom = { ...DEFAULT_HEALTH_THRESHOLDS, vacancyHealthyMax: 90, vacancyWarnMax: 95 };
    const vac = computeL2([root], custom).find((x) => x.key === 'vacancy')!;
    // (20-4)/20 = 80% ≤ 90 → healthy（默认阈值下为 danger）
    expect(vac.status).toBe('healthy');
  });

  it('computeHealthReport 支持自定义管理幅度阈值', () => {
    const only = dept('m', 'M', 1, { leaderId: 'L1', leaderName: '领导', employees: [emp('a', 'L1.1')] });
    const strict = { ...DEFAULT_HEALTH_THRESHOLDS, spanWarnMax: 0, spanWarnLow: 0, spanHealthyMin: 0, spanHealthyMax: 0 };
    const report = computeHealthReport([only], COSTS, undefined, strict);
    const span = report.l2.find((x) => x.key === 'span')!;
    // 1 人直管，健康区间 [0,0]，1>0 且 1>warnMax(0) → danger
    expect(span.status).toBe('danger');
  });
});

// —— 以下为测试专家补测（填补前端未覆盖边界） ——

describe('generateSuggestions（指标级建议）边界补充', () => {
  it('多项异常 → 每条非健康指标各生成建议，健康指标被跳过', () => {
    const metrics: L2Metric[] = [
      { key: 'span', label: '管理幅度', value: 1.5, unit: '人', status: 'warn', verdict: '偏窄' },
      { key: 'depth', label: '层级深度', value: 3, unit: '层', status: 'healthy', verdict: '精简' },
      { key: 'managerRatio', label: '管理者比', value: 30, unit: '%', status: 'danger', verdict: '过高' },
      { key: 'vacancy', label: '空岗率', value: 8, unit: '%', status: 'healthy', verdict: '满编' },
    ];
    const s = generateSuggestions(metrics);
    // 只有 span(warn) 与 managerRatio(danger) 两条；depth/vacancy 健康被跳过
    expect(s).toHaveLength(2);
    expect(s.map((x) => x.metricKey).sort()).toEqual(['managerRatio', 'span']);
  });

  it('风险优先级：danger → critical、warn → major', () => {
    const metrics: L2Metric[] = [
      { key: 'vacancy', label: '空岗率', value: 30, unit: '%', status: 'danger', verdict: '严重缺编' },
      { key: 'span', label: '管理幅度', value: 1.5, unit: '人', status: 'warn', verdict: '偏窄' },
    ];
    const s = generateSuggestions(metrics);
    const vac = s.find((x) => x.metricKey === 'vacancy')!;
    const span = s.find((x) => x.metricKey === 'span')!;
    expect(vac.severity).toBe('critical');
    expect(span.severity).toBe('major');
  });

  it('span 值为 null（无任何有负责人部门）→ 仍生成建议，detail 提示配置负责人', () => {
    // 无 leaderId/leaderName → spanLeaders=0 → span=null，status=warn
    const noLeader = dept('t', 'T', 1, { employees: [emp('a', 'L1.1')] });
    const s = generateSuggestions(computeL2([noLeader]));
    const span = s.find((x) => x.metricKey === 'span')!;
    expect(span).toBeDefined();
    expect(span.title).toBe('优化管理幅度');
    expect(span.detail).toContain('配置负责人');
    expect(span.severity).toBe('major');
  });

  it('建议 id 格式为 m-<key>', () => {
    const metrics: L2Metric[] = [
      { key: 'depth', label: '层级深度', value: 8, unit: '层', status: 'danger', verdict: '过深' },
    ];
    const s = generateSuggestions(metrics);
    expect(s[0].id).toBe('m-depth');
  });
});

describe('generateDeptSuggestions（部门级建议）边界补充', () => {
  it('管理幅度偏宽（direct > spanHealthyMax=8）→ major', () => {
    const employees = Array.from({ length: 9 }, (_, i) => emp(`e${i}`, 'L1.1'));
    const root = dept('tech', '技术部', 1, { leaderId: 'L01', leaderName: '领导', employees });
    const s = generateDeptSuggestions([root], DEFAULT_HEALTH_THRESHOLDS);
    const wide = s.find((x) => x.id === 'd-tech-spanwide')!;
    expect(wide).toBeDefined();
    expect(wide.severity).toBe('major');
    expect(wide.title).toContain('偏宽');
    expect(wide.title).toContain('9 人');
  });

  it('超编（gap<0）超编占比 > overWarnRatio=20% → critical', () => {
    // headcount=10, actual=13 → gap=-3, 超编占比 3/13≈23.1% > 20% → critical
    const root = dept('o', '市场部', 1, { headcount: 10, employees: Array.from({ length: 13 }, (_, i) => emp(`e${i}`, 'L1.1')) });
    const s = generateDeptSuggestions([root], DEFAULT_HEALTH_THRESHOLDS);
    const over = s.find((x) => x.id === 'd-o-over')!;
    expect(over).toBeDefined();
    expect(over.severity).toBe('critical');
    expect(over.title).toContain('超编 3 人');
    expect(over.detail).toContain('内部转岗');
  });

  it('空岗率三级分级：=10% minor、(10,20]% major、>20% critical', () => {
    const minor = dept('mi', '轻微缺编', 1, { headcount: 10, employees: Array.from({ length: 9 }, (_, i) => emp(`e${i}`, 'L1.1')) }); // 10% → minor
    const major = dept('ma', '中度缺编', 1, { headcount: 10, employees: Array.from({ length: 8 }, (_, i) => emp(`e${i}`, 'L1.1')) }); // 20% → major
    const s = generateDeptSuggestions([minor, major], DEFAULT_HEALTH_THRESHOLDS);
    const mi = s.find((x) => x.deptId === 'mi' && x.title.includes('空岗'))!;
    const ma = s.find((x) => x.deptId === 'ma' && x.title.includes('空岗'))!;
    expect(mi.severity).toBe('minor');
    expect(ma.severity).toBe('major');
  });

  it('建议按严重度排序（critical → major → minor → info）且 id 含部门', () => {
    const critical = dept('c', 'C组', 1, { headcount: 10, employees: Array.from({ length: 4 }, (_, i) => emp(`e${i}`, 'L1.1')) }); // 60% 空岗 critical
    const info = dept('i', 'I组', 1, { employees: [emp('a', 'L1.1')] }); // 未配置编制 info
    const s = generateDeptSuggestions([info, critical], DEFAULT_HEALTH_THRESHOLDS);
    const sevRank = { critical: 0, major: 1, minor: 2, info: 3 } as const;
    for (let i = 1; i < s.length; i++) {
      expect(sevRank[s[i].severity]).toBeGreaterThanOrEqual(sevRank[s[i - 1].severity]);
    }
    expect(s[0].severity).toBe('critical');
    expect(s[0].deptId).toBe('c');
    expect(s[s.length - 1].severity).toBe('info');
  });
});

describe('阈值可配置化（get/set/reset + localStorage 默认回退）', () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      removeItem: (k: string) => storage.delete(k),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('未配置 → getHealthThresholds 返回默认阈值', () => {
    expect(getHealthThresholds()).toEqual(DEFAULT_HEALTH_THRESHOLDS);
  });

  it('setHealthThresholds 持久化后 getHealthThresholds 返回覆盖值，未覆盖字段回退默认', () => {
    const custom: HealthThresholds = { ...DEFAULT_HEALTH_THRESHOLDS, vacancyHealthyMax: 30, vacancyWarnMax: 40 };
    setHealthThresholds(custom);
    expect(storage.get('org-designer.health-thresholds')).toBeTruthy();
    const got = getHealthThresholds();
    expect(got.vacancyHealthyMax).toBe(30);
    expect(got.vacancyWarnMax).toBe(40);
    expect(got.spanHealthyMin).toBe(DEFAULT_HEALTH_THRESHOLDS.spanHealthyMin);
  });

  it('getHealthThresholds 对部分覆盖做合并（缺省字段回退默认）', () => {
    storage.set('org-designer.health-thresholds', JSON.stringify({ spanHealthyMax: 10 }));
    const got = getHealthThresholds();
    expect(got.spanHealthyMax).toBe(10);
    expect(got.spanHealthyMin).toBe(DEFAULT_HEALTH_THRESHOLDS.spanHealthyMin);
  });

  it('解析非法 JSON → 回退默认阈值', () => {
    storage.set('org-designer.health-thresholds', '{not valid json');
    expect(getHealthThresholds()).toEqual(DEFAULT_HEALTH_THRESHOLDS);
  });

  it('resetHealthThresholds 清除配置并恢复默认', () => {
    setHealthThresholds({ ...DEFAULT_HEALTH_THRESHOLDS, spanHealthyMin: 1 });
    resetHealthThresholds();
    expect(storage.has('org-designer.health-thresholds')).toBe(false);
    expect(getHealthThresholds()).toEqual(DEFAULT_HEALTH_THRESHOLDS);
  });
});

describe('computeL1 接受阈值参数（可配置化缺口）', () => {
  it('computeL1 用传入阈值覆盖空岗状态', () => {
    const root = dept('t', '技术部', 1, { headcount: 10, employees: Array.from({ length: 4 }, (_, i) => emp(`e${i}`, 'L1.1')) });
    // 缺省（当前阈值）：空岗率 60% > 20% → danger
    expect(computeL1([root])[0].status).toBe('danger');
    // 自定义放宽空岗阈值：60% ≤ 90 → healthy
    const loose: HealthThresholds = { ...DEFAULT_HEALTH_THRESHOLDS, vacancyHealthyMax: 90, vacancyWarnMax: 95 };
    expect(computeL1([root], loose)[0].status).toBe('healthy');
  });
});

describe('v2.0.5 未入架构员工 & 员工职级差距', () => {
  it('computeUnassignedEmployees 返回未挂载到任何部门的员工', () => {
    const e1 = emp('e1', 'L1.1');
    const e2 = emp('e2', 'L1.2');
    const e3 = emp('e3', 'L2.1');
    const root = dept('d1', '技术部', 1, { employees: [e1, e2], children: [] });
    expect(computeUnassignedEmployees([e1, e2, e3], [root]).map((e) => e.id)).toEqual(['e3']);
  });

  it('computeUnassignedEmployees 递归统计子部门已挂载员工', () => {
    const e1 = emp('e1', 'L1.1');
    const child = dept('c', '研发组', 2, { employees: [e1] });
    const root = dept('d1', '技术部', 1, { children: [child] });
    expect(computeUnassignedEmployees([e1], [root]).length).toBe(0);
  });

  it('employeeLevelGap 未设置 targetLevel 返回 null', () => {
    expect(employeeLevelGap(emp('e', 'L1.1'))).toBeNull();
  });

  it('employeeLevelGap 目标高于当前 → 差距与灯号', () => {
    const g1 = employeeLevelGap(emp('e', 'L1.1', { targetLevel: 'L2.1' }));
    expect(g1).not.toBeNull();
    expect(g1!.gap).toBe(1);
    expect(g1!.status).toBe('warn');
    const g2 = employeeLevelGap(emp('e', 'L1.1', { targetLevel: 'L3.2' }));
    expect(g2!.gap).toBeCloseTo(2.1, 1);
    expect(g2!.status).toBe('danger');
  });

  it('employeeLevelGap 达到/超出目标 → healthy', () => {
    const g = employeeLevelGap(emp('e', 'L2.1', { targetLevel: 'L1.1' }));
    expect(g).not.toBeNull();
    expect(g!.status).toBe('healthy');
  });

  it('computeUnassignedEmployees 排除虚拟员工（兼岗）', () => {
    const real = emp('r1', 'L1.1');
    const virtual = emp('v1', 'L1.1', { isVirtual: true });
    const root = dept('d1', '技术部', 1, { employees: [real, virtual], children: [] });
    // 未挂载真实员工才算未入架构；虚拟兼岗不算
    expect(computeUnassignedEmployees([real, virtual, emp('r2', 'L2.1')], [root]).map((e) => e.id)).toEqual(['r2']);
  });
});

// —— —— v2.0.8：窗口期后由 HR 诊断逻辑收口所补 —— ——

describe('v2.0.8 空岗率口径对齐', () => {
  it('部分部门未配置编制 → 空岗率分母只算已配置部门', () => {
    // 已配置编制部门：编制 10、实际 6（直属）→ 空岗 40%；
    // 未配置编制部门：4 名员工，不计入分母（旧口径会把它算进分母→ 压低估为 0%）。
    const configured = dept('cfg', '已配置', 1, {
      headcount: 10,
      employees: Array.from({ length: 6 }, (_, i) => emp(`c${i}`, 'L1.1')),
    });
    const unconfigured = dept('uncfg', '未配置', 1, {
      employees: Array.from({ length: 4 }, (_, i) => emp(`u${i}`, 'L1.1')),
    });
    const l2 = computeL2([configured, unconfigured]);
    const vac = l2.find((x) => x.key === 'vacancy')!;
    // 分母 = 已配置部门实际 6（不含未配置编制部门的 4 人）→ (10-6)/10 = 40%
    expect(vac.value).toBeCloseTo(40, 0);
    expect(vac.status).toBe('danger');
  });

  it('已配置部门的子树员工计入分母（编制覆盖整棵子树）', () => {
    const child = dept('sub', '子组', 2, { employees: Array.from({ length: 3 }, (_, i) => emp(`s${i}`, 'L1.1')) });
    const root = dept('root', '已配置', 1, { headcount: 10, employees: [emp('r0', 'L1.1')], children: [child] });
    const l2 = computeL2([root]);
    const vac = l2.find((x) => x.key === 'vacancy')!;
    // 实际 = 直属 1 + 子部门 3 = 4 → (10-4)/10 = 60%
    expect(vac.value).toBeCloseTo(60, 0);
    expect(vac.status).toBe('danger');
  });

  it('父子均配置编制 → 员工不重复计入分母', () => {
    const child = dept('sub', '子组', 2, { headcount: 3, employees: [emp('s0', 'L1.1'), emp('s1', 'L1.1')] });
    const root = dept('root', '父', 1, { headcount: 5, children: [child] });
    const l2 = computeL2([root]);
    const vac = l2.find((x) => x.key === 'vacancy')!;
    // 总编制 5+3=8，实际只计子部门 2 人 → (8-2)/8 = 75%
    expect(vac.value).toBeCloseTo(75, 0);
    expect(vac.status).toBe('danger');
  });

  it('全部未配置编制 → 空岗率 null + 关注', () => {
    const root = dept('t', 'T', 1, { employees: [emp('a', 'L1.1'), emp('b', 'L1.1')] });
    const l2 = computeL2([root]);
    const vac = l2.find((x) => x.key === 'vacancy')!;
    expect(vac.value).toBeNull();
    expect(vac.status).toBe('warn');
    expect(vac.verdict).toContain('未配置编制');
  });
});

describe('v2.0.8 企业阶段预设 STAGE_PRESETS', () => {
  it('三档存在且 growth == 当前默认', () => {
    expect(Object.keys(STAGE_PRESETS).sort()).toEqual(['growth', 'mature', 'startup']);
    expect(STAGE_PRESETS.startup.id).toBe('startup');
    expect(STAGE_PRESETS.growth.id).toBe('growth');
    expect(STAGE_PRESETS.mature.id).toBe('mature');
    // growth 即当前默认口径
    expect(STAGE_PRESETS.growth.thresholds).toEqual(DEFAULT_HEALTH_THRESHOLDS);
    expect(DEFAULT_STAGE).toBe('growth');
  });

  it('各档阈值结构完整、description 注明仅供参考', () => {
    for (const stage of ['startup', 'growth', 'mature'] as const) {
      const t = STAGE_PRESETS[stage].thresholds;
      expect(t.spanHealthyMin).toBeLessThanOrEqual(t.spanHealthyMax);
      expect(t.spanWarnLow).toBeLessThanOrEqual(t.spanHealthyMin);
      expect(t.spanWarnMax).toBeGreaterThanOrEqual(t.spanHealthyMax);
      expect(t.depthHealthyMax).toBeLessThanOrEqual(t.depthWarnMax);
      expect(t.managerHealthyMax).toBeLessThanOrEqual(t.managerWarnMax);
      expect(t.vacancyHealthyMax).toBeLessThanOrEqual(t.vacancyWarnMax);
      expect(t.overWarnRatio).toBeGreaterThan(0);
      expect(STAGE_PRESETS[stage].label).toBeTruthy();
      expect(STAGE_PRESETS[stage].description).toContain('仅供参考');
    }
  });

  it('初创/成熟档取值符合 HR 审计档位', () => {
    const s = STAGE_PRESETS.startup.thresholds;
    expect(s.spanHealthyMin).toBe(2);
    expect(s.spanHealthyMax).toBe(7);
    expect(s.spanWarnMax).toBe(10);
    const m = STAGE_PRESETS.mature.thresholds;
    expect(m.spanHealthyMin).toBe(5);
    expect(m.spanHealthyMax).toBe(9);
    expect(m.spanWarnMax).toBe(14);
    expect(m.overWarnRatio).toBe(0.15);
  });
});

describe('v2.0.8 setStagePreset / getStagePresetThresholds 持久化', () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      removeItem: (k: string) => storage.delete(k),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getStagePresetThresholds 返回该档副本，修改不影响原始预设', () => {
    const t = getStagePresetThresholds('startup');
    expect(t).toEqual(STAGE_PRESETS.startup.thresholds);
    t.spanHealthyMin = 999;
    expect(STAGE_PRESETS.startup.thresholds.spanHealthyMin).not.toBe(999);
  });

  it('setStagePreset 应用自定义阈值并持久化（getHealthThresholds 读取生效）', () => {
    setStagePreset('mature');
    expect(storage.get('org-designer.health-thresholds')).toBeTruthy();
    expect(getHealthThresholds()).toEqual(STAGE_PRESETS.mature.thresholds);
    expect(getHealthThresholds().spanHealthyMax).toBe(9);
    expect(getHealthThresholds().depthHealthyMax).toBe(5);
    expect(getHealthThresholds().overWarnRatio).toBe(0.15);
  });

  it('setStagePreset(growth) 恢复为当前默认阈值', () => {
    setStagePreset('startup');
    setStagePreset('growth');
    expect(getHealthThresholds()).toEqual(DEFAULT_HEALTH_THRESHOLDS);
  });
});

describe('v2.0.8 诊断口径说明 METRIC_CALIBER_NOTES', () => {
  it('四个指标 key 均非空且 metricCaliberNote 一致', () => {
    const keys: Array<L2Metric['key']> = ['span', 'depth', 'managerRatio', 'vacancy'];
    for (const k of keys) {
      expect(METRIC_CALIBER_NOTES[k]).toBeTruthy();
      expect(METRIC_CALIBER_NOTES[k].length).toBeGreaterThan(10);
      expect(metricCaliberNote(k)).toBe(METRIC_CALIBER_NOTES[k]);
    }
  });

  it('口径说明包含关键限定语义（v2.0.9 同步改写）', () => {
    expect(METRIC_CALIBER_NOTES.span).toContain('中位数');
    expect(METRIC_CALIBER_NOTES.span).toContain('有负责人');
    expect(METRIC_CALIBER_NOTES.depth).toContain('P90');
    expect(METRIC_CALIBER_NOTES.depth).toContain('最大层数');
    expect(METRIC_CALIBER_NOTES.managerRatio).toContain('员工总数');
    expect(METRIC_CALIBER_NOTES.managerRatio).toContain('外部');
    expect(METRIC_CALIBER_NOTES.vacancy).toContain('有效编制');
    expect(METRIC_CALIBER_NOTES.vacancy).toContain('战略储备');
  });
});

describe('v2.0.8 isHeadcountUnset', () => {
  it('null/undefined → true', () => {
    expect(isHeadcountUnset(null)).toBe(true);
    expect(isHeadcountUnset(undefined)).toBe(true);
  });

  it('有效数值 → false（含 0 与超编边界）', () => {
    expect(isHeadcountUnset(0)).toBe(false);
    expect(isHeadcountUnset(3)).toBe(false);
    expect(isHeadcountUnset(-1)).toBe(false);
  });
});

// —— —— v2.0.9：诊断口径修正（A 管理幅度 / B 层级深度 / C 管理者比） —— ——

describe('v2.0.9 A 管理幅度口径修正', () => {
  it('directReports：中间管理层直管 = 直挂 IC + 下一层有负责人子部门数（旧口径=0）', () => {
    const c1 = dept('c1', '子1', 2, { leaderId: 'L1', leaderName: '甲', employees: [emp('a', 'L1.1')] });
    const c2 = dept('c2', '子2', 2, { leaderId: 'L2', leaderName: '乙', employees: [emp('b', 'L1.1')] });
    const c3 = dept('c3', '子3', 2, { leaderId: 'L3', leaderName: '丙', employees: [emp('c', 'L1.1')] });
    const rd = dept('rd', '研发部', 1, { leaderId: 'L0', leaderName: '丁', children: [c1, c2, c3], employees: [] });
    // 旧口径：节点直挂 0 人 → 被误判「无人直管」；新口径：3 名下一级管理者
    expect(directReports(rd)).toBe(3);
    const bd = computeSpanBreakdown([rd]);
    expect(bd.distribution.find((r) => r.deptId === 'rd')!.directReports).toBe(3);
  });

  it('directReports：扁平单层组织退化与旧口径一致（无子部门、直挂 4 人）', () => {
    const d = dept('d', 'D', 1, {
      leaderId: 'L1',
      leaderName: '领导',
      employees: [emp('a', 'L1.1'), emp('b', 'L1.1'), emp('c', 'L1.1'), emp('d', 'L1.1')],
    });
    expect(directReports(d)).toBe(4);
    expect(computeL2([d]).find((x) => x.key === 'span')!.value).toBe(4);
  });

  it('中位数稳健性：直管 [2,3,40] → span.value=3，max=40 触发极值升级 → danger', () => {
    const narrow = dept('n', '窄部门', 1, { leaderId: 'L1', leaderName: '领导A', employees: [emp('a', 'L1.1'), emp('b', 'L1.1')] });
    const mid = dept('m', '中部门', 1, { leaderId: 'L2', leaderName: '领导B', employees: [emp('c', 'L1.1'), emp('d', 'L1.1'), emp('e', 'L1.1')] });
    const wide = dept('w', '宽部门', 1, { leaderId: 'L3', leaderName: '领导C', employees: Array.from({ length: 40 }, (_, i) => emp(`w${i}`, 'L1.1')) });
    const l2 = computeL2([narrow, mid, wide]);
    const span = l2.find((x) => x.key === 'span')!;
    expect(span.value).toBe(3); // 中位数（旧口径算术均值 = 15，被 40 稀释）
    const bd = span.spanBreakdown!;
    expect(bd.count).toBe(3);
    expect(bd.max).toBe(40);
    expect(bd.min).toBe(2);
    expect(bd.mean).toBe(15); // 均值保留作参考（回归对照旧 span.value）
    expect(bd.distribution[0].deptId).toBe('w');
    expect(span.status).toBe('danger'); // 40 ≥ spanWarnMax(12)×1.5=18 → 预警
    expect(span.verdict).toContain('管理幅度失衡');
  });

  it('极值兜底：中位数健康但 max 超 spanWarnMax → L2 至少关注 + 部门级建议标 critical', () => {
    const ok = dept('ok', '正常部门', 1, { leaderId: 'L1', leaderName: '领导A', employees: Array.from({ length: 4 }, (_, i) => emp(`a${i}`, 'L1.1')) });
    const ok2 = dept('ok2', '正常部门2', 1, { leaderId: 'L2', leaderName: '领导B', employees: Array.from({ length: 4 }, (_, i) => emp(`b${i}`, 'L1.1')) });
    const wide = dept('wide', '宽部门', 1, { leaderId: 'L3', leaderName: '领导C', employees: Array.from({ length: 13 }, (_, i) => emp(`w${i}`, 'L1.1')) });
    const l2 = computeL2([ok, ok2, wide]);
    const span = l2.find((x) => x.key === 'span')!;
    expect(span.value).toBe(4); // 中位数 [4,4,13] 在健康区间 [3,8]
    expect(span.status).toBe('warn'); // max 13 > 12 且 < 18 → 至少关注
    expect(span.verdict).toContain('单点失衡');
    const suggestions = generateDeptSuggestions([ok, ok2, wide], DEFAULT_HEALTH_THRESHOLDS);
    const critical = suggestions.find((x) => x.deptId === 'wide' && x.severity === 'critical');
    expect(critical).toBeDefined();
    expect(critical!.title).toContain('管理幅度过宽');
  });

  it('不可算分支：无任何有负责人部门 → median/min/max null、status warn、verdict 含「未设置部门负责人」', () => {
    const root = dept('t', 'T', 1, { employees: [emp('a', 'L1.1')] });
    expect(computeSpanBreakdown([root])).toEqual({
      count: 0,
      median: null,
      mean: null,
      min: null,
      max: null,
      distribution: [],
    });
    const span = computeL2([root]).find((x) => x.key === 'span')!;
    expect(span.value).toBeNull();
    expect(span.status).toBe('warn');
    expect(span.verdict).toContain('未设置部门负责人');
  });

  it('spanStatusWithBreakdown：极值升级规则（>spanWarnMax 至少关注；≥×1.5 预警）', () => {
    const base: SpanBreakdown = { count: 10, median: 4, mean: 4, min: 1, max: 4, distribution: [] };
    expect(spanStatusWithBreakdown(base, DEFAULT_HEALTH_THRESHOLDS)).toBe('healthy'); // 中位数 4、max 4 → 健康
    expect(
      spanStatusWithBreakdown({ ...base, max: 13 }, DEFAULT_HEALTH_THRESHOLDS),
    ).toBe('warn'); // 13 > 12 且 < 18 → 至少关注
    expect(
      spanStatusWithBreakdown({ ...base, max: 18 }, DEFAULT_HEALTH_THRESHOLDS),
    ).toBe('danger'); // 18 ≥ 12×1.5 → 预警
    expect(
      spanStatusWithBreakdown({ count: 0, median: null, mean: null, min: null, max: null, distribution: [] }, DEFAULT_HEALTH_THRESHOLDS),
    ).toBe('warn'); // 不可算
  });
});

describe('v2.0.9 B 层级深度口径修正', () => {
  /** 混合树：深度分布 [1,2,2,2,3,3,3,4,4,4,4,5,6]（n=13）→ P50=3 / P90=5 / max=6 */
  function mixedDepthTree(): Department {
    const deep = dept('f', 'F', 6);
    const e = dept('e', 'E', 5, { children: [deep] });
    const d = dept('d', 'D', 4, { children: [e] });
    const c = dept('c', 'C', 3, { children: [d] });
    const b = dept('b', 'B', 2, { children: [c] });
    const a2 = dept('a2', 'A2', 2, {
      children: [dept('a2a', 'A2a', 3, { children: [dept('a2a1', 'A2a1', 4), dept('a2a2', 'A2a2', 4)] })],
    });
    const a3 = dept('a3', 'A3', 2, {
      children: [dept('a3a', 'A3a', 3, { children: [dept('a3a1', 'A3a1', 4)] })],
    });
    return dept('root', '总部', 1, { children: [b, a2, a3] });
  }

  it('分层：深链不再=全组织结论 → max=6、P50=3、P90=5（整数层）、deepestPath 定位深链', () => {
    const bd = computeDepthBreakdown([mixedDepthTree()]);
    expect(bd.max).toBe(6);
    expect(bd.p50).toBe(3);
    expect(bd.p90).toBe(5);
    expect(bd.deptCount).toBe(13);
    expect(Number.isInteger(bd.p90)).toBe(true); // nearest-rank 整数分位（不会出现 3.7 层）
    expect(bd.deepestDeptId).toBe('f');
    expect(bd.deepestPath).toEqual(['总部', 'B', 'C', 'D', 'E', 'F']);
    // L2：value 展示 P90（主），status 按 P90 判定；max 仅作孤立深链升级
    const depth = computeL2([mixedDepthTree()]).find((x) => x.key === 'depth')!;
    expect(depth.value).toBe(5);
    expect(depth.depthBreakdown).toMatchObject({ max: 6, p50: 3, p90: 5 });
    expect(depth.status).toBe('warn'); // P90=5 落在 (4,6]
  });

  it('均匀深链（单链）：P90=max；单部门样本 P50=P90=max；空树全部归零', () => {
    const bd = computeDepthBreakdown([chain(5)]);
    expect(bd.max).toBe(5);
    expect(bd.p90).toBe(5);
    // 按「部门节点」统计：深度 [1,2,3,4,5] 的中位数落在第 3 层
    expect(bd.p50).toBe(3);
    expect(bd.deptCount).toBe(5);
    expect(bd.deepestPath).toEqual(['D1', 'D2', 'D3', 'D4', 'D5']);
    // 单部门样本（n=1）：三者相等
    expect(computeDepthBreakdown([dept('only', 'Only', 1)])).toMatchObject({
      max: 1,
      p50: 1,
      p90: 1,
      deptCount: 1,
      deepestDeptId: 'only',
      deepestPath: ['Only'],
    });
    expect(computeDepthBreakdown([])).toEqual({
      max: 0,
      p50: 0,
      p90: 0,
      deepestDeptId: '',
      deepestPath: [],
      deptCount: 0,
    });
  });

  it('孤立深链升级：P90 健康但 max > depthWarnMax → 至少关注（旧口径 max 主判为预警）', () => {
    // 33 个部门：27 个深度 ≤2 + 一条 7 层深链 → P90=4（健康）、max=7（>warnMax 6）
    const shallow = Array.from({ length: 26 }, (_, i) => dept(`s${i}`, `浅层${i}`, 2));
    let chainNode = dept('c7', 'C7', 7);
    for (let i = 6; i >= 2; i--) chainNode = dept(`c${i}`, `C${i}`, i, { children: [chainNode] });
    const root = dept('root', '总部', 1, { children: [...shallow, chainNode] });
    const bd = computeDepthBreakdown([root]);
    expect(bd.deptCount).toBe(33);
    expect(bd.max).toBe(7);
    expect(bd.p90).toBe(4);
    const depth = computeL2([root]).find((x) => x.key === 'depth')!;
    expect(depth.value).toBe(4);
    expect(depth.status).toBe('warn'); // 关注而非预警（旧口径按 7 → danger）
    expect(depth.verdict).toContain('最深链路');
  });

  it('depthStatusWithBreakdown：P90 主判 + 孤立深链升级 + max 硬上限', () => {
    const t = DEFAULT_HEALTH_THRESHOLDS; // healthyMax 4 / warnMax 6
    const mk = (p90: number, max: number): DepthBreakdown => ({
      max,
      p50: 3,
      p90,
      deepestDeptId: '',
      deepestPath: [],
      deptCount: 30,
    });
    expect(depthStatusWithBreakdown(mk(3, 5), t)).toBe('healthy'); // P90 健康 + max 未超 → 健康
    expect(depthStatusWithBreakdown(mk(3, 7), t)).toBe('warn'); // 孤立深链升级（7 > 6）
    expect(depthStatusWithBreakdown(mk(3, 9), t)).toBe('danger'); // 硬上限（9 > 6+2）
    expect(depthStatusWithBreakdown(mk(5, 5), t)).toBe('warn'); // P90 主判
    expect(depthStatusWithBreakdown(mk(8, 8), t)).toBe('danger'); // P90 预警
    expect(
      depthStatusWithBreakdown({ max: 0, p50: 0, p90: 0, deepestDeptId: '', deepestPath: [], deptCount: 0 }, t),
    ).toBe('warn'); // 空树
  });
});

describe('v2.0.9 C 管理者比口径修正', () => {
  it('外部负责人剔除：leaderId 不在员工名册 → 不计分子，仅展示 externalManagers', () => {
    const d = dept('d', '外部负责人部门', 1, {
      leaderId: 'EXT1',
      leaderName: '组织外VP',
      employees: [emp('e1', 'L1.1'), emp('e2', 'L1.1'), emp('e3', 'L1.1')],
    });
    const bd = computeManagerBreakdown([d]);
    expect(bd.internalManagers).toBe(0);
    expect(bd.externalManagers).toBe(1);
    expect(bd.multiDeptManagers).toBe(0);
    expect(bd.totalEmployees).toBe(3);
    expect(bd.nonManagerEmployees).toBe(3);
    const ratio = computeL2([d]).find((x) => x.key === 'managerRatio')!;
    expect(ratio.value).toBe(0);
    expect(ratio.managerBreakdown!.externalManagers).toBe(1);
  });

  it('内部负责人计入：leaderId 命中名册员工 → 计分子', () => {
    const d = dept('d', 'D', 1, {
      leaderId: 'L01',
      leaderName: '领导A',
      employees: [emp('l01', 'L2.1', { employeeId: 'L01', name: '领导A' }), emp('e1', 'L1.1')],
    });
    const bd = computeManagerBreakdown([d]);
    expect(bd.internalManagers).toBe(1);
    expect(bd.externalManagers).toBe(0);
    expect(bd.totalEmployees).toBe(2);
    expect(computeL2([d]).find((x) => x.key === 'managerRatio')!.value).toBe(50);
  });

  it('去重 bug 修复：同一人 A 部门用 leaderId、B 部门用 leaderName（同姓名在名册内）→ 只算 1', () => {
    const a = dept('a', 'A', 1, {
      leaderId: 'L01',
      leaderName: '领导A',
      employees: [emp('l01', 'L2.1', { employeeId: 'L01', name: '领导A' }), emp('e1', 'L1.1')],
    });
    const bDept = dept('b', 'B', 1, { leaderName: '领导A', employees: [emp('e2', 'L1.1'), emp('e3', 'L1.1')] });
    const bd = computeManagerBreakdown([a, bDept]);
    // 旧口径：id:L01 + name:领导A 两个 key → 2；新口径统一解析到同一名册员工 → 1
    expect(bd.internalManagers).toBe(1);
    const ratio = computeL2([a, bDept]).find((x) => x.key === 'managerRatio')!;
    expect(ratio.managerBreakdown!.internalManagers).toBe(1);
    expect(ratio.value).toBe(25); // 1/4
  });

  it('兼岗暴露：同一人兼任 2 部门 → multiDeptManagers=1、去重后分子仍 1', () => {
    const a = dept('a', 'A', 1, {
      leaderId: 'L01',
      leaderName: '领导A',
      employees: [emp('l01', 'L2.1', { employeeId: 'L01', name: '领导A' }), emp('e1', 'L1.1')],
    });
    const bDept = dept('b', 'B', 1, { leaderId: 'L01', leaderName: '领导A', employees: [emp('e2', 'L1.1')] });
    const bd = computeManagerBreakdown([a, bDept]);
    expect(bd.multiDeptManagers).toBe(1); // 兼岗暴露
    expect(bd.internalManagers).toBe(1); // 去重后分子不变
    expect(bd.externalManagers).toBe(0);
  });

  it('双口径：nonManagerEmployees = 总数 − 内部管理者；辅助口径「每 9 名非管理员工配 1 名管理者」', () => {
    const a = dept('a', 'A', 1, {
      leaderId: 'L01',
      leaderName: '领导A',
      employees: [
        emp('l01', 'L2.1', { employeeId: 'L01', name: '领导A' }),
        ...Array.from({ length: 9 }, (_, i) => emp(`a${i}`, 'L1.1')),
      ],
    });
    const bDept = dept('b', 'B', 1, {
      leaderId: 'L02',
      leaderName: '领导B',
      employees: [
        emp('l02', 'L2.1', { employeeId: 'L02', name: '领导B' }),
        ...Array.from({ length: 9 }, (_, i) => emp(`b${i}`, 'L1.1')),
      ],
    });
    const bd = computeManagerBreakdown([a, bDept]);
    expect(bd.internalManagers).toBe(2);
    expect(bd.totalEmployees).toBe(20);
    expect(bd.nonManagerEmployees).toBe(18);
    const ratio = computeL2([a, bDept]).find((x) => x.key === 'managerRatio')!;
    expect(ratio.value).toBe(10); // 主口径 2/20
    expect(ratio.status).toBe('healthy');
    expect(ratio.verdict).toContain('约 9 名非管理员工配 1 名管理者');
  });

  it('无员工：managerRatio null + verdict 含「无员工数据」', () => {
    const l2 = computeL2([dept('empty', '空部门', 1, {})]);
    const ratio = l2.find((x) => x.key === 'managerRatio')!;
    expect(ratio.value).toBeNull();
    expect(ratio.status).toBe('warn');
    expect(ratio.verdict).toContain('无员工数据');
  });
});

// —— —— v2.1.1 健康度联动（岗位级编制/缺口/成本 + leaderType 精确化 + 状态机接入） —— ——

describe('v2.1.1 deptHeadcount（统一编制入口）', () => {
  it('优先聚合直属岗位 active 编制之和', () => {
    const d = dept('d', 'D', 1, {
      positions: [pos('p1', 'd', '工程师', { headcount: 3 }), pos('p2', 'd', '产品', { headcount: 2 })],
    });
    expect(deptHeadcount(d)).toBe(5);
  });

  it('frozen / archived 岗位不计编制（frozen 不计待补缺口）', () => {
    const d = dept('d', 'D', 1, {
      positions: [
        pos('p1', 'd', '工程师', { headcount: 3 }),
        pos('p2', 'd', '冻结岗', { headcount: 4, status: 'frozen' }),
        pos('p3', 'd', '归档岗', { headcount: 5, status: 'archived' }),
      ],
    });
    expect(deptHeadcount(d)).toBe(3);
  });

  it('无 positions → 回退部门级冗余派生 headcount（过渡期兼容）', () => {
    expect(deptHeadcount(dept('d', 'D', 1, { headcount: 7 }))).toBe(7);
    expect(deptHeadcount(dept('d', 'D', 1, {}))).toBeNull();
    expect(deptHeadcount(dept('d', 'D', 1, { headcount: 0 }))).toBeNull(); // 0 = 未配置
  });

  it('positions 存在但聚合为 0（全 frozen/0）→ null，不回退 headcount', () => {
    const d = dept('d', 'D', 1, {
      headcount: 9,
      positions: [pos('p1', 'd', '冻结', { headcount: 0, status: 'frozen' })],
    });
    expect(deptHeadcount(d)).toBeNull();
  });

  it('active 但 headcount<=0 的岗位不计编制（与 captain 定稿 headcount>0 口径一致）', () => {
    // active + headcount 0（= 编制未配置/冻结）→ 不计；仅 active + headcount>0 才累加
    const d = dept('d', 'D', 1, {
      positions: [
        pos('p1', 'd', '未配置', { headcount: 0 }),
        pos('p2', 'd', '有效岗', { headcount: 4 }),
      ],
    });
    expect(deptHeadcount(d)).toBe(4);
  });
});

describe('v2.1.1 computePositionSummary（岗位级编制/缺口/成本）', () => {
  it('空岗：gap = headcount - assignedCount；gapCost 用 levelBand 目标职级成本', () => {
    const positions = [pos('p1', 'd1', '工程师', { headcount: 3, levelBandMin: 'L1.1' })];
    const employees = [empAssigned('e1', 'L1.1', 'p1'), empAssigned('e2', 'L1.1', 'p1')];
    const row = computePositionSummary(positions, employees, COSTS)[0];
    expect(row).toMatchObject({
      positionId: 'p1',
      departmentId: 'd1',
      name: '工程师',
      headcount: 3,
      assignedCount: 2,
      gap: 1,
      avgCost: 2, // 套岗 2 人，职级 L1.1 成本 2
      gapCost: 2, // 1 × unit(levelBand L1.1→2)
    });
    expect(row.status).toBe('danger'); // 1/3=33% > 20%
  });

  it('超编：assigned > headcount → gap 负 + 按 overStatus 分级', () => {
    const positions = [pos('p1', 'd1', '工程师', { headcount: 1 })];
    const employees = [empAssigned('e1', 'L1.1', 'p1'), empAssigned('e2', 'L1.1', 'p1')];
    const row = computePositionSummary(positions, employees, COSTS)[0];
    expect(row.gap).toBe(-1);
    expect(row.assignedCount).toBe(2);
    expect(row.status).toBe('danger'); // 超编 1/2=50% > 20%
  });

  it('frozen 岗位不计缺口：gap null、gapCost 0、status 关注（未配置/冻结）', () => {
    const positions = [pos('p1', 'd1', '冻结岗位', { headcount: 4, status: 'frozen' })];
    const employees = [empAssigned('e1', 'L1.1', 'p1')];
    const row = computePositionSummary(positions, employees, COSTS)[0];
    expect(row.gap).toBeNull();
    expect(row.gapCost).toBe(0);
    expect(row.status).toBe('warn');
  });

  it('archived 岗位被过滤', () => {
    const positions = [
      pos('p1', 'd1', '归档岗', { status: 'archived' }),
      pos('p2', 'd1', '正常岗', { headcount: 1 }),
    ];
    expect(computePositionSummary(positions, [], COSTS).map((x) => x.positionId)).toEqual(['p2']);
  });

  it('虚拟兼岗副本不计套岗人数', () => {
    const positions = [pos('p1', 'd1', '工程师', { headcount: 2 })];
    const employees = [
      empAssigned('real', 'L1.1', 'p1'),
      empAssigned('virt', 'L1.1', 'p1', { isVirtual: true }),
    ];
    const row = computePositionSummary(positions, employees, COSTS)[0];
    expect(row.assignedCount).toBe(1);
    expect(row.gap).toBe(1);
  });

  it('编制 0（非 frozen）→ gap null 不计缺口：status 关注', () => {
    const row = computePositionSummary([pos('p1', 'd1', '待定', { headcount: 0 })], [], COSTS)[0];
    expect(row.gap).toBeNull();
    expect(row.status).toBe('warn');
  });

  it('无 levelBand → gapCost 用套岗员工 targetLevel 成本（L3.2→5）', () => {
    const positions = [pos('p1', 'd1', '工程师', { headcount: 2 })];
    const employees = [empAssigned('e1', 'L1.1', 'p1', { targetLevel: 'L3.2' })];
    const row = computePositionSummary(positions, employees, COSTS)[0];
    // gap = 2-1 = 1；unit = targetLevel L3.2 成本 5 → gapCost 5
    expect(row.gapCost).toBe(5);
  });

  it('满编（headcount == assignedCount，显式编制）→ gap 0、status healthy', () => {
    // 显式编制 = 导入人数时，headcount>0 且 gap=0 → 满编/healthy
    const positions = [pos('p1', 'd1', '工程师', { headcount: 3 })];
    const employees = [empAssigned('e1', 'L1.1', 'p1'), empAssigned('e2', 'L1.1', 'p1'), empAssigned('e3', 'L1.1', 'p1')];
    const row = computePositionSummary(positions, employees, COSTS)[0];
    expect(row.gap).toBe(0);
    expect(row.status).toBe('healthy'); // 满编，非 overStatus(0) 的 warn
  });

  it('主路径（岗位名称、无编制列，import-eng 定案 headcount=0）→ 未配置，即使有人套岗', () => {
    // import-eng find-or-create 岗位 headcount=0（编制未配置），员工套上后：
    // 走「未配置/未配置编制」口径：gap=null、status=warn、不计缺口/不计超编、gapCost=0
    const positions = [pos('p1', 'd1', '前端工程师', { headcount: 0 })];
    const employees = [empAssigned('e1', 'L1.1', 'p1'), empAssigned('e2', 'L1.1', 'p1')];
    const row = computePositionSummary(positions, employees, COSTS)[0];
    expect(row.assignedCount).toBe(2); // 在岗人数仍如实反映
    expect(row.headcount).toBe(0);
    expect(row.gap).toBeNull(); // 未配置，不计缺口（不伪装满编）
    expect(row.status).toBe('warn'); // 未配置 → 关注
    expect(row.gapCost).toBe(0); // 不计缺口成本
  });
});

describe('v2.1.1 computeManagerBreakdown leaderType 精确化', () => {
  it('分子只计 owner；deputy/acting/external 进 externalManagers；vacant 单独提示', () => {
    const owner = dept('a', 'A', 1, {
      leaderType: 'owner',
      leaderId: 'L01',
      leaderName: '领导A',
      employees: [emp('l01', 'L2.1', { employeeId: 'L01', name: '领导A' }), emp('e1', 'L1.1')],
    });
    const deputy = dept('b', 'B', 1, {
      leaderType: 'deputy',
      leaderId: 'L02',
      leaderName: '副职B',
      employees: [emp('l02', 'L2.1', { employeeId: 'L02', name: '副职B' }), emp('e2', 'L1.1')],
    });
    const acting = dept('c', 'C', 1, {
      leaderType: 'acting',
      leaderId: 'L03',
      leaderName: '代理C',
      employees: [emp('l03', 'L2.1', { employeeId: 'L03', name: '代理C' }), emp('e3', 'L1.1')],
    });
    const ext = dept('d', 'D', 1, {
      leaderType: 'external',
      leaderId: 'EXT1',
      leaderName: '挂名D',
      employees: [emp('e4', 'L1.1')],
    });
    const vacant = dept('e', 'E', 1, {
      leaderType: 'vacant',
      leaderId: 'V1',
      leaderName: '空缺',
      employees: [emp('e5', 'L1.1')],
    });
    const bd = computeManagerBreakdown([owner, deputy, acting, ext, vacant]);
    expect(bd.internalManagers).toBe(1); // 只计 owner
    expect(bd.externalManagers).toBe(3); // deputy + acting + external
    expect(bd.vacantLeaderDepts).toBe(1); // vacant 提示
    expect(bd.multiDeptManagers).toBe(0);
    expect(bd.totalEmployees).toBe(8);
    const ratio = computeL2([owner, deputy, acting, ext, vacant]).find((x) => x.key === 'managerRatio')!;
    expect(ratio.value).toBeCloseTo(12.5, 1); // 1/8 = 12.5%
    expect(ratio.verdict).toContain('负责人空缺'); // vacant 提示
  });

  it('同一人既为正职又任别处副职 → 仍按内部（不因副职降级）', () => {
    const a = dept('a', 'A', 1, {
      leaderType: 'owner',
      leaderId: 'L01',
      leaderName: '领导A',
      employees: [emp('l01', 'L2.1', { employeeId: 'L01', name: '领导A' }), emp('e1', 'L1.1')],
    });
    const b = dept('b', 'B', 1, {
      leaderType: 'deputy',
      leaderId: 'L01',
      leaderName: '领导A',
      employees: [emp('e2', 'L1.1')],
    });
    const bd = computeManagerBreakdown([a, b]);
    expect(bd.internalManagers).toBe(1); // 正职为准
    expect(bd.externalManagers).toBe(0);
    expect(bd.multiDeptManagers).toBe(1); // 兼任 2 部门（一处正职）
  });

  it('缺省 leaderType 视为 owner（兼容旧数据）', () => {
    const d = dept('d', 'D', 1, {
      leaderId: 'L01',
      leaderName: '领导A',
      employees: [emp('l01', 'L2.1', { employeeId: 'L01', name: '领导A' }), emp('e1', 'L1.1')],
    });
    const bd = computeManagerBreakdown([d]);
    expect(bd.internalManagers).toBe(1);
    expect(bd.vacantLeaderDepts).toBe(0);
  });
});

describe('v2.1.1 状态机接入（computeMatchStates 复用，data-eng 已建 match.ts）', () => {
  it('computeMatchStates 从 analytics 再导出', () => {
    expect(typeof computeMatchStates).toBe('function');
  });

  it('岗位超额 1；日期未知不指定后进者', () => {
    const positions = [pos('p1', 'd1', '工程师', { headcount: 2 })];
    const employees = [
      empAssigned('e1', 'L1.1', 'p1'),
      empAssigned('e2', 'L1.1', 'p1'),
      empAssigned('e3', 'L1.1', 'p1'),
    ];
    const states: MatchResult[] = computeMatchStates(employees, positions);
    expect(states.find((s) => s.employeeId === 'e1')!.status).toBe('placed');
    expect(states.find((s) => s.employeeId === 'e2')!.status).toBe('placed');
    expect(states.find((s) => s.employeeId === 'e3')).toMatchObject({ status: 'placed', positionOverflow: 1, overflowUnresolved: true });
  });

  it('未套岗 → unassigned；archived 岗位等同未套岗', () => {
    const positions = [pos('p1', 'd1', '归档', { status: 'archived', headcount: 2 })];
    const employees = [empAssigned('e1', 'L1.1', 'p1'), empAssigned('e2', 'L1.1', 'p1')];
    const states = computeMatchStates(employees, positions);
    expect(states.every((s) => s.status === 'unassigned')).toBe(true);
  });
});

describe('v2.1.1 空岗率口径一致（迁移后部门级数字不变）', () => {
  it('同一部门：positions 聚合 == 部门级 headcount（迁移前后一致）', () => {
    const mkEmps = () => Array.from({ length: 6 }, (_, i) => emp(`e${i}`, 'L1.1'));
    // 迁移前：headcount=10（无岗位）
    const legacy = dept('tech', '技术部', 1, { headcount: 10, employees: mkEmps() });
    // 迁移后：默认岗位 headcount=10（dept.headcount 为冗余派生）
    const migrated = dept('tech', '技术部', 1, {
      headcount: 10,
      positions: [pos('p1', 'tech', '默认岗位', { headcount: 10 })],
      employees: mkEmps(),
    });
    expect(deptHeadcount(migrated)).toBe(10);
    const legacyVac = computeL2([legacy]).find((x) => x.key === 'vacancy')!;
    const migratedVac = computeL2([migrated]).find((x) => x.key === 'vacancy')!;
    expect(legacyVac.value).toBeCloseTo(40, 0); // (10-6)/10
    expect(migratedVac.value).toBe(legacyVac.value);
    expect(migratedVac.status).toBe(legacyVac.status);
    // L1/L3 部门级数字不变
    expect(computeL1([migrated])[0].headcount).toBe(computeL1([legacy])[0].headcount);
    expect(computeL3([migrated], COSTS)[0].headcount).toBe(computeL3([legacy], COSTS)[0].headcount);
  });
});


describe('报告体验一致性回归', () => {
  it('父子成本只累计一次，未配置部门不能制造超编', () => {
    const tree = [dept('a', 'A', 1, { headcount: 3, employees: [emp('a1', 'L1.1')], children: [dept('ac', 'A子部门', 2, { employees: [emp('a2', 'L2.1')] })] }), dept('b', '未配编制', 1, { employees: [emp('b1', 'L3.2')] })];
    const report = computeHealthReport(tree, COSTS);
    expect(report.totals.totalEmployees).toBe(3);
    expect(report.totals.totalHeadcount).toBe(3);
    expect(report.totals.totalGap).toBe(1);
    expect(report.totals.totalCost).toBe(10);
    expect(computeHealthReport(tree, COSTS, 'ac').totals.totalDepartments).toBe(1);
  });
  it('只有子部门配编制时，父部门的未覆盖员工不进入缺口', () => {
    const root = dept('a', 'A', 1, { employees: [emp('a1', 'L1.1')], children: [dept('ac', 'A子部门', 2, { headcount: 2, employees: [emp('a2', 'L2.1')] })] });
    const report = computeHealthReport([root], COSTS);
    expect(report.totals.totalGap).toBe(1);
    expect(report.l3[0].gap).toBe(1);
    expect(report.l2.find((m) => m.key === 'vacancy')?.value).toBe(50);
  });
});
