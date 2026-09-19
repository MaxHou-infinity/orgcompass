import { describe, it, expect } from 'vitest';
import {
  computeHealthReport,
  computeL2,
  computeL3,
  directReports,
  isDeptLeader,
  deptHeadcountStatus,
  generateDeptSuggestions,
  computeManagerBreakdown,
  METRIC_CALIBER_NOTES,
} from './analytics';
import type { Department, Employee, Position } from '../types';

/**
 * —— v2.3.1 口径修复回归（审计报告 F-01 ~ F-06 + Q-08）——
 *
 * 这些断言的设计目标是「回退修复即失败」：把任何一条实现改回 v2.3.0 的写法，
 * 对应断言必须变红。每一项都对应一个真实用户可见的错误结论。
 */

function emp(id: string, name = id, extra: Partial<Employee> = {}): Employee {
  return { id, name, employeeId: `E-${id}`, level: 'L2.1', ...extra };
}

function dept(
  id: string,
  name: string,
  opts: Partial<Department> & { employees?: Employee[]; positions?: Position[] } = {},
): Department {
  return {
    id,
    name,
    level: opts.level ?? 1,
    expanded: true,
    children: opts.children ?? [],
    employees: opts.employees ?? [],
    positions: opts.positions,
    headcount: opts.headcount,
    leaderId: opts.leaderId,
    leaderName: opts.leaderName,
    leaderType: opts.leaderType,
  };
}

function pos(id: string, departmentId: string, headcount: number, status: Position['status'] = 'active'): Position {
  return { id, departmentId, name: `岗位${id}`, headcount, status, createdAt: 't', updatedAt: 't' };
}

const NO_COSTS: never[] = [];

// ───────────────────────── F-01 超编不得判健康 ─────────────────────────

describe('v2.3.1 F-01：超编时空岗率不得判「健康 / 编制基本满编」', () => {
  it('编制 1 / 实际 2 → 空岗率为负，但灯号与判读必须走超编口径', () => {
    const d = dept('d', '研发部', {
      headcount: 1,
      employees: [emp('a'), emp('b')],
    });
    const vacancy = computeL2([d]).find((m) => m.key === 'vacancy')!;
    expect(vacancy.value).toBeLessThan(0); // 仍用负值表达「超出编制」
    expect(vacancy.status).not.toBe('healthy'); // ← v2.3.0 是 healthy
    expect(vacancy.verdict).not.toContain('满编'); // ← v2.3.0 是「编制基本满编」
    expect(vacancy.verdict).toContain('超出编制');
  });

  it('超编与同层部门状态（deptStatus）判定方向一致', () => {
    const d = dept('d', '研发部', { headcount: 1, employees: [emp('a'), emp('b')] });
    const l3 = computeL3([d], NO_COSTS)[0];
    const vacancy = computeL2([d]).find((m) => m.key === 'vacancy')!;
    expect(l3.status).not.toBe('healthy');
    expect(vacancy.status).not.toBe('healthy');
  });

  it('恰好满编仍判健康（不误伤）', () => {
    const d = dept('d', '研发部', { headcount: 2, employees: [emp('a'), emp('b')] });
    const vacancy = computeL2([d]).find((m) => m.key === 'vacancy')!;
    expect(vacancy.value).toBe(0);
    expect(vacancy.status).toBe('healthy');
    expect(vacancy.verdict).toBe('编制基本满编');
  });
});

// ───────────────────────── F-02 管理幅度不含负责人本人 ─────────────────────────

describe('v2.3.1 F-02：管理幅度不得把负责人本人算作直管下属', () => {
  it('负责人是唯一成员 → 直管 0 人（旧实现为 1）', () => {
    const leader = emp('leader', '陈晨');
    const d = dept('d', '研发部', { employees: [leader], leaderId: 'E-leader', leaderName: '陈晨' });
    expect(isDeptLeader(leader, d)).toBe(true);
    expect(directReports(d)).toBe(0);
  });

  it('负责人 + 1 名下属 → 直管 1 人', () => {
    const d = dept('d', '研发部', {
      employees: [emp('leader'), emp('ic')],
      leaderId: 'E-leader',
    });
    expect(directReports(d)).toBe(1);
  });

  it('负责人 + 1 名下属 + 1 个有负责人子部门 → 直管 2 人', () => {
    const child = dept('c', '前端组', { leaderId: 'E-x' });
    const d = dept('d', '研发部', {
      employees: [emp('leader'), emp('ic')],
      leaderId: 'E-leader',
      children: [child],
    });
    expect(directReports(d)).toBe(2);
  });

  it('无 leaderId 时按姓名兜底剔除，且不影响同名之外的人', () => {
    const d = dept('d', '研发部', { employees: [emp('leader', '陈晨'), emp('other', '王雨')], leaderName: '陈晨' });
    expect(directReports(d)).toBe(1);
  });

  it('L2 管理幅度不再因「负责人即唯一成员」而把 critical 降级', () => {
    // 5 个部门，负责人都是本部门唯一成员 → span 中位数应为 0（旧实现为 1）
    const depts = ['a', 'b', 'c', 'd', 'e'].map((k) =>
      dept(k, `部门${k}`, { employees: [emp(`l-${k}`)], leaderId: `E-l-${k}` }),
    );
    const span = computeL2(depts).find((m) => m.key === 'span')!;
    expect(span.spanBreakdown?.median).toBe(0);
    // 旧实现把负责人本人算作下属 → 中位数 1 → warn，把「负责人无人直管」这一 critical 事实降级。
    expect(span.status).toBe('danger');
  });
});

// ───────────────────────── F-03 管理者比分子分母同键去重 ─────────────────────────

describe('v2.3.1 F-03：管理者比分子与分母必须同键去重', () => {
  it('同一真人被重复挂载 → 分母只计 1 人（旧实现按记录计 3）', () => {
    const shared = emp('shared');
    const a = dept('a', 'A', { employees: [shared], leaderId: 'E-shared' }); // 兼任 A、B 负责人
    const b = dept('b', 'B', { employees: [shared], leaderId: 'E-shared' });
    const c = dept('c', 'C', { employees: [shared] });
    const mb = computeManagerBreakdown([a, b, c]);
    expect(mb.internalManagers).toBe(1);
    expect(mb.totalEmployees).toBe(1); // ← v2.3.0 是 3
    expect(mb.nonManagerEmployees).toBe(0);
  });

  it('同一工号的两条记录按同一「人」去重', () => {
    const a = dept('a', 'A', { employees: [emp('id1', '张三', { employeeId: 'E001' })] });
    const b = dept('b', 'B', { employees: [emp('id2', '张三', { employeeId: 'E001' })] });
    const mb = computeManagerBreakdown([a, b]);
    expect(mb.totalEmployees).toBe(1);
  });

  it('管理者比不再因重复挂载被系统性低估', () => {
    const shared = emp('shared');
    const a = dept('a', 'A', { employees: [shared], leaderId: 'E-shared' });
    const b = dept('b', 'B', { employees: [shared] });
    const ratio = computeL2([a, b]).find((m) => m.key === 'managerRatio')!;
    expect(ratio.value).toBe(100); // 1 名内部负责人 / 1 名真人
  });

  it('报告 totals 与 L2 分母同源', () => {
    const shared = emp('shared');
    const a = dept('a', 'A', { employees: [shared, emp('x')], leaderId: 'E-shared' });
    const b = dept('b', 'B', { employees: [shared] });
    const report = computeHealthReport([a, b], NO_COSTS);
    expect(report.totals.totalEmployees).toBe(2); // shared + x
  });
});

// ───────────────────────── F-04 L1/L3 actual 与 gap 同口径 ─────────────────────────

describe('v2.3.1 F-04：L1/L3 的 actual 必须与 gap/status 同口径（真人去重）', () => {
  const build = () => {
    const shared = emp('shared');
    // 同一真人被挂到两个部门（数据问题），编制共 3
    const a = dept('a', 'A', { headcount: 2, employees: [shared, emp('x')] });
    const b = dept('b', 'B', { headcount: 1, employees: [shared] });
    return [a, b];
  };

  it('L3 行满足 gap === headcount - actual（不再「编制 3 / 实际 3 / 空岗 1」自相矛盾）', () => {
    const rows = computeL3(build(), NO_COSTS);
    for (const row of rows) {
      if (row.gap === null || row.headcount === null) continue;
      expect(row.gap).toBe(row.headcount - row.actual);
    }
  });

  it('L1 行同样自洽，且不把重复挂载算成两个人', () => {
    const report = computeHealthReport(build(), NO_COSTS);
    expect(report.l1[0].actual).toBe(2); // shared + x（shared 在两个部门只算一次）
    expect(report.l3[0].gap).toBe(report.l3[0].headcount! - report.l3[0].actual);
  });

  it('未配置编制的部门仍展示真实人数（不被去重口径压成 0）', () => {
    const d = dept('d', 'D', { employees: [emp('a'), emp('b')] });
    const row = computeL3([d], NO_COSTS)[0];
    expect(row.headcount).toBeNull();
    expect(row.actual).toBe(2);
  });

  it('成本口径同样按真人去重（避免人数去重而成本双计）', () => {
    const shared = emp('shared', 'shared', { cost: 10 });
    const a = dept('a', 'A', { headcount: 1, employees: [shared] });
    const b = dept('b', 'B', { headcount: 1, employees: [shared] });
    const rows = computeL3([a, b], NO_COSTS);
    // 每个子树各自算成本：A 子树 10、B 子树 10（子树视角下没有重复）
    expect(rows.find((r) => r.deptId === 'a')!.actualCost).toBe(10);
    // 跨子树不重复计：父子同挂时父子树只算一次
    const parent = dept('p', 'P', { headcount: 2, employees: [shared], children: [dept('c', 'C', { headcount: 1, employees: [shared] })] });
    const pRow = computeL3([parent], NO_COSTS)[0];
    expect(pRow.actual).toBe(1);
    expect(pRow.actualCost).toBe(10);
  });
});

// ───────────────────────── F-05 编制冻结 ≠ 未配置编制 ─────────────────────────

describe('v2.3.1 F-05：编制冻结必须与「未配置编制」分开表达', () => {
  it('全部岗位 frozen → 部门状态为 frozen，空岗率判读说明冻结而非「未配置」', () => {
    const d = dept('d', 'D', { positions: [pos('p1', 'd', 3, 'frozen'), pos('p2', 'd', 2, 'frozen')] });
    expect(deptHeadcountStatus(d)).toBe('frozen');
    const vacancy = computeL2([d]).find((m) => m.key === 'vacancy')!;
    expect(vacancy.verdict).toContain('冻结');
    expect(vacancy.verdict).not.toContain('未配置编制数据');
  });

  it('真正未配置 → 仍报「未配置编制数据」', () => {
    const d = dept('d', 'D', { employees: [emp('a')] });
    expect(deptHeadcountStatus(d)).toBe('unconfigured');
    const vacancy = computeL2([d]).find((m) => m.key === 'vacancy')!;
    expect(vacancy.verdict).toContain('未配置编制数据');
  });

  it('有 active 编制 → configured', () => {
    const d = dept('d', 'D', { positions: [pos('p1', 'd', 3), pos('p2', 'd', 3, 'frozen')] });
    expect(deptHeadcountStatus(d)).toBe('configured');
  });

  it('部门建议文案区分「编制冻结」与「未配置编制」', () => {
    const frozen = dept('f', '冻结部门', { positions: [pos('p1', 'f', 3, 'frozen')] });
    const unset = dept('u', '未配置部门', { employees: [emp('a')] });
    const titles = generateDeptSuggestions([frozen, unset], undefined).map((s) => s.title);
    expect(titles.some((t) => t.includes('编制冻结'))).toBe(true);
    expect(titles.some((t) => t.includes('未配置编制'))).toBe(true);
  });
});

// ───────────────────────── Q-08 口径文案与实现一致 ─────────────────────────

describe('v2.3.1 Q-08：口径文案与实现一致', () => {
  it('管理幅度口径说明写明「不含负责人本人」', () => {
    expect(METRIC_CALIBER_NOTES.span).toContain('不含负责人本人');
  });

  it('空岗率口径说明包含超编分支与冻结分支', () => {
    expect(METRIC_CALIBER_NOTES.vacancy).toContain('超出编制');
    expect(METRIC_CALIBER_NOTES.vacancy).toContain('冻结');
  });

  it('管理者比口径说明写明分子分母同键去重', () => {
    expect(METRIC_CALIBER_NOTES.managerRatio).toContain('真人');
    expect(METRIC_CALIBER_NOTES.managerRatio).toContain('同一键');
  });
});
