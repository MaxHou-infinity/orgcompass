import { describe, it, expect } from 'vitest';
import {
  assessmentDayOf,
  localDayOf,
  currentRevisionEndpoint,
  resolveSupervisorAssessment,
  revisionLinkIssue,
} from './competency';
import { seedLegacyAssignments, inspectPlacements } from './placement';
import { confirmedNotCompetentSet } from './assignment';
import { COMPETENCY_SCALE } from '../types';
import type { Assessment, Department, Employee, PositionAssignment } from '../types';

/**
 * —— v2.3.1 评估链路回归（审计报告 F-08 / F-13）——
 *
 * 断言目标是「回退修复即失败」。
 */

function asm(id: string, assessedAt: string, score: number, extra: Partial<Assessment> = {}): Assessment {
  return {
    id,
    employeeId: 'e1',
    dimension: 'business',
    score,
    scale: COMPETENCY_SCALE,
    requirement: 3,
    assessorRole: 'supervisor',
    assessedAt,
    source: 'manual',
    createdAt: assessedAt,
    updatedAt: assessedAt,
    ...extra,
  };
}

// ───────────────────────── F-08 同日键 ─────────────────────────

describe('v2.3.1 F-08：同日判定必须用「自然日」而不是「时刻」', () => {
  it('assessmentDayOf 优先用显式 assessmentDay；缺失时按本地时区从 assessedAt 回推', () => {
    expect(assessmentDayOf({ assessedAt: '2026-09-18T04:00:00.000Z' })).toBe(localDayOf('2026-09-18T04:00:00.000Z'));
    expect(assessmentDayOf({ assessedAt: '2026-09-18T04:00:00.000Z', assessmentDay: '2026-09-19' })).toBe('2026-09-19');
    // 非法值不被采信 → 回退到时刻推导
    expect(assessmentDayOf({ assessedAt: '2026-09-18T04:00:00.000Z', assessmentDay: '9/18' })).toBe(
      localDayOf('2026-09-18T04:00:00.000Z'),
    );
  });

  it('同一天、不同时刻（本地正午归一 vs 真实时刻）→ 不再静默取较晚时刻那条', () => {
    // v2.3.0 复现：批量评估写入「本地正午」(04:00Z)，随后导入写入真实时刻 (02:00Z)。
    // 旧实现只取 assessedAt 最大者 → 02:00Z 那条既不入组也不成端点 → 用户刚导入的分永不生效且无提示。
    const pool = [
      asm('batch', '2026-09-18T04:00:00.000Z', 3),
      asm('import', '2026-09-18T02:00:00.000Z', 5),
    ];
    const resolved = resolveSupervisorAssessment(pool, 'e1', 'business');
    // 两条同属一天且内容冲突、无修订关系 → 必须标记「评分冲突待核对」，不得按顺序任选
    expect(resolved.conflict).toBe(true);
    expect(resolved.effective).toBeNull();
  });

  it('同日有显式修订关系 → 取修订链终点（旧分保留）', () => {
    const pool = [
      asm('batch', '2026-09-18T04:00:00.000Z', 3),
      asm('rev', '2026-09-18T02:00:00.000Z', 5, { revisionOf: 'batch' }),
    ];
    const resolved = resolveSupervisorAssessment(pool, 'e1', 'business');
    expect(resolved.conflict).toBe(false);
    expect(resolved.effective?.id).toBe('rev');
    expect(resolved.effective?.score).toBe(5);
  });

  it('不同自然日 → 仍取最新一天，不误报冲突', () => {
    const pool = [
      asm('old', '2026-09-17T04:00:00.000Z', 3),
      asm('new', '2026-09-18T02:00:00.000Z', 5),
    ];
    const resolved = resolveSupervisorAssessment(pool, 'e1', 'business');
    expect(resolved.conflict).toBe(false);
    expect(resolved.effective?.score).toBe(5);
  });

  it('写入层：同日另一时刻已有记录时，currentRevisionEndpoint 能命中（不再写出悬空新记录）', () => {
    const pool = [asm('batch', '2026-09-18T04:00:00.000Z', 3)];
    const endpoint = currentRevisionEndpoint(pool, {
      employeeId: 'e1',
      dimension: 'business',
      assessorRole: 'supervisor',
      assessedAt: '2026-09-18T02:00:00.000Z',
      scope: 'general',
    });
    // ← v2.3.0 这里是 undefined（时刻不等），于是新记录既不成为修订、也不进分组 → 静默失效
    expect(endpoint?.id).toBe('batch');
  });

  it('revisionLinkIssue 接受同一自然日的修订，拒绝跨自然日', () => {
    const target = asm('t', '2026-09-18T04:00:00.000Z', 3);
    expect(revisionLinkIssue(target, asm('r', '2026-09-18T02:00:00.000Z', 4, { revisionOf: 't' }))).toBeUndefined();
    expect(revisionLinkIssue(target, asm('r', '2026-09-19T02:00:00.000Z', 4, { revisionOf: 't' }))).toBe('修订不能跨评估日');
  });
});

// ───────────────────────── F-13 legacy 离岗重入守卫 ─────────────────────────

describe('v2.3.1 F-13：legacy 关联不得把旧「不胜任」确认复活到新关系', () => {
  const t0 = '2026-09-01T00:00:00.000Z';
  const t1 = '2026-09-02T00:00:00.000Z';

  function build() {
    const e: Employee = { id: 'e', name: 'e', employeeId: 'E', level: 'L1', positionId: 'pa' };
    const departments: Department[] = [
      {
        id: 'a',
        name: 'a',
        level: 1,
        expanded: true,
        children: [],
        employees: [e],
        positions: [
          { id: 'pa', departmentId: 'a', name: '岗位A', status: 'active', headcount: 1, createdAt: t0, updatedAt: t0 },
        ],
      },
    ];
    // 旧关系（曾离岗）已 ended —— 这正是 v2.3.0 漏掉的守卫依据
    const ended: PositionAssignment = {
      id: 'old-rel',
      employeeId: 'e',
      positionId: 'pa',
      type: 'primary',
      status: 'ended',
      endDate: t1,
      createdAt: t0,
      updatedAt: t1,
    };
    // v2.2 时代遗留的确认：没有 relationId（linkConfirmations 存在的意义）
    const legacyConfirm: PositionAssignment = {
      id: 'confirm',
      employeeId: 'e',
      positionId: 'pa',
      type: 'primary',
      status: 'not_competent',
      createdAt: t0,
      updatedAt: t0,
    };
    return { e, departments, records: [ended, legacyConfirm] };
  }

  it('曾离岗再回同岗 → 旧确认不自动挂到新关系，也不生效', () => {
    const { e, departments, records } = build();
    const seeded = seedLegacyAssignments([e], departments, records, t0, true);
    expect(seeded.find((r) => r.id === 'confirm')!.relationId).toBeUndefined(); // ← v2.3.0 会被挂成新关系
    expect(confirmedNotCompetentSet(seeded, [e]).has('e')).toBe(false);
    expect(inspectPlacements([e], departments, seeded)).toEqual([]);
  });

  it('对照：没有「曾离岗」历史时，legacy 确认仍按原样挂链（不误伤正常迁移）', () => {
    const { e, departments, records } = build();
    // 去掉 ended 关系 → 只剩遗留确认，应当正常挂链
    const seeded = seedLegacyAssignments([e], departments, [records[1]], t0, true);
    expect(seeded.find((r) => r.id === 'confirm')!.relationId).toBeTruthy();
    expect(confirmedNotCompetentSet(seeded, [e]).has('e')).toBe(true);
  });

  it('linkConfirmations=false 时行为不变（迁移以外不自动关联）', () => {
    const { e, departments, records } = build();
    const seeded = seedLegacyAssignments([e], departments, [records[1]], t0, false);
    expect(seeded.find((r) => r.id === 'confirm')!.relationId).toBeUndefined();
  });
});
