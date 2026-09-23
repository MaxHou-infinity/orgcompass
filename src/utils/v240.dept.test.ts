// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { checkDeptDeletion, eligibleParents, removeDepartment, validateParent } from './departments';
import type { Department, Employee } from '../types';

/**
 * V2.4.0：部门增删的两条产品规则（用户实测反馈）。
 *
 * 起因：从左侧「新建部门」建出的部门**删不掉** —— 右键菜单只有「调整层级归属」，
 * 全仓没有任何删除部门的能力；而新建时的「归属部门」下拉把**所有部门**平铺进去，
 * 选同级或下级也能建出来，等于没有约束。
 *
 * 规则（用户定义）：
 * 1. 删除：(a) 卡内无成员 → 允许；(b) 仍有员工 → 拒绝并提示先挪人。
 * 2. 归属：不得归属**同级或下级**部门；可以不指定归属，之后在画布上拖动调整。
 */

const emp = (id: string, name: string, extra: Partial<Employee> = {}): Employee =>
  ({ id, name, employeeId: id, level: 'L1.1', ...extra });
const dept = (id: string, name: string, level: number, extra: Partial<Department> = {}): Department =>
  ({ id, name, level, expanded: true, children: [], employees: [], ...extra });

describe('V2.4.0 部门归属规则：不得归属同级或下级', () => {
  it('不指定归属始终允许（生成后再在画布上拖动）', () => {
    expect(validateParent(undefined, 2).ok).toBe(true);
    expect(validateParent(undefined, 1).ok).toBe(true);
  });

  it('归属层级更浅的部门 → 允许', () => {
    expect(validateParent(dept('d1', '总部', 1), 2).ok).toBe(true);
    expect(validateParent(dept('d1', '总部', 1), 6).ok).toBe(true);
    expect(validateParent(dept('d1', '中心', 2), 3).ok).toBe(true);
  });

  it('归属**同级**部门 → 拒绝，并说明不得归属同级或下级', () => {
    const v = validateParent(dept('d2', '市场部', 2), 2);
    expect(v.ok).toBe(false);
    expect(v.message).toContain('不得归属同级或下级部门');
    expect(v.message).toContain('市场部');
  });

  it('归属**下级**部门 → 拒绝', () => {
    const v = validateParent(dept('d3', '小组', 3), 2);
    expect(v.ok).toBe(false);
    expect(v.message).toContain('不得归属同级或下级部门');
  });

  it('层级非法时拒绝（不允许建出 L0）', () => {
    expect(validateParent(undefined, 0).ok).toBe(false);
    expect(validateParent(undefined, Number.NaN).ok).toBe(false);
  });
});

describe('V2.4.0 归属候选只列层级更浅的部门', () => {
  const tree: Department[] = [
    dept('d1', '总部', 1, {
      children: [
        dept('d2', '研发中心', 2, { children: [dept('d3', '后端组', 3)] }),
        dept('d4', '市场部', 2),
      ],
    }),
    dept('d5', '独立事业部', 1),
  ];

  it('新建 L2 时只列 L1（同级 L2 与下级 L3 都不出现）', () => {
    const ids = eligibleParents(tree, 2).map((o) => o.id);
    expect(ids).toEqual(['d1', 'd5']);
    expect(ids).not.toContain('d2'); // 同级
    expect(ids).not.toContain('d4'); // 同级
    expect(ids).not.toContain('d3'); // 下级
  });

  it('新建 L1 时没有可归属的上级（下拉只剩「暂不指定」）', () => {
    expect(eligibleParents(tree, 1)).toHaveLength(0);
  });

  it('新建 L4 时 L1/L2/L3 都可归属', () => {
    expect(eligibleParents(tree, 4).map((o) => o.id)).toEqual(['d1', 'd2', 'd3', 'd4', 'd5']);
  });

  it('候选标签带层级前缀，让用户看得出为什么选项少了', () => {
    const [first] = eligibleParents(tree, 2);
    expect(first.label).toContain('L1');
    expect(first.label).toContain('总部');
  });
});

describe('V2.4.0 部门删除前置检查', () => {
  it('空部门（无成员、无子部门）→ 允许删除', () => {
    expect(checkDeptDeletion(dept('d1', '新事业部', 1)).ok).toBe(true);
  });

  it('仍有员工 → 拒绝，并列出姓名要求先挪人', () => {
    const d = dept('d1', '技术部', 1, { employees: [emp('e1', '张三'), emp('e2', '李四')] });
    const c = checkDeptDeletion(d);
    expect(c.ok).toBe(false);
    expect(c.message).toContain('还有 2 名员工');
    expect(c.message).toContain('张三');
    expect(c.message).toContain('李四');
    expect(c.message).toContain('请先把他们挪到其他部门');
    expect(c.employees).toHaveLength(2);
  });

  it('还有子部门 → 拒绝（否则整棵子树会被静默丢弃）', () => {
    const d = dept('d1', '总部', 1, { children: [dept('d2', '研发中心', 2), dept('d3', '市场部', 2)] });
    const c = checkDeptDeletion(d);
    expect(c.ok).toBe(false);
    expect(c.message).toContain('还有 2 个子部门');
    expect(c.message).toContain('研发中心');
    expect(c.childNames).toEqual(['研发中心', '市场部']);
  });

  it('只剩兼岗记录 → 也拒绝（否则那条兼岗会变成悬空引用）', () => {
    const d = dept('d1', '技术部', 1, { employees: [emp('v1', '张三（兼）', { isVirtual: true })] });
    const c = checkDeptDeletion(d);
    expect(c.ok).toBe(false);
    expect(c.message).toContain('兼岗');
  });
});

describe('V2.4.0 从树中移除部门', () => {
  it('移除目标部门（含其子树），其余结构保持', () => {
    const tree: Department[] = [
      dept('d1', '总部', 1, { children: [dept('d2', '研发中心', 2, { children: [dept('d3', '后端组', 3)] }), dept('d4', '市场部', 2)] }),
      dept('d5', '独立事业部', 1),
    ];
    const next = removeDepartment(tree, 'd2');
    expect(next.map((d) => d.id)).toEqual(['d1', 'd5']);
    expect(next[0].children.map((d) => d.id)).toEqual(['d4']); // d3 随子树一起走
  });

  it('移除叶子部门', () => {
    const tree: Department[] = [dept('d1', '总部', 1, { children: [dept('d2', '研发中心', 2)] })];
    expect(removeDepartment(tree, 'd2')[0].children).toEqual([]);
  });

  it('目标不存在 → 返回原引用（不产生空历史）', () => {
    const tree: Department[] = [dept('d1', '总部', 1)];
    expect(removeDepartment(tree, 'nope')).toBe(tree);
  });
});
