import { describe, it, expect } from 'vitest';
import {
  assessmentApplicability,
  assessmentScopeOf,
  computeCompetencySummary,
  currentRevisionEndpoint,
  expectedDimensions,
  listAssessmentHistory,
  resolveSupervisorAssessment,
  revisionChainIssue,
  revisionLinkIssue,
} from './competency';
import { listReviewEvents } from './assignment';
import { parseProject, serializeProject, createProject } from './project';
import type {
  Assessment,
  CompetencyDimensionDef,
  CompetencyModel,
  PositionAssignment,
} from '../types';
import { COMPETENCY_SCALE } from '../types';

/**
 * V2.3 M2 验收样例（docs/v230-contract.md §8：A10—A21、A24—A25）。
 * 这些断言是「目标行为」，覆盖同日修订、完整度、岗位适用性、HRBP 校准与复核留痕。
 */

function dim(key: string, over: Partial<CompetencyDimensionDef> = {}): CompetencyDimensionDef {
  return {
    key,
    label: `维度-${key}`,
    definition: `定义-${key}`,
    weight: 0.5,
    group: 'staff',
    order: 1,
    enabled: true,
    builtin: true,
    ...over,
  };
}

function model(...dims: CompetencyDimensionDef[]): CompetencyModel {
  return { dimensions: dims };
}

let seq = 0;
function asm(over: Partial<Assessment> & { employeeId: string; dimension: string; score: number }): Assessment {
  seq += 1;
  const t = over.assessedAt ?? '2026-09-01T12:00:00.000Z';
  return {
    id: over.id ?? `asm-${seq}`,
    employeeId: over.employeeId,
    dimension: over.dimension,
    score: over.score,
    scale: COMPETENCY_SCALE,
    requirement: over.requirement ?? 3,
    assessorRole: over.assessorRole ?? 'supervisor',
    assessedAt: t,
    source: over.source ?? 'manual',
    createdAt: over.createdAt ?? t,
    updatedAt: over.updatedAt ?? t,
    ...(over.positionId ? { positionId: over.positionId } : {}),
    ...(over.scope ? { scope: over.scope } : {}),
    ...(over.relationId ? { relationId: over.relationId } : {}),
    ...(over.revisionOf ? { revisionOf: over.revisionOf } : {}),
    ...(over.assessorId ? { assessorId: over.assessorId } : {}),
    ...(over.enteredBy ? { enteredBy: over.enteredBy } : {}),
    ...(over.note ? { note: over.note } : {}),
  };
}

function rel(over: Partial<PositionAssignment> & { id: string; employeeId: string; positionId: string }): PositionAssignment {
  return {
    type: 'primary',
    status: 'active',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

const staffModel = model(
  dim('business', { order: 1 }),
  dim('individual', { order: 2 }),
);

describe('A10—A12 完整度：应评 / 已评 / 模型未配置（R02、D01）', () => {
  it('A10：员工两维仅一维达标 → 部分已评 1/2，不计完整达标人数', () => {
    const list = [asm({ employeeId: 'a', dimension: 'business', score: 4, requirement: 3 })];
    const s = computeCompetencySummary(list, 'a', staffModel, { expectedGroup: 'staff' })!;
    expect(s.completeness.status).toBe('partial');
    expect(s.completeness.assessed).toBe(1);
    expect(s.completeness.expected).toBe(2);
    expect(s.overall?.status).toBe('healthy'); // 已评维度达标
    expect(s.completeness.qualified).toBe(false); // 但不称完整达标
  });

  it('A11：两维仅一维红灯 → 部分已评与具体风险并存，可进入待复核', () => {
    const list = [asm({ employeeId: 'a', dimension: 'business', score: 1, requirement: 3 })];
    const s = computeCompetencySummary(list, 'a', staffModel, { expectedGroup: 'staff' })!;
    expect(s.completeness.status).toBe('partial');
    expect(s.completeness.assessed).toBe(1);
    expect(s.dimensions[0].gap).toBe(2);
    expect(s.overall?.status).toBe('danger');
    expect(s.notCompetentCandidate).toBe(true); // 部分已评仍保留已发现的风险
    expect(s.completeness.qualified).toBe(false);
  });

  it('两维都评且全绿 → 完整已评 + 完整达标', () => {
    const list = [
      asm({ employeeId: 'a', dimension: 'business', score: 4, requirement: 3 }),
      asm({ employeeId: 'a', dimension: 'individual', score: 3, requirement: 3 }),
    ];
    const s = computeCompetencySummary(list, 'a', staffModel, { expectedGroup: 'staff' })!;
    expect(s.completeness.status).toBe('complete');
    expect(s.completeness.qualified).toBe(true);
  });

  it('A12：当前组所有维度停用 → 模型未配置，分母不可算，不显示全员达标', () => {
    const m = model(dim('business', { enabled: false }), dim('individual', { enabled: false }));
    const list = [asm({ employeeId: 'a', dimension: 'business', score: 4, requirement: 3 })];
    const s = computeCompetencySummary(list, 'a', m, { expectedGroup: 'staff' })!;
    expect(expectedDimensions(m, 'staff')).toHaveLength(0);
    expect(s.completeness.status).toBe('model-unconfigured');
    expect(s.completeness.computable).toBe(false);
    expect(s.completeness.qualified).toBe(false);
    expect(s.overall).toBeNull();
  });

  it('A13：员工转干部，有旧 staff 评分 → 旧分可查，leadership 按未评处理', () => {
    const m = model(
      dim('leadership_strategy', { group: 'leadership' }),
      dim('business', { group: 'staff' }),
    );
    const list = [asm({ employeeId: 'a', dimension: 'business', score: 4, requirement: 3 })];
    const s = computeCompetencySummary(list, 'a', m, { expectedGroup: 'leadership' })!;
    expect(s.completeness.status).toBe('unrated');
    expect(s.completeness.assessed).toBe(0);
    expect(s.dimensions).toEqual([]);
    // 旧 staff 评分仍可查（历史轨迹）
    expect(listAssessmentHistory(list, 'a', m).map((h) => h.dimension)).toEqual(['business']);
  });
});

describe('A14—A15 岗位适用性（R03、D02）', () => {
  it('A14：旧岗位评分 + 当前新岗位 → 旧分不自动成为新岗位结论', () => {
    const list = [asm({ employeeId: 'a', dimension: 'business', score: 5, requirement: 3, positionId: 'p1', scope: 'position' })];
    const s = computeCompetencySummary(list, 'a', staffModel, {
      expectedGroup: 'staff',
      currentPositionId: 'p2',
      assignments: [rel({ id: 'rel-b', employeeId: 'a', positionId: 'p2' })],
    })!;
    expect(s.dimensions).toEqual([]); // 旧岗位分不进当前结论
    expect(s.completeness.historical).toEqual(['business']);
    expect(s.completeness.assessed).toBe(0);
  });

  it('A14b：绑定旧任职关系（relationId 不再是当前关系）→ 同样只作历史', () => {
    const list = [asm({ employeeId: 'a', dimension: 'business', score: 5, requirement: 3, positionId: 'p1', scope: 'position', relationId: 'rel-old' })];
    const ctx = {
      expectedGroup: 'staff' as const,
      currentPositionId: 'p1',
      currentRelationId: 'rel-new',
      assignments: [rel({ id: 'rel-new', employeeId: 'a', positionId: 'p1' })],
    };
    expect(assessmentApplicability(list[0], ctx)).toBe('historical');
    const s = computeCompetencySummary(list, 'a', staffModel, ctx)!;
    expect(s.completeness.historical).toEqual(['business']);
  });

  it('A14c：曾离岗再回同岗（存在已结束任职）→ 旧记录不能证明同一次任职', () => {
    const list = [asm({ employeeId: 'a', dimension: 'business', score: 5, requirement: 3, positionId: 'p1', scope: 'position' })];
    const ctx = {
      expectedGroup: 'staff' as const,
      currentPositionId: 'p1',
      currentRelationId: 'rel-2',
      assignments: [
        rel({ id: 'rel-1', employeeId: 'a', positionId: 'p1', status: 'ended', endDate: '2026-08-01T00:00:00.000Z' }),
        rel({ id: 'rel-2', employeeId: 'a', positionId: 'p1', startDate: '2026-09-01T00:00:00.000Z' }),
      ],
    };
    expect(assessmentApplicability(list[0], ctx)).toBe('historical');
  });

  it('A15：当前岗位与通用评价同时存在 → 当前岗位优先，来源可解释', () => {
    const list = [
      asm({ id: 'general-1', employeeId: 'a', dimension: 'business', score: 1, requirement: 3, scope: 'general', assessedAt: '2026-09-02T12:00:00.000Z' }),
      asm({ id: 'pos-1', employeeId: 'a', dimension: 'business', score: 4, requirement: 3, positionId: 'p1', scope: 'position', assessedAt: '2026-09-01T12:00:00.000Z' }),
    ];
    const ctx = {
      expectedGroup: 'staff' as const,
      currentPositionId: 'p1',
      assignments: [rel({ id: 'rel-1', employeeId: 'a', positionId: 'p1' })],
    };
    const s = computeCompetencySummary(list, 'a', staffModel, ctx)!;
    expect(s.dimensions[0].score).toBe(4);
    expect(s.dimensions[0].assessmentId).toBe('pos-1');
    expect(s.dimensions[0].applicability).toBe('current-position'); // 旧记录按当前岗位核对，来源可解释
  });

  it('当前任职评价（relationId 命中）优先于通用评价，并标明来源为 current', () => {
    const list = [
      asm({ id: 'g', employeeId: 'a', dimension: 'business', score: 1, requirement: 3, scope: 'general' }),
      asm({ id: 'c', employeeId: 'a', dimension: 'business', score: 5, requirement: 3, positionId: 'p1', scope: 'position', relationId: 'rel-1' }),
    ];
    const s = computeCompetencySummary(list, 'a', staffModel, {
      expectedGroup: 'staff',
      currentPositionId: 'p1',
      currentRelationId: 'rel-1',
      assignments: [rel({ id: 'rel-1', employeeId: 'a', positionId: 'p1' })],
    })!;
    expect(s.dimensions[0].assessmentId).toBe('c');
    expect(s.dimensions[0].applicability).toBe('current');
  });

  it('无岗位限制的旧记录（无 positionId）→ 通用评价，来源可解释', () => {
    const list = [asm({ employeeId: 'a', dimension: 'business', score: 4, requirement: 3 })];
    expect(assessmentScopeOf(list[0])).toBe('general');
    const s = computeCompetencySummary(list, 'a', staffModel, { expectedGroup: 'staff' })!;
    expect(s.dimensions[0].applicability).toBe('general');
  });

  it('历史岗位评价不能成为默认回退值：当前任职无分时，旧岗位分不顶上', () => {
    const list = [
      asm({ employeeId: 'a', dimension: 'business', score: 5, requirement: 3, positionId: 'p1', scope: 'position', relationId: 'rel-old' }),
    ];
    const s = computeCompetencySummary(list, 'a', staffModel, {
      expectedGroup: 'staff',
      currentPositionId: 'p2',
      currentRelationId: 'rel-new',
      assignments: [rel({ id: 'rel-new', employeeId: 'a', positionId: 'p2' })],
    })!;
    expect(s.dimensions).toEqual([]);
    expect(s.overall).toBeNull();
    expect(s.completeness.historical).toEqual(['business']);
  });
});

describe('A16—A18 同日修订与冲突（R06、F03）', () => {
  const T = '2026-09-01T12:00:00.000Z';

  it('A16：同日旧分与显式修订分 → 用修订链终点，旧分保留', () => {
    const old = asm({ id: 'old', employeeId: 'a', dimension: 'business', score: 2, requirement: 3, assessedAt: T });
    const rev = asm({ id: 'rev', employeeId: 'a', dimension: 'business', score: 5, requirement: 3, assessedAt: T, revisionOf: 'old' });
    const r = resolveSupervisorAssessment([old, rev], 'a', 'business');
    expect(r.effective?.id).toBe('rev');
    expect(r.effective?.score).toBe(5);
    expect(r.revisedIds).toContain('old'); // 旧分保留可查
    expect(r.conflict).toBe(false);

    const s = computeCompetencySummary([old, rev], 'a', staffModel, { expectedGroup: 'staff' })!;
    expect(s.dimensions[0].score).toBe(5);
    expect(s.dimensions[0].revised).toBe(true);
  });

  it('A17：旧数据同时间两条冲突分 → 标记冲突，不按数组顺序选择', () => {
    const x = asm({ id: 'x', employeeId: 'a', dimension: 'business', score: 2, requirement: 3, assessedAt: T });
    const y = asm({ id: 'y', employeeId: 'a', dimension: 'business', score: 5, requirement: 3, assessedAt: T });
    // 两种顺序都必须得到同一结论（不受数组顺序影响）
    for (const list of [[x, y], [y, x]]) {
      const r = resolveSupervisorAssessment(list, 'a', 'business');
      expect(r.conflict).toBe(true);
      expect(r.effective).toBeNull();
    }
    const s = computeCompetencySummary([x, y], 'a', staffModel, { expectedGroup: 'staff' })!;
    expect(s.completeness.conflicted).toEqual(['business']);
    expect(s.completeness.dataIssue).toBe(true);
    expect(s.completeness.assessed).toBe(0); // 冲突维度不进有效已评分子
    expect(s.dimensions).toEqual([]);
  });

  it('同时间内容完全一致 → 折叠为重复，保留原记录且不判冲突', () => {
    const x = asm({ id: 'x', employeeId: 'a', dimension: 'business', score: 3, requirement: 3, assessedAt: T, note: '同上' });
    const y = asm({ id: 'y', employeeId: 'a', dimension: 'business', score: 3, requirement: 3, assessedAt: T, note: '同上' });
    const r = resolveSupervisorAssessment([x, y], 'a', 'business');
    expect(r.conflict).toBe(false);
    expect(r.duplicate).toBe(true);
    expect(r.effective?.score).toBe(3);
    expect(r.allIds.sort()).toEqual(['x', 'y']); // 原记录都保留
  });

  it('A18：无效修订链（跨人 / 跨维度 / 跨角色 / 跨时点 / 循环 / 分叉）拒绝写入', () => {
    const base = asm({ id: 'base', employeeId: 'a', dimension: 'business', score: 2, requirement: 3, assessedAt: T });
    const other = asm({ id: 'other', employeeId: 'b', dimension: 'business', score: 2, requirement: 3, assessedAt: T });
    const all = [base, other];

    expect(revisionChainIssue(all, asm({ employeeId: 'a', dimension: 'business', score: 3, assessedAt: T, revisionOf: 'other' })))
      .toBe('修订不能跨员工');
    expect(revisionChainIssue(all, asm({ employeeId: 'b', dimension: 'other', score: 3, assessedAt: T, revisionOf: 'other' })))
      .toBe('修订不能跨维度');
    expect(revisionChainIssue(all, asm({ employeeId: 'b', dimension: 'business', score: 3, assessedAt: T, revisionOf: 'other', assessorRole: 'hrbp' })))
      .toBe('修订不能跨评分角色');
    expect(revisionChainIssue(all, asm({ employeeId: 'b', dimension: 'business', score: 3, assessedAt: '2026-10-01T00:00:00.000Z', revisionOf: 'other' })))
      .toBe('修订不能跨评估时点');
    expect(revisionChainIssue(all, asm({ employeeId: 'b', dimension: 'business', score: 3, assessedAt: T, revisionOf: 'missing' })))
      .toBe('被修订记录不存在');

    // 分叉：base 已有 rev1，再来 rev2 指向 base → 拒绝
    const rev1 = asm({ id: 'rev1', employeeId: 'a', dimension: 'business', score: 3, assessedAt: T, revisionOf: 'base' });
    expect(revisionChainIssue([base, rev1], asm({ employeeId: 'a', dimension: 'business', score: 4, assessedAt: T, revisionOf: 'base' })))
      .toBe('同一记录已存在修订，不能无提示分叉');

    // 链式修订合法：base ← rev1 ← rev2，终点为 rev2
    const rev2 = asm({ id: 'rev2', employeeId: 'a', dimension: 'business', score: 4, assessedAt: T, revisionOf: 'rev1' });
    expect(revisionChainIssue([base, rev1], rev2)).toBeUndefined();
    const chain = resolveSupervisorAssessment([base, rev1, rev2], 'a', 'business');
    expect(chain.effective?.id).toBe('rev2');
    expect(chain.revisedIds.sort()).toEqual(['base', 'rev1']); // 旧分逐级保留

    // 循环：两条互相引用
    const c1 = { ...asm({ id: 'c1', employeeId: 'a', dimension: 'business', score: 3, assessedAt: T }), revisionOf: 'c2' };
    const c2 = { ...asm({ id: 'c2', employeeId: 'a', dimension: 'business', score: 4, assessedAt: T }), revisionOf: 'c1' };
    expect(revisionChainIssue([c1, c2], c1)).toBeTruthy();
    // 读侧也不产出结论
    expect(resolveSupervisorAssessment([c1, c2], 'a', 'business').conflict).toBe(true);
  });

  it('修订约束的范围一致性：跨适用范围拒绝', () => {
    const pos = asm({ id: 'pos', employeeId: 'a', dimension: 'business', score: 2, requirement: 3, assessedAt: T, positionId: 'p1', scope: 'position' });
    const general = asm({ id: 'gen', employeeId: 'a', dimension: 'business', score: 2, requirement: 3, assessedAt: T, scope: 'general' });
    expect(revisionLinkIssue(pos, { ...general, revisionOf: 'pos' })).toBe('修订不能跨评价适用范围');
  });

  it('currentRevisionEndpoint 返回同日修订链终点', () => {
    const old = asm({ id: 'old', employeeId: 'a', dimension: 'business', score: 2, requirement: 3, assessedAt: T });
    const rev = asm({ id: 'rev', employeeId: 'a', dimension: 'business', score: 5, requirement: 3, assessedAt: T, revisionOf: 'old' });
    const endpoint = currentRevisionEndpoint([old, rev], {
      employeeId: 'a', dimension: 'business', assessorRole: 'supervisor', assessedAt: T, scope: 'general',
    });
    expect(endpoint?.id).toBe('rev');
  });
});

describe('A19 HRBP 校准并列（R06、D03）', () => {
  it('上级分 2、HRBP 校准分 4 → 校准并列，原始灯号仍按上级分', () => {
    const list = [
      asm({ id: 'sup', employeeId: 'a', dimension: 'business', score: 2, requirement: 3, assessorRole: 'supervisor', assessorId: '上级A' }),
      asm({ id: 'cal', employeeId: 'a', dimension: 'business', score: 4, requirement: 3, assessorRole: 'hrbp', assessorId: 'HRBP-B' }),
    ];
    const s = computeCompetencySummary(list, 'a', staffModel, { expectedGroup: 'staff' })!;
    expect(s.dimensions[0].score).toBe(2);
    expect(s.dimensions[0].gap).toBe(1);
    expect(s.overall?.status).toBe('warn'); // 校准分不进入灯号
    expect(s.dimensions[0].hrbpCalibration).toMatchObject({ score: 4, assessorId: 'HRBP-B' });
    expect(s.assessedBy).toEqual(['上级A']); // 校准分不算「已评」
    expect(s.completeness.assessed).toBe(1);
  });

  it('只有 HRBP 校准分时 → 该维度仍未评（校准不冒充原始分）', () => {
    const list = [asm({ employeeId: 'a', dimension: 'business', score: 4, requirement: 3, assessorRole: 'hrbp' })];
    const s = computeCompetencySummary(list, 'a', staffModel, { expectedGroup: 'staff' })!;
    expect(s.completeness.status).toBe('unrated');
    expect(s.dimensions).toEqual([]);
  });
});

describe('A20—A21 人工复核留痕（R03、D04）', () => {
  const T = '2026-09-05T00:00:00.000Z';
  const relation = rel({ id: 'rel-1', employeeId: 'a', positionId: 'p1', positionName: '工程师' });
  const confirmed = rel({
    id: 'rev-1', employeeId: 'a', positionId: 'p1', status: 'not_competent', relationId: 'rel-1',
    confirmedBy: '复核人A', confirmedAt: T, reviewNote: '连续两个周期未达要求', reviewAssessmentIds: ['sup-1'],
  });

  it('A20：确认后撤销确认 → 两条事实均可查，当前确认取消', () => {
    const revoked = { ...confirmed, revokedAt: '2026-09-08T00:00:00.000Z', revokedBy: '复核人B', revokeReason: '补充证据后推翻' };
    const events = listReviewEvents([relation, revoked], [], 'a');
    expect(events).toHaveLength(1);
    expect(events[0].revoked).toBe(true);
    expect(events[0].confirmedBy).toBe('复核人A');
    expect(events[0].confirmedAt).toBe(T);
    expect(events[0].revokedBy).toBe('复核人B');
    expect(events[0].revokeReason).toBe('补充证据后推翻');
    expect(events[0].note).toBe('连续两个周期未达要求');
    expect(events[0].assessmentIds).toEqual(['sup-1']);
    // 当前确认取消 → 不再作用于在任关系
    expect(events[0].appliesToCurrentRelation).toBe(true); // 任职仍在，但确认已撤销（由 revoked 表达）
  });

  it('未撤销的确认作用于当前在任关系', () => {
    const events = listReviewEvents([relation, confirmed], [], 'a');
    expect(events[0].revoked).toBe(false);
    expect(events[0].appliesToCurrentRelation).toBe(true);
    expect(events[0].relationActive).toBe(true);
  });

  it('A21：人工确认后新增评分 → 原确认可见且标记依据已有变化', () => {
    const late = asm({
      employeeId: 'a', dimension: 'business', score: 2, requirement: 3,
      createdAt: '2026-09-20T00:00:00.000Z', assessedAt: '2026-09-20T00:00:00.000Z',
    });
    const events = listReviewEvents([relation, confirmed], [late], 'a');
    expect(events[0].staleAfterNewAssessment).toBe(true);
    expect(events[0].confirmedBy).toBe('复核人A'); // 原确认仍可查
  });

  it('关系结束后原确认只作历史；同人重回同岗的新关系不继承', () => {
    const ended = { ...relation, status: 'ended' as const, endDate: '2026-09-10T00:00:00.000Z' };
    const back = rel({ id: 'rel-2', employeeId: 'a', positionId: 'p1', startDate: '2026-10-01T00:00:00.000Z' });
    const events = listReviewEvents([ended, back, confirmed], [], 'a');
    expect(events[0].relationActive).toBe(false); // 原任职已结束
    expect(events[0].appliesToCurrentRelation).toBe(false); // 旧确认不继承到新关系
    expect(events[0].confirmedBy).toBe('复核人A'); // 但历史可查
  });

  it('一人某个兼岗被确认，不传播成主岗结论', () => {
    const secondary = rel({ id: 'rel-sec', employeeId: 'a', positionId: 'p2', type: 'secondary' });
    const secConfirm = rel({
      id: 'rev-sec', employeeId: 'a', positionId: 'p2', status: 'not_competent', relationId: 'rel-sec',
      confirmedBy: '复核人A', confirmedAt: T,
    });
    const events = listReviewEvents([relation, secondary, confirmed, secConfirm], [], 'a');
    const main = events.find((e) => e.positionId === 'p1')!;
    const sec = events.find((e) => e.positionId === 'p2')!;
    expect(main.relationId).toBe('rel-1');
    expect(sec.relationId).toBe('rel-sec');
    expect(main.id).not.toBe(sec.id);
  });
});

describe('A24—A25 旧数据缺失保持未知 + 新事实完整回读', () => {
  it('A24：旧格式缺到岗日期和确认人 → 缺失保持未知，保存重开不伪造事实', () => {
    const project = createProject('M2 迁移');
    const sc = project.scenarios[0];
    sc.allEmployeesFlat = [{ id: 'e1', name: '张三', employeeId: 'E001', level: 'L1' }];
    sc.departments = [{ id: 'd1', name: '研发部', level: 1, children: [], employees: [sc.allEmployeesFlat[0]], expanded: true }];
    sc.positionAssignments = [
      { id: 'asg-legacy', employeeId: 'e1', positionId: 'p1', type: 'primary', status: 'active', source: 'legacy', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
      { id: 'rev-legacy', employeeId: 'e1', positionId: 'p1', type: 'primary', status: 'not_competent', relationId: 'asg-legacy', source: 'legacy', confirmedAt: '2026-09-02T00:00:00.000Z', createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z' },
    ];

    const again = parseProject(serializeProject(project))!;
    const a = again.scenarios[0].positionAssignments!;
    const active = a.find((x) => x.id === 'asg-legacy')!;
    const review = a.find((x) => x.id === 'rev-legacy')!;
    expect(active.startDate).toBeUndefined(); // 不伪造到岗日期
    expect(review.confirmedBy).toBeUndefined(); // 不编造确认人
    expect(review.confirmedAt).toBe('2026-09-02T00:00:00.000Z'); // 已知事实保留
    const events = listReviewEvents(a, [], 'e1');
    expect(events[0].confirmedBy).toBeUndefined();
  });

  it('A25：新字段经过序列化回读保持一致（关系 / 修订 / 复核）', () => {
    const project = createProject('M2 回读');
    const sc = project.scenarios[0];
    sc.allEmployeesFlat = [{ id: 'e1', name: '张三', employeeId: 'E001', level: 'L1', positionId: 'p1' }];
    sc.departments = [{ id: 'd1', name: '研发部', level: 1, children: [], employees: [sc.allEmployeesFlat[0]], expanded: true }];
    sc.positionAssignments = [
      rel({ id: 'rel-1', employeeId: 'e1', positionId: 'p1' }),
      rel({
        id: 'rev-1', employeeId: 'e1', positionId: 'p1', status: 'not_competent', relationId: 'rel-1',
        confirmedBy: '复核人A', confirmedAt: '2026-09-05T00:00:00.000Z',
        reviewNote: '依据说明', reviewAssessmentIds: ['a1', 'a2'],
        revokedAt: '2026-09-06T00:00:00.000Z', revokedBy: '复核人B', revokeReason: '证据不足',
      }),
    ];
    sc.assessments = [
      asm({ id: 'a1', employeeId: 'e1', dimension: 'business', score: 2, requirement: 3, positionId: 'p1', scope: 'position', relationId: 'rel-1' }),
      asm({ id: 'a2', employeeId: 'e1', dimension: 'business', score: 4, requirement: 3, positionId: 'p1', scope: 'position', relationId: 'rel-1', revisionOf: 'a1', assessedAt: '2026-09-01T12:00:00.000Z' }),
      asm({ id: 'a3', employeeId: 'e1', dimension: 'individual', score: 3, requirement: 3, assessorRole: 'hrbp', assessorId: 'HRBP-B', enteredBy: '牵头HRBP' }),
    ];

    const again = parseProject(serializeProject(project))!;
    const sc2 = again.scenarios[0];
    const a2 = sc2.assessments!.find((x) => x.id === 'a2')!;
    expect(a2.revisionOf).toBe('a1');
    expect(a2.scope).toBe('position');
    expect(a2.relationId).toBe('rel-1');
    const a3 = sc2.assessments!.find((x) => x.id === 'a3')!;
    expect(a3.assessorRole).toBe('hrbp');
    expect(a3.enteredBy).toBe('牵头HRBP');
    const review = sc2.positionAssignments!.find((x) => x.id === 'rev-1')!;
    expect(review.reviewNote).toBe('依据说明');
    expect(review.reviewAssessmentIds).toEqual(['a1', 'a2']);
    expect(review.revokedBy).toBe('复核人B');
    expect(review.revokeReason).toBe('证据不足');

    // 迁移幂等：二次回读修订链仍解析到终点
    const again2 = parseProject(serializeProject(again))!;
    const r = resolveSupervisorAssessment(again2.scenarios[0].assessments!, 'e1', 'business', {
      expectedGroup: 'staff', currentPositionId: 'p1', currentRelationId: 'rel-1', assignments: again2.scenarios[0].positionAssignments!,
    });
    expect(r.effective?.id).toBe('a2');
    expect(r.revisedIds).toEqual(['a1']);
  });
});
