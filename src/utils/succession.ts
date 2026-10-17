import type { Department, LevelConfig, Successor, SuccessorReadiness } from '../types';
import { deriveManagementLoads } from './management';
import type { HealthThresholds } from './healthThresholds';

export const SUCCESSOR_READINESS_LABELS = { ready_now: '随时可接', ready_1_2y: '1–2 年可接', ready_3y_plus: '3 年以上' } as const;
export function isSuccessorReadiness(value: unknown): value is SuccessorReadiness {
  return value === 'ready_now' || value === 'ready_1_2y' || value === 'ready_3y_plus';
}
export function computeSuccession(roots: Department[], levels: LevelConfig[] = [], thresholds: Partial<HealthThresholds> = {}) {
  const graph = deriveManagementLoads(roots);
  const owners = graph.roles.ownerKeys;
  const ownerPositions = new Set([...graph.employeesByKey].filter(([key]) => owners.has(key)).map(([, e]) => e.positionId).filter(Boolean));
  const levelsOrder = new Map(levels.map((level, i) => [`${level.code}${level.number}`, i]));
  const positions: { department: Department; position: NonNullable<Department['positions']>[number] }[] = [];
  const walk = (list: Department[]) => list.forEach((d) => { for (const position of d.positions ?? []) if (position.status === 'active') positions.push({ department: d, position }); walk(d.children); });
  walk(roots);
  let invalidCandidates = 0;
  const all = positions.map(({ department, position }) => {
    const incumbents = new Set([...graph.employeesByKey].filter(([, e]) => e.positionId === position.id).map(([, e]) => e.id));
    const candidates = new Map<string, Successor>();
    for (const successor of position.successors ?? []) {
      const person = graph.roles.resolve(successor.employeeId);
      if (!person || incumbents.has(person.id) || !isSuccessorReadiness(successor.readiness)) { invalidCandidates++; continue; }
      candidates.set(person.id, { employeeId: person.id, readiness: successor.readiness });
    }
    return { departmentId: department.id, departmentName: department.name, positionId: position.id, positionName: position.name,
      critical: position.isCritical ?? ownerPositions.has(position.id), candidates: [...candidates.values()], rawCandidates: position.successors ?? [],
      levelRank: levelsOrder.get(position.levelBandMax ?? position.levelBandMin ?? '') ?? -1,
      covered: [...candidates.values()].some((successor) => successor.readiness !== 'ready_3y_plus') };
  });
  const critical = all.filter((position) => position.critical);
  const coverage = critical.length ? critical.filter((position) => position.covered).length / critical.length * 100 : null;
  const frequency = new Map<string, string[]>();
  for (const position of critical) for (const candidate of position.candidates) frequency.set(candidate.employeeId, [...(frequency.get(candidate.employeeId) ?? []), position.positionName]);
  const status = coverage === null || critical.length < (thresholds.successionSampleMin ?? 5) ? 'nodata' as const
    : coverage >= (thresholds.successionHealthyMin ?? 70) ? 'healthy' as const : coverage >= (thresholds.successionWarnMin ?? 50) ? 'warn' as const : 'danger' as const;
  return { all, criticalCount: critical.length, coveredCount: critical.filter((p) => p.covered).length, coverage, status,
    unconfigured: critical.filter((p) => p.rawCandidates.length === 0).length, invalidCandidates,
    risks: critical.filter((p) => p.candidates.length === 0).sort((a, b) => b.levelRank - a.levelRank),
    concentration: [...frequency].filter(([, list]) => list.length >= 3).map(([employeeId, positions]) => ({ employeeId, name: graph.roles.resolve(employeeId)?.name ?? employeeId, positions })) };
}

export interface SuccessorImport { positionId: string; employeeNumber: string; readiness: SuccessorReadiness }
export function mapSuccessorImportRows(rows: Record<string, unknown>[]): SuccessorImport[] {
  if (rows.length === 0) throw new Error('继任表没有数据');
  return rows.map((row, i) => {
    const positionId = String(row['岗位 ID'] ?? '').trim();
    const employeeNumber = String(row['继任人工号'] ?? '').trim();
    const readiness = row['准备度'];
    if (!positionId || !employeeNumber || !isSuccessorReadiness(readiness)) throw new Error(`继任表第 ${i + 2} 行：需填写岗位 ID、继任人工号和有效准备度（ready_now / ready_1_2y / ready_3y_plus）`);
    return { positionId, employeeNumber, readiness };
  });
}
/** 先验证整批，调用方一次性落地；不按姓名猜继任人、不接受工号歧义或现任人。 */
export function validateSuccessorImport(rows: SuccessorImport[], roots: Department[]) {
  const graph = deriveManagementLoads(roots);
  const positions = computeSuccession(roots).all;
  const result = new Map<string, { departmentId: string; successors: Successor[] }>();
  for (const row of rows) {
    const position = positions.find((p) => p.positionId === row.positionId);
    const matches = [...graph.employeesByKey.values()].filter((e) => e.employeeId === row.employeeNumber);
    if (!position || matches.length !== 1 || matches[0].positionId === row.positionId) throw new Error(`无法导入 ${row.positionId}/${row.employeeNumber}：岗位不存在、工号缺失/歧义或继任人为现任人`);
    const entry = result.get(row.positionId) ?? { departmentId: position.departmentId, successors: [...position.rawCandidates] };
    entry.successors = [...entry.successors.filter((candidate) => candidate.employeeId !== matches[0].id), { employeeId: matches[0].id, readiness: row.readiness }];
    result.set(row.positionId, entry);
  }
  return result;
}
