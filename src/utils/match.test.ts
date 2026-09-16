import { describe, it, expect } from 'vitest';
import { computeMatchStates } from './match';
import { confirmedNotCompetentSet } from './assignment';
import type { Employee, Position } from '../types';

function pos(id: string, headcount: number, status: Position['status'] = 'active', name = '岗位'): Position {
  return { id, departmentId: 'd1', name, headcount, status, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
}
function emp(id: string, positionId?: string, isVirtual = false): Employee {
  return { id, name: `员工${id}`, employeeId: `E${id}`, level: 'L1.1', positionId, isVirtual };
}

describe('computeMatchStates（人岗匹配状态机 v2.1.1）', () => {
  it('满编：岗位 headcount=2，2 人套岗 → 全部 placed', () => {
    const positions = [pos('p1', 2)];
    const emps = [emp('a', 'p1'), emp('b', 'p1')];
    const r = computeMatchStates(emps, positions);
    expect(r.map((x) => x.status)).toEqual(['placed', 'placed']);
    expect(r.every((x) => x.positionId === 'p1')).toBe(true);
  });

  it('超编：日期未知时只报告岗位超额，不指定个人', () => {
    const positions = [pos('p1', 2)];
    const emps = [emp('a', 'p1'), emp('b', 'p1'), emp('c', 'p1')];
    const r = computeMatchStates(emps, positions);
    expect(r.find((x) => x.employeeId === 'c')).toMatchObject({ status: 'placed', positionOverflow: 1, overflowUnresolved: true });
    expect(r.find((x) => x.employeeId === 'a')?.status).toBe('placed');
  });

  it('编制 0 / 未配置：套岗仍 placed，不判超编', () => {
    const positions = [pos('p1', 0)];
    const emps = [emp('a', 'p1'), emp('b', 'p1')];
    const r = computeMatchStates(emps, positions);
    expect(r.map((x) => x.status)).toEqual(['placed', 'placed']); // headcount<=0 不判超编
  });

  it('无 positionId → unassigned(no_position)；archived 岗位 → unassigned', () => {
    const positions = [pos('p1', 2, 'archived')];
    const emps = [emp('a'), emp('b', 'p1')];
    const r = computeMatchStates(emps, positions);
    expect(r.find((x) => x.employeeId === 'a')).toMatchObject({ status: 'unassigned', reason: 'no_position' });
    expect(r.find((x) => x.employeeId === 'b')?.status).toBe('unassigned'); // archived 不计占用
  });

  it('虚拟兼岗不参与判定（跟随主岗，不单独产出）', () => {
    const positions = [pos('p1', 2)];
    const emps = [emp('a', 'p1'), emp('v', 'p1', true)];
    const r = computeMatchStates(emps, positions);
    expect(r.map((x) => x.employeeId)).toEqual(['a']); // 虚拟被跳过
  });

  it('冻结编制（frozen）→ 视为未配置，不判超编、不占缺口', () => {
    const positions = [pos('p1', 3, 'frozen')];
    const emps = [emp('a', 'p1'), emp('b', 'p1')];
    const r = computeMatchStates(emps, positions);
    expect(r.map((x) => x.status)).toEqual(['placed', 'placed']);
  });
});

describe('computeMatchStates v2.2.0：not_competent 两态接入（design doc §6）', () => {
  it('已确认 not_competent → 产出 MatchStatus.not_competent + reason=not-competent', () => {
    const positions = [pos('p1', 2)];
    const emps = [emp('a', 'p1')];
    const r = computeMatchStates(emps, positions, new Set(['a']));
    expect(r[0]).toMatchObject({ status: 'not_competent', positionId: 'p1', reason: 'not-competent' });
  });

  it('覆盖优先级：not_competent > overstaffed（后进超编者被确认）', () => {
    const positions = [pos('p1', 1)];
    const emps = [emp('a', 'p1'), emp('b', 'p1')];
    const r = computeMatchStates(emps, positions, new Set(['b']));
    expect(r.find((x) => x.employeeId === 'b')?.status).toBe('not_competent');
    expect(r.find((x) => x.employeeId === 'a')?.status).toBe('placed');
  });

  it('unassigned 仍最高：未套岗员工即使被确认也保持 unassigned', () => {
    const positions = [pos('p1', 2)];
    const emps = [emp('a'), emp('b', 'p1')];
    const r = computeMatchStates(emps, positions, new Set(['a', 'b']));
    expect(r.find((x) => x.employeeId === 'a')).toMatchObject({ status: 'unassigned', reason: 'no_position' });
    expect(r.find((x) => x.employeeId === 'b')?.status).toBe('not_competent');
  });

  it('候选（未人工确认）不产出：缺省入参 = v2.1.1 行为', () => {
    const positions = [pos('p1', 2)];
    const emps = [emp('a', 'p1')];
    expect(computeMatchStates(emps, positions)[0].status).toBe('placed');
    expect(computeMatchStates(emps, positions, new Set())[0].status).toBe('placed');
  });

  it('虚拟副本跟随主岗：确认集合含虚拟副本 id 也不单独产出', () => {
    const positions = [pos('p1', 2)];
    const emps = [emp('a', 'p1'), emp('v', 'p1', true)];
    const r = computeMatchStates(emps, positions, new Set(['v']));
    expect(r.map((x) => x.employeeId)).toEqual(['a']);
    expect(r[0].status).toBe('placed');
  });

  it('与 confirmedNotCompetentSet 衔接：assignment 确认态 → match 产出', () => {
    const positions = [pos('p1', 2)];
    const emps = [emp('a', 'p1')];
    const confirmed = confirmedNotCompetentSet([
      { id: 'active-1', employeeId: 'a', positionId: 'p1', type: 'primary', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      { relationId: 'active-1', id: 'asg-1', employeeId: 'a', positionId: 'p1', type: 'primary', startDate: '2026-01-01', status: 'not_competent', confirmedBy: 'hr', confirmedAt: '2026-02-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' },
    ], emps);
    expect(computeMatchStates(emps, positions, confirmed)[0]).toMatchObject({ status: 'not_competent', reason: 'not-competent' });
  });
});
