// @vitest-environment node
import { describe, it, expect } from 'vitest';
import type * as XLSXType from 'xlsx';
import {
  buildDepartmentTree,
  mapEmployeeRows,
  countPositionConflicts,
  declaredDeptCells,
  mergeOrgTemplates,
  pruneTemplateOnlyEmptyDepts,
  inheritPositionSetup,
  resolveReportsToEmployeeIds,
  parseExcelFromBuffer,
} from './excel';
import { computeLevelGaps, describeLevelGap, levelGapBadge } from './deptLevel';
import { generateLevelGapSuggestions, collectAllSuggestions, computeHealthReport } from './analytics';
import { parseProject, serializeProject, createProject } from './project';
import { DEFAULT_LEVELS } from './levels';
import type { Department, Employee, OrgTemplate } from '../types';

/**
 * v2.3.2 导入契约回归。
 *
 * 本文件的每条用例都对应一处**已确认的缺陷修复**，写法遵循仓库既有约定：
 * 「把修复回退掉，这条用例必须失败」。因此断言直指行为差异点，不做模糊断言。
 */

async function loadXlsx(): Promise<typeof XLSXType> {
  return import('xlsx');
}

function emp(partial: Partial<Employee> & { name: string; employeeId: string }): Employee {
  return {
    id: partial.employeeId,
    level: 'L1.1',
    dept1: '', dept2: '', dept3: '', dept4: '', dept5: '', dept6: '',
    ...partial,
  };
}

/**
 * 用**导入行**构造员工（而不是直接造 Employee）。
 * 必须走 mapEmployeeRows：`岗位` → `_positionName` 的映射发生在导入层，
 * 直接造对象会让「建岗/套岗」整条链路静默失效，测试就测不到真实行为。
 */
function rosterOf(rows: Record<string, unknown>[]): Employee[] {
  return resolveReportsToEmployeeIds(mapEmployeeRows(rows));
}

/** 递归收集全部部门（含子部门） */
function flatten(depts: Department[]): Department[] {
  return depts.flatMap((d) => [d, ...flatten(d.children)]);
}

function byName(depts: Department[], name: string): Department[] {
  return flatten(depts).filter((d) => d.name === name);
}

// ───────────────────────── ① 岗位两列合并为一列 ─────────────────────────

describe('v2.3.2 ① 岗位 / 岗位名称 合并为一列「岗位」', () => {
  it('单列「岗位」：同时决定卡片展示文字与岗位实体名（不再各管一摊）', () => {
    const employees = mapEmployeeRows([{ 姓名: '张三', 工号: 'E001', 岗位: '前端工程师', 一级部门: '技术部' }]);
    expect(employees[0].title).toBe('前端工程师');

    const tree = buildDepartmentTree(employees, []);
    expect(tree[0].positions?.map((p) => p.name)).toEqual(['前端工程师']);
    expect(employees[0].positionId).toBe(tree[0].positions?.[0].id);
  });

  it('旧文件只写「岗位名称」也能建岗（向后兼容，不要求用户改表）', () => {
    const employees = mapEmployeeRows([{ 姓名: '张三', 工号: 'E001', 岗位名称: '前端工程师', 一级部门: '技术部' }]);
    expect(employees[0].title).toBe('前端工程师');
    expect(buildDepartmentTree(employees, [])[0].positions?.map((p) => p.name)).toEqual(['前端工程师']);
  });

  it('旧列名「职位」同样兼容', () => {
    const employees = mapEmployeeRows([{ 姓名: '张三', 工号: 'E001', 职位: '前端工程师', 一级部门: '技术部' }]);
    expect(employees[0].title).toBe('前端工程师');
  });

  it('两列并存且取值不一致 → 按「岗位」为准，并且**计数上报**（不静默丢弃）', () => {
    const rows = [
      { 姓名: '张三', 岗位: '前端工程师', 岗位名称: '前端开发', 一级部门: '技术部' },
      { 姓名: '李四', 岗位: '后端工程师', 岗位名称: '后端工程师', 一级部门: '技术部' },
    ];
    expect(countPositionConflicts(rows)).toBe(1);
    expect(mapEmployeeRows(rows)[0].title).toBe('前端工程师');
    // 单列（新模板）文件永远不产生冲突计数
    expect(countPositionConflicts([{ 姓名: '张三', 岗位: '前端工程师' }])).toBe(0);
  });

  it('「岗位」留空 → title 不存在（不落 "NA"），且不建岗、不套岗', () => {
    const employees = mapEmployeeRows([{ 姓名: '张三', 工号: 'E001', 岗位: '', 一级部门: '技术部' }]);
    // 旧实现 title 落 'NA' → 画布上真的渲染出 "NA"，把「用户没填」显示成「岗位叫 NA」
    expect(employees[0].title).toBeUndefined();
    expect('title' in employees[0]).toBe(false);

    const tree = buildDepartmentTree(employees, []);
    expect(tree[0].positions).toEqual([]);
    expect(employees[0].positionId).toBeUndefined();
  });

  it('员工信息模板只导出一列岗位（不导出 岗位名称 / 职位）', async () => {
    const XLSX = await loadXlsx();
    const { buildSampleEmployeeTemplateBytes } = await import('./excel');
    const rows = await parseExcelFromBuffer(await buildSampleEmployeeTemplateBytes());
    const headers = Object.keys(rows[0]);
    expect(headers).toContain('岗位');
    expect(headers).not.toContain('岗位名称');
    expect(XLSX.version).toBeTruthy();
  });
});

// ───────────────────────── ② 列位置 = 声明层级 ─────────────────────────

describe('v2.3.2 ② 部门按「列位置 = 声明层级」建树（留空不压缩）', () => {
  it('declaredDeptCells：三个单元格按 1/2/3 保留，中间的留空不塌陷', () => {
    expect(declaredDeptCells({ dept1: '技术部', dept2: '', dept3: '前端组' }))
      .toEqual([{ level: 1, name: '技术部' }, { level: 3, name: '前端组' }]);
  });

  it('中间层留空 → 三级部门仍是 L3，直接挂在一级部门下（不被压成 L2）', () => {
    const tree = buildDepartmentTree(
      [emp({ name: '张三', employeeId: 'E001', dept1: '技术部', dept3: '前端组' })], [],
    );
    const 前端组 = byName(tree, '前端组')[0];
    // 旧实现把非空单元格顺次编号 → 前端组会是 L2
    expect(前端组.level).toBe(3);
    expect(前端组.parentId).toBe(byName(tree, '技术部')[0].id);
    expect(前端组.employees.map((e) => e.name)).toEqual(['张三']);
  });

  it('层级断档 + 组织架构模板声明同一部门 → **只有一个**前端组（不再出现重复空部门）', () => {
    const employees = [emp({ name: '张三', employeeId: 'E001', dept1: '技术部', dept3: '前端组' })];
    const templates: OrgTemplate[] = [
      { dept1: '技术部', dept2: '研发部', dept3: '前端组', deptLevel: '3' },
    ];
    const tree = buildDepartmentTree(employees, templates);
    // 旧实现：员工侧建 '2-前端组'、模板侧建 '3-前端组' → 两个同名节点，一个装人、一个空着
    expect(byName(tree, '前端组')).toHaveLength(1);
    expect(byName(tree, '前端组')[0].employees).toHaveLength(1);
    expect(byName(tree, '前端组')[0].level).toBe(3);
  });

  it('断档行也能正确归属（兜底查找用「声明层级」而不是「非空单元格个数」）', () => {
    const employees = [
      emp({ name: '张三', employeeId: 'E001', dept1: '技术部', dept2: '研发部' }),
      emp({ name: '李四', employeeId: 'E002', dept3: '前端组' }),
    ];
    const tree = buildDepartmentTree(employees, []);
    // 李四的三级部门是根级 L3（无上级）——不被误挂到别处，也不丢人
    const 前端组 = byName(tree, '前端组')[0];
    expect(前端组.level).toBe(3);
    expect(前端组.employees.map((e) => e.name)).toEqual(['李四']);
  });

  it('层级连续时行为不变（回归保护：没有断档就没有变化）', () => {
    const tree = buildDepartmentTree(
      [emp({ name: '张三', employeeId: 'E001', dept1: '技术部', dept2: '研发部', dept3: '前端组' })], [],
    );
    expect(byName(tree, '前端组')[0].level).toBe(3);
    expect(byName(tree, '研发部')[0].level).toBe(2);
    expect(computeLevelGaps(tree).size).toBe(0);
  });
});

// ───────────────────────── ③ 层级断档派生信号 ─────────────────────────

describe('v2.3.2 ③ 层级断档（向上无归属）派生与文案', () => {
  const gapped = (): Department[] => buildDepartmentTree(
    [emp({ name: '张三', employeeId: 'E001', dept1: '技术部', dept3: '前端组' })], [],
  );

  it('子部门 level ≠ 父+1 → 判定为断档，missingLevels 指出缺哪一级', () => {
    const gaps = computeLevelGaps(gapped());
    expect(gaps.size).toBe(1);
    const gap = [...gaps.values()][0];
    expect(gap).toMatchObject({ deptName: '前端组', level: 3, parentLevel: 1, parentName: '技术部', missingLevels: [2] });
  });

  it('根部门 level ≠ 1 → 同样判定为断档（缺 1..n-1 级）', () => {
    const tree = buildDepartmentTree([emp({ name: '李四', employeeId: 'E002', dept3: '前端组' })], []);
    const gap = [...computeLevelGaps(tree).values()][0];
    expect(gap).toMatchObject({ level: 3, parentLevel: 0, parentName: null, missingLevels: [1, 2] });
    expect(describeLevelGap(gap)).toContain('没有上级部门');
  });

  it('无断档 → 空 Map（画布零额外渲染）', () => {
    const tree = buildDepartmentTree(
      [emp({ name: '张三', employeeId: 'E001', dept1: '技术部', dept2: '研发部' })], [],
    );
    expect(computeLevelGaps(tree).size).toBe(0);
  });

  it('文案与胶囊标签：解释「为什么这条线是虚线」并给出可行动指引', () => {
    const gap = [...computeLevelGaps(gapped()).values()][0];
    expect(levelGapBadge(gap)).toBe('缺 L2');
    const text = describeLevelGap(gap);
    expect(text).toContain('前端组（L3）');
    expect(text).toContain('技术部（L1）');
    expect(text).toContain('缺少 L2 部门');
  });

  it('诊断报告产出 major 级建议（可行动、可汇总），且无断档时不产出', () => {
    const suggestions = generateLevelGapSuggestions(gapped());
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ severity: 'major', deptName: '前端组', id: expect.stringContaining('-levelgap') });
    expect(suggestions[0].detail).toContain('L2');

    const clean = buildDepartmentTree(
      [emp({ name: '张三', employeeId: 'E001', dept1: '技术部', dept2: '研发部' })], [],
    );
    expect(generateLevelGapSuggestions(clean)).toEqual([]);
  });

  it('断档建议进入 collectAllSuggestions 汇总（不只是孤立函数）', () => {
    const tree = gapped();
    const all = collectAllSuggestions(computeHealthReport(tree, DEFAULT_LEVELS), tree);
    expect(all.some((s) => s.id.endsWith('-levelgap'))).toBe(true);
  });
});

// ───────────────────────── ④ 组织模板 = 补充层 ─────────────────────────

describe('v2.3.2 ④ 组织架构模板降级为补充层（原地合并）', () => {
  const baseRoster = () => rosterOf([
    { 姓名: '张三', 工号: 'E001', 一级部门: '技术部', 二级部门: '研发部', 岗位: '前端工程师' },
  ]);
  const baseTree = (): Department[] => buildDepartmentTree(baseRoster(), []);

  it('补「没有任何员工的空部门」+ 补「部门负责人」', () => {
    const result = mergeOrgTemplates(baseTree(), [
      { dept1: '技术部', dept2: '研发部', deptLevel: '2', leaderId: 'E001', leaderName: '张三' },
      { dept1: '技术部', dept2: '测试部', deptLevel: '2' },
      { dept1: '人力资源部', deptLevel: '1' },
    ]);
    expect(result.addedPaths.sort()).toEqual(['技术部/测试部', '人力资源部'].sort());
    expect(byName(result.departments, '技术部')[0].children.map((c) => c.name).sort()).toEqual(['研发部', '测试部'].sort());
    expect(byName(result.departments, '研发部')[0].leaderName).toBe('张三');
    expect(byName(result.departments, '人力资源部')[0].employees).toEqual([]);
  });

  it('合并**不动**员工的部门归属、岗位与编制（旧实现整体重建 → 编制清零）', () => {
    const before = baseTree();
    // 员工归属在最深匹配部门「研发部」，岗位也建在这里
    const 研发部 = before[0].children[0];
    expect(研发部.positions).toHaveLength(1);
    研发部.positions![0].headcount = 7;
    const employeesBefore = JSON.stringify(研发部.employees.map((e) => e.name));
    const headcountBefore = 研发部.positions![0].headcount;

    const result = mergeOrgTemplates(before, [
      { dept1: '技术部', dept2: '研发部', deptLevel: '2', leaderId: 'E001', leaderName: '张三' },
    ]);
    const 研发部After = byName(result.departments, '研发部')[0];
    // 员工归属不变
    expect(JSON.stringify(研发部After.employees.map((e) => e.name))).toBe(employeesBefore);
    // 岗位与编制原样保留（旧实现走 importWorkspace 重建 → 编制归 0）
    expect(研发部After.positions).toHaveLength(1);
    expect(研发部After.positions![0].headcount).toBe(headcountBefore);
    // 纯函数：入参树未被就地修改
    expect(研发部.positions![0].headcount).toBe(7);
  });

  it('「部门级别」留空 → 负责人挂到本行最深一级（旧实现静默丢失负责人）', () => {
    const result = mergeOrgTemplates(baseTree(), [
      { dept1: '技术部', dept2: '研发部', leaderId: 'E001', leaderName: '张三' },
    ]);
    expect(byName(result.departments, '研发部')[0].leaderName).toBe('张三');
    expect(result.leaderDeptIds).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it('「部门级别」填错（行内没有该层级）→ 明确 warning，不猜、不静默', () => {
    const result = mergeOrgTemplates(baseTree(), [
      { dept1: '技术部', dept2: '研发部', deptLevel: '5', leaderId: 'E001', leaderName: '张三' },
    ]);
    expect(result.leaderDeptIds).toEqual([]);
    expect(result.warnings[0]).toContain('负责人未应用');
    expect(byName(result.departments, '研发部')[0].leaderName).toBeUndefined();
  });

  it('「部门级别」不是数字 → warning', () => {
    const result = mergeOrgTemplates(baseTree(), [
      { dept1: '技术部', dept2: '研发部', deptLevel: '二级', leaderId: 'E001', leaderName: '张三' },
    ]);
    expect(result.warnings[0]).toContain('不是数字');
  });

  it('模板行未提供负责人 → 不清除用户已手工设置的负责人', () => {
    const tree = baseTree();
    tree[0].children[0].leaderId = 'E999';
    tree[0].children[0].leaderName = '手工负责人';
    const result = mergeOrgTemplates(tree, [{ dept1: '技术部', dept2: '研发部', deptLevel: '2' }]);
    expect(byName(result.departments, '研发部')[0].leaderName).toBe('手工负责人');
  });

  it('同名部门在不同层级 → 提示需确认（员工表与模板口径打架时说清楚）', () => {
    const employees = [emp({ name: '张三', employeeId: 'E001', dept1: '技术部', dept2: '研发部' })];
    const tree = buildDepartmentTree(employees, []);
    const result = mergeOrgTemplates(tree, [{ dept1: '技术部', dept2: '研发部', dept3: '研发部', deptLevel: '3' }]);
    expect(result.warnings.some((w) => w.includes('请确认以哪份数据为准'))).toBe(true);
  });
});

// ───────────────────────── ⑤ 补充层「可替换」 ─────────────────────────

describe('v2.3.2 ⑤ 重传组织架构模板 = 可替换（先收回上一次的空部门）', () => {
  const previous: OrgTemplate[] = [
    { dept1: '技术部', dept2: '测试部', deptLevel: '2' },
    { dept1: '人力资源部', deptLevel: '1' },
  ];

  it('上一份模板留下的空部门被收回；有员工的部门与手工部门不受影响', () => {
    const tree: Department[] = [
      {
        id: 'd1', name: '技术部', level: 1, expanded: true, children: [
          { id: 'd1a', name: '研发部', level: 2, expanded: true, employees: [emp({ name: '张三', employeeId: 'E001' })], children: [] },
          { id: 'd1b', name: '测试部', level: 2, expanded: true, employees: [], children: [] },
        ], employees: [], positions: [],
      },
      { id: 'd2', name: '人力资源部', level: 1, expanded: true, employees: [], children: [], positions: [] },
      { id: 'd3', name: '手工新建部', level: 1, expanded: true, employees: [], children: [], positions: [] },
    ];
    const result = pruneTemplateOnlyEmptyDepts(tree, previous);
    expect(result.removedPaths.sort()).toEqual(['人力资源部', '技术部/测试部'].sort());
    const names = flatten(result.departments).map((d) => d.name);
    expect(names).toContain('研发部');   // 有人 → 保留
    expect(names).toContain('手工新建部'); // 非模板来源 → 保留
    expect(names).not.toContain('测试部');
    expect(names).not.toContain('人力资源部');
  });

  it('模板部门的子树里还有部门（哪怕是空的非模板部门）→ 整体保留，不误删父级', () => {
    const tree: Department[] = [{
      id: 'd1', name: '人力资源部', level: 1, expanded: true, employees: [], positions: [],
      children: [{ id: 'd1a', name: '招聘组', level: 2, expanded: true, employees: [], children: [], positions: [] }],
    }];
    const result = pruneTemplateOnlyEmptyDepts(tree, previous);
    expect(result.removedPaths).toEqual([]);
    expect(flatten(result.departments).map((d) => d.name)).toContain('招聘组');
  });

  it('没有上一份模板 → 不做任何回收（空数组零成本分支）', () => {
    const tree: Department[] = [
      { id: 'd1', name: '人力资源部', level: 1, expanded: true, employees: [], children: [], positions: [] },
    ];
    const result = pruneTemplateOnlyEmptyDepts(tree, []);
    expect(result.removedPaths).toEqual([]);
    expect(result.departments).toBe(tree);
  });

  it('端到端：重传新模板后结果 = 「员工表 + 新模板」，不叠加旧模板', () => {
    const employees = [emp({ name: '张三', employeeId: 'E001', dept1: '技术部', dept2: '研发部' })];
    const first = buildDepartmentTree(employees, previous);
    const pruned = pruneTemplateOnlyEmptyDepts(first, previous);
    const second = mergeOrgTemplates(pruned.departments, [{ dept1: '技术部', dept2: '测试部', deptLevel: '2' }]);
    const names = flatten(second.departments).map((d) => d.name);
    expect(names).toContain('测试部');       // 新模板带来
    expect(names).not.toContain('人力资源部'); // 旧模板收回
    expect(names).toContain('研发部');        // 员工表结构保留
  });
});

// ───────────────────────── ⑥ 编制继承 ─────────────────────────

describe('v2.3.2 ⑥ 重导入继承岗位配置（修复「编制被清零」）', () => {
  const roster = () => rosterOf([
    { 姓名: '张三', 工号: 'E001', 一级部门: '技术部', 二级部门: '研发部', 岗位: '前端工程师' },
  ]);

  it('重传员工表 → 编制不再被清零（回退修复即失败）', () => {
    const first = buildDepartmentTree(roster(), []);
    first[0].children[0].positions![0].headcount = 5;
    first[0].children[0].positions![0].jobFamily = '技术';
    first[0].children[0].positions![0].levelBandMax = 'L3.2';

    // 重新导入同一份名册：新树里 headcount 生来为 0
    const rebuilt = buildDepartmentTree(roster(), []);
    expect(rebuilt[0].children[0].positions![0].headcount).toBe(0);

    const inherited = inheritPositionSetup(rebuilt, first);
    const pos = inherited.departments[0].children[0].positions![0];
    expect(pos.headcount).toBe(5);
    expect(pos.jobFamily).toBe('技术');
    expect(pos.levelBandMax).toBe('L3.2');
    expect(inherited.inherited).toBe(1);
  });

  it('名册里暂时没人提及的岗位被保留（编制是配置数据，名册不携带）', () => {
    const first = buildDepartmentTree(roster(), []);
    first[0].children[0].positions!.push({
      id: 'pos-extra', departmentId: first[0].children[0].id, name: '后端工程师',
      headcount: 3, status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const rebuilt = buildDepartmentTree(roster(), []);
    const inherited = inheritPositionSetup(rebuilt, first);
    const names = inherited.departments[0].children[0].positions!.map((p) => p.name);
    expect(names).toContain('后端工程师');
    expect(inherited.restored).toBe(1);
    expect(inherited.departments[0].children[0].positions!.find((p) => p.name === '后端工程师')!.headcount).toBe(3);
  });

  it('已归档（软删）的岗位不复活，尊重用户的删除意图', () => {
    const first = buildDepartmentTree(roster(), []);
    first[0].children[0].positions!.push({
      id: 'pos-archived', departmentId: first[0].children[0].id, name: '已删岗位',
      headcount: 9, status: 'archived', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const rebuilt = buildDepartmentTree(roster(), []);
    const inherited = inheritPositionSetup(rebuilt, first);
    expect(inherited.departments[0].children[0].positions!.map((p) => p.name)).not.toContain('已删岗位');
    expect(inherited.restored).toBe(0);
  });

  it('冻结状态一并继承（不把冻结岗位悄悄解冻）', () => {
    const first = buildDepartmentTree(roster(), []);
    first[0].children[0].positions![0].status = 'frozen';
    const rebuilt = buildDepartmentTree(roster(), []);
    const inherited = inheritPositionSetup(rebuilt, first);
    expect(inherited.departments[0].children[0].positions![0].status).toBe('frozen');
  });

  it('部门路径已不存在 → 不凭空恢复岗位', () => {
    const first = buildDepartmentTree(roster(), []);
    const other = buildDepartmentTree(rosterOf([
      { 姓名: '李四', 工号: 'E002', 一级部门: '市场部', 岗位: '市场专员' },
    ]), []);
    const inherited = inheritPositionSetup(other, first);
    expect(inherited.restored).toBe(0);
    expect(inherited.inherited).toBe(0);
  });

  it('端到端组合：重导入 = 员工表主结构 + 模板补充 + 编制继承', () => {
    const templates: OrgTemplate[] = [{ dept1: '技术部', dept2: '研发部', deptLevel: '2', leaderId: 'E001', leaderName: '张三' }];
    const first = buildDepartmentTree(roster(), templates);
    first[0].children[0].positions![0].headcount = 4;

    const base = buildDepartmentTree(roster(), []);
    const merged = mergeOrgTemplates(base, templates);
    const inherited = inheritPositionSetup(merged.departments, first);
    const 研发部 = byName(inherited.departments, '研发部')[0];
    expect(研发部.leaderName).toBe('张三');
    expect(研发部.positions![0].headcount).toBe(4);
  });
});

// ───────────────────────── ⑦ 补充层持久化 ─────────────────────────

describe('v2.3.2 ⑦ 组织架构模板写入 .orgproj（关闭应用不再失忆）', () => {
  const templates: OrgTemplate[] = [{ dept1: '技术部', dept2: '研发部', deptLevel: '2', leaderId: 'E001', leaderName: '张三' }];

  it('serialize → parse 保留 orgTemplates', () => {
    const project = createProject('补充层测试');
    project.orgTemplates = templates;
    const roundTripped = parseProject(serializeProject(project));
    expect(roundTripped?.orgTemplates).toEqual(templates);
  });

  it('旧文件没有该字段 → 不凭空新增（不写入 orgTemplates 键，旧文件往返零改动）', () => {
    const legacy = serializeProject({ ...createProject('旧文件'), orgTemplates: undefined });
    expect(legacy).not.toContain('orgTemplates');
    const roundTripped = parseProject(legacy);
    expect(roundTripped).not.toBeNull();
    expect('orgTemplates' in (roundTripped as object)).toBe(false);
    // 再序列化一次也不该冒出该键
    expect(serializeProject(roundTripped!)).not.toContain('orgTemplates');
  });

  it('非法行被清洗：整行无部门名丢弃、非对象丢弃', () => {
    const project = createProject('清洗');
    project.orgTemplates = [
      { dept1: '技术部', dept2: '研发部' },
      { dept1: '', dept2: '' } as OrgTemplate,
      null as unknown as OrgTemplate,
    ];
    const roundTripped = parseProject(serializeProject(project));
    expect(roundTripped?.orgTemplates).toHaveLength(1);
    expect(roundTripped?.orgTemplates?.[0].dept1).toBe('技术部');
  });

  it('格式版本不因新增可选字段而升级（旧版应用仍能打开新文件）', () => {
    const project = createProject('版本');
    project.orgTemplates = templates;
    const roundTripped = parseProject(serializeProject(project));
    expect(roundTripped?.version).toBe(project.version);
  });
});
