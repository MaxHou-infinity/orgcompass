import type { Assessment, Department, Employee, Position, PositionAssignment } from '../types';
import type { HistorySnapshot } from './history';

export interface PlacementIndex {
  employees: Map<string, Array<{ departmentId: string; employee: Employee }>>;
  positions: Map<string, Position>;
  departments: Map<string, Department>;
}

export function indexPlacements(departments: Department[]): PlacementIndex {
  const index: PlacementIndex = { employees: new Map(), positions: new Map(), departments: new Map() };
  const walk = (list: Department[]) => {
    for (const d of list) {
      index.departments.set(d.id, d);
      for (const p of d.positions ?? []) index.positions.set(p.id, p);
      for (const employee of d.employees) {
        const entries = index.employees.get(employee.id) ?? [];
        entries.push({ departmentId: d.id, employee });
        index.employees.set(employee.id, entries);
      }
      walk(d.children);
    }
  };
  walk(departments);
  return index;
}

export function placementIssue(employee: Employee, index: PlacementIndex): string | undefined {
  const locations = index.employees.get(employee.id) ?? [];
  if (locations.length > 1) return '同一人员记录出现在多个位置';
  if (!employee.positionId) return locations[0]?.employee.positionId ? '画布与名册的岗位引用不一致' : undefined;
  const p = index.positions.get(employee.positionId);
  if (!p || p.status === 'archived') return '当前岗位不存在或已归档';
  if (locations.length === 0) return '已套岗但未进入组织架构';
  if (locations[0].departmentId !== p.departmentId) return '人员部门与岗位所属部门不一致';
  if (locations[0].employee.positionId !== employee.positionId) return '画布与名册的岗位引用不一致';
  return undefined;
}

export function assignmentIssue(employee: Employee, records: PositionAssignment[]): string | undefined {
  const active = records.filter((a) => a.employeeId === employee.id && a.type === 'primary' && a.status === 'active' && !a.endDate);
  if (active.length > 1) return '存在多条在任主岗关系，需核对历史';
  if (active.length === 1 && active[0].positionId !== employee.positionId) return '在任关系与当前主岗引用不一致';
  return undefined;
}

export function indexPrimaryAssignments(records: PositionAssignment[]): Map<string, PositionAssignment[]> {
  const index = new Map<string, PositionAssignment[]>();
  for (const a of records) {
    if (a.type !== 'primary' || a.status !== 'active' || a.endDate) continue;
    const rows = index.get(a.employeeId) ?? [];
    rows.push(a); index.set(a.employeeId, rows);
  }
  return index;
}

export function inspectPlacements(employees: Employee[], departments: Department[], records: PositionAssignment[] = [], assessments: Assessment[] = []): string[] {
  const index = indexPlacements(departments);
  const issues: string[] = [];
  const primaryRecords = indexPrimaryAssignments(records);
  const seen = new Set<string>();
  const real = new Set(employees.filter((e) => !e.isVirtual).map((e) => e.id));
  for (const e of employees) {
    if (seen.has(e.id)) issues.push(`${e.name}：名册内存在重复内部标识`);
    seen.add(e.id);
    const issue = placementIssue(e, index);
    if (issue) issues.push(`${e.name}：${issue}`);
    const relationIssue = !e.isVirtual && assignmentIssue(e, primaryRecords.get(e.id) ?? []);
    if (relationIssue) issues.push(`${e.name}：${relationIssue}`);
    if (e.isVirtual && (!e.primaryEmployeeId || !real.has(e.primaryEmployeeId))) {
      issues.push(`${e.name}：兼岗记录没有可核对的真人引用`);
    }
  }
  for (const [id, entries] of index.employees) {
    if (!seen.has(id)) issues.push(`${entries[0].employee.name}：画布人员不在名册中`);
  }
  const orphanScores = assessments.filter((a) => !real.has(a.employeeId));
  if (orphanScores.length) issues.push(`${orphanScores.length} 条评分的真人对象无法核对；原记录保留，不自动匹配同名人员`);
  const orphanActive = records.filter((a) => a.status === 'active' && !a.endDate && !real.has(a.employeeId));
  if (orphanActive.length) issues.push(`${orphanActive.length} 条在任关系的真人对象无法核对；原记录保留，需核对历史`);
  return issues;
}

type Relation = { employeeId: string; positionId: string; type: 'primary' | 'secondary' };
const key = (r: Relation) => JSON.stringify([r.employeeId, r.positionId, r.type]);
const newId = () => `asg-${crypto.randomUUID()}`;

function currentRelations(employees: Employee[], departments: Department[]): Relation[] {
  const index = indexPlacements(departments);
  const real = new Set(employees.filter((e) => !e.isVirtual).map((e) => e.id));
  const ids = new Map<string, number>();
  for (const e of employees) ids.set(e.id, (ids.get(e.id) ?? 0) + 1);
  const out = new Map<string, Relation>();
  for (const e of employees) {
    if (!e.positionId || ids.get(e.id) !== 1 || placementIssue(e, index)) continue;
    if (e.isVirtual && (!e.primaryEmployeeId || !real.has(e.primaryEmployeeId))) continue;
    const relation: Relation = {
      employeeId: e.isVirtual ? e.primaryEmployeeId! : e.id,
      positionId: e.positionId,
      type: e.isVirtual ? 'secondary' : 'primary',
    };
    out.set(key(relation), relation);
  }
  return [...out.values()];
}

/** 旧投影只证明当前关联。不给旧任职补 startDate，也不猜测结束时间。 */
export function seedLegacyAssignments(
  employees: Employee[], departments: Department[], records: PositionAssignment[], now: string, linkConfirmations = true,
): PositionAssignment[] {
  const index = indexPlacements(departments);
  const out: PositionAssignment[] = records.map((r) => ({ ...r, source: r.source ?? 'legacy' }));
  const activeByKey = new Map<string, PositionAssignment[]>();
  for (const a of out) {
    if (a.status !== 'active' || a.endDate) continue;
    const rows = activeByKey.get(key(a)) ?? [];
    rows.push(a); activeByKey.set(key(a), rows);
  }
  for (const r of currentRelations(employees, departments)) {
    const active = activeByKey.get(key(r)) ?? [];
    if (active.length === 0) {
      const p = index.positions.get(r.positionId)!;
      const created: PositionAssignment = { ...r, id: newId(), status: 'active', source: 'legacy',
        positionName: p.name, departmentName: index.departments.get(p.departmentId)?.name,
        createdAt: now, updatedAt: now };
      out.push(created); activeByKey.set(key(r), [created]);
    }
  }
  const currentKeys = new Set(currentRelations(employees, departments).map(key));
  for (const a of out) {
    const active = activeByKey.get(key(a));
    if (linkConfirmations && currentKeys.has(key(a)) && active?.length === 1 && a.status === 'not_competent' && !a.relationId && !a.endDate) a.relationId = active[0].id;
  }
  return out;
}

/** 只在显式结构操作时调用：同一次快照提交同步投影与任职。展开/改名不触碰人岗事实。 */
export function reconcilePlacementChange(prev: HistorySnapshot, next: HistorySnapshot, now: string): HistorySnapshot {
  if (prev === next) return prev;
  const before = indexPlacements(prev.departments);
  const after = indexPlacements(next.departments);
  const oldEmployees = new Map(prev.allEmployeesFlat.map((e) => [e.id, e]));
  const touched = new Set<string>();
  const locations = (i: PlacementIndex, id: string) => (i.employees.get(id) ?? []).map((x) => x.departmentId).sort().join('\0');
  const nextEmployees = next.allEmployeesFlat.map((e) => {
    const old = oldEmployees.get(e.id);
    const p = e.positionId ? after.positions.get(e.positionId) : undefined;
    const oldP = old?.positionId ? before.positions.get(old.positionId) : undefined;
    const changed = !old || old.positionId !== e.positionId || locations(before, e.id) !== locations(after, e.id)
      || oldP?.status !== p?.status || oldP?.departmentId !== p?.departmentId;
    if (!changed) return e;
    touched.add(e.id);
    const loc = after.employees.get(e.id) ?? [];
    if (e.positionId && (!p || p.status === 'archived' || loc.length !== 1 || loc[0].departmentId !== p.departmentId)) {
      return { ...e, positionId: undefined, assignmentType: e.isVirtual ? 'secondary' as const : 'primary' as const };
    }
    return e;
  });
  const nextIds = new Set(nextEmployees.map((e) => e.id));
  for (const old of prev.allEmployeesFlat) if (!nextIds.has(old.id)) touched.add(old.id);
  if (touched.size === 0) return next;
  const flat = new Map(nextEmployees.map((e) => [e.id, e]));
  const syncTree = (list: Department[]): Department[] => list.map((d) => ({ ...d,
    employees: d.employees.map((e) => touched.has(e.id) && flat.has(e.id) ? { ...e, ...flat.get(e.id)! } : e),
    children: syncTree(d.children),
  }));
  const departments = syncTree(next.departments);
  const beforeRelations = currentRelations(prev.allEmployeesFlat, prev.departments);
  const afterRelations = currentRelations(nextEmployees, departments);
  const wanted = new Set(afterRelations.map(key));
  const prior = new Set(beforeRelations.map(key));
  const touchedRelations = new Set(prev.allEmployeesFlat.filter((e) => touched.has(e.id) && e.positionId)
    .map((e) => key({ employeeId: e.isVirtual ? e.primaryEmployeeId ?? e.id : e.id,
      positionId: e.positionId!, type: e.isVirtual ? 'secondary' : 'primary' })));
  const touchedPrimary = new Set([...prev.allEmployeesFlat, ...nextEmployees].filter((e) => touched.has(e.id) && !e.isVirtual).map((e) => e.id));
  // 仅为变更前已存在但未记历史的关系补“未知日期”的关联，不能给旧岗位写今天的到岗时间。
  let records = seedLegacyAssignments(prev.allEmployeesFlat, prev.departments, next.positionAssignments, now, false);
  records = records.map((a) => a.status === 'active' && !a.endDate
    && (prior.has(key(a)) || touchedRelations.has(key(a)) || (a.type === 'primary' && touchedPrimary.has(a.employeeId)))
    && (!wanted.has(key(a)) || !prior.has(key(a)))
    ? { ...a, status: 'ended' as const, endDate: now, updatedAt: now } : a);
  const index = indexPlacements(departments);
  for (const r of afterRelations) {
    if (prior.has(key(r))) continue;
    const p = index.positions.get(r.positionId)!;
    records.push({ ...r, id: newId(), status: 'active', source: 'operation', startDate: now,
      positionName: p.name, departmentName: index.departments.get(p.departmentId)?.name,
      createdAt: now, updatedAt: now });
  }
  return { ...next, departments, allEmployeesFlat: nextEmployees, positionAssignments: records };
}

/** 套岗统一入口：主岗所在部门随目标岗位对齐，清理重复挂载。 */
export function assignPrimary(prev: HistorySnapshot, employeeId: string, positionId: string): HistorySnapshot {
  const e = prev.allEmployeesFlat.find((x) => x.id === employeeId && !x.isVirtual);
  const index = indexPlacements(prev.departments);
  const p = index.positions.get(positionId);
  if (!e || !p || p.status === 'archived' || !index.departments.has(p.departmentId)) return prev;
  if (e.positionId === p.id && !placementIssue(e, index)) return prev;
  const assigned = { ...e, positionId, assignmentType: 'primary' as const };
  const update = (list: Department[]): Department[] => list.map((d) => ({ ...d,
    employees: [...d.employees.filter((x) => x.id !== employeeId), ...(d.id === p.departmentId ? [assigned] : [])],
    children: update(d.children),
  }));
  return { ...prev, departments: update(prev.departments), allEmployeesFlat: prev.allEmployeesFlat.map((x) => x.id === e.id ? assigned : x) };
}
