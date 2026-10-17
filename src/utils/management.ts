import type { Department, Employee } from '../types';

/** 负责人身份与实际带人身份共用解析器；姓名只在唯一命中时兜底。 */
export function deriveManagerRoles(departments: Department[], employees: Employee[]) {
  const real = employees.filter((e) => !e.isVirtual);
  const personKey = (e: Employee) => e.employeeId || e.id;
  const byReference = new Map<string, Employee[]>();
  const byName = new Map<string, Employee[]>();
  const add = (map: Map<string, Employee[]>, key: string, e: Employee) => {
    if (key) map.set(key, [...(map.get(key) ?? []), e]);
  };
  for (const e of real) {
    add(byReference, e.id, e);
    if (e.employeeId !== e.id) add(byReference, e.employeeId, e);
    add(byName, e.name, e);
  }
  const unique = (matches: Employee[] = []) =>
    new Set(matches.map(personKey)).size === 1 ? matches[0] : undefined;
  const resolve = (reference: string) => unique(byReference.get(reference));
  const resolveLeader = (dept: Department) => dept.leaderId
    ? resolve(dept.leaderId)
    : dept.leaderName ? unique(byName.get(dept.leaderName)) : undefined;
  const ownerKeys = new Set<string>();
  const reportingKeys = new Set<string>();
  const walk = (list: Department[]) => {
    for (const d of list) {
      const leader = resolveLeader(d);
      if ((d.leaderType ?? 'owner') === 'owner' && leader) ownerKeys.add(personKey(leader));
      walk(d.children);
    }
  };
  walk(departments);
  for (const e of real) {
    const manager = e.reportsToEmployeeId ? resolve(e.reportsToEmployeeId) : undefined;
    if (manager && personKey(manager) !== personKey(e)) reportingKeys.add(personKey(manager));
  }
  const managerKeys = new Set([...ownerKeys, ...reportingKeys]);
  return {
    personKey, resolve, resolveLeader, ownerKeys, reportingKeys, managerKeys,
    managerIds: new Set(real.filter((e) => managerKeys.has(personKey(e))).map((e) => e.id)),
  };
}

export interface ManagerLoad {
  key: string;
  name: string;
  deptIds: string[];
  deptNames: string[];
  reports: Set<string>;
  isDepartmentOwner: boolean;
}

export type ReportingExclusionReason = '引用不存在' | '循环汇报' | '自己汇报给自己' | '重名无法匹配' | '冲突汇报';
export interface ReportingExclusion {
  employeeKey: string;
  employeeId: string;
  name: string;
  deptId: string;
  deptName: string;
  reason: ReportingExclusionReason;
}

export interface ReportingCoverage {
  total: number;
  included: number;
  coverage: number | null;
  excluded: ReportingExclusion[];
}

/** 部门覆盖率使用全局已核对关系的异常清单，避免把合法跨部门上级误判为不存在。 */
export function reportingCoverage(roots: Department[], department?: Department): ReportingCoverage {
  const management = deriveManagementLoads(roots);
  if (!department) return management;
  const ids = new Set<string>();
  const members = new Set<string>();
  const walk = (d: Department) => {
    ids.add(d.id);
    d.employees.filter((e) => !e.isVirtual).forEach((e) => members.add(management.roles.personKey(e)));
    d.children.forEach(walk);
  };
  walk(department);
  const excluded = management.excluded.filter((e) => members.has(e.employeeKey));
  return { total: members.size, included: members.size - excluded.length,
    coverage: members.size ? (members.size - excluded.length) / members.size : null, excluded };
}

/** 明确汇报关系优先；未填时穿透无负责人子组，推断到最近的正职负责人。
 * 同人兼任多个正职合并负荷；无效/冲突引用保持未知，不按姓名猜上级。
 */
export function deriveManagementLoads(roots: Department[]) {
  const employees: Employee[] = [];
  const collect = (list: Department[]) => {
    for (const d of list) { employees.push(...d.employees); collect(d.children); }
  };
  collect(roots);
  const roles = deriveManagerRoles(roots, employees);
  const loads = new Map<string, ManagerLoad>();
  const candidates = new Map<string, Set<string>>();
  const explicit = new Map<string, Set<string>>();
  const invalid = new Set<string>();
  const reasons = new Map<string, ReportingExclusionReason>();
  const employeeDept = new Map<string, Department>();
  const locate = (list: Department[]) => {
    for (const d of list) {
      for (const e of d.employees) if (!e.isVirtual && !employeeDept.has(roles.personKey(e))) employeeDept.set(roles.personKey(e), d);
      locate(d.children);
    }
  };
  locate(roots);
  const ensure = (key: string, name: string, dept: Department, isOwner = false) => {
    let load = loads.get(key);
    if (!load) {
      load = { key, name, deptIds: [], deptNames: [], reports: new Set(), isDepartmentOwner: isOwner };
      loads.set(key, load);
    }
    if (isOwner) load.isDepartmentOwner = true;
    if (!load.deptIds.includes(dept.id)) { load.deptIds.push(dept.id); load.deptNames.push(dept.name); }
    return load;
  };
  const add = (map: Map<string, Set<string>>, employee: string, manager: string) => {
    if (employee === manager) return;
    const set = map.get(employee) ?? new Set();
    set.add(manager); map.set(employee, set);
  };
  const registerOwners = (list: Department[]) => {
    for (const d of list) {
      const leader = roles.resolveLeader(d);
      const ambiguous = !leader && !d.leaderId && employees.some((e) => !e.isVirtual && e.name === d.leaderName);
      if (!ambiguous && (d.leaderType ?? 'owner') === 'owner' && (d.leaderId || d.leaderName)) {
        const key = leader ? roles.personKey(leader) : `external:${d.leaderId || d.leaderName}`;
        ensure(key, leader?.name ?? d.leaderName ?? d.leaderId!, d, true);
      }
      registerOwners(d.children);
    }
  };
  registerOwners(roots);
  const walk = (list: Department[], ancestors: string[]) => {
    for (const d of list) {
      const leader = roles.resolveLeader(d);
      const ambiguous = !leader && !d.leaderId && employees.some((e) => !e.isVirtual && e.name === d.leaderName);
      const owner = !ambiguous && (d.leaderType ?? 'owner') === 'owner' && (d.leaderId || d.leaderName)
        ? leader ? roles.personKey(leader) : `external:${d.leaderId || d.leaderName}` : undefined;
      if (owner) {
        ensure(owner, leader?.name ?? d.leaderName ?? d.leaderId!, d, true);
        // 子部门负责人本身也是上一级经理的一名下属，不以部门个数重复计人。
        const parent = [...ancestors].reverse().find((key) => key !== owner);
        if (parent && !leader?.reportsToEmployeeId) add(candidates, owner, parent);
      }
      const path = owner ? [...ancestors, owner] : ancestors;
      for (const e of d.employees) {
        if (e.isVirtual) continue;
        const key = roles.personKey(e);
        if (e.reportsToEmployeeId) {
          const manager = roles.resolve(e.reportsToEmployeeId);
          if (!manager || roles.personKey(manager) === key) {
            invalid.add(key);
            const matches = employees.filter((candidate) => !candidate.isVirtual &&
              (candidate.id === e.reportsToEmployeeId || candidate.employeeId === e.reportsToEmployeeId || candidate.name === e.reportsToEmployeeId));
            reasons.set(key, manager ? '自己汇报给自己' : new Set(matches.map(roles.personKey)).size > 1 ? '重名无法匹配' : '引用不存在');
            continue;
          }
          const managerKey = roles.personKey(manager);
          if (!loads.has(managerKey)) ensure(managerKey, manager.name, employeeDept.get(managerKey) ?? d);
          add(explicit, key, managerKey);
        } else {
          const manager = [...path].reverse().find((id) => id !== key);
          if (manager) add(candidates, key, manager);
          else if (ambiguous) { invalid.add(key); reasons.set(key, '重名无法匹配'); }
        }
      }
      walk(d.children, path);
    }
  };
  walk(roots, []);
  const parentByKey = new Map<string, string>();
  for (const key of new Set([...candidates.keys(), ...explicit.keys(), ...invalid])) {
    const targets = explicit.get(key) ?? candidates.get(key);
    if (invalid.has(key) || !targets || targets.size !== 1) {
      reasons.set(key, reasons.get(key) ?? '冲突汇报'); continue;
    }
    parentByKey.set(key, [...targets][0]);
  }
  // 对最终显式优先的图查环，结构兜底也可能与跨部门显式关系形成环。
  const visited = new Set<string>();
  for (const start of parentByKey.keys()) {
    const path: string[] = [];
    const indexes = new Map<string, number>();
    let key: string | undefined = start;
    while (key && !visited.has(key)) {
      if (indexes.has(key)) {
        for (const member of path.slice(indexes.get(key)!)) reasons.set(member, '循环汇报');
        break;
      }
      indexes.set(key, path.length); path.push(key); key = parentByKey.get(key);
    }
    path.forEach((member) => visited.add(member));
  }
  for (const key of reasons.keys()) parentByKey.delete(key);
  for (const [key, parent] of parentByKey) loads.get(parent)?.reports.add(key);
  const employeesByKey = new Map(employees.filter((e) => !e.isVirtual).map((e) => [roles.personKey(e), e]));
  const excluded: ReportingExclusion[] = [...reasons].flatMap(([key, reason]) => {
    const employee = employeesByKey.get(key);
    const dept = employeeDept.get(key);
    return employee && dept ? [{ employeeKey: key, employeeId: employee.id, name: employee.name, deptId: dept.id, deptName: dept.name, reason }] : [];
  });
  const total = employeesByKey.size;
  return { roles, loads: [...loads.values()], unresolved: excluded.length, excluded, parentByKey,
    employeesByKey, employeeDept, total, included: total - excluded.length,
    coverage: total > 0 ? (total - excluded.length) / total : null };
}
