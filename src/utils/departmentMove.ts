import type { Department } from '../types';
import { findDeptById } from './departments';

/**
 * `target` 是否为 `source` 的严格子孙（不含自身）。
 *
 * 从 source 向下查找 target.id，拒绝把部门移动到自己的后代。
 * 用于拒绝「移入自身后代」，并允许向父/祖先上移。
 */
export function isDescendant(source: Department, target: Department): boolean {
  const walk = (dept: Department): boolean => {
    for (const child of dept.children) {
      if (child.id === target.id) return true;
      if (walk(child)) return true;
    }
    return false;
  };
  return walk(source);
}

/**
 * 画布投放与 `moveDepartmentInTree` 入口共用的合法性判定：
 * 拒绝自身、拒绝移入自身后代；允许向父/祖先上移及无关目标。
 * 拖到根（target 为 null）不走此函数，由调用方按根处理。
 * 移到当前父视为合法，移动函数再将其做成无操作（不产生伪变更）。
 */
export function allowsDepartmentMove(source: Department, target: Department): boolean {
  return source.id !== target.id && !isDescendant(source, target);
}

/** 与 `allowsDepartmentMove` 同一规则（保留原名供既有测试与对照）。 */
export function existingCanvasAllowsDepartmentDrop(source: Department, target: Department): boolean {
  return allowsDepartmentMove(source, target);
}

/** 按新深度重算整棵子树的 level（只改 level，不改 parentId / 人员 / 岗位）。 */
export function relevelSubtree(dept: Department, baseLevel: number): Department {
  return {
    ...dept,
    level: baseLevel,
    children: dept.children.map((child) => relevelSubtree(child, baseLevel + 1)),
  };
}

export interface MoveDepartmentResult {
  departments: Department[];
  moved: boolean;
}

/** 在树结构上找直接父 id；已在根返回 null；找不到源返回 undefined。 */
export function currentParentId(depts: Department[], id: string): string | null | undefined {
  if (depts.some((d) => d.id === id)) return null;
  for (const d of depts) {
    if (d.children.some((c) => c.id === id)) return d.id;
    const inner = currentParentId(d.children, id);
    if (inner !== undefined) return inner;
  }
  return undefined;
}

/**
 * 将部门（含其原有子树）挂到新父节点或根，并只对被移动子树递推 level。
 * 旁支原样返回（结构共享）。
 *
 * 与画布同一规则：非法（自身 / 移入后代）或目标不存在 / 源不存在 → 返回原树引用，moved=false。
 * 已在当前父（或已在根且目标为根）→ 无操作，原树引用，moved=false，避免重复/丢失/伪变更。
 * 不新增提示系统。
 */
export function moveDepartmentInTree(
  depts: Department[],
  deptId: string,
  targetDeptId: string | null,
): MoveDepartmentResult {
  const source = findDeptById(depts, deptId);
  if (!source) return { departments: depts, moved: false };

  const toRoot = !targetDeptId || targetDeptId === 'root';
  const parentId = currentParentId(depts, deptId);
  if (parentId === undefined) return { departments: depts, moved: false };

  if (toRoot) {
    if (parentId === null) return { departments: depts, moved: false };
  } else {
    const target = findDeptById(depts, targetDeptId);
    if (!target) return { departments: depts, moved: false };
    if (!allowsDepartmentMove(source, target)) return { departments: depts, moved: false };
    if (parentId === targetDeptId) return { departments: depts, moved: false };
  }

  let movedDept: Department | undefined;
  const removeDept = (list: Department[]): Department[] => {
    return list
      .map((dept) => {
        if (dept.id === deptId) {
          movedDept = dept;
          return null;
        }
        if (dept.children.length > 0) return { ...dept, children: removeDept(dept.children) };
        return dept;
      })
      .filter((d): d is Department => d !== null);
  };

  const newDepts = removeDept(depts);
  if (movedDept === undefined) return { departments: depts, moved: false };

  if (toRoot) {
    const updated = relevelSubtree({ ...movedDept, parentId: undefined }, 1);
    return { departments: [...newDepts, updated], moved: true };
  }

  const targetDept = findDeptById(newDepts, targetDeptId);
  if (!targetDept) return { departments: depts, moved: false };

  const updated = relevelSubtree({ ...movedDept, parentId: targetDept.id }, targetDept.level + 1);
  const addToTarget = (list: Department[]): Department[] => {
    return list.map((dept) => {
      if (dept.id === targetDeptId) return { ...dept, children: [...dept.children, updated] };
      if (dept.children.length > 0) return { ...dept, children: addToTarget(dept.children) };
      return dept;
    });
  };
  return { departments: addToTarget(newDepts), moved: true };
}

export function levelsById(depts: Department[], acc: Record<string, number> = {}): Record<string, number> {
  for (const d of depts) {
    acc[d.id] = d.level;
    if (d.children.length > 0) levelsById(d.children, acc);
  }
  return acc;
}

export function countDeptIds(depts: Department[], acc: string[] = []): string[] {
  for (const d of depts) {
    acc.push(d.id);
    if (d.children.length > 0) countDeptIds(d.children, acc);
  }
  return acc;
}
