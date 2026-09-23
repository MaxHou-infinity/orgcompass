import { Department, Employee } from '../types';

/**
 * 纯函数：将一组员工（empIds）从各自所在部门移除，一次性加入目标部门（toDeptId）。
 * 与单员工移动口径一致：移动记录走历史（调用方负责 setDepartments）。
 *
 * 约定：
 * - 若目标部门不存在或查找失败，返回原引用（避免产生空历史/破坏树）。
 * - 递归遍历整棵树，找到所有匹配 empIds 的员工并移除；其余位置结构保持。
 */
export function moveEmployeesBetween(
  depts: Department[],
  empIds: string[],
  toDeptId: string,
): Department[] {
  const empSet = new Set(empIds);
  if (empSet.size === 0 || !toDeptId) return depts;

  const collected: Employee[] = [];
  let targetFound = false;

  /** 移除所有匹配员工（先遍历树，收集被移员工） */
  const removeFromAll = (list: Department[]): Department[] => {
    return list.map((dept) => {
      const kept: Employee[] = [];
      for (const e of dept.employees) {
        if (empSet.has(e.id)) collected.push(e);
        else kept.push(e);
      }
      const children = dept.children.length > 0 ? removeFromAll(dept.children) : dept.children;
      if (dept.id === toDeptId) targetFound = true;
      return children === dept.children && kept.length === dept.employees.length
        ? dept
        : { ...dept, employees: kept, children };
    });
  };

  let newDepts = removeFromAll(depts);
  if (collected.length === 0 || !targetFound) return depts;

  /** 一次性加入目标部门 */
  const addAll = (list: Department[]): Department[] => {
    return list.map((dept) => {
      if (dept.id === toDeptId) return { ...dept, employees: [...dept.employees, ...collected] };
      if (dept.children.length > 0) return { ...dept, children: addAll(dept.children) };
      return dept;
    });
  };
  newDepts = addAll(newDepts);

  return newDepts;
}

/** 部门下拉选项（层级缩进 + 名称）。 */
export interface DeptOption {
  id: string;
  name: string;
  /** 带缩进的展示名（多层部门用 └ 标示层级） */
  label: string;
  level: number;
}

/**
 * V2.4.0：把部门树拍平成下拉选项（供「目标部门」这类选择器复用）。
 * 多处（岗位操作 / 虚拟员工 / 岗位与编制新增岗位）都需要同一份口径，
 * 抽出来避免各写一份缩进规则。
 */
export function flattenDeptOptions(depts: Department[], depth = 0, acc: DeptOption[] = []): DeptOption[] {
  for (const d of depts) {
    acc.push({
      id: d.id,
      name: d.name,
      label: '　'.repeat(Math.min(depth, 4)) + (depth > 0 ? '└ ' : '') + d.name,
      level: d.level,
    });
    flattenDeptOptions(d.children, depth + 1, acc);
  }
  return acc;
}

/** 在整棵树里按 id 找部门（含子树）。 */
export function findDeptById(depts: Department[], id: string): Department | undefined {
  for (const d of depts) {
    if (d.id === id) return d;
    const hit = findDeptById(d.children, id);
    if (hit) return hit;
  }
  return undefined;
}

/** 员工在树中所在的部门（虚拟副本与真人都按 id 匹配；找不到返回 undefined）。 */
export function findEmployeeDept(depts: Department[], empId: string): Department | undefined {
  for (const d of depts) {
    if (d.employees.some((e) => e.id === empId)) return d;
    const hit = findEmployeeDept(d.children, empId);
    if (hit) return hit;
  }
  return undefined;
}

// ───────────────────────── V2.4.0 部门增删的两条产品规则 ─────────────────────────

/**
 * 归属合法性：新建/调整层级时，父部门层级必须**严格小于**自身层级。
 *
 * 用户规则：「新增二级部门时，只能归属于一级部门；选择归属到同层级的二级部门或下一层的
 * 三级部门，理论上不允许创建」。不指定归属（挂到根）始终允许 —— 用户可以先生成出来，
 * 之后在画布上拖动做归属。
 *
 * 说明：这里**只**拦「同级或下级」；父层级小于自身但不连续（如 L3 挂在 L1 下）不拦截，
 * 它属于「层级断档」，产品已有可见的断档提示（琥珀虚线 + 缺 Lx 胶囊），是提示而非禁止。
 */
export function validateParent(parent: Department | undefined, level: number): { ok: boolean; message?: string } {
  // 层级先校验：否则「不指定归属」会把非法层级一并放过去（L0 之类的脏数据）
  if (!Number.isFinite(level) || level < 1) {
    return { ok: false, message: '部门层级无效' };
  }
  if (!parent) return { ok: true };
  if (parent.level >= level) {
    return {
      ok: false,
      message: `不得归属同级或下级部门：「${parent.name}」是 L${parent.level}，而新部门是 L${level}。只能归属层级更浅的部门，或不指定归属。`,
    };
  }
  return { ok: true };
}

/** 可作为父部门的候选（层级严格小于 level；保持树的先序，便于下拉展示）。 */
export function eligibleParents(depts: Department[], level: number, depth = 0, acc: DeptOption[] = []): DeptOption[] {
  for (const d of depts) {
    if (d.level < level) {
      acc.push({
        id: d.id,
        name: d.name,
        label: `${'　'.repeat(Math.min(depth, 4))}${depth > 0 ? '└ ' : ''}L${d.level} · ${d.name}`,
        level: d.level,
      });
    }
    // 即使某层不合法，也要继续往下找：层级是声明值，不保证子一定比父大
    eligibleParents(d.children, level, depth + 1, acc);
  }
  return acc;
}

/** 删除部门前的检查结果。 */
export interface DeptDeletionCheck {
  ok: boolean;
  /** 直属成员（阻塞时用于提示里列出姓名） */
  employees: Employee[];
  /** 子部门名（阻塞时用于提示） */
  childNames: string[];
  message?: string;
}

/**
 * 部门删除的前置检查（用户规则）：
 * (a) 卡片内**没有成员** → 允许删除；
 * (b) 仍挂载员工 → 不删，提示先把员工挪到其他部门。
 *
 * 补充一条安全约束：**还有子部门**时也不删 —— 否则整棵子树会被静默丢弃。
 * 用户没提这一条，但「删掉父部门顺手带走子树」是数据丢失级行为，不能默认发生。
 */
export function checkDeptDeletion(dept: Department): DeptDeletionCheck {
  const employees = dept.employees.filter((e) => !e.isVirtual);
  const virtuals = dept.employees.filter((e) => e.isVirtual);
  const childNames = dept.children.map((c) => c.name);

  if (employees.length > 0) {
    const names = employees.map((e) => e.name).join('、');
    const extra = virtuals.length > 0 ? `，另有 ${virtuals.length} 条兼岗记录` : '';
    return {
      ok: false, employees, childNames,
      message: `「${dept.name}」内还有 ${employees.length} 名员工（${names}）${extra}。请先把他们挪到其他部门，再删除该部门。`,
    };
  }
  if (childNames.length > 0) {
    return {
      ok: false, employees, childNames,
      message: `「${dept.name}」下还有 ${childNames.length} 个子部门（${childNames.join('、')}）。请先删除或移出这些子部门，再删除该部门。`,
    };
  }
  if (virtuals.length > 0) {
    return {
      ok: false, employees, childNames,
      message: `「${dept.name}」内还有 ${virtuals.length} 条兼岗记录。请先清理兼岗，再删除该部门。`,
    };
  }
  return { ok: true, employees, childNames };
}

/** 从部门树中移除某部门（含其子树）。找不到时返回原引用，避免产生空历史。 */
export function removeDepartment(depts: Department[], deptId: string): Department[] {
  let hit = false;
  const walk = (list: Department[]): Department[] => {
    const kept: Department[] = [];
    for (const d of list) {
      if (d.id === deptId) { hit = true; continue; }
      kept.push(d.children.length > 0 ? { ...d, children: walk(d.children) } : d);
    }
    return kept;
  };
  const next = walk(depts);
  return hit ? next : depts;
}
