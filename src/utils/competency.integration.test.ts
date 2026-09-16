import { describe, it, expect } from 'vitest';
import { parseProject, serializeProject } from './project';
import { DEFAULT_LEVELS } from './levels';
import { computeCompetencyStates, computeCompetencySummary } from './competency';
import { confirmedNotCompetentSet } from './assignment';
import { computeMatchStates } from './match';
import type { Assessment, PositionAssignment, ProjectFile, Scenario } from '../types';

/**
 * —— v2.2.0 全链路集成测试（design doc §6 / §10 / §13 出口）——
 *
 * 模拟端到端数据流：构造 v2 fixture → parseProject 迁移 v3 → 添加 supervisor 评估
 * （某维度 worstGap≥2）→ computeCompetencyStates 产出 danger 候选 →
 * confirmedNotCompetentSet 人工确认 → computeMatchStates 产出 MatchStatus.not_competent →
 * 未评估员工保持 null/灰态。链路各环节断言与 design §10/§13 对齐。
 */

/** v2 结构 fixture（无胜任度字段）：p1(编制3) 3 员工、p2(编制1) 2 员工、e4 未套岗。
 *  注意 allEmployeesFlat 顺序：e5/e6 在前（v2.1.1 用数组序近似套岗时间序，超编后进者判定依赖此序）。 */
function v2Fixture(): ProjectFile {
  const now = '2026-08-01T00:00:00Z';
  const posP1 = { id: 'p1', departmentId: 'd1', name: '岗位一', headcount: 3, status: 'active', createdAt: now, updatedAt: now };
  const posP2 = { id: 'p2', departmentId: 'd1', name: '岗位二', headcount: 1, status: 'active', createdAt: now, updatedAt: now };
  const scenario: Scenario = {
    id: 's1',
    name: '基线',
    createdAt: now,
    updatedAt: now,
    levelConfigs: DEFAULT_LEVELS.map((c) => ({ ...c })),
    canvas: { zoom: 100 },
    positions: [posP1, posP2],
    departments: [
      {
        id: 'd1',
        name: '研发部',
        level: 1,
        expanded: true,
        children: [],
        positions: [posP1, posP2],
        employees: [
          { id: 'e5', name: '周五', employeeId: 'E005', level: 'L1.1', positionId: 'p2' },
          { id: 'e6', name: '孙六', employeeId: 'E006', level: 'L1.1', positionId: 'p2' },
          { id: 'e1', name: '张三', employeeId: 'E001', level: 'L1.1', positionId: 'p1' },
          { id: 'e2', name: '李四', employeeId: 'E002', level: 'L3.1', positionId: 'p1' },
          { id: 'e3', name: '王五', employeeId: 'E003', level: 'L2.1', positionId: 'p1' },
          { id: 'e4', name: '赵四', employeeId: 'E004', level: 'L1.1' },
          { id: 'v1', name: '张三兼岗', employeeId: 'E001', level: 'L1.1', positionId: 'p2', isVirtual: true, primaryEmployeeId: 'e1', assignmentType: 'secondary' },
        ],
      },
    ],
    allEmployeesFlat: [
      { id: 'e5', name: '周五', employeeId: 'E005', level: 'L1.1', positionId: 'p2' },
      { id: 'e6', name: '孙六', employeeId: 'E006', level: 'L1.1', positionId: 'p2' },
      { id: 'e1', name: '张三', employeeId: 'E001', level: 'L1.1', positionId: 'p1' },
      { id: 'e2', name: '李四', employeeId: 'E002', level: 'L3.1', positionId: 'p1' },
      { id: 'e3', name: '王五', employeeId: 'E003', level: 'L2.1', positionId: 'p1' },
      { id: 'e4', name: '赵四', employeeId: 'E004', level: 'L1.1' },
      { id: 'v1', name: '张三兼岗', employeeId: 'E001', level: 'L1.1', positionId: 'p2', isVirtual: true, primaryEmployeeId: 'e1', assignmentType: 'secondary' },
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

/** 构造一条 supervisor 原始分评估（requirement 快照落库） */
function asm(
  id: string,
  employeeId: string,
  dimension: string,
  score: number,
  requirement: number,
  assessedAt = '2026-09-01T00:00:00Z',
): Assessment {
  return {
    id,
    employeeId,
    dimension,
    score,
    scale: { min: 1, max: 5 },
    requirement,
    assessorRole: 'supervisor',
    assessorId: 'mgr1',
    assessedAt,
    source: 'manual',
    createdAt: assessedAt,
    updatedAt: assessedAt,
  };
}

describe('胜任度全链路集成（v2 迁移 → 评估 → 候选/确认 → 匹配状态）', () => {
  it('链路完整：迁移回填 → 评估 → danger 候选 → 确认 → not_competent → 未评估灰态', () => {
    // 1) 迁移：v2 fixture → parseProject → v3，三张表就位
    const project = parseProject(serializeProject(v2Fixture()))!;
    expect(project.version).toBe(4);
    const sc = project.scenarios[0];
    const model = sc.competencyModel!;
    expect(model.dimensions.length).toBe(6);
    expect(sc.assessments).toEqual([]);
    expect(sc.positionAssignments!.length).toBeGreaterThan(0);
    expect(sc.positionAssignments!.every((a) => !a.startDate && a.source === 'legacy')).toBe(true);

    // 2) 添加 supervisor 评估：e1 某维度 worstGap=2（business: score1 req3）→ danger 候选
    //    e2 全绿（含 hrbp 低分干扰：hrbp 不参与灯号）；e5 候选（未确认）
    sc.assessments = [
      asm('a1', 'e1', 'business', 1, 3),
      asm('a2', 'e1', 'individual', 3, 3),
      asm('a3', 'e2', 'business', 4, 4),
      asm('a4', 'e2', 'individual', 4, 4),
      asm('a5', 'e5', 'business', 1, 3),
    ];
    sc.assessments.push({
      ...asm('a6', 'e2', 'business', 1, 4, '2026-09-02T00:00:00Z'),
      assessorRole: 'hrbp', // 校准分并列呈现、不参与 Gap/灯号
    });

    // 3) computeCompetencyStates：每员工一条；danger 候选正确产出；未评估员工 null/灰态
    const states = computeCompetencyStates(sc.assessments, sc.allEmployeesFlat, model);
    expect(states.length).toBe(sc.allEmployeesFlat.length); // 每员工都返回一条

    const s1 = states.find((s) => s.employeeId === 'e1')!;
    expect(s1.overall?.status).toBe('danger');
    expect(s1.overall?.worstGap).toBe(2);
    expect(s1.notCompetentCandidate).toBe(true);
    expect(s1.dimensions.find((d) => d.dimension === 'business')?.gap).toBe(2); // 红灯可指向具体维度

    const s2 = states.find((s) => s.employeeId === 'e2')!;
    expect(s2.overall?.status).toBe('healthy'); // hrbp 低分不参与，supervisor 4 分 req4 → gap0
    expect(s2.notCompetentCandidate).toBe(false);

    const s5 = states.find((s) => s.employeeId === 'e5')!;
    expect(s5.overall?.status).toBe('danger');
    expect(s5.notCompetentCandidate).toBe(true); // 候选成立，但未确认

    // 未评估员工（e3/e4/虚拟副本 v1）→ overall null 灰态，不伪装绿/红
    for (const id of ['e3', 'e4', 'v1']) {
      const s = states.find((x) => x.employeeId === id)!;
      expect(s.overall).toBeNull();
      expect(s.dimensions).toEqual([]);
      expect(s.notCompetentCandidate).toBe(false);
    }

    // 4) 人工确认：e1（p1 不胜任）+ e6（p2 超编位确认）→ confirmedNotCompetentSet
    const assignments: PositionAssignment[] = [
      ...sc.positionAssignments!,
      { relationId: sc.positionAssignments!.find((a) => a.employeeId === 'e1' && a.type === 'primary')!.id, id: 'asg1', employeeId: 'e1', positionId: 'p1', type: 'primary', startDate: '2026-08-01', status: 'not_competent', confirmedBy: 'hrbp1', confirmedAt: '2026-09-05T00:00:00Z', createdAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z' },
      { relationId: sc.positionAssignments!.find((a) => a.employeeId === 'e6' && a.type === 'primary')!.id, id: 'asg2', employeeId: 'e6', positionId: 'p2', type: 'primary', startDate: '2026-08-01', status: 'not_competent', confirmedBy: 'hrbp1', confirmedAt: '2026-09-05T00:00:00Z', createdAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z' },
    ];
    const confirmed = confirmedNotCompetentSet(assignments, sc.allEmployeesFlat);
    expect(Array.from(confirmed).sort()).toEqual(['e1', 'e6']);

    // 5) computeMatchStates（缺省前四态逻辑不变 + 确认优先 overstaffed + unassigned 仍最高）
    const results = computeMatchStates(sc.allEmployeesFlat, sc.positions ?? [], confirmed);
    const byEmp = new Map(results.map((r) => [r.employeeId, r]));

    // e1：已套岗 + 已确认 → not_competent（reason='not-competent'）
    expect(byEmp.get('e1')).toMatchObject({ status: 'not_competent', reason: 'not-competent', positionId: 'p1' });
    // e6：p2 超编后进者，但确认优先于 overstaffed → not_competent
    expect(byEmp.get('e6')).toMatchObject({ status: 'not_competent', reason: 'not-competent' });
    // e2/e3：正常套岗 → placed（e3 未评估灰态不产 not_competent）
    expect(byEmp.get('e2')?.status).toBe('placed');
    expect(byEmp.get('e3')?.status).toBe('placed');
    // e5：danger 候选但【未确认】→ 不自动定级，仍 placed
    expect(byEmp.get('e5')?.status).toBe('placed');
    // e4：未套岗 → unassigned 仍最高（即使确认集合不含它，语义上 unassigned 优先）
    expect(byEmp.get('e4')).toMatchObject({ status: 'unassigned', reason: 'no_position' });
    // 虚拟副本不单独产出
    expect(byEmp.has('v1')).toBe(false);

    // 6) 派生不落库：串行化项目后不存在任何派生字段（worstGap/灯号/totalScore）
    const json = serializeProject(project);
    expect(json).not.toContain('worstGap');
    expect(json).not.toContain('notCompetentCandidate');
    expect(json).not.toContain('totalScore');
  });

  it('round-trip 不丢评估事实：serialize → parse 后 assessments/positionAssignments 保留、模型保留', () => {
    const project = parseProject(serializeProject(v2Fixture()))!;
    const sc = project.scenarios[0];
    sc.assessments = [asm('a1', 'e1', 'business', 2, 3)];
    sc.positionAssignments = [
      { relationId: sc.positionAssignments!.find((a) => a.employeeId === 'e1' && a.type === 'primary')!.id, id: 'asg1', employeeId: 'e1', positionId: 'p1', type: 'primary', startDate: '2026-08-01', status: 'active', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z' },
    ];

    const again = parseProject(serializeProject(project))!;
    const sc2 = again.scenarios[0];
    expect(sc2.assessments?.length).toBe(1);
    expect(sc2.assessments?.[0]).toMatchObject({ employeeId: 'e1', dimension: 'business', score: 2, requirement: 3 });
    expect(sc2.positionAssignments?.length).toBe(1);
    expect(sc2.positionAssignments?.[0]).toMatchObject({ employeeId: 'e1', status: 'active' });
    expect(sc2.competencyModel?.dimensions.length).toBe(6);

    // 迁移幂等：二次 parse 后派生口径不变
    const s = computeCompetencySummary(sc2.assessments ?? [], 'e1', sc2.competencyModel!)!;
    expect(s.overall?.worstGap).toBe(1); // req3 - score2 = 1 → warn
    expect(s.notCompetentCandidate).toBe(false);
  });
});
