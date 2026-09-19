import { describe, it, expect } from 'vitest';
import { computeHealthReport, computeL2, DEFAULT_HEALTH_THRESHOLDS, HealthThresholds, L2Metric } from './analytics';
import { Department, Employee, LevelConfig, Scenario } from '../types';
import {
  computeScenarioDiff,
  computeMetricDiffs,
  computeDeptDiffs,
  computePersonnelChanges,
  computeDiffTotals,
  computeScenarioTotals,
} from './scenarioDiff';

const TH: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS;

/** 便捷构造员工（employeeId = id，保证「负责人命中名册」的内部判定） */
function emp(id: string, opts: Partial<Employee> = {}): Employee {
  return { id, name: `员工${id}`, employeeId: id, level: 'L1', ...opts };
}

/** 便捷构造部门 */
function dept(id: string, name: string, level: number, opts: Partial<Department> = {}): Department {
  return {
    id,
    name,
    level,
    children: opts.children ?? [],
    employees: opts.employees ?? [],
    expanded: true,
    ...opts,
  };
}

/** 便捷构造场景 */
function scenario(id: string, departments: Department[], allEmployeesFlat: Employee[], levelConfigs: LevelConfig[] = []): Scenario {
  return {
    id,
    name: id,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    departments,
    allEmployeesFlat,
    levelConfigs,
    canvas: { zoom: 100 },
  };
}

/** 职级成本配置：L1 = 4w/月 */
const COST_CONFIGS: LevelConfig[] = [{ code: 'L', number: '1', label: '一级', color: '#000000', cost: 4 }];

it('场景对比与诊断报告对部分编制和多层成本采用一致汇总', () => {
  const employees = [emp('a'), emp('b'), emp('c')];
  const tree = [dept('root', '根部门', 1, {
    employees: [employees[0]], children: [dept('child', '已配编制', 2, { headcount: 2, employees: [employees[1]] })],
  }), dept('other', '未配编制', 1, { employees: [employees[2]] })];
  const totals = computeScenarioTotals(scenario('baseline', tree, employees, COST_CONFIGS));
  const report = computeHealthReport(tree, COST_CONFIGS);
  expect(totals.totalGap).toBe(1);
  expect(totals.totalGap).toBe(report.totals.totalGap);
  expect(totals.totalCost).toBe(12);
  expect(totals.totalCost).toBe(report.totals.totalCost);
});

/** 手造 L2 指标（只测 computeMetricDiffs 的差异逻辑，不依赖引擎语义） */
function metric(key: L2Metric['key'], value: number | null, status: 'healthy' | 'warn' | 'danger'): L2Metric {
  return { key, label: key, value, unit: '', status, verdict: '' };
}

describe('computeMetricDiffs（指标差异纯函数）', () => {
  it('指标值变化 → delta = 目标 − 基线，灯号各自保留', () => {
    const diffs = computeMetricDiffs([metric('span', 3, 'healthy')], [metric('span', 5, 'warn')]);
    expect(diffs).toHaveLength(4);
    const span = diffs.find((d) => d.key === 'span')!;
    expect(span.baseline).toBe(3);
    expect(span.target).toBe(5);
    expect(span.delta).toBe(2);
    expect(span.comparable).toBe(true);
    expect(span.baselineStatus).toBe('healthy');
    expect(span.targetStatus).toBe('warn');
  });

  it('任一方不可算 → delta=null 且 comparable=false，状态为 null（不把缺失当 0）', () => {
    const diffs = computeMetricDiffs([metric('span', null, 'warn')], [metric('span', 5, 'healthy')]);
    const span = diffs.find((d) => d.key === 'span')!;
    expect(span.baseline).toBeNull();
    expect(span.target).toBe(5);
    expect(span.delta).toBeNull();
    expect(span.comparable).toBe(false);
    expect(span.baselineStatus).toBeNull();
    expect(span.targetStatus).toBeNull();
  });

  it('缺失 key → 视为不可比；label/unit 取任一侧', () => {
    const diffs = computeMetricDiffs([metric('span', 3, 'healthy')], []);
    expect(diffs).toHaveLength(4);
    expect(diffs.find((d) => d.key === 'depth')!.comparable).toBe(false);
    expect(diffs.find((d) => d.key === 'span')!.comparable).toBe(false);
    expect(diffs.find((d) => d.key === 'span')!.delta).toBeNull();
  });
});

describe('computeScenarioDiff · 指标组装', () => {
  it('指标键顺序固定（span/depth/managerRatio/vacancy），值与 computeL2 输出对齐', () => {
    const base = scenario(
      'sc-base',
      [dept('d1', '技术部', 1, { leaderId: 'E1', leaderName: '员工E1', headcount: 5, employees: [emp('E1')] })],
      [emp('E1')],
    );
    const tgt = scenario(
      'sc-tgt',
      [dept('d1', '技术部', 1, { leaderId: 'E1', leaderName: '员工E1', headcount: 5, employees: [emp('E1'), emp('E2')] })],
      [emp('E1'), emp('E2')],
    );
    const diff = computeScenarioDiff(base, tgt, TH);
    expect(diff.metrics.map((m) => m.key)).toEqual(['span', 'depth', 'managerRatio', 'vacancy']);
    // 与 computeL2 输出直接对齐（差异层只做对齐+求差，不重复计算）
    expect(diff.metrics).toEqual(computeMetricDiffs(computeL2(base.departments, TH), computeL2(tgt.departments, TH)));
    expect(diff.baselineScenarioId).toBe('sc-base');
    expect(diff.targetScenarioId).toBe('sc-tgt');
  });

  it('基线未配置编制、目标已配置 → vacancy 不可比（不把缺失当 0）', () => {
    const base = scenario('sc-base', [dept('d1', '技术部', 1, { leaderId: 'E1', leaderName: '员工E1', employees: [emp('E1')] })], [emp('E1')]);
    const tgt = scenario('sc-tgt', [dept('d1', '技术部', 1, { leaderId: 'E1', leaderName: '员工E1', headcount: 10, employees: [emp('E1')] })], [emp('E1')]);
    const vacancy = computeScenarioDiff(base, tgt, TH).metrics.find((m) => m.key === 'vacancy')!;
    expect(vacancy.baseline).toBeNull();
    expect(vacancy.target).not.toBeNull();
    expect(vacancy.delta).toBeNull();
    expect(vacancy.comparable).toBe(false);
  });

  it('空树基线 → 层级深度不可比（引擎的 0 不当作真实值）', () => {
    const base = scenario('sc-base', [], []);
    const tgt = scenario('sc-tgt', [dept('d1', '研发部', 1, { leaderId: 'E1', leaderName: '员工E1', employees: [emp('E1')] })], [emp('E1')]);
    const depth = computeScenarioDiff(base, tgt, TH).metrics.find((m) => m.key === 'depth')!;
    expect(depth.baseline).toBeNull();
    expect(depth.delta).toBeNull();
    expect(depth.comparable).toBe(false);
  });

  it('整体健康度取最差灯号；全部不可算 → overall=null 且 comparable=false', () => {
    const emptyA = scenario('sc-a', [], []);
    const emptyB = scenario('sc-b', [], []);
    const diff = computeScenarioDiff(emptyA, emptyB, TH);
    expect(diff.overall.baseline).toBeNull();
    expect(diff.overall.target).toBeNull();
    expect(diff.overall.comparable).toBe(false);
  });
});

describe('computeDeptDiffs（部门差异表）', () => {
  it('新增 / 删除：delta 取目标值 / 基线值取负', () => {
    const base = scenario('sc-base', [dept('d1', '技术部', 1, { headcount: 5, employees: [emp('E1')] })], [emp('E1')]);
    const tgt = scenario(
      'sc-tgt',
      [
        dept('d1', '技术部', 1, { headcount: 5, employees: [emp('E1')] }),
        dept('d2', '市场部', 1, { headcount: 2, employees: [] }),
      ],
      [emp('E1')],
    );
    const added = computeDeptDiffs(base, tgt, TH).find((d) => d.changeType === 'added')!;
    expect(added.deptId).toBe('d2');
    expect(added.baseline).toBeUndefined();
    expect(added.target?.headcount).toBe(2);
    expect(added.delta.headcount).toBe(2);

    const removed = computeDeptDiffs(tgt, base, TH).find((d) => d.changeType === 'removed')!;
    expect(removed.deptId).toBe('d2');
    expect(removed.baseline?.headcount).toBe(2);
    expect(removed.target).toBeUndefined();
    expect(removed.delta.headcount).toBe(-2);
    expect(removed.delta.actual).toBe(0);
  });

  it('层级变化 → moved；父级变化 → reparented（父级优先于层级）', () => {
    const base = scenario(
      'sc-base',
      [
        dept('root', '集团', 1, {
          children: [dept('d1', '研发部', 2, { parentId: 'root', employees: [emp('E1')] })],
        }),
      ],
      [emp('E1')],
    );
    // 层级变化（父级不变）
    const movedTgt = scenario(
      'sc-tgt-moved',
      [
        dept('root', '集团', 1, {
          children: [dept('d1', '研发部', 3, { parentId: 'root', employees: [emp('E1')] })],
        }),
      ],
      [emp('E1')],
    );
    expect(computeDeptDiffs(base, movedTgt, TH).find((d) => d.deptId === 'd1')!.changeType).toBe('moved');
    // 父级变化（换到另一棵树下）
    const reparentTgt = scenario(
      'sc-tgt-reparent',
      [
        dept('root2', '集团2', 1, {
          children: [dept('d1', '研发部', 2, { parentId: 'root2', employees: [emp('E1')] })],
        }),
      ],
      [emp('E1')],
    );
    expect(computeDeptDiffs(base, reparentTgt, TH).find((d) => d.deptId === 'd1')!.changeType).toBe('reparented');
  });

  it('负责人变化 → leader-changed', () => {
    const base = scenario('sc-base', [dept('d1', '研发部', 1, { leaderId: 'E1', leaderName: '员工E1', headcount: 4, employees: [emp('E1')] })], [emp('E1')]);
    const tgt = scenario('sc-tgt', [dept('d1', '研发部', 1, { leaderId: 'E2', leaderName: '员工E2', headcount: 4, employees: [emp('E2')] })], [emp('E2')]);
    const d = computeDeptDiffs(base, tgt, TH).find((x) => x.deptId === 'd1')!;
    expect(d.changeType).toBe('leader-changed');
    expect(d.baseline?.leaderName).toBe('员工E1');
    expect(d.target?.leaderName).toBe('员工E2');
  });

  it('编制变化 → config-changed；完全一致 → unchanged', () => {
    const base = scenario('sc-base', [dept('d1', '研发部', 1, { headcount: 5, employees: [emp('E1')] })], [emp('E1')]);
    const cfgTgt = scenario('sc-tgt', [dept('d1', '研发部', 1, { headcount: 6, employees: [emp('E1')] })], [emp('E1')]);
    expect(computeDeptDiffs(base, cfgTgt, TH).find((d) => d.deptId === 'd1')!.changeType).toBe('config-changed');
    const sameTgt = scenario('sc-tgt', [dept('d1', '研发部', 1, { headcount: 5, employees: [emp('E1')] })], [emp('E1')]);
    const unchanged = computeDeptDiffs(base, sameTgt, TH).find((d) => d.deptId === 'd1')!;
    expect(unchanged.changeType).toBe('unchanged');
    expect(unchanged.delta.headcount).toBe(0);
    expect(unchanged.delta.actual).toBe(0);
    expect(unchanged.delta.gap).toBe(0);
    // v2.3.1 F-11：该 fixture 未配置职级成本（levelConfigs=[]）→ 缺口成本不可估算，
    // 「未知 vs 未知」的差值同样未知（null，界面显示「—」），不再当成 0。
    expect(unchanged.delta.gapCost).toBeNull();
  });

  it('编制缺失不可比：一侧未配置 → headcount/gap/gapCost Δ 为 null，actual Δ 仍可算', () => {
    const base = scenario('sc-base', [dept('d1', '研发部', 1, { employees: [emp('E1')] })], [emp('E1')]);
    const tgt = scenario('sc-tgt', [dept('d1', '研发部', 1, { headcount: 10, employees: [emp('E1')] })], [emp('E1')]);
    const d = computeDeptDiffs(base, tgt, TH).find((x) => x.deptId === 'd1')!;
    expect(d.baseline?.headcount).toBeNull();
    expect(d.delta.headcount).toBeNull();
    expect(d.delta.gap).toBeNull();
    expect(d.delta.gapCost).toBeNull();
    expect(d.delta.actual).toBe(0);
  });

  it('同名唯一兜底匹配（容忍 id 漂移）', () => {
    const base = scenario('sc-base', [dept('a', '研发部', 2, { headcount: 5 })], []);
    const tgt = scenario('sc-tgt', [dept('b', '研发部', 2, { headcount: 5 })], []);
    const diffs = computeDeptDiffs(base, tgt, TH);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].deptId).toBe('a');
    expect(diffs[0].changeType).toBe('unchanged');
  });
});

describe('computePersonnelChanges（人员调动清单）', () => {
  it('换部门 → moved-dept（带新旧部门与负责人名）', () => {
    const base = scenario(
      'sc-base',
      [dept('da', '研发部', 1, { leaderId: 'L1', leaderName: '组长L1', employees: [emp('E1')] })],
      [emp('E1')],
    );
    const tgt = scenario(
      'sc-tgt',
      [dept('db', '产品部', 1, { leaderId: 'L2', leaderName: '组长L2', employees: [emp('E1')] })],
      [emp('E1')],
    );
    const changes = computePersonnelChanges(base, tgt);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual(
      expect.objectContaining({
        employeeId: 'E1',
        type: 'moved-dept',
        fromDeptName: '研发部',
        toDeptName: '产品部',
        fromLeaderName: '组长L1',
        toLeaderName: '组长L2',
      }),
    );
  });

  it('部门不变、负责人变 → moved-reporting（换汇报线）', () => {
    const base = scenario(
      'sc-base',
      [dept('d1', '研发部', 1, { leaderId: 'L1', leaderName: '组长L1', employees: [emp('E1')] })],
      [emp('E1')],
    );
    const tgt = scenario(
      'sc-tgt',
      [dept('d1', '研发部', 1, { leaderId: 'L2', leaderName: '组长L2', employees: [emp('E1')] })],
      [emp('E1')],
    );
    const changes = computePersonnelChanges(base, tgt);
    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe('moved-reporting');
    expect(changes[0].toDeptName).toBe('研发部');
    expect(changes[0].fromLeaderName).toBe('组长L1');
    expect(changes[0].toLeaderName).toBe('组长L2');
  });

  it('新增 / 移除（含未入架构员工）', () => {
    const base = scenario('sc-base', [], [emp('E1'), emp('E5')]);
    const tgt = scenario('sc-tgt', [], [emp('E1'), emp('E6')]);
    const changes = computePersonnelChanges(base, tgt);
    expect(changes).toHaveLength(2);
    expect(changes.find((c) => c.type === 'added')).toEqual(
      expect.objectContaining({ employeeId: 'E6', toDeptName: undefined }),
    );
    expect(changes.find((c) => c.type === 'removed')).toEqual(
      expect.objectContaining({ employeeId: 'E5', fromDeptName: undefined }),
    );
  });

  it('未入架构员工进入部门 → moved-dept（from 无部门）', () => {
    const base = scenario('sc-base', [], [emp('E9')]);
    const tgt = scenario('sc-tgt', [dept('d1', '研发部', 1, { leaderId: 'L1', leaderName: '组长L1', employees: [emp('E9')] })], [emp('E9')]);
    const changes = computePersonnelChanges(base, tgt);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual(
      expect.objectContaining({ employeeId: 'E9', type: 'moved-dept', fromDeptName: undefined, toDeptName: '研发部' }),
    );
  });

  it('兼岗虚拟员工标记透传（isVirtual）', () => {
    const virtualEmp: Employee = { id: 'v1', name: '兼岗x', employeeId: 'v1', level: 'L1', isVirtual: true };
    const base = scenario('sc-base', [], []);
    const tgt = scenario('sc-tgt', [dept('d1', '研发部', 1, { employees: [virtualEmp] })], [virtualEmp]);
    const changes = computePersonnelChanges(base, tgt);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual(expect.objectContaining({ type: 'added', isVirtual: true }));
  });

  it('树内与 flat 列表同人只算一次（去重）', () => {
    const base = scenario('sc-base', [dept('d1', '研发部', 1, { employees: [emp('E1')] })], [emp('E1')]);
    const tgt = scenario(
      'sc-tgt',
      [dept('d1', '研发部', 1, { employees: [emp('E1')] }), dept('d2', '产品部', 1, { employees: [emp('E2')] })],
      [emp('E1'), emp('E2'), emp('E2')],
    );
    const changes = computePersonnelChanges(base, tgt);
    expect(changes).toHaveLength(1);
    expect(changes[0].employeeId).toBe('E2');
  });
});

describe('computeScenarioTotals / computeDiffTotals（缺口与成本汇总）', () => {
  it('编制/缺口/成本按 L1 子树口径，不重复累计父子', () => {
    const base = scenario(
      'sc-base',
      [
        dept('root', '集团', 1, {
          headcount: 10,
          employees: [emp('E1')],
          children: [dept('child', '研发部', 2, { parentId: 'root', headcount: 6, employees: [emp('E2')] })],
        }),
      ],
      [emp('E1'), emp('E2')],
      COST_CONFIGS,
    );
    const tgt = scenario(
      'sc-tgt',
      [
        dept('root', '集团', 1, {
          headcount: 10,
          employees: [emp('E1')],
          children: [dept('child', '研发部', 2, { parentId: 'root', headcount: 6, employees: [emp('E2'), emp('E3')] })],
        }),
      ],
      [emp('E1'), emp('E2'), emp('E3')],
      COST_CONFIGS,
    );
    const b = computeScenarioTotals(base, TH);
    const t = computeScenarioTotals(tgt, TH);
    expect(b.totalHeadcount).toBe(16); // 10 + 6（L1 子树，不重复累计）
    expect(b.totalEmployees).toBe(2);
    expect(b.totalGap).toBe(14);
    expect(b.totalCost).toBe(8); // 2 人 × 4w
    expect(t.totalGap).toBe(13);
    expect(t.totalCost).toBe(12);

    const totals = computeDiffTotals(base, tgt, TH);
    expect(totals.headcountDelta).toBe(0);
    expect(totals.gapDelta).toBe(-1);
    expect(totals.costDelta).toBe(4);
    expect(totals.gapCostDelta).toBe(-4); // (13×4) − (14×4)
  });

  it('一方完全未配置编制 → 编制/缺口/缺口成本 Δ 为 null，成本 Δ 仍可算', () => {
    const base = scenario('sc-base', [dept('d1', '研发部', 1, { employees: [emp('E1')] })], [emp('E1')], COST_CONFIGS);
    const tgt = scenario('sc-tgt', [dept('d1', '研发部', 1, { headcount: 4, employees: [emp('E1')] })], [emp('E1')], COST_CONFIGS);
    const totals = computeDiffTotals(base, tgt, TH);
    expect(totals.headcountDelta).toBeNull();
    expect(totals.gapDelta).toBeNull();
    expect(totals.gapCostDelta).toBeNull();
    expect(totals.costDelta).toBe(0);
  });
});

describe('computeScenarioDiff · 端到端', () => {
  it('完整场景差异：部门增删/编制移动/人员调动/汇总/整体灯号一次算清', () => {
    const base = scenario(
      'sc-base',
      [
        dept('R1', '研发中心', 1, {
          leaderId: 'L1',
          leaderName: '组长L1',
          headcount: 10,
          children: [dept('C1', '研发一组', 2, { parentId: 'R1', headcount: 4, employees: [emp('E2')] })],
          employees: [emp('E1')],
        }),
      ],
      [emp('E1'), emp('E2'), emp('E5')],
      COST_CONFIGS,
    );
    const tgt = scenario(
      'sc-tgt',
      [
        dept('R1', '研发中心', 1, {
          leaderId: 'L1',
          leaderName: '组长L1',
          headcount: 10,
          children: [dept('C1', '研发一组', 2, { parentId: 'R1', headcount: 4, employees: [emp('E2')] })],
          employees: [],
        }),
        dept('R2', '产品中心', 1, {
          leaderId: 'L3',
          leaderName: '组长L3',
          headcount: 2,
          employees: [emp('E1'), emp('E3')],
        }),
      ],
      [emp('E1'), emp('E2'), emp('E3'), emp('E6')],
      COST_CONFIGS,
    );

    const diff = computeScenarioDiff(base, tgt, TH);

    // 部门差异：R2 新增；R1 因人员移出（实际人数变）→ config-changed；C1 不变
    expect(diff.departmentDiffs.map((d) => d.deptId).sort()).toEqual(['C1', 'R1', 'R2']);
    expect(diff.departmentDiffs.find((d) => d.deptId === 'R2')!.changeType).toBe('added');
    expect(diff.departmentDiffs.find((d) => d.deptId === 'R1')!.changeType).toBe('config-changed');
    expect(diff.departmentDiffs.find((d) => d.deptId === 'C1')!.changeType).toBe('unchanged');

    // 人员调动：E1 换部门；E3/E6 新增；E5 移除；E2 不动
    expect(diff.personnelChanges.map((c) => c.employeeId).sort()).toEqual(['E1', 'E3', 'E5', 'E6']);
    expect(diff.personnelChanges.find((c) => c.employeeId === 'E3')!.type).toBe('added');
    expect(diff.personnelChanges.find((c) => c.employeeId === 'E5')!.type).toBe('removed');
    expect(diff.personnelChanges.find((c) => c.employeeId === 'E1')!.type).toBe('moved-dept');
    expect(diff.personnelChanges.find((c) => c.employeeId === 'E1')!.fromDeptName).toBe('研发中心');
    expect(diff.personnelChanges.find((c) => c.employeeId === 'E1')!.toDeptName).toBe('产品中心');

    // 汇总：编制 +2；总人数 +1（E3 新增、E1 仍在）；缺口 +1；成本 +4（E3）
    expect(diff.totals.headcountDelta).toBe(2);
    expect(diff.totals.gapDelta).toBe(1);
    expect(diff.totals.costDelta).toBe(4);

    // 整体灯号：双方都可算
    expect(diff.overall.comparable).toBe(true);
    expect(['healthy', 'warn', 'danger']).toContain(diff.overall.baseline);
    expect(['healthy', 'warn', 'danger']).toContain(diff.overall.target);
  });
});
