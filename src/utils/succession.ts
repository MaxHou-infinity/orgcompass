import type { Department, LevelConfig, Successor, SuccessorReadiness } from '../types';
import { deriveManagementLoads } from './management';
import { levelRankMap } from './level';
import type { HealthThresholds } from './healthThresholds';

export const SUCCESSOR_READINESS_LABELS = { ready_now: '随时可接', ready_1_2y: '1–2 年可接', ready_3y_plus: '3 年以上' } as const;
export function isSuccessorReadiness(value: unknown): value is SuccessorReadiness {
  return value === 'ready_now' || value === 'ready_1_2y' || value === 'ready_3y_plus';
}
export function computeSuccession(roots: Department[], levels: LevelConfig[] = [], thresholds: Partial<HealthThresholds> = {}) {
  const graph = deriveManagementLoads(roots);
  const owners = graph.roles.ownerKeys;
  const ownerPositions = new Set([...graph.employeesByKey].filter(([key]) => owners.has(key)).map(([, e]) => e.positionId).filter(Boolean));
  const levelsOrder = levelRankMap(levels);
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
    const managerPosition = [...incumbents].some((id) => graph.roles.managerIds.has(id));
    const vacant = incumbents.size === 0;
    return { departmentId: department.id, departmentName: department.name, positionId: position.id, positionName: position.name, managerPosition, vacant,
      critical: position.isCritical ?? ownerPositions.has(position.id), candidates: [...candidates.values()], rawCandidates: position.successors ?? [],
      levelRank: levelsOrder.get(position.levelBandMax ?? position.levelBandMin ?? '') ?? -1,
      covered: [...candidates.values()].some((successor) => successor.readiness !== 'ready_3y_plus') };
  });
  const critical = all.filter((position) => position.critical);
  const coverage = critical.length ? critical.filter((position) => position.covered).length / critical.length * 100 : null;
  const frequency = new Map<string, string[]>();
  for (const position of critical) for (const candidate of position.candidates) frequency.set(candidate.employeeId, [...(frequency.get(candidate.employeeId) ?? []), position.positionName]);
  // v2.5.1：范围内一个继任人都没录入 → 「未配置」，属于数据缺失（nodata），不是 0% 覆盖率红灯。
  const configured = critical.some((position) => position.rawCandidates.length > 0);
  const baseStatus = coverage === null || !configured || critical.length < (thresholds.successionSampleMin ?? 5) ? 'nodata' as const
    : coverage >= (thresholds.successionHealthyMin ?? 70) ? 'healthy' as const : coverage >= (thresholds.successionWarnMin ?? 50) ? 'warn' as const : 'danger' as const;
  // v2.5.1：关键岗位已经空缺且没有近期可接的继任人，是正在发生的单点风险，覆盖率再高也至少「关注」。
  const vacantUncovered = critical.filter((p) => p.vacant && !p.covered);
  const status = baseStatus === 'healthy' && vacantUncovered.length > 0 ? 'warn' as const : baseStatus;
  // v2.5.1 管理者梯队（快速扩张场景）：管理岗的“近期可接”后备人数（去重真人）÷ 管理岗数。
  // 去重使同一人挂在多个管理岗下只算一份储备；没有任何继任录入时为未配置（nodata），不推断。
  const managerPositions = all.filter((p) => p.managerPosition);
  const bench = new Set(managerPositions.flatMap((p) => p.candidates.filter((c) => c.readiness !== 'ready_3y_plus').map((c) => c.employeeId)));
  const pipelineConfigured = managerPositions.some((p) => p.rawCandidates.length > 0);
  const pipelineRatio = managerPositions.length && pipelineConfigured ? Math.round(bench.size / managerPositions.length * 100) / 100 : null;
  const pipelineStatus = pipelineRatio === null || managerPositions.length < (thresholds.successionSampleMin ?? 5) ? 'nodata' as const
    : pipelineRatio >= (thresholds.pipelineHealthyMin ?? 0.8) ? 'healthy' as const : pipelineRatio >= (thresholds.pipelineWarnMin ?? 0.5) ? 'warn' as const : 'danger' as const;
  const pipeline = { managerPositions: managerPositions.length, readyBench: bench.size, ratio: pipelineRatio, status: pipelineStatus, configured: pipelineConfigured };
  return { all, configured, pipeline, vacantUncovered: vacantUncovered.map((p) => ({ positionId: p.positionId, positionName: p.positionName, departmentName: p.departmentName })), criticalCount: critical.length, coveredCount: critical.filter((p) => p.covered).length, coverage, status,
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
