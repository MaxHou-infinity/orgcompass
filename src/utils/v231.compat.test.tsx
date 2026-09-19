// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from '../App';
import { parseProject, serializeProject, createProject, decodeStoredProject, PROJECT_STORAGE_KEY } from './project';
import { latestHrbpAssessment } from './competency';
import { DEFAULT_LEVELS } from './levels';
import { DEFAULT_COMPETENCY_MODEL, COMPETENCY_SCALE } from '../types';
import type { Assessment, Department, Employee, ProjectFile } from '../types';

/**
 * —— v2.3.1 兼容与闭环回归（审计报告 Q-07 / Q-10 / Q-18）——
 */

const storage = new Map<string, string>();
const t = '2026-09-01T00:00:00.000Z';

beforeEach(() => {
  storage.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => storage.clear(),
    key: () => null,
    length: storage.size,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ───────────────────── Q-10：同格式新增字段不得被静默丢弃 ─────────────────────

describe('v2.3.1 Q-10：未知字段跨版本往返必须保留', () => {
  const withFutureFields = () => {
    const p = createProject('兼容项目');
    (p.meta as unknown as Record<string, unknown>).futureMetaFlag = true;
    const sc = p.scenarios[0];
    (sc as unknown as Record<string, unknown>).futureScenarioField = 'keep-me';
    sc.levelConfigs = DEFAULT_LEVELS.map((c) => ({ ...c }));
    (sc.levelConfigs[0] as unknown as Record<string, unknown>).futureCostBasis = 'band';
    const dept: Department = {
      id: 'd1',
      name: '研发部',
      level: 1,
      expanded: true,
      children: [],
      employees: [{ id: 'e1', name: '张三', employeeId: 'E001', level: 'L1' }],
      positions: [
        {
          id: 'p1',
          departmentId: 'd1',
          name: '前端',
          headcount: 3,
          status: 'active',
          createdAt: t,
          updatedAt: t,
        },
      ],
    };
    (dept as unknown as Record<string, unknown>).futureDeptField = { nested: true };
    (dept.positions![0] as unknown as Record<string, unknown>).futurePositionField = 42;
    sc.departments = [dept];
    return p;
  };

  it('项目 / 场景 / 部门 / 岗位 / 职级配置上的未知字段都能往返保留', () => {
    const parsed = parseProject(serializeProject(withFutureFields()))!;
    const sc = parsed.scenarios[0];
    expect((parsed.meta as unknown as Record<string, unknown>).futureMetaFlag).toBe(true);
    expect((sc as unknown as Record<string, unknown>).futureScenarioField).toBe('keep-me');
    const dept = sc.departments[0];
    expect((dept as unknown as Record<string, unknown>).futureDeptField).toEqual({ nested: true });
    expect((dept.positions![0] as unknown as Record<string, unknown>).futurePositionField).toBe(42);
    expect((sc.levelConfigs[0] as unknown as Record<string, unknown>).futureCostBasis).toBe('band');
  });

  it('已知字段仍走清洗：非法值不会被原始值透传（防止「保留未知字段」变成绕过校验）', () => {
    const raw = JSON.parse(serializeProject(withFutureFields()));
    raw.scenarios[0].departments[0].leaderType = 'bogus';
    raw.scenarios[0].departments[0].headcount = 'abc';
    raw.scenarios[0].departments[0].positions[0].status = 'weird';
    raw.scenarios[0].departments[0].positions[0].headcount = 'NaN';
    const parsed = parseProject(JSON.stringify(raw))!;
    const dept = parsed.scenarios[0].departments[0];
    expect(dept.leaderType).toBeUndefined(); // 非法枚举被丢弃
    expect(dept.headcount).toBeUndefined(); // 非法数字不落库
    expect(dept.positions![0].status).toBe('active'); // 回退默认
    expect(dept.positions![0].headcount).toBe(0);
  });

  it('__proto__ / constructor 不会被搬运（不做原型链注入）', () => {
    const raw = JSON.parse(serializeProject(withFutureFields()));
    raw.scenarios[0].departments[0].__proto__ = { polluted: true };
    raw.scenarios[0].departments[0].constructor = 'evil';
    const parsed = parseProject(JSON.stringify(raw))!;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const dept = parsed.scenarios[0].departments[0] as unknown as Record<string, unknown>;
    expect(dept.constructor).toBe(Object);
    expect(Object.prototype.hasOwnProperty.call(dept, '__proto__')).toBe(false);
  });
});

// ───────────────────── Q-18：HRBP 校准分的岗位适用性 ─────────────────────

describe('v2.3.1 Q-18：HRBP 校准分与上级分同口径过适用性', () => {
  const ctx = { currentRelationId: 'rel2', currentPositionId: 'p2' };
  const hrbp = (id: string, relationId?: string, assessedAt = t): Assessment => ({
    id,
    employeeId: 'e1',
    dimension: 'business',
    score: 4,
    scale: COMPETENCY_SCALE,
    requirement: 3,
    assessorRole: 'hrbp',
    assessedAt,
    source: 'manual',
    createdAt: t,
    updatedAt: t,
    scope: 'position',
    positionId: 'p1',
    ...(relationId ? { relationId } : {}),
  });

  it('换岗后旧岗位（ended 关系）的校准分不再作为当前校准', () => {
    // 「新」的评估时点更晚（否则并列时按先到先得，测试会失去判别力）
    const pool = [hrbp('old', 'rel1', '2026-09-01T00:00:00.000Z'), hrbp('new', 'rel2', '2026-09-02T00:00:00.000Z')];
    expect(latestHrbpAssessment(pool, 'e1', 'business')?.id).toBe('new'); // 不给 ctx：取最新
    // ← v2.3.0：这里仍返回 'old'（不看适用性），旧岗位校准被当成当前校准展示
    expect(latestHrbpAssessment(pool, 'e1', 'business', ctx)?.id).toBe('new');
    // 只有旧岗位校准分存在时，当前面不展示任何校准（而不是把旧岗位分当当前分）
    expect(latestHrbpAssessment([hrbp('old', 'rel1')], 'e1', 'business', ctx)).toBeNull();
  });

  it('只有旧岗位校准时 → 当前不再展示为有效校准', () => {
    const pool = [hrbp('old', 'rel1')];
    expect(latestHrbpAssessment(pool, 'e1', 'business', ctx)).toBeNull();
  });
});

// ───────────────────── Q-07：leaderType 写入点 ─────────────────────

describe('v2.3.1 Q-07：负责人类型可写（此前 leaderType 全仓无写入点）', () => {
  it('在部门卡上标注「副职」会落库，并改变管理者比口径', () => {
    vi.useFakeTimers();
    const e: Employee = { id: 'e', name: 'M2员工', employeeId: 'E01', level: 'L1', positionId: 'pa' };
    const tree: Department[] = [{
      id: 'a', name: '研发部', level: 1, employees: [e], leaderId: 'E01', leaderName: 'M2员工',
      children: [], expanded: true,
      positions: [{ id: 'pa', departmentId: 'a', name: '岗位A', headcount: 2, status: 'active', createdAt: t, updatedAt: t }],
    }];
    const p: ProjectFile = createProject('Q07');
    Object.assign(p.scenarios[0], {
      departments: tree,
      allEmployeesFlat: [e],
      positionAssignments: [],
      assessments: [],
      competencyModel: DEFAULT_COMPETENCY_MODEL,
    });
    storage.set(PROJECT_STORAGE_KEY, JSON.stringify(p));
    storage.set('org-designer.onboarded', '1');
    storage.set('org-designer.display-hint', '1');
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    Element.prototype.scrollIntoView = vi.fn();

    render(<App />);
    const select = screen.getByLabelText('负责人类型');
    expect((select as HTMLSelectElement).value).toBe('owner'); // 有负责人但未标注 → 视为正职
    act(() => {
      fireEvent.change(select, { target: { value: 'deputy' } });
    });
    act(() => {
      vi.advanceTimersByTime(1000); // 触发 800ms 自动保存
    });
    // 自动保存是压缩格式（lz16:），需用与运行时同一入口解码
    const saved = JSON.parse(decodeStoredProject(storage.get(PROJECT_STORAGE_KEY)!)!);
    expect(saved.scenarios[0].departments[0].leaderType).toBe('deputy');
  });
});
