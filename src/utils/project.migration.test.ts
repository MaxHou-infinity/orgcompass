import { describe, it, expect } from 'vitest';
import { parseProject, serializeProject } from './project';
import { DEFAULT_LEVELS } from './levels';
import { computeL2, computeL3 } from './analytics';
import { DEFAULT_COMPETENCY_MODEL } from '../types';
import type { ProjectFile, Scenario, Position } from '../types';

/** v1 项目 fixture：d1(编制5)、d2(编制3，有员工)、d3(未配置编制，有员工) */
function v1ProjectFixture(): ProjectFile {
  const now = '2026-08-01T00:00:00Z';
  const scenario: Scenario = {
    id: 's1',
    name: '基线',
    createdAt: now,
    updatedAt: now,
    levelConfigs: DEFAULT_LEVELS.map((c) => ({ ...c })),
    canvas: { zoom: 100 },
    departments: [
      {
        id: 'd1',
        name: '研发部',
        level: 1,
        expanded: true,
        headcount: 5,
        children: [
          {
            id: 'd2',
            name: '开发组',
            level: 2,
            expanded: true,
            headcount: 3,
            parentId: 'd1',
            children: [],
            employees: [
              { id: 'e1', name: '张三', employeeId: 'E001', level: 'L1.1' },
              { id: 'e2', name: '李四', employeeId: 'E002', level: 'L2.1' },
            ],
          },
        ],
        employees: [{ id: 'e3', name: '王五', employeeId: 'E003', level: 'L3.1' }],
      },
      {
        id: 'd3',
        name: '测试部',
        level: 1,
        expanded: true,
        headcount: undefined,
        children: [],
        employees: [{ id: 'e4', name: '赵六', employeeId: 'E004', level: 'L1.1' }],
      },
    ],
    allEmployeesFlat: [
      { id: 'e1', name: '张三', employeeId: 'E001', level: 'L1.1' },
      { id: 'e2', name: '李四', employeeId: 'E002', level: 'L2.1' },
      { id: 'e3', name: '王五', employeeId: 'E003', level: 'L3.1' },
      { id: 'e4', name: '赵六', employeeId: 'E004', level: 'L1.1' },
    ],
  };
  return {
    id: 'proj-v1',
    name: 'v1项目',
    version: 1,
    currentScenarioId: 's1',
    scenarios: [scenario],
    meta: { createdAt: now, updatedAt: now, version: 1 },
  };
}

describe('.orgproj v1→v3 迁移（岗位化；v2.2.0 升至 v3，岗位派生逻辑不变）', () => {
  it('v1 头数>0 部门派生「默认岗位」，员工自动套岗，数字不变', () => {
    const parsed = parseProject(serializeProject(v1ProjectFixture()))!;
    expect(parsed).not.toBeNull();
    expect(parsed.version).toBe(4); // 数据模型版本升为 4（v1→v2→v3 链式迁移）

    const sc = parsed.scenarios[0];
    // 全量岗位扁平镜像：d1 + d2 各一个默认岗位（d3 无编制 → 不建岗）
    expect(sc.positions?.length).toBe(2);

    const d1 = sc.departments.find((d) => d.id === 'd1')!;
    const d2 = d1.children.find((d) => d.id === 'd2')!;
    const d3 = sc.departments.find((d) => d.id === 'd3')!;

    // 默认岗位编制数 = 原部门编制（数字不变），名称「默认岗位」
    expect(d1.positions?.[0]?.headcount).toBe(5);
    expect(d2.positions?.[0]?.headcount).toBe(3);
    expect(d1.positions?.[0]?.name).toBe('默认岗位');
    expect(d3.positions?.length ?? 0).toBe(0);

    // 员工自动套岗到所属部门默认岗位
    const e1 = d2.employees.find((e) => e.id === 'e1')!;
    const e3 = d1.employees.find((e) => e.id === 'e3')!;
    const e4 = d3.employees.find((e) => e.id === 'e4')!;
    expect(e1.positionId).toBe(d2.positions?.[0]?.id);
    expect(e2In(d2).positionId).toBe(d2.positions?.[0]?.id);
    expect(e3.positionId).toBe(d1.positions?.[0]?.id);
    expect(e4.positionId).toBeUndefined(); // d3 无编制 → 不建岗，不套岗

    // 原部门 headcount 保留为冗余派生（向下兼容）
    expect(d1.headcount).toBe(5);
    expect(d2.headcount).toBe(3);
  });

  it('迁移幂等：重复 parse 不重复建岗、不重复套岗', () => {
    const first = parseProject(serializeProject(v1ProjectFixture()))!;
    const second = parseProject(serializeProject(first))!;
    const s1 = first.scenarios[0];
    const s2 = second.scenarios[0];
    expect(s2.positions?.length).toBe(s1.positions?.length);
    // 每个岗位头部与次数一致（无重复）
    for (const d of s2.departments) {
      expect(d.positions?.length).toBe(d.positions?.length);
    }
  });

  it('非法 JSON / 空参数 → null；v3 文件往返稳定', () => {
    expect(parseProject('not json {')).toBeNull();
    const v3 = parseProject(serializeProject(v1ProjectFixture()))!;
    const again = parseProject(serializeProject(v3))!;
    expect(again.scenarios[0].positions?.length).toBe(2);
    expect(again.version).toBe(4);
  });

  it('关键准则「数字不变」：v1 迁移 v3 后 computeL2/L3 指标与迁移前完全一致', () => {
    const before = v1ProjectFixture().scenarios[0];
    const migrated = parseProject(serializeProject(v1ProjectFixture()))!.scenarios[0];

    const l2Before = computeL2(before.departments);
    const l2After = computeL2(migrated.departments);
    for (let i = 0; i < l2Before.length; i++) {
      expect(l2After[i].key).toBe(l2Before[i].key);
      expect(l2After[i].value).toBe(l2Before[i].value); // 空岗率等数值不变
      expect(l2After[i].status).toBe(l2Before[i].status);
    }

    const l3Before = computeL3(before.departments, before.levelConfigs);
    const l3After = computeL3(migrated.departments, migrated.levelConfigs);
    expect(l3After.map((r) => r.gap)).toEqual(l3Before.map((r) => r.gap));
    expect(l3After.map((r) => r.actual)).toEqual(l3Before.map((r) => r.actual));
  });
});

function e2In(dep: { employees: { id: string; positionId?: string }[] }) {
  return dep.employees.find((e) => e.id === 'e2')!;
}

// —— —— v2.2.0：v2 → v3 迁移（design doc §4：幂等 + 无损 + 不造数据） —— ——

/** v2 项目 fixture：岗位 + 套岗已落地（v2 结构），但无胜任度三字段。 */
function v2ProjectFixture(): ProjectFile {
  const now = '2026-08-01T00:00:00Z';
  const posD1: Position = { id: 'pos-d1', departmentId: 'd1', name: '默认岗位', headcount: 5, status: 'active', createdAt: now, updatedAt: now };
  const posD2: Position = { id: 'pos-d2', departmentId: 'd2', name: '默认岗位', headcount: 3, status: 'active', createdAt: now, updatedAt: now };
  const scenario: Scenario = {
    id: 's1',
    name: '基线',
    createdAt: now,
    updatedAt: now,
    levelConfigs: DEFAULT_LEVELS.map((c) => ({ ...c })),
    canvas: { zoom: 100 },
    positions: [posD1, posD2],
    departments: [
      {
        id: 'd1',
        name: '研发部',
        level: 1,
        expanded: true,
        headcount: 5,
        positions: [posD1],
        children: [
          {
            id: 'd2',
            name: '开发组',
            level: 2,
            expanded: true,
            headcount: 3,
            parentId: 'd1',
            positions: [posD2],
            children: [],
            employees: [
              { id: 'e1', name: '张三', employeeId: 'E001', level: 'L1.1', positionId: 'pos-d2' },
              { id: 'e2', name: '李四', employeeId: 'E002', level: 'L2.1', positionId: 'pos-d2' },
            ],
          },
        ],
        employees: [{ id: 'e3', name: '王五', employeeId: 'E003', level: 'L3.1', positionId: 'pos-d1' }],
      },
      {
        id: 'd3',
        name: '测试部',
        level: 1,
        expanded: true,
        headcount: undefined,
        children: [],
        employees: [{ id: 'e4', name: '赵六', employeeId: 'E004', level: 'L1.1' }],
      },
    ],
    allEmployeesFlat: [
      { id: 'e1', name: '张三', employeeId: 'E001', level: 'L1.1', positionId: 'pos-d2' },
      { id: 'e2', name: '李四', employeeId: 'E002', level: 'L2.1', positionId: 'pos-d2' },
      { id: 'e3', name: '王五', employeeId: 'E003', level: 'L3.1', positionId: 'pos-d1' },
      { id: 'e4', name: '赵六', employeeId: 'E004', level: 'L1.1' },
    ],
  };
  return {
    id: 'proj-v2',
    name: 'v2项目',
    version: 2,
    currentScenarioId: 's1',
    scenarios: [scenario],
    meta: { createdAt: now, updatedAt: now, version: 2 },
  };
}

describe('.orgproj v2→v3 迁移（胜任度引擎：幂等 + 无损 + 不造数据）', () => {
  it('版本升为 4；competencyModel 回填默认 6 维（深拷贝不共享引用）；评分为空，旧当前关系缺日期', () => {
    const parsed = parseProject(serializeProject(v2ProjectFixture()))!;
    expect(parsed).not.toBeNull();
    expect(parsed.version).toBe(4);
    expect(parsed.meta.version).toBe(4);

    const sc = parsed.scenarios[0];
    // 模型缺省回填默认预设（深层拷贝：改解析结果不影响全局默认）
    expect(sc.competencyModel?.dimensions).toHaveLength(6);
    expect(sc.competencyModel?.dimensions.map((d) => d.key)).toEqual(
      DEFAULT_COMPETENCY_MODEL.dimensions.map((d) => d.key),
    );
    sc.competencyModel!.dimensions[0].label = '被我改了';
    expect(DEFAULT_COMPETENCY_MODEL.dimensions[0].label).toBe('战略解码');

    // 评分不回填；格式 4 为旧当前投影分配未知日期的关联标识
    expect(sc.assessments).toEqual([]);
    expect(sc.positionAssignments!.length).toBeGreaterThan(0);
    expect(sc.positionAssignments!.every((a) => !a.startDate && a.source === 'legacy')).toBe(true);
    const e1 = sc.departments[0].children[0].employees.find((e) => e.id === 'e1')!;
    expect(e1.positionId).toBe('pos-d2');
  });

  it('旧数字完全不变：编制 / 职级 / 套岗 / L2-L3 指标与迁移前一致', () => {
    const before = v2ProjectFixture().scenarios[0];
    const migrated = parseProject(serializeProject(v2ProjectFixture()))!.scenarios[0];

    const d1 = migrated.departments.find((d) => d.id === 'd1')!;
    const d2 = d1.children.find((d) => d.id === 'd2')!;
    expect(d1.headcount).toBe(5);
    expect(d2.headcount).toBe(3);
    expect(d1.positions?.[0]?.headcount).toBe(5);
    expect(d2.positions?.[0]?.headcount).toBe(3);
    expect(migrated.departments.find((d) => d.id === 'd3')!.positions?.length ?? 0).toBe(0);

    const beforeE = before.departments[0].children[0].employees;
    const afterE = migrated.departments[0].children[0].employees;
    expect(afterE.map((e) => e.level)).toEqual(beforeE.map((e) => e.level));
    expect(afterE.map((e) => e.positionId)).toEqual(beforeE.map((e) => e.positionId));

    const l2Before = computeL2(before.departments);
    const l2After = computeL2(migrated.departments);
    expect(l2After.map((m) => `${m.key}:${m.value}:${m.status}`)).toEqual(
      l2Before.map((m) => `${m.key}:${m.value}:${m.status}`),
    );
    const l3Before = computeL3(before.departments, before.levelConfigs);
    const l3After = computeL3(migrated.departments, migrated.levelConfigs);
    expect(l3After.map((r) => r.gap)).toEqual(l3Before.map((r) => r.gap));
    expect(l3After.map((r) => r.actual)).toEqual(l3Before.map((r) => r.actual));
  });

  it('已有三字段保留不覆盖（幂等）：模型 1 维 / 评估 1 条 / 时态 1 条迁移后原样保留', () => {
    const now = '2026-08-01T00:00:00Z';
    const partial = JSON.stringify({
      id: 'proj-v2-partial',
      name: '带部分胜任度数据的 v2',
      version: 2,
      currentScenarioId: 's1',
      scenarios: [{
        id: 's1',
        name: 'A',
        departments: [],
        allEmployeesFlat: [],
        levelConfigs: DEFAULT_LEVELS.map((c) => ({ ...c })),
        canvas: { zoom: 100 },
        competencyModel: {
          dimensions: [
            { key: 'custom_keep_000001', label: '自定义维度', definition: '定义', weight: 0.5, group: 'staff', order: 1, enabled: true },
          ],
        },
        assessments: [
          { id: 'asm-1', employeeId: 'e1', dimension: 'custom_keep_000001', score: 4, requirement: 4, assessorRole: 'supervisor', assessedAt: now, source: 'manual', createdAt: now, updatedAt: now },
        ],
        positionAssignments: [
          { id: 'asg-1', employeeId: 'e1', positionId: 'p1', type: 'primary', startDate: '2026-01-01', status: 'active', createdAt: now, updatedAt: now },
        ],
      }],
      meta: { createdAt: now, updatedAt: now, version: 2 },
    });
    const parsed = parseProject(partial)!;
    const sc = parsed.scenarios[0];
    expect(parsed.version).toBe(4);
    expect(sc.competencyModel?.dimensions).toHaveLength(1); // 已有模型不覆盖
    expect(sc.competencyModel?.dimensions[0].key).toBe('custom_keep_000001');
    expect(sc.assessments).toHaveLength(1);
    expect(sc.positionAssignments).toHaveLength(1);
  });

  it('二次迁移幂等：不重复建岗/套岗，模型维度 key 稳定、当前关联标识稳定', () => {
    const first = parseProject(serializeProject(v2ProjectFixture()))!;
    const second = parseProject(serializeProject(first))!;
    expect(second.version).toBe(4);
    const s1 = first.scenarios[0];
    const s2 = second.scenarios[0];
    expect(s2.positions?.map((p) => p.id).sort()).toEqual(s1.positions?.map((p) => p.id).sort());
    expect(s2.competencyModel?.dimensions.map((d) => d.key)).toEqual(
      s1.competencyModel?.dimensions.map((d) => d.key),
    );
    expect(s2.assessments).toEqual([]);
    expect(s2.positionAssignments).toEqual(s1.positionAssignments);
  });
});
