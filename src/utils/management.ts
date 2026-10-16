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
      if ((d.leaderType ?? 'owner') === 'owner' && (d.leaderId || d.leaderName)) {
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
      const owner = (d.leaderType ?? 'owner') === 'owner' && (d.leaderId || d.leaderName)
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
          if (!manager || roles.personKey(manager) === key) { invalid.add(key); continue; }
          const managerKey = roles.personKey(manager);
          if (!loads.has(managerKey)) ensure(managerKey, manager.name, employeeDept.get(managerKey) ?? d);
          add(explicit, key, managerKey);
        } else {
          const manager = [...path].reverse().find((id) => id !== key);
          if (manager) add(candidates, key, manager);
        }
      }
      walk(d.children, path);
    }
  };
  walk(roots, []);
  let unresolved = 0;
  for (const key of new Set([...candidates.keys(), ...explicit.keys(), ...invalid])) {
    const targets = explicit.get(key) ?? candidates.get(key);
    if (invalid.has(key) || !targets || targets.size !== 1) { unresolved++; continue; }
    loads.get([...targets][0])?.reports.add(key);
  }
  return { roles, loads: [...loads.values()], unresolved };
}
