import { describe, it, expect } from 'vitest';
import type { Department, Employee } from '../types';
import { HistoryStore } from './history';
import {
  allowsDepartmentMove,
  countDeptIds,
  currentParentId,
  existingCanvasAllowsDepartmentDrop,
  isDescendant,
  levelsById,
  moveDepartmentInTree,
} from './departmentMove';
import { findDeptById } from './departments';

function emp(id: string, opts: Partial<Employee> = {}): Employee {
  return { id, name: id, employeeId: id, level: 'L1', ...opts };
}

function dept(id: string, name: string, level: number, opts: Partial<Department> = {}): Department {
  return {
    id,
    name,
    level,
    parentId: opts.parentId,
    children: opts.children ?? [],
    employees: opts.employees ?? [],
    expanded: true,
    ...opts,
  };
}

/** PRD 夹具：A/B/C 与 X/Y/Z */
function fixtureTree(): Department[] {
  return [
    dept('A', 'A', 1, {
      employees: [emp('EA')],
      children: [
        dept('B', 'B', 2, {
          parentId: 'A',
          employees: [emp('EB')],
          children: [dept('C', 'C', 3, { parentId: 'B', employees: [emp('EC')] })],
        }),
      ],
    }),
    dept('X', 'X', 1, {
      children: [
        dept('Y', 'Y', 2, {
          parentId: 'X',
          children: [dept('Z', 'Z', 3, { parentId: 'Y' })],
        }),
      ],
    }),
  ];
}

function node(tree: Department[], id: string): Department {
  const found = findDeptById(tree, id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

function applyMove(store: HistoryStore<Department[]>, deptId: string, targetDeptId: string | null) {
  store.set((prev) => {
    const result = moveDepartmentInTree(prev, deptId, targetDeptId);
    return result.moved ? result.departments : prev;
  });
}

function idsAndParents(tree: Department[]) {
  const acc: Record<string, string | null> = {};
  const walk = (list: Department[], parent: string | null) => {
    for (const d of list) {
      acc[d.id] = parent;
      walk(d.children, d.id);
    }
  };
  walk(tree, null);
  return acc;
}

describe('部门投放与移动函数共用同一合法性规则', () => {
  it('A-C01-08b 直接以自身为目标：投放拒绝，移动函数返回原树', () => {
    const tree = fixtureTree();
    const B = node(tree, 'B');
    expect(existingCanvasAllowsDepartmentDrop(B, B)).toBe(false);
    expect(allowsDepartmentMove(B, B)).toBe(false);
    const result = moveDepartmentInTree(tree, 'B', 'B');
    expect(result.moved).toBe(false);
    expect(result.departments).toBe(tree);
  });

  it('投放允许矩阵与 A-C01-08 要求一致（允许上移，拒绝移入后代）', () => {
    const tree = fixtureTree();
    const A = node(tree, 'A');
    const B = node(tree, 'B');
    const C = node(tree, 'C');
    const X = node(tree, 'X');
    const Z = node(tree, 'Z');

    const actual = {
      self_B_onto_B: allowsDepartmentMove(B, B),
      ancestor_A_onto_descendant_C: allowsDepartmentMove(A, C),
      ancestor_X_onto_descendant_Z: allowsDepartmentMove(X, Z),
      child_C_onto_parent_B: allowsDepartmentMove(C, B),
      descendant_C_onto_ancestor_A: allowsDepartmentMove(C, A),
      unrelated_B_onto_Z: allowsDepartmentMove(B, Z),
    };
    const required = {
      self_B_onto_B: false,
      ancestor_A_onto_descendant_C: false,
      ancestor_X_onto_descendant_Z: false,
      child_C_onto_parent_B: true,
      descendant_C_onto_ancestor_A: true,
      unrelated_B_onto_Z: true,
    };
    expect(actual).toEqual(required);
    expect(existingCanvasAllowsDepartmentDrop(A, C)).toBe(allowsDepartmentMove(A, C));
    expect(existingCanvasAllowsDepartmentDrop(C, A)).toBe(allowsDepartmentMove(C, A));

    expect(isDescendant(A, C)).toBe(true);
    expect(isDescendant(C, A)).toBe(false);
    expect(isDescendant(B, B)).toBe(false);
  });

  it('A→C 拒绝：树引用、结构、历史栈均不变', () => {
    const tree = fixtureTree();
    const beforeIds = countDeptIds(tree);
    const beforeParents = idsAndParents(tree);
    const beforeLevels = levelsById(tree);
    const result = moveDepartmentInTree(tree, 'A', 'C');
    expect(allowsDepartmentMove(node(tree, 'A'), node(tree, 'C'))).toBe(false);
    expect(result.moved).toBe(false);
    expect(result.departments).toBe(tree);
    expect(countDeptIds(result.departments)).toEqual(beforeIds);
    expect(idsAndParents(result.departments)).toEqual(beforeParents);
    expect(levelsById(result.departments)).toEqual(beforeLevels);

    const store = new HistoryStore(tree);
    applyMove(store, 'A', 'C');
    expect(store.getSnapshot()).toBe(tree);
    expect(store.undoDepth).toBe(0);
    expect(store.canUndo()).toBe(false);
    expect(idsAndParents(store.getSnapshot())).toEqual(beforeParents);
  });

  it('X→Z 拒绝：树引用、结构、历史栈均不变', () => {
    const tree = fixtureTree();
    const beforeParents = idsAndParents(tree);
    const beforeLevels = levelsById(tree);
    const result = moveDepartmentInTree(tree, 'X', 'Z');
    expect(result.moved).toBe(false);
    expect(result.departments).toBe(tree);
    expect(idsAndParents(result.departments)).toEqual(beforeParents);
    expect(levelsById(result.departments)).toEqual(beforeLevels);

    const store = new HistoryStore(tree);
    applyMove(store, 'X', 'Z');
    expect(store.getSnapshot()).toBe(tree);
    expect(store.undoDepth).toBe(0);
    expect(store.canRedo()).toBe(false);
  });

  it('C→A 合法上移：归属与层级正确，历史可撤销重做', () => {
    const tree = fixtureTree();
    expect(allowsDepartmentMove(node(tree, 'C'), node(tree, 'A'))).toBe(true);
    const { departments, moved } = moveDepartmentInTree(tree, 'C', 'A');
    expect(moved).toBe(true);
    expect(departments).not.toBe(tree);
    expect(node(departments, 'C').parentId).toBe('A');
    expect(currentParentId(departments, 'C')).toBe('A');
    expect(levelsById(departments)).toMatchObject({ A: 1, B: 2, C: 2, X: 1, Y: 2, Z: 3 });
    expect(node(departments, 'A').children.map((d) => d.id)).toEqual(['B', 'C']);
    expect(node(departments, 'B').children).toEqual([]);
    expect(node(departments, 'C').employees.map((e) => e.id)).toEqual(['EC']);
    expect(countDeptIds(departments).sort()).toEqual(countDeptIds(tree).sort());

    const store = new HistoryStore(tree);
    applyMove(store, 'C', 'A');
    expect(levelsById(store.getSnapshot())).toMatchObject({ C: 2, B: 2, A: 1 });
    expect(store.undoDepth).toBe(1);
    store.undo();
    expect(store.getSnapshot()).toBe(tree);
    expect(levelsById(store.getSnapshot())).toMatchObject({ C: 3, B: 2 });
    expect(currentParentId(store.getSnapshot(), 'C')).toBe('B');
    store.redo();
    expect(currentParentId(store.getSnapshot(), 'C')).toBe('A');
    expect(levelsById(store.getSnapshot())).toMatchObject({ C: 2 });
  });

  it('移到当前父（C→B）可无操作：无重复、无丢失、无伪变更、不写历史', () => {
    const tree = fixtureTree();
    expect(allowsDepartmentMove(node(tree, 'C'), node(tree, 'B'))).toBe(true);
    expect(currentParentId(tree, 'C')).toBe('B');
    const result = moveDepartmentInTree(tree, 'C', 'B');
    expect(result.moved).toBe(false);
    expect(result.departments).toBe(tree);
    const ids = countDeptIds(result.departments);
    expect(ids).toEqual(['A', 'B', 'C', 'X', 'Y', 'Z']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(idsAndParents(result.departments)).toEqual(idsAndParents(tree));
    expect(levelsById(result.departments)).toEqual(levelsById(tree));

    const store = new HistoryStore(tree);
    applyMove(store, 'C', 'B');
    expect(store.getSnapshot()).toBe(tree);
    expect(store.undoDepth).toBe(0);
  });

  it('已在根再移到根：无操作，原树不变', () => {
    const tree = fixtureTree();
    const result = moveDepartmentInTree(tree, 'A', null);
    expect(result.moved).toBe(false);
    expect(result.departments).toBe(tree);
    expect(tree.map((d) => d.id)).toEqual(['A', 'X']);
  });
});

describe('C01 只对被移动子树递推 level', () => {
  it('A-C01-01 把 B（含 C）挂到 Z 下：B=4，C=5，不得父 4 子 3', () => {
    const { departments, moved } = moveDepartmentInTree(fixtureTree(), 'B', 'Z');
    expect(moved).toBe(true);
    const lv = levelsById(departments);
    expect(lv).toMatchObject({ A: 1, X: 1, Y: 2, Z: 3, B: 4, C: 5 });
    expect(node(departments, 'B').parentId).toBe('Z');
    expect(node(departments, 'C').parentId).toBe('B');
    expect(node(departments, 'Z').children.map((d) => d.id)).toEqual(['B']);
    expect(node(departments, 'A').children).toEqual([]);
    expect(node(departments, 'B').employees.map((e) => e.id)).toEqual(['EB']);
    expect(node(departments, 'C').employees.map((e) => e.id)).toEqual(['EC']);
  });

  it('A-C01-02 旁支 A/X/Y/Z 的 level、顺序、人员不变', () => {
    const before = fixtureTree();
    const { departments } = moveDepartmentInTree(before, 'B', 'Z');
    expect(node(departments, 'A').level).toBe(1);
    expect(node(departments, 'A').employees.map((e) => e.id)).toEqual(['EA']);
    expect(departments.map((d) => d.id)).toEqual(['A', 'X']);
    expect(node(departments, 'X').children.map((d) => d.id)).toEqual(['Y']);
    expect(node(departments, 'Y').children.map((d) => d.id)).toEqual(['Z']);
    expect(levelsById(departments)).toMatchObject({ X: 1, Y: 2, Z: 3, A: 1 });
  });

  it('A-C01-05 把 B（含 C）移到与 A、X 并列的根：B=1，C=2', () => {
    const { departments } = moveDepartmentInTree(fixtureTree(), 'B', null);
    const lv = levelsById(departments);
    expect(lv).toMatchObject({ A: 1, B: 1, C: 2, X: 1, Y: 2, Z: 3 });
    expect(departments.map((d) => d.id)).toEqual(['A', 'X', 'B']);
    expect(node(departments, 'B').parentId).toBeUndefined();
  });

  it('A-C01-06 把 B 从 A 下移到 X 下，与 Y 同为 L2', () => {
    const { departments } = moveDepartmentInTree(fixtureTree(), 'B', 'X');
    const lv = levelsById(departments);
    expect(lv).toMatchObject({ A: 1, X: 1, Y: 2, B: 2, C: 3, Z: 3 });
    expect(node(departments, 'X').children.map((d) => d.id)).toEqual(['Y', 'B']);
  });

  it('A-C01-07 连续上下移动：每次按当时的树重算，不残留旧级别', () => {
    const first = moveDepartmentInTree(fixtureTree(), 'B', 'Z').departments;
    expect(levelsById(first)).toMatchObject({ B: 4, C: 5 });
    const second = moveDepartmentInTree(first, 'B', null).departments;
    expect(levelsById(second)).toMatchObject({ B: 1, C: 2 });
    const third = moveDepartmentInTree(second, 'B', 'A').departments;
    expect(levelsById(third)).toMatchObject({ B: 2, C: 3, A: 1 });
  });

  it('A-C01-03 走既有 HistoryStore：撤销回到移动前，重做含子孙 level', () => {
    const store = new HistoryStore<Department[]>(fixtureTree());
    store.set((prev) => moveDepartmentInTree(prev, 'B', 'Z').departments);
    expect(levelsById(store.getSnapshot())).toMatchObject({ B: 4, C: 5 });
    store.undo();
    expect(levelsById(store.getSnapshot())).toMatchObject({ A: 1, B: 2, C: 3, X: 1, Y: 2, Z: 3 });
    store.redo();
    expect(levelsById(store.getSnapshot())).toMatchObject({ B: 4, C: 5, Z: 3 });
  });
});
