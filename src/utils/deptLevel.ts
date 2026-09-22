import type { Department } from '../types';

/**
 * v2.3.2：部门「层级断档」（向上无归属）的纯派生判定。
 *
 * 背景：员工信息表的「一~六级部门」按**列位置 = 声明层级**解读。若某行只填了一级和三级
 * （二级留空），该三级部门向上没有二级归属，只能直接挂到一级部门下 —— 结构上成立，
 * 但它是一个应该被看见的组织问题（缺一层管理归属，或员工填表漏填）。
 *
 * 判定规则（与组织架构模板的层级口径完全一致，故两类来源的断档都会被识别）：
 * - 根部门：`level !== 1` → 断档（自称 L3 却没有上级）；
 * - 非根部门：`level !== 父.level + 1` → 断档。
 *
 * 为什么放在这里而不是导入时打标记：
 * 1. 纯派生 → 员工表导入、组织模板补充、以后手工调整产生的断档**全都**会出现信号；
 * 2. 不新增持久化字段 → 旧文件不需要迁移，断档也不会因为「忘了打标记」而漏报。
 *
 * 反例（不会误报）：手工拖动部门由 `App.handleChangeDepartmentLevel` 强制重算为连续层级，
 * 因此画布上的手工调整不会产生断档。
 */
export interface DeptLevelGap {
  deptId: string;
  deptName: string;
  /** 该部门声明的层级（Department.level） */
  level: number;
  /** 父部门层级；根部门为 0 */
  parentLevel: number;
  /** 父部门名；根部门为 null */
  parentName: string | null;
  /** 断档处缺失的层级（升序）。根部门 level=3 → [1,2]；子部门 level=4 挂在 L1 下 → [2,3] */
  missingLevels: number[];
}

/** 断档判定：期望层级 = 父层级 + 1（根部门期望 1）。 */
function expectedLevel(parentLevel: number): number {
  return parentLevel + 1;
}

function missingBetween(expected: number, actual: number): number[] {
  const out: number[] = [];
  for (let l = expected; l < actual; l++) out.push(l);
  return out;
}

/**
 * 收集整棵树的层级断档，返回 `deptId → gap`。
 * 无断档返回空 Map（调用方据此决定是否渲染异常信号，零成本）。
 */
export function computeLevelGaps(roots: Department[]): Map<string, DeptLevelGap> {
  const out = new Map<string, DeptLevelGap>();
  const walk = (depts: Department[], parentLevel: number, parentName: string | null) => {
    for (const d of depts) {
      const expected = expectedLevel(parentLevel);
      if (d.level !== expected) {
        out.set(d.id, {
          deptId: d.id,
          deptName: d.name,
          level: d.level,
          parentLevel,
          parentName,
          missingLevels: missingBetween(expected, d.level),
        });
      }
      walk(d.children, d.level, d.name);
    }
  };
  walk(roots, 0, null);
  return out;
}

/**
 * 面向用户的一句话说明（部门卡 tooltip / 诊断报告共用，避免两处文案漂移）。
 * 例：「前端组（L3）直接挂在 技术部（L1）下，中间缺少 L2 部门」
 */
export function describeLevelGap(gap: DeptLevelGap): string {
  if (gap.parentName === null) {
    const missing = gap.missingLevels.length > 0 ? `，缺少 ${gap.missingLevels.map((l) => `L${l}`).join('、')} 部门` : '';
    return `${gap.deptName}（L${gap.level}）没有上级部门${missing}；若非有意为之，请补充其上级部门`;
  }
  const missing = gap.missingLevels.length > 0
    ? `，中间缺少 ${gap.missingLevels.map((l) => `L${l}`).join('、')} 部门`
    : '';
  return `${gap.deptName}（L${gap.level}）直接挂在 ${gap.parentName}（L${gap.parentLevel}）下${missing}；若非有意为之，请在员工表补充中间层级或调整层级`;
}

/** 断档处缺失层级的紧凑标签（部门卡胶囊用），如 `缺 L2` / `缺 L2、L3`；无具体缺失层 → `层级异常` */
export function levelGapBadge(gap: DeptLevelGap): string {
  if (gap.missingLevels.length === 0) return '层级异常';
  return `缺 ${gap.missingLevels.map((l) => `L${l}`).join('、')}`;
}
