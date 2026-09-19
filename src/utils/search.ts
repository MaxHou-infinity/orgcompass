import { Department } from '../types';
import { flattenDepartments } from './analytics';

/**
 * 组织搜索（v2.0.3 P0-2，纯函数可测）。
 *
 * 支持按「部门名 / 员工姓名 / 员工工号」搜索，输出：
 * - 部门命中与员工命中（含所属部门路径）
 * - 需展开的祖先部门 id 集合（用于自动展开父级）
 * 搜索逻辑与组件解耦，便于单测。
 */

export interface SearchMatch {
  type: 'department' | 'employee';
  /** 部门 id 或员工 id */
  id: string;
  /** 所属部门 id（员工命中时为其所在部门；部门命中时为自己） */
  deptId: string;
  /** 展示名（部门名 / 员工名） */
  name: string;
  /** 副标题（部门路径 / 员工工号 + 职级） */
  sub: string;
  /** 祖先链（含自身）部门 id，用于自动展开 */
  ancestry: string[];
}

export interface SearchResult {
  matches: SearchMatch[];
  /** 需展开的部门 id（祖先链去重） */
  expandIds: string[];
  count: number;
}

/** 建立部门 id → 直属父级 id 的映射（根部门父级为 undefined） */
export function buildParentMap(depts: Department[]): Map<string, string | undefined> {
  const map = new Map<string, string | undefined>();
  const walk = (list: Department[], parentId?: string) => {
    for (const d of list) {
      map.set(d.id, parentId);
      walk(d.children, d.id);
    }
  };
  walk(depts);
  return map;
}

/** 执行搜索 */
export function searchOrg(depts: Department[], rawQuery: string): SearchResult {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return { matches: [], expandIds: [], count: 0 };

  const parentMap = buildParentMap(depts);
  // 记录每个部门节点的祖先链（由 parentMap 反查，含自身）
  const ancestryCache = new Map<string, string[]>();
  const getAncestry = (deptId: string): string[] => {
    const cached = ancestryCache.get(deptId);
    if (cached) return cached;
    const chain: string[] = [];
    let cur: string | undefined = deptId;
    while (cur) {
      chain.unshift(cur);
      cur = parentMap.get(cur);
    }
    ancestryCache.set(deptId, chain);
    return chain;
  };

  const matches: SearchMatch[] = [];
  const expand = new Set<string>();

  // 部门命中
  for (const d of flattenDepartments(depts)) {
    if (d.name.toLowerCase().includes(query)) {
      const ancestry = getAncestry(d.id);
      matches.push({
        type: 'department',
        id: d.id,
        deptId: d.id,
        name: d.name,
        sub: `部门 · L${d.level}`,
        ancestry,
      });
      // 命中部门自身不展开（要高亮它），仅展开祖先
      ancestry.forEach((id) => {
        if (id !== d.id) expand.add(id);
      });
    }
  }

  // 员工命中（含所属部门）
  const empSeen = new Set<string>();
  const walkEmps = (list: Department[]) => {
    for (const d of list) {
      const ancestry = getAncestry(d.id);
      for (const e of d.employees) {
        if (!e.name && !e.employeeId) continue;
        if (
          e.name.toLowerCase().includes(query) ||
          e.employeeId.toLowerCase().includes(query)
        ) {
          if (empSeen.has(e.id)) continue;
          empSeen.add(e.id);
          matches.push({
            type: 'employee',
            id: e.id,
            deptId: d.id,
            name: e.name,
            sub: `员工 · ${e.employeeId} · ${e.level} · ${d.name}`,
            ancestry,
          });
          // 员工命中要展开其所属部门+祖先
          ancestry.forEach((id) => expand.add(id));
        }
      }
      walkEmps(d.children);
    }
  };
  walkEmps(depts);

  return { matches, expandIds: [...expand], count: matches.length };
}

/**
 * 展开给定部门 id 的祖先链（含目标自身），返回新树。
 * 无任何展开状态变化时返回原引用（避免产生空历史）。
 */
export function expandDepartments(depts: Department[], ids: Set<string>): Department[] {
  if (ids.size === 0) return depts;
  // v2.3.1（T-03）：未发生任何变化的层必须**返回原数组引用**。
  // 旧实现 list.map(...) 每次都会新建数组，于是 children !== d.children 恒为 true →
  // 即使目标 id 一个都没命中，也会重建整棵树并返回新引用（调用方会误以为状态变了，
  // 进而产生无意义的历史快照 / 人岗重算）。这与该函数自己的注释「避免空历史」相矛盾。
  const mapList = (list: Department[]): Department[] => {
    let changed = false;
    const next = list.map((d) => {
      const children = mapList(d.children);
      const expanded = ids.has(d.id) ? true : d.expanded;
      if (children === d.children && expanded === d.expanded) return d;
      changed = true;
      return { ...d, children, expanded };
    });
    return changed ? next : list;
  };
  return mapList(depts);
}

/** 员工 id → 所属部门 id 的工具（批量移动用）：给定组织树与员工集合，返回 empId→deptId。 */
export function employeeDeptMap(depts: Department[], empIds: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const wanted = new Set(empIds);
  if (wanted.size === 0) return map;
  const walk = (list: Department[]) => {
    for (const d of list) {
      for (const e of d.employees) {
        if (wanted.has(e.id)) map.set(e.id, d.id);
      }
      walk(d.children);
    }
  };
  walk(depts);
  return map;
}


/** 搜索命中的成员必须可见；清除搜索后保留用户原先的展开选择。 */
export function expandedMembersForSearch(depts: Department[], expanded: ReadonlySet<string>, employeeIds: ReadonlySet<string>): Set<string> {
  const result = new Set(expanded);
  const walk = (list: Department[]) => {
    for (const dept of list) {
      if (dept.employees.some((emp) => employeeIds.has(emp.id))) result.add(dept.id);
      walk(dept.children);
    }
  };
  if (employeeIds.size) walk(depts);
  return result;
}
