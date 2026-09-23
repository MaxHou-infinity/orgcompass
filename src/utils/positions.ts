import type { Department, Employee, Position } from '../types';

/**
 * 岗位扁平表派生（v2.3 M4 修复）。
 *
 * 契约 §2.2：**部门层级、部门人员位置和直属岗位以 `departments` 为结构来源；
 * 岗位扁平表从树派生，不独立编辑。**
 *
 * `Scenario.positions` 是历史遗留的扁平镜像字段：应用主路径（useOrgWorkspace 的 live state）
 * 只维护 `departments`，保存时也不会回写该镜像，因此它可能长期为空或过期。
 * 任何消费岗位的派生都必须从部门树取，不能信任 `Scenario.positions`。
 */
export function flattenPositions(depts: Department[]): Position[] {
  const out: Position[] = [];
  const walk = (list: Department[]) => {
    for (const d of list) {
      if (Array.isArray(d.positions)) out.push(...d.positions);
      walk(d.children);
    }
  };
  walk(depts);
  return out;
}

/** 「无明确岗位」的员工及其原因（V2.4.0 删除岗位后的持续提示位用）。 */
export interface PositionlessEmployee {
  employee: Employee;
  /** 未套岗 = 从未指定岗位；岗位失效 = 岗位已删除/归档或不存在 */
  reason: 'unassigned' | 'missing-position';
  /** 该员工当前所在部门名（未入架构时为 undefined） */
  deptName?: string;
}

/**
 * V2.4.0：找出**没有明确岗位归属**的真人员工（虚拟兼岗副本不计入 —— 它们本身就是派生记录）。
 *
 * 两种情形分开表达，因为处置方式不同：
 * - `unassigned`：从未套岗 → 需要在「岗位与编制」里给他分配岗位；
 * - `missing-position`：岗位被删除/归档 → 需要新建岗位或把他调到别的岗位。
 *
 * 用户场景（本版新增删除岗位功能后）：删掉一个有 3 人挂靠的岗位，这 3 人必须
 * **持续可见**地提示出来，而不是只在删除确认弹窗里出现一次就消失。
 */
export function findPositionlessEmployees(
  employees: Employee[],
  departments: Department[],
): PositionlessEmployee[] {
  const live = new Map<string, Position>();
  const deptOf = new Map<string, string>();

  const walk = (depts: Department[]): void => {
    for (const d of depts) {
      for (const p of d.positions ?? []) live.set(p.id, p);
      for (const e of d.employees) deptOf.set(e.id, d.name);
      walk(d.children);
    }
  };
  walk(departments);

  const out: PositionlessEmployee[] = [];
  for (const e of employees) {
    if (e.isVirtual) continue;
    if (!e.positionId) {
      out.push({ employee: e, reason: 'unassigned', deptName: deptOf.get(e.id) });
      continue;
    }
    const p = live.get(e.positionId);
    if (!p || p.status === 'archived') {
      out.push({ employee: e, reason: 'missing-position', deptName: deptOf.get(e.id) });
    }
  }
  return out;
}
