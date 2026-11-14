import { describe, it, expect } from 'vitest';
import { DEFAULT_HEALTH_THRESHOLDS, type HealthThresholds } from './analytics';
import { Department, Employee, LevelConfig, Scenario } from '../types';
import { computeDiffTotals, computeScenarioTotals } from './scenarioDiff';
import { formatGapCostDelta, formatGapCostSide } from './statusUI';

const TH: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS;
const COST: LevelConfig[] = [{ code: 'L', number: '1', label: '一级', color: '#000000', cost: 4 }];

function emp(id: string, opts: Partial<Employee> = {}): Employee {
  return { id, name: id, employeeId: id, level: 'L1', ...opts };
}

function dept(id: string, name: string, level: number, opts: Partial<Department> = {}): Department {
  return { id, name, level, children: opts.children ?? [], employees: opts.employees ?? [], expanded: true, ...opts };
}

function scenario(id: string, departments: Department[], allEmployeesFlat: Employee[]): Scenario {
  return {
    id, name: id, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    departments, allEmployeesFlat, levelConfigs: COST, canvas: { zoom: 100 },
  };
}

/** 有编制、有缺口、无成本依据 → L3 gapCost=null */
function unknownGapRoot(id: string, headcount: number): Department {
  return dept(id, id, 1, { headcount });
}

/** 有编制、有在岗且成本完整：缺口成本 = gap × 4 */
function knownGapRoot(id: string, headcount: number, employeeIds: string[]): Department {
  return dept(id, id, 1, { headcount, employees: employeeIds.map((e) => emp(e)) });
}

describe('C03 缺口成本汇总与差额口径', () => {
  it('A-C03-01 基线全部无法估算、目标可估：汇总不得把基线未知收成 0，不得给出确定性差额', () => {
    const base = scenario('base', [unknownGapRoot('R', 2)], []);
    const tgt = scenario('tgt', [knownGapRoot('R', 2, ['E1'])], [emp('E1')]);
    const b = computeScenarioTotals(base, TH);
    const t = computeScenarioTotals(tgt, TH);
    expect(b.gapCostIncomplete).toBe(true);
    expect(b.totalGapCost).toBeNull();
    expect(b.gapCostKnownSubtotal).toBe(0);
    expect(b.gapCostUnestimatedCount).toBe(1);
    expect(t.gapCostIncomplete).toBe(false);
    expect(t.totalGapCost).toBe(4); // gap 1 × 4
    const diff = computeDiffTotals(base, tgt, TH);
    expect(diff.gapCostDelta).toBeNull();
    expect(formatGapCostSide(b)).toContain('未估');
    expect(formatGapCostSide(b)).not.toBe('0w');
    expect(formatGapCostDelta(diff.gapCostDelta)).toBe('无数据/不可比');
  });

  it('A-C03-02 部分岗位/根已知、部分未知：已知小计可识别，差额不把未估当 0', () => {
    const tree = [knownGapRoot('A', 2, ['E1']), unknownGapRoot('B', 2)];
    const s = scenario('mix', tree, [emp('E1')]);
    const tot = computeScenarioTotals(s, TH);
    expect(tot.gapCostIncomplete).toBe(true);
    expect(tot.totalGapCost).toBeNull();
    expect(tot.gapCostKnownSubtotal).toBe(4);
    expect(tot.gapCostUnestimatedCount).toBe(1);
    expect(formatGapCostSide(tot)).toBe('4w（已知小计，另有 1 项无法估算）');
    const diff = computeDiffTotals(s, s, TH);
    expect(diff.gapCostDelta).toBeNull();
  });

  it('A-C03-03 两侧完整且相等（含真实 0）：差额为 0，展示仍是 0', () => {
    const zero = scenario('z', [knownGapRoot('R', 1, ['E1'])], [emp('E1')]);
    const z = computeScenarioTotals(zero, TH);
    expect(z.gapCostIncomplete).toBe(false);
    expect(z.totalGapCost).toBe(0);
    expect(z.gapCostKnownSubtotal).toBe(0);
    expect(formatGapCostSide(z)).toBe('0w');
    expect(computeDiffTotals(zero, zero, TH).gapCostDelta).toBe(0);
    expect(formatGapCostDelta(0)).toBe('Δ 0w');
  });

  it('A-C03-04 两侧完整且不同：差额为两已知值之差', () => {
    const base = scenario('b', [knownGapRoot('R', 3, ['E1'])], [emp('E1')]); // gap 2 → 8
    const tgt = scenario('t', [knownGapRoot('R', 2, ['E1'])], [emp('E1')]); // gap 1 → 4
    const b = computeScenarioTotals(base, TH);
    const t = computeScenarioTotals(tgt, TH);
    expect(b.totalGapCost).toBe(8);
    expect(t.totalGapCost).toBe(4);
    expect(computeDiffTotals(base, tgt, TH).gapCostDelta).toBe(-4);
  });

  it('A-C03-06 / REQ-C03-05 两侧均无法估算：两侧都不得写成 0，差额不可比', () => {
    const s = scenario('u', [unknownGapRoot('R', 2)], []);
    const tot = computeScenarioTotals(s, TH);
    expect(tot.totalGapCost).toBeNull();
    expect(tot.gapCostIncomplete).toBe(true);
    expect(formatGapCostSide(tot)).not.toBe('0w');
    expect(computeDiffTotals(s, s, TH).gapCostDelta).toBeNull();
  });

  it('A-C03-07 / REQ-C03-06 仅目标侧未知：不得把目标当 0 再相减，不得显示降到 0', () => {
    const base = scenario('b', [knownGapRoot('R', 2, ['E1'])], [emp('E1')]);
    const tgt = scenario('t', [unknownGapRoot('R', 2)], []);
    const diff = computeDiffTotals(base, tgt, TH);
    const t = computeScenarioTotals(tgt, TH);
    expect(computeScenarioTotals(base, TH).totalGapCost).toBe(4);
    expect(t.totalGapCost).toBeNull();
    expect(diff.gapCostDelta).toBeNull();
    expect(formatGapCostSide(t)).not.toBe('0w');
    expect(formatGapCostDelta(diff.gapCostDelta)).toBe('无数据/不可比');
  });

  it('A-C03-08 / REQ-C03-07 无需估算即可判定为真实 0，不得置空', () => {
    const s = scenario('z', [knownGapRoot('R', 1, ['E1'])], [emp('E1')]);
    const tot = computeScenarioTotals(s, TH);
    expect(tot.totalGap).toBe(0);
    expect(tot.totalGapCost).toBe(0);
    expect(tot.gapCostIncomplete).toBe(false);
    expect(formatGapCostSide(tot)).toBe('0w');
  });

  it('A-C03-09 / REQ-C03-08 多根已知与未知混合', () => {
    const tree = [knownGapRoot('A', 3, ['E1']), unknownGapRoot('B', 2), knownGapRoot('C', 1, ['E2'])];
    // A gap 2 → 8；C gap 0 → 0；B unknown
    const s = scenario('m', tree, [emp('E1'), emp('E2')]);
    const tot = computeScenarioTotals(s, TH);
    expect(tot.gapCostIncomplete).toBe(true);
    expect(tot.totalGapCost).toBeNull();
    expect(tot.gapCostKnownSubtotal).toBe(8);
    expect(tot.gapCostUnestimatedCount).toBe(1);
    expect(formatGapCostSide(tot)).toBe('8w（已知小计，另有 1 项无法估算）');
  });
});
