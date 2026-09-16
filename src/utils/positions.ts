import type { Department, Position } from '../types';

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
