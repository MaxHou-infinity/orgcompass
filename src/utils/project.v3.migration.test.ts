import { describe, it, expect } from 'vitest';
import { parseProject, serializeProject, PROJECT_VERSION } from './project';
import { DEFAULT_LEVELS } from './levels';
import { DEFAULT_COMPETENCY_MODEL } from '../types';
import { computeL2, computeL3 } from './analytics';
import { computeMatchStates } from './match';
import type { Position, ProjectFile, Scenario } from '../types';

/**
 * —— v2.2.0 迁移 E2E（design doc §4 / §13 出口）——
 *
 * 验证 v2 结构 .orgproj → parseProject 后：
 * 1) competencyModel 回填默认 6 维（深层拷贝，不共享引用）；
 * 2) assessments = []、positionAssignments = []（空数组占位，**不回填**——不造数据红线）；
 * 3) 旧数字完全不变：headcount / 职级 / 套岗 positionId / L2/L3 指标 / 匹配三态；
 * 4) 二次 parse 幂等：不重复建岗/套岗，competencyModel 与两张表保留。
 */

/** v2 项目 fixture：d1(编制5)、d2(编制3，有员工)、d3(未配置编制，有员工)——真实 v2 结构（部门内岗位镜像 + 员工套岗），无胜任度字段 */
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

describe('.orgproj v2→v3 迁移（胜任度引擎）', () => {
  it('数据模型版本升为 4', () => {
    expect(PROJECT_VERSION).toBe(4);
    const parsed = parseProject(serializeProject(v2ProjectFixture()))!;
    expect(parsed).not.toBeNull();
    expect(parsed.version).toBe(4);
    expect(parsed.meta.version).toBe(4);
  });

  it('competencyModel 回填默认 6 维（深层拷贝，不共享引用）', () => {
    const parsed = parseProject(serializeProject(v2ProjectFixture()))!;
    const model = parsed.scenarios[0].competencyModel!;
    expect(model.dimensions.length).toBe(6);
    expect(model.dimensions.map((d) => d.key)).toEqual(
      DEFAULT_COMPETENCY_MODEL.dimensions.map((d) => d.key),
    );
    // 深层拷贝：改解析结果不影响默认预设（防共享引用污染）
    model.dimensions[0].label = '被我改了';
    expect(DEFAULT_COMPETENCY_MODEL.dimensions[0].label).toBe('战略解码');
  });

  it('评分不回填；旧当前关系建立关联标识但不伪造到岗日期', () => {
    const parsed = parseProject(serializeProject(v2ProjectFixture()))!;
    const sc = parsed.scenarios[0];
    expect(sc.assessments).toEqual([]);
    expect(sc.positionAssignments!.length).toBeGreaterThan(0);
    expect(sc.positionAssignments!.every((a) => !a.startDate && a.source === 'legacy')).toBe(true);
    // 只标识旧当前关系；assignment 表不伪造 startDate
    const e1 = sc.departments[0].children[0].employees.find((e) => e.id === 'e1')!;
    expect(e1.positionId).toBeTruthy();
  });

  it('旧数字不变：headcount / 职级 / 套岗 / L2-L3 指标 / 匹配三态与迁移前完全一致', () => {
    const before = v2ProjectFixture().scenarios[0];
    const migrated = parseProject(serializeProject(v2ProjectFixture()))!.scenarios[0];

    // 部门编制与岗位编制数字不变
    const d1 = migrated.departments.find((d) => d.id === 'd1')!;
    const d2 = d1.children.find((d) => d.id === 'd2')!;
    const d3 = migrated.departments.find((d) => d.id === 'd3')!;
    expect(d1.headcount).toBe(5);
    expect(d2.headcount).toBe(3);
    expect(d1.positions?.[0]?.headcount).toBe(5);
    expect(d2.positions?.[0]?.headcount).toBe(3);
    expect(d3.positions?.length ?? 0).toBe(0);

    // 员工职级 / 套岗 positionId 不变
    const beforeE = before.departments[0].children[0].employees;
    const afterE = migrated.departments[0].children[0].employees;
    expect(afterE.map((e) => e.level)).toEqual(beforeE.map((e) => e.level));
    expect(afterE.map((e) => e.positionId)).toEqual(beforeE.map((e) => e.positionId));

    // L2/L3 指标（空岗率/缺口/职级差距）完全一致
    const l2Before = computeL2(before.departments);
    const l2After = computeL2(migrated.departments);
    for (let i = 0; i < l2Before.length; i++) {
      expect(l2After[i].key).toBe(l2Before[i].key);
      expect(l2After[i].value).toBe(l2Before[i].value);
      expect(l2After[i].status).toBe(l2Before[i].status);
    }
    const l3Before = computeL3(before.departments, before.levelConfigs);
    const l3After = computeL3(migrated.departments, migrated.levelConfigs);
    expect(l3After.map((r) => r.gap)).toEqual(l3Before.map((r) => r.gap));
    expect(l3After.map((r) => r.actual)).toEqual(l3Before.map((r) => r.actual));

    // 匹配三态一致（缺省入参 = v2.1.1 行为，not_competent 不产出）
    const mBefore = computeMatchStates(before.allEmployeesFlat, before.positions ?? []);
    const mAfter = computeMatchStates(migrated.allEmployeesFlat, migrated.positions ?? []);
    expect(mAfter.map((r) => r.status)).toEqual(mBefore.map((r) => r.status));
  });

  it('二次 parse 幂等：不重复建岗/套岗，三张表保留不重建', () => {
    const first = parseProject(serializeProject(v2ProjectFixture()))!;
    const second = parseProject(serializeProject(first))!;
    expect(second.version).toBe(4);
    const s1 = first.scenarios[0];
    const s2 = second.scenarios[0];

    // 岗位数量与 id 稳定（无重复建岗）
    expect(s2.positions?.length).toBe(s1.positions?.length);
    expect(s2.positions?.map((p) => p.id).sort()).toEqual(s1.positions?.map((p) => p.id).sort());

    // 员工套岗 id 稳定（无重复套岗）
    const flat1 = s1.allEmployeesFlat.filter((e) => !e.isVirtual).sort((a, b) => a.id.localeCompare(b.id));
    const flat2 = s2.allEmployeesFlat.filter((e) => !e.isVirtual).sort((a, b) => a.id.localeCompare(b.id));
    expect(flat2.map((e) => e.positionId)).toEqual(flat1.map((e) => e.positionId));

    // 三张表幂等：模型维度 key 稳定、当前关联标识稳定
    expect(s2.competencyModel?.dimensions.map((d) => d.key)).toEqual(
      s1.competencyModel?.dimensions.map((d) => d.key),
    );
    expect(s2.assessments).toEqual([]);
    expect(s2.positionAssignments).toEqual(s1.positionAssignments);
  });
});
