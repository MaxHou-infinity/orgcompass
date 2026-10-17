import type { Department, LevelConfig } from '../types';
import { deriveManagementLoads } from './management';
import { fullCode, levelRankMap } from './level';

export function computeReportingChains(roots: Department[], levels: LevelConfig[] = []) {
  const graph = deriveManagementLoads(roots);
  const excluded = new Set(graph.excluded.map((e) => e.employeeKey));
  const chains: { employeeId: string; deptId: string; names: string[]; keys: string[]; length: number }[] = [];
  let incomplete = 0;
  for (const [start, employee] of graph.employeesByKey) {
    const keys: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = start;
    let valid = true;
    while (current) {
      if (excluded.has(current) || seen.has(current) || !graph.employeesByKey.has(current)) { valid = false; break; }
      seen.add(current); keys.push(current); current = graph.parentByKey.get(current);
    }
    if (!valid) { incomplete++; continue; }
    chains.push({ employeeId: employee.id, deptId: graph.employeeDept.get(start)!.id,
      names: keys.map((key) => graph.employeesByKey.get(key)!.name), keys, length: keys.length - 1 });
  }
  // v2.5.1：顶层负责人（链长 0，没有上级）不是“被汇报链隔开”的人，不进入分位数，避免压低 P50/P90。
  const sorted = chains.filter((c) => c.length > 0).map((c) => c.length).sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] : null;
  const distribution = [...new Set(sorted)].map((length) => ({ length, count: sorted.filter((n) => n === length).length }));
  // v2.5.1：按每个职级的可比职级值（rank，缺省由编号推导）比较，跨序列 L/E 按实际资历；列表顺序不影响结果。
  const ranks = levelRankMap(levels);
  const order = new Map(levels.filter((level) => ranks.has(fullCode(level))).map((level) => [fullCode(level), { ...level, rank: ranks.get(fullCode(level))! }]));
  const inversions: { managerId: string; managerName: string; managerLevel: string; employeeId: string; employeeName: string; employeeLevel: string; deptId: string; kind: 'inversion' | 'equal' }[] = [];
  const missingLevels = new Set<string>();
  let checkedRelations = 0;
  for (const [key, parent] of graph.parentByKey) {
    const employee = graph.employeesByKey.get(key);
    const manager = graph.employeesByKey.get(parent);
    if (!employee || !manager) continue;
    const employeeLevel = order.get(employee.level), managerLevel = order.get(manager.level);
    if (!employeeLevel) missingLevels.add(key);
    if (!managerLevel) missingLevels.add(parent);
    if (!employeeLevel || !managerLevel) continue;
    checkedRelations++;
    if (employeeLevel.rank >= managerLevel.rank) inversions.push({ managerId: manager.id, managerName: manager.name, managerLevel: manager.level,
      employeeId: employee.id, employeeName: employee.name, employeeLevel: employee.level, deptId: graph.employeeDept.get(key)!.id,
      kind: employeeLevel.rank === managerLevel.rank ? 'equal' : 'inversion' });
  }
  const compressed = chains.filter((chain) => {
    const managerKeys = chain.keys.filter((key) => graph.roles.managerKeys.has(key));
    if (managerKeys.length < 2) return false;
    return managerKeys.slice(1).every((key, i) => {
      const lower = order.get(graph.employeesByKey.get(managerKeys[i])!.level);
      const upper = order.get(graph.employeesByKey.get(key)!.level);
      // “不足一整级”：相邻管理层可比职级值差 < 1（含跨序列，按 rank 比较）。
      return lower && upper && upper.rank >= lower.rank && upper.rank - lower.rank < 1;
    });
  });
  return { count: chains.length, total: graph.total, incomplete, p50: percentile(0.5), p90: percentile(0.9), max: sorted.at(-1) ?? null,
    distribution, longest: [...chains].sort((a, b) => b.length - a.length || a.employeeId.localeCompare(b.employeeId)).slice(0, 5),
    inversions, compressed: compressed.slice().sort((a, b) => b.length - a.length).filter((chain, i, list) => list.findIndex((candidate) => candidate.keys.filter((key) => graph.roles.managerKeys.has(key)).join('|') === chain.keys.filter((key) => graph.roles.managerKeys.has(key)).join('|')) === i),
    missingLevels: missingLevels.size, checkedRelations };
}
