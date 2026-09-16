import { describe, it, expect } from 'vitest';
import {
  PROJECT_VERSION,
  createProject,
  createScenario,
  cloneScenario,
  serializeProject,
  parseProject,
  loadProject,
  persistProject,
  getCurrentScenario,
  PROJECT_STORAGE_KEY,
  DEFAULT_SCENARIO_NAME,
} from './project';
import { computeL2 } from './analytics';
import { Scenario, Department, Employee, DEFAULT_COMPETENCY_MODEL } from '../types';

function emp(id: string): Employee {
  return { id, name: id, employeeId: id, level: 'L1.1' };
}

function dept(id: string, name: string, level: number, opts: Partial<Department> = {}): Department {
  return {
    id,
    name,
    level,
    children: opts.children ?? [],
    employees: opts.employees ?? [],
    expanded: true,
    headcount: opts.headcount,
  };
}

describe('createProject / createScenario', () => {
  it('默认项目含一个「基线」场景', () => {
    const p = createProject('测试项目');
    expect(p.name).toBe('测试项目');
    expect(p.version).toBe(PROJECT_VERSION);
    expect(p.scenarios).toHaveLength(1);
    expect(p.scenarios[0].name).toBe(DEFAULT_SCENARIO_NAME);
    expect(p.currentScenarioId).toBe(p.scenarios[0].id);
    expect(p.scenarios[0].departments).toEqual([]);
  });

  it('createScenario 生成带 id/时间的场景', () => {
    const s = createScenario('现状', { departments: [], allEmployeesFlat: [], levelConfigs: [], canvas: { zoom: 100 } }, '2026-01-01T00:00:00Z');
    expect(s.name).toBe('现状');
    expect(s.createdAt).toBe('2026-01-01T00:00:00Z');
    expect(s.updatedAt).toBe('2026-01-01T00:00:00Z');
    expect(s.id).toMatch(/^scene-/);
  });

  it('cloneScenario 复制为「{原名} 副本」且不共享引用', () => {
    const orig: Scenario = {
      id: 's1',
      name: '方案A',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      departments: [dept('d1', '技术部', 1, { employees: [emp('e1')] })],
      allEmployeesFlat: [emp('e1')],
      levelConfigs: [],
      canvas: { zoom: 120 },
    };
    const clone = cloneScenario(orig, '2026-01-02');
    expect(clone.name).toBe('方案A 副本');
    expect(clone.id).not.toBe(orig.id);
    expect(clone.departments).not.toBe(orig.departments);
    expect(clone.departments[0]).not.toBe(orig.departments[0]);
    expect(clone.departments[0].employees).not.toBe(orig.departments[0].employees);
    // 原场景不受影响
    expect(orig.departments[0].name).toBe('技术部');
  });

  it('v2.2.0：基线场景携带胜任度三字段（默认模型 6 维 + 两张空表）', () => {
    const p = createProject('胜任度项目');
    const s = p.scenarios[0];
    expect(s.competencyModel?.dimensions).toHaveLength(6);
    expect(s.competencyModel?.dimensions.map((d) => d.key)).toEqual([
      'leadership_strategy', 'leadership_team', 'leadership_results', 'leadership_collab',
      'business', 'individual',
    ]);
    expect(s.assessments).toEqual([]);
    expect(s.positionAssignments).toEqual([]);
  });

  it('v2.2.0：createScenario 快照缺三字段 → 缺省回退（默认模型 + 空表），兼容旧调用方', () => {
    const s = createScenario('旧快照', { departments: [], allEmployeesFlat: [], levelConfigs: [], canvas: { zoom: 100 } });
    expect(s.competencyModel?.dimensions).toHaveLength(6);
    expect(s.assessments).toEqual([]);
    expect(s.positionAssignments).toEqual([]);
  });

  it('v2.2.0：cloneScenario 深拷贝胜任度三字段，不共享引用', () => {
    const orig: Scenario = {
      id: 's1',
      name: '带评估的场景',
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
      departments: [],
      allEmployeesFlat: [],
      levelConfigs: [],
      canvas: { zoom: 100 },
      competencyModel: structuredClone(DEFAULT_COMPETENCY_MODEL),
      assessments: [
        { id: 'asm-1', employeeId: 'e1', dimension: 'leadership_strategy', score: 4, scale: { min: 1, max: 5 }, requirement: 4, assessorRole: 'supervisor', assessedAt: '2026-01-01T00:00:00Z', source: 'manual', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      ],
      positionAssignments: [
        { id: 'asg-1', employeeId: 'e1', positionId: 'p1', type: 'primary', startDate: '2026-01-01', status: 'active', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      ],
    };
    const clone = cloneScenario(orig);
    expect(clone.competencyModel).not.toBe(orig.competencyModel);
    expect(clone.assessments).not.toBe(orig.assessments);
    expect(clone.positionAssignments).not.toBe(orig.positionAssignments);
    clone.assessments![0].score = 2;
    clone.positionAssignments![0].status = 'ended';
    expect(orig.assessments![0].score).toBe(4);
    expect(orig.positionAssignments![0].status).toBe('active');
  });
});

describe('序列化 / 反序列化往返', () => {
  it('serialize → parse 保留数据', () => {
    const p = createProject('往返项目');
    const s = p.scenarios[0];
    s.departments = [dept('d1', '技术部', 1, { children: [dept('d2', '研发组', 2)], headcount: 5 })];
    s.allEmployeesFlat = [emp('e1')];
    s.canvas = { zoom: 150 };

    const roundTrip = parseProject(serializeProject(p));
    expect(roundTrip).not.toBeNull();
    expect(roundTrip!.name).toBe('往返项目');
    expect(roundTrip!.currentScenarioId).toBe(p.currentScenarioId);
    expect(roundTrip!.scenarios).toHaveLength(1);
    const rs = roundTrip!.scenarios[0];
    expect(rs.departments).toHaveLength(1);
    expect(rs.departments[0].name).toBe('技术部');
    expect(rs.departments[0].headcount).toBe(5);
    expect(rs.canvas.zoom).toBe(150);
    expect(rs.allEmployeesFlat).toHaveLength(1);
  });

  it('非法 JSON 返回 null', () => {
    expect(parseProject('{bad json')).toBeNull();
    expect(parseProject('')).toBeNull();
    expect(parseProject('123')).toBeNull();
  });

  it('缺场景时补一个「基线」场景，失效 currentScenarioId 回退第一个', () => {
    const brokenRaw = JSON.stringify({
      id: 'proj',
      name: 'X',
      version: 1,
      currentScenarioId: 'no-such-scene',
      scenarios: [{ id: 's1', name: 'A', departments: [], allEmployeesFlat: [], levelConfigs: [], canvas: {} }],
      meta: {},
    });
    const p = parseProject(brokenRaw)!;
    expect(p.currentScenarioId).toBe('s1');
    expect(p.scenarios).toHaveLength(1);

    const noScenarios = parseProject(JSON.stringify({ id: 'proj', name: 'Y', scenarios: [] }))!;
    expect(noScenarios.scenarios).toHaveLength(1);
    expect(noScenarios.scenarios[0].name).toBe(DEFAULT_SCENARIO_NAME);
  });

  it('清洗非法部门节点与未知职级颜色', () => {
    const dirty = JSON.stringify({
      id: 'proj',
      name: 'Z',
      currentScenarioId: 's1',
      scenarios: [{
        id: 's1',
        name: 'A',
        departments: [{ id: 'd1', name: '合法', level: 1, employees: [], children: [] }, { bogus: true }],
        allEmployeesFlat: [],
        levelConfigs: [{ code: 'L', number: '1.1', label: '初级', color: '#FFCC99', cost: 2.5 }],
        canvas: {},
      }],
    });
    const p = parseProject(dirty)!;
    expect(p.scenarios[0].departments).toHaveLength(1);
    expect(p.scenarios[0].departments[0].name).toBe('合法');
    expect(p.scenarios[0].departments[0].expanded).toBe(true);
    expect(p.scenarios[0].levelConfigs[0].cost).toBe(2.5);
  });
});

describe('localStorage IO', () => {
  it('persistProject → loadProject 往返', () => {
    const p = createProject('存储项目');
    p.scenarios[0].name = '已改';
    // 模拟 localStorage
    const storage = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
      clear: () => storage.clear(),
      key: () => null,
      length: storage.size,
    } as unknown as Storage;

    expect(persistProject(p)).toBe(true);
    expect(storage.has(PROJECT_STORAGE_KEY)).toBe(true);
    expect(storage.get(PROJECT_STORAGE_KEY)).toMatch(/^lz16:/);
    const loaded = loadProject();
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe('存储项目');
    expect(loaded!.scenarios[0].name).toBe('已改');
  });

  it('仍可读取历史未压缩的 localStorage 项目', () => {
    const p = createProject('历史项目');
    const storage = new Map<string, string>([[PROJECT_STORAGE_KEY, serializeProject(p)]]);
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
      clear: () => storage.clear(),
      key: () => null,
      length: storage.size,
    } as unknown as Storage;

    expect(loadProject()?.name).toBe('历史项目');
  });

  it('大型胜任度项目压缩后可在受限配额内保存并完整恢复', () => {
    const p = createProject('1000 人大型组织');
    p.scenarios[0].assessments = Array.from({ length: 6000 }, (_, i) => ({
      id: `assessment-${i}`,
      employeeId: `employee-${i % 1000}`,
      dimension: 'leadership_strategy',
      score: 4,
      scale: { min: 1, max: 5 },
      requirement: 3,
      assessorRole: 'supervisor' as const,
      assessedAt: '2026-09-05T00:00:00.000Z',
      source: 'manual' as const,
      createdAt: '2026-09-05T00:00:00.000Z',
      updatedAt: '2026-09-05T00:00:00.000Z',
    }));
    const storage = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (v.length > 500_000) throw new DOMException('Quota exceeded', 'QuotaExceededError');
        storage.set(k, v);
      },
      removeItem: (k: string) => void storage.delete(k),
      clear: () => storage.clear(),
      key: () => null,
      length: storage.size,
    } as unknown as Storage;

    expect(serializeProject(p).length).toBeGreaterThan(1_000_000);
    expect(persistProject(p)).toBe(true);
    expect(storage.get(PROJECT_STORAGE_KEY)!.length).toBeLessThan(500_000);
    expect(loadProject()?.scenarios[0].assessments).toHaveLength(6000);
  });
});

describe('getCurrentScenario', () => {
  it('取 currentScenarioId 对应场景', () => {
    const p = createProject('x');
    const s2 = createScenario('方案B', { departments: [], allEmployeesFlat: [], levelConfigs: [], canvas: { zoom: 100 } });
    p.scenarios.push(s2);
    p.currentScenarioId = s2.id;
    expect(getCurrentScenario(p)!.id).toBe(s2.id);
  });

  it('currentScenarioId 失效 → 回退第一个场景', () => {
    const p = createProject('x');
    p.currentScenarioId = 'no-such-scene';
    expect(getCurrentScenario(p)!.id).toBe(p.scenarios[0].id);
  });
});

describe('parseProject 版本迁移与字段归一化', () => {
  it('缺 version → 默认 PROJECT_VERSION（3）', () => {
    const raw = JSON.stringify({ id: 'proj', name: 'x', scenarios: [{ id: 's1', name: 'A' }] });
    const p = parseProject(raw)!;
    expect(p.version).toBe(PROJECT_VERSION);
    expect(p.meta.version).toBe(PROJECT_VERSION);
  });
  it('显式 version 0（历史项目）→ 保留 0，不强行迁移为 1', () => {
    const raw = JSON.stringify({ id: 'proj', name: 'x', version: 0, scenarios: [{ id: 's1', name: 'A' }] });
    const p = parseProject(raw)!;
    expect(p.version).toBe(0);
    expect(p.meta.version).toBe(0);
  });

  it('旧场景缺 canvas/departments/allEmployeesFlat/levelConfigs → 归一化补默认', () => {
    const raw = JSON.stringify({ id: 'proj', name: 'legacy', scenarios: [{ id: 's1', name: '旧场景' }] });
    const p = parseProject(raw)!;
    const s = p.scenarios[0];
    expect(s.departments).toEqual([]);
    expect(s.allEmployeesFlat).toEqual([]);
    expect(s.levelConfigs.length).toBeGreaterThan(0); // 回退默认职级
    expect(s.canvas.zoom).toBe(100);
    expect(s.canvas.lastFocusedDeptId).toBeUndefined();
  });

  it('部门缺 expanded/headcount/leader → expanded 取 level<=3，headcount 为 undefined', () => {
    const raw = JSON.stringify({
      id: 'proj',
      name: 'x',
      scenarios: [{
        id: 's1',
        name: 'A',
        departments: [
          { id: 'd1', name: '技术部', level: 1, employees: [], children: [] },
          { id: 'd2', name: '深组', level: 5, employees: [], children: [] },
        ],
      }],
    });
    const p = parseProject(raw)!;
    const [d1, d2] = p.scenarios[0].departments;
    expect(d1.expanded).toBe(true); // level 1 <= 3
    expect(d2.expanded).toBe(false); // level 5 > 3
    expect(d1.headcount).toBeUndefined();
    expect(d1.leaderId).toBeUndefined();
  });

  it('headcount 归一化：number（含 0）保留、字符串/NaN 丢弃为 undefined', () => {
    const raw = JSON.stringify({
      id: 'proj',
      name: 'x',
      scenarios: [{
        id: 's1',
        name: 'A',
        departments: [
          { id: 'd1', name: 'A', level: 1, employees: [], children: [], headcount: 0 },
          { id: 'd2', name: 'B', level: 1, employees: [], children: [], headcount: '5' },
          { id: 'd3', name: 'C', level: 1, employees: [], children: [], headcount: Number.NaN },
        ],
      }],
    });
    const p = parseProject(raw)!;
    const [d1, d2, d3] = p.scenarios[0].departments;
    expect(d1.headcount).toBe(0); // number 保留，含 0
    expect(d2.headcount).toBeUndefined();
    expect(d3.headcount).toBeUndefined();
  });
});

// —— —— v2.0.9：.orgproj 兼容守卫（口径修正零数据模型改动） —— ——

describe('v2.0.9 .orgproj 往返一致守卫', () => {
  /** 构造一个字段齐全（负责人/编制/职级/画布/时间戳）的项目，作为口径修正前后的对照样本 */
  function richProject(): ProjectFile {
    return {
      id: 'proj-1',
      name: '兼容项目',
      version: PROJECT_VERSION,
      currentScenarioId: 's1',
      scenarios: [{
        id: 's1',
        name: '基线',
        createdAt: '2026-08-01T00:00:00Z',
        updatedAt: '2026-08-01T00:00:00Z',
        departments: [{
          id: 'd1',
          name: '技术部',
          level: 1,
          leaderId: 'L01',
          leaderName: '领导A',
          parentId: undefined,
          expanded: true,
          headcount: 5,
          positions: [],
          children: [{
            id: 'd2',
            name: '研发组',
            level: 2,
            leaderId: 'L02',
            leaderName: '领导B',
            parentId: 'd1',
            expanded: true,
            headcount: 3,
            positions: [],
            children: [],
            employees: [
              { id: 'e1', name: '员工一', employeeId: 'E001', level: 'L1.1', title: '工程师', cost: 2.5 },
              { id: 'l02', name: '领导B', employeeId: 'L02', level: 'L3.2', targetLevel: 'L2.1' },
            ],
          }],
          employees: [
            { id: 'l01', name: '领导A', employeeId: 'L01', level: 'L3.2', isVirtual: false },
            { id: 'e2', name: '员工二', employeeId: 'E002', level: 'L1.1' },
          ],
        } as Department],
        allEmployeesFlat: [
          { id: 'l01', name: '领导A', employeeId: 'L01', level: 'L3.2' },
          { id: 'l02', name: '领导B', employeeId: 'L02', level: 'L3.2' },
          { id: 'e1', name: '员工一', employeeId: 'E001', level: 'L1.1' },
          { id: 'e2', name: '员工二', employeeId: 'E002', level: 'L1.1' },
        ],
        levelConfigs: [{ code: 'L', number: '1.1', label: '初级', color: '#FFCC99', cost: 2 }],
        canvas: { zoom: 120, lastFocusedDeptId: 'd1' },
        positions: [],
        // —— v2.2.0：胜任度三字段（往返守卫对齐） ——
        competencyModel: DEFAULT_COMPETENCY_MODEL,
        assessments: [],
        positionAssignments: [],
      }],
      meta: { createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', version: PROJECT_VERSION },
    };
  }

  it('parse(serialize(p)) 深等于 p（数据模型零改动，.orgproj 向后兼容）', () => {
    const p = richProject();
    const roundTripped = parseProject(serializeProject(p));
    expect(roundTripped).not.toBeNull();
    expect(roundTripped).toEqual(p);
  });

  it('往返后 computeL2 口径分析结果一致（breakdown 为运行时派生，不写入持久化结构）', () => {
    const p = richProject();
    const before = computeL2(p.scenarios[0].departments);
    const rt = parseProject(serializeProject(p))!;
    const after = computeL2(rt.scenarios[0].departments);
    expect(after).toEqual(before);
    // 三段 breakdown 均在运行时派生出并挂到 L2 指标上
    const span = after.find((m) => m.key === 'span')!;
    expect(span.spanBreakdown).toBeDefined();
    expect(after.find((m) => m.key === 'depth')!.depthBreakdown).toBeDefined();
    expect(after.find((m) => m.key === 'managerRatio')!.managerBreakdown).toBeDefined();
  });
});

// —— —— v2.2.0：胜任度三张表 sanitize（design doc §4.3） —— ——

describe('v2.2.0 胜任度三张表 sanitize', () => {
  function rawProject(scenario: Record<string, unknown>): string {
    return JSON.stringify({
      id: 'proj',
      name: 'sanitize',
      version: 3,
      currentScenarioId: 's1',
      scenarios: [{ id: 's1', name: 'A', departments: [], allEmployeesFlat: [], levelConfigs: [], canvas: {}, ...scenario }],
      meta: { version: 3 },
    });
  }

  it('维度逐条校验：非法维度丢单条；全非法 → 回退默认预设', () => {
    const p = parseProject(rawProject({
      competencyModel: {
        dimensions: [
          { key: 'custom_ok_123456', label: '合法维度', definition: '定义', weight: 0.3, group: 'staff', order: 1, enabled: true },
          { key: '非法Key!', label: '非法 key 形式', definition: 'd', weight: 0.2, group: 'staff', order: 2, enabled: true }, // 丢
          { key: 'no_weight', label: '缺权重', definition: 'd', group: 'staff', order: 3, enabled: true },                    // 丢
          { key: 'bad_group', label: '非法分组', definition: 'd', weight: 0.2, group: 'exec', order: 4, enabled: true },       // 丢
          { key: 'neg_weight', label: '负权重', definition: 'd', weight: -1, group: 'staff', order: 5, enabled: true },        // 丢
        ],
      },
    }))!;
    const model = p.scenarios[0].competencyModel!;
    expect(model.dimensions).toHaveLength(1);
    expect(model.dimensions[0].key).toBe('custom_ok_123456');
    expect(model.dimensions[0].builtin).toBeUndefined();

    const empty = parseProject(rawProject({ competencyModel: { dimensions: [] } }))!;
    expect(empty.scenarios[0].competencyModel?.dimensions).toHaveLength(6); // 空 → 默认预设
  });

  it('评估逐条校验：必填缺失/分数越界/非法 dimension/非 supervisor|hrbp → 丢；requirement 回填 3；scale 强制 1..5', () => {
    const p = parseProject(rawProject({
      competencyModel: DEFAULT_COMPETENCY_MODEL,
      assessments: [
        { id: 'asm-1', employeeId: 'e1', dimension: 'leadership_strategy', score: 4, requirement: 4, assessorRole: 'supervisor', assessedAt: '2026-01-01', source: 'manual' },
        { id: 'asm-2', employeeId: 'e2', dimension: 'leadership_team', score: 7, assessorRole: 'supervisor', assessedAt: '2026-01-01' },          // score 越界 → 丢
        { id: 'asm-3', employeeId: 'e3', dimension: 'Bad Dimension', score: 3, assessorRole: 'supervisor', assessedAt: '2026-01-01' },             // dimension 非法形式 → 丢
        { id: 'asm-4', employeeId: 'e4', dimension: 'business', score: 3, assessorRole: 'self', assessedAt: '2026-01-01' },                        // 非 MVP 角色 → 丢
        { id: 'asm-5', employeeId: 'e5', dimension: 'custom_ghost_000001', score: 2, requirement: 9, assessorRole: 'hrbp', assessedAt: '2026-01-01' }, // orphan key 保留 + requirement 回填 3
        { id: 'asm-6', employeeId: 'e6', dimension: 'individual', score: 3, assessorRole: 'supervisor' },                                           // 缺 assessedAt → 丢
      ],
    }))!;
    const assessments = p.scenarios[0].assessments!;
    expect(assessments).toHaveLength(2);
    expect(assessments[0].id).toBe('asm-1');
    expect(assessments[0].scale).toEqual({ min: 1, max: 5 });
    expect(assessments[0].requirement).toBe(4);
    expect(assessments[1].id).toBe('asm-5'); // orphan（key 不在模型）保留单条
    expect(assessments[1].requirement).toBe(3); // 9 越界 → 回填 3
    expect(assessments[1].assessorRole).toBe('hrbp');
  });

  it('人岗时态逐条校验：必填缺失丢单条；type/status 非法回退 primary/active', () => {
    const p = parseProject(rawProject({
      positionAssignments: [
        { id: 'asg-1', employeeId: 'e1', positionId: 'p1', startDate: '2026-01-01', type: 'primary', status: 'active' },
        { id: 'asg-2', employeeId: 'e2', positionId: 'p2', startDate: '2026-01-01', type: 'weird', status: 'bogus' }, // 回退 primary/active
        { id: 'asg-3', employeeId: 'e3', positionId: 'p3', type: 'primary', status: 'active' },                      // 缺 startDate → 保留未知日期
        { id: 'asg-4', employeeId: 'e4', positionId: 'p4', startDate: '2026-01-01', type: 'secondary', status: 'not_competent', confirmedBy: 'e9', confirmedAt: '2026-02-01' },
      ],
    }))!;
    const asg = p.scenarios[0].positionAssignments!;
    expect(asg).toHaveLength(4);
    expect(asg[0]).toMatchObject({ id: 'asg-1', type: 'primary', status: 'active' });
    expect(asg[1]).toMatchObject({ id: 'asg-2', type: 'primary', status: 'active' });
    expect(asg[2].startDate).toBeUndefined();
    expect(asg[3]).toMatchObject({ id: 'asg-4', type: 'secondary', status: 'not_competent', confirmedBy: 'e9' });
  });
});
