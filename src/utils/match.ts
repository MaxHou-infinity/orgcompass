import type { Department, Employee, Position, MatchStatus, PositionAssignment } from '../types';
import { assignmentIssue, indexPlacements, indexPrimaryAssignments, placementIssue } from './placement';

export interface MatchResult {
  employeeId: string;
  status: MatchStatus;
  positionId?: string;
  reason?: 'no_position' | 'overstaffed' | 'unknown' | 'not-competent';
  dataIssue?: string;
  /** 岗位超额为事实；缺可信顺序时不任意给个人分配超编身份。 */
  positionOverflow?: number;
  overflowUnresolved?: boolean;
}

export function computeMatchStates(
  allEmployees: Employee[], positions: Position[], confirmedNotCompetent?: ReadonlySet<string>,
  assignments: PositionAssignment[] = [], departments?: Department[],
): MatchResult[] {
  const byId = new Map(positions.map((p) => [p.id, p]));
  const index = departments ? indexPlacements(departments) : undefined;
  const primaryRecords = indexPrimaryAssignments(assignments);
  const duplicateIds = new Set<string>();
  const seen = new Set<string>();
  for (const e of allEmployees) { if (seen.has(e.id)) duplicateIds.add(e.id); seen.add(e.id); }
  const employees = [...new Map(allEmployees.filter((e) => !e.isVirtual).map((e) => [e.id, e])).values()];
  const issueFor = (e: Employee) => duplicateIds.has(e.id) ? '名册存在重复内部标识'
    : (index ? placementIssue(e, index) : undefined) ?? assignmentIssue(e, primaryRecords.get(e.id) ?? []);
  const occupants = new Map<string, Employee[]>();
  for (const e of employees) {
    const p = e.positionId ? byId.get(e.positionId) : undefined;
    if (!p || p.status === 'archived' || issueFor(e)) continue;
    occupants.set(p.id, [...(occupants.get(p.id) ?? []), e]);
  }
  const overflowByPosition = new Map<string, { count: number; late: Set<string>; unresolved: boolean }>();
  for (const [pid, emps] of occupants) {
    const p = byId.get(pid)!;
    if (p.status !== 'active' || p.headcount <= 0 || emps.length <= p.headcount) continue;
    const arrivals = emps.map((e) => {
      const active = (primaryRecords.get(e.id) ?? []).filter((a) => a.positionId === pid);
      const a = active.length === 1 ? active[0] : undefined;
      return { id: e.id, time: a?.source === 'operation' && a.startDate ? Date.parse(a.startDate) : NaN };
    });
    arrivals.sort((a, b) => a.time - b.time);
    const boundary = Math.floor(p.headcount);
    const unresolved = arrivals.some((a) => !Number.isFinite(a.time))
      || arrivals[boundary - 1]?.time === arrivals[boundary]?.time;
    overflowByPosition.set(pid, { count: emps.length - p.headcount, unresolved,
      late: new Set(unresolved ? [] : arrivals.slice(boundary).map((a) => a.id)) });
  }
  return employees.map((e) => {
    const issue = issueFor(e);
    if (issue) return { employeeId: e.id, positionId: e.positionId, status: 'unassigned', reason: 'unknown', dataIssue: issue };
    const p = e.positionId ? byId.get(e.positionId) : undefined;
    if (!p || p.status === 'archived') return { employeeId: e.id, status: 'unassigned', reason: 'no_position' };
    const overflow = overflowByPosition.get(p.id);
    const isConfirmed = confirmedNotCompetent?.has(e.id);
    const late = overflow?.late.has(e.id);
    return { employeeId: e.id, positionId: p.id,
      status: isConfirmed ? 'not_competent' : late ? 'overstaffed' : 'placed',
      reason: isConfirmed ? 'not-competent' : late ? 'overstaffed' : undefined,
      ...(overflow ? { positionOverflow: overflow.count, overflowUnresolved: overflow.unresolved } : {}),
    };
  });
}
