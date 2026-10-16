import type { Employee, LevelConfig, Position } from '../types';
import { fullCode } from './level';
const round1 = (value: number) => Math.round(value * 10) / 10;

/** 获取某职级配置的月成本；未知职级返回 0 */
export function costForLevel(configs: LevelConfig[], code: string): number {
  const match = configs.find((c) => fullCode(c) === code);
  return typeof match?.cost === 'number' && Number.isFinite(match.cost) ? match.cost : 0;
}

/** 员工月成本：优先用员工个人成本 emp.cost，缺省降级按职级成本映射。 */
export function employeeCost(emp: Employee, configs: LevelConfig[]): number {
  if (typeof emp.cost === 'number' && Number.isFinite(emp.cost)) return emp.cost;
  return costForLevel(configs, emp.level);
}

/** 显式的零成本与没有成本数据分开。 */
export function hasEmployeeCost(emp: Employee, configs: LevelConfig[]): boolean {
  if (typeof emp.cost === 'number' && Number.isFinite(emp.cost) && emp.cost >= 0) return true;
  return configs.some((c) => fullCode(c) === emp.level && typeof c.cost === 'number' && Number.isFinite(c.cost) && c.cost >= 0);
}

export function positionUnitCost(
  pos: Position,
  assigned: Employee[],
  configs: LevelConfig[],
): { cost: number; basis: string } {
  for (const code of [pos.levelBandMin, pos.levelBandMax]) {
    if (!code) continue;
    const c = costForLevel(configs, code);
    if (c > 0) return { cost: c, basis: `岗位职级带宽 ${code} 的单位成本` };
  }
  const targetCosts = assigned
    .map((e) => (e.targetLevel ? costForLevel(configs, e.targetLevel) : 0))
    .filter((c) => c > 0);
  if (targetCosts.length > 0) {
    return {
      cost: round1(targetCosts.reduce((s, c) => s + c, 0) / targetCosts.length),
      basis: `在岗 ${targetCosts.length} 人目标职级成本均值（降级）`,
    };
  }
  const actualCosts = assigned.map((e) => employeeCost(e, configs)).filter((c) => c > 0);
  if (actualCosts.length > 0) {
    return {
      cost: round1(actualCosts.reduce((s, c) => s + c, 0) / actualCosts.length),
      basis: `在岗 ${actualCosts.length} 人实际成本均值（降级）`,
    };
  }
  return { cost: 0, basis: '无岗位带宽 / 目标职级 / 在岗成本依据' };
}
