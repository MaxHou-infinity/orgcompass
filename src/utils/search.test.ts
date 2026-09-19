import { describe, it, expect } from 'vitest';
import { searchOrg, expandDepartments, buildParentMap, expandedMembersForSearch } from './search';
import { Department, Employee } from '../types';

function emp(id: string, name: string, employeeId: string, level = 'L1.1'): Employee {
  return { id, name, employeeId, level };
}

function dept(id: string, name: string, level: number, opts: Partial<Department> = {}): Department {
  return {
    id,
    name,
    level,
    parentId: opts.parentId,
    children: opts.children ?? [],
    employees: opts.employees ?? [],
    expanded: opts.expanded ?? true,
    headcount: opts.headcount,
    leaderId: opts.leaderId,
    leaderName: opts.leaderName,
  };
}

/** 构造：技术部(L1) → 研发组(L2) → 后端(L3)，含员工；以及 销售部(L1) */
function build(): Department[] {
  const backend = dept('d-backend', '后端', 3, {
    employees: [emp('e-wang', '王五', 'E003'), emp('e-li', '李四', 'E004')],
  });
  const rd = dept('d-rd', '研发组', 2, { children: [backend], leaderId: 'E001', leaderName: '张三' });
  const tech = dept('d-tech', '技术部', 1, { children: [rd], employees: [emp('e-zhang', '张三', 'E001')] });
  const sales = dept('d-sales', '销售部', 1, { employees: [emp('e-zhao', '赵六', 'E006')] });
  return [tech, sales];
}

describe('buildParentMap', () => {
  it('建立 id→父级 映射', () => {
    const map = buildParentMap(build());
    expect(map.get('d-tech')).toBeUndefined();
    expect(map.get('d-rd')).toBe('d-tech');
    expect(map.get('d-backend')).toBe('d-rd');
  });
});

describe('searchOrg（搜索，P0-2）', () => {
  it('空查询返回空结果', () => {
    expect(searchOrg(build(), '')).toEqual({ matches: [], expandIds: [], count: 0 });
    expect(searchOrg(build(), '   ').count).toBe(0);
  });

  it('按部门名命中并给祖先链（不误展开自身）', () => {
    const r = searchOrg(build(), '研发');
    expect(r.count).toBe(1);
    expect(r.matches[0].type).toBe('department');
    expect(r.matches[0].id).toBe('d-rd');
    // 祖先（不含自身）需展开：技术部
    expect(r.expandIds).toEqual(['d-tech']);
  });

  it('按员工姓名命中并展开所属部门祖先', () => {
    const r = searchOrg(build(), '王五');
    expect(r.count).toBe(1);
    expect(r.matches[0].type).toBe('employee');
    expect(r.matches[0].id).toBe('e-wang');
    // 展开：技术部 + 研发组（所属部门 d-backend 及其祖先，含自身）
    expect(r.expandIds.sort()).toEqual(['d-backend', 'd-rd', 'd-tech'].sort());
  });

  it('按工号命中', () => {
    const r = searchOrg(build(), 'E006');
    expect(r.count).toBe(1);
    expect(r.matches[0].name).toBe('赵六');
  });

  it('部门与员工都命中时聚合', () => {
    const r = searchOrg(build(), '销售');
    expect(r.count).toBe(1); // 部门「销售部」
    expect(r.matches[0].type).toBe('department');
  });
});

describe('expandDepartments（展开祖先链，P0-2）', () => {
  const flatten = (list: Department[]): Department[] => list.flatMap((d) => [d, ...flatten(d.children)]);

  it('展开目标及其祖先；其余节点保持原样', () => {
    // v2.3.1（T-03）：原 fixture 里所有节点本来就是 expanded=true，
    // 「目标链仍为 expanded」在任何实现下都成立（把 mapList 改成 return list 也全绿）。
    // 现在从**全部折叠**出发，并要求未在 ids 内的节点保持折叠。
    const collapsed = (list: Department[]): Department[] =>
      list.map((d) => ({ ...d, expanded: false, children: collapsed(d.children) }));
    const tree = collapsed(build());
    const result = expandDepartments(tree, new Set(['d-backend', 'd-rd', 'd-tech']));
    const flat = flatten(result);
    expect(flat.find((d) => d.id === 'd-tech')!.expanded).toBe(true);
    expect(flat.find((d) => d.id === 'd-rd')!.expanded).toBe(true);
    expect(flat.find((d) => d.id === 'd-backend')!.expanded).toBe(true);
    // 未被请求展开的节点必须保持折叠（否则等于「全展开」而不是「展开祖先链」）
    expect(flat.find((d) => d.id === 'd-sales')!.expanded).toBe(false);
    // 未命中的 id 不产生任何变化 → 返回原引用（不污染历史栈）
    expect(expandDepartments(tree, new Set(['no-such-id']))).toBe(tree);
  });

  it('展开时保持结构不变，只改 expanded 字段（浅拷贝节点，children 引用按需替换）', () => {
    const collapsed = (list: Department[]): Department[] =>
      list.map((d) => ({ ...d, expanded: false, children: collapsed(d.children) }));
    const tree = collapsed(build());
    const result = expandDepartments(tree, new Set(['d-rd']));
    const before = flatten(tree);
    const after = flatten(result);
    expect(after.map((d) => d.id)).toEqual(before.map((d) => d.id));
    expect(after.map((d) => d.name)).toEqual(before.map((d) => d.name));
    // 未被触碰的子树保持原引用（避免整树重建）
    expect(result.find((d) => d.id === 'd-sales')).toBe(tree.find((d) => d.id === 'd-sales'));
  });

  it('无任何展开变化时返回原引用（避免空历史）', () => {
    const tree = build();
    const result = expandDepartments(tree, new Set<string>());
    expect(result).toBe(tree);
  });

  it('空 ids 集合 → 原引用', () => {
    const tree = build();
    expect(expandDepartments(tree, new Set())).toBe(tree);
  });
});


it('搜索展开命中成员的容器，清除搜索不污染手动展开状态', () => {
  const tree = [dept('a', 'A', 1, { children: [dept('b', 'B', 2, { employees: [emp('e', '测试', 'E001')] })] })];
  const manual = new Set(['a']);
  expect([...expandedMembersForSearch(tree, manual, new Set(['e']))]).toEqual(['a', 'b']);
  expect([...expandedMembersForSearch(tree, manual, new Set())]).toEqual(['a']);
});
