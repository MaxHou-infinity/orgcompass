import { describe, it, expect } from 'vitest';
import { deriveBoard } from './boardScope';
import {
  buildGapListExcelBytes,
  buildGapListRows,
  filterGapListRows,
  summarizeGapList,
} from './gapList';
import { DEFAULT_LEVELS } from './levels';
import { DEFAULT_COMPETENCY_MODEL } from '../types';
import type { Assessment, Department, Employee, LevelConfig, Position, PositionAssignment } from '../types';

/**
 * V2.3 M4 验收样例（docs/v230-contract.md §8：A28—A31）。
 * 关键断言：待补与超额分别表达、冻结/未配置/满编分别表达、缺成本不为 0、
 * 导出逐行对应界面与筛选范围且不含个人评价字段。
 */

const T = '2026-09-01T00:00:00.000Z';

function emp(id: string, name: string, over: Partial<Employee> = {}): Employee {
  return { id, name, employeeId: `E-${id}`, level: 'L2.1', ...over };
}

function pos(id: string, departmentId: string, headcount: number, over: Partial<Position> = {}): Position {
  return { id, departmentId, name: `岗位-${id}`, headcount, status: 'active', createdAt: T, updatedAt: T, ...over };
}

interface Fixture {
  departments: Department[];
  allEmployees: Employee[];
  positions: Position[];
  assessments: Assessment[];
  positionAssignments: PositionAssignment[];
  levelConfigs: LevelConfig[];
}

function build(fixture: Fixture, scopeDeptId: string | null = null) {
  return deriveBoard({
    departments: fixture.departments,
    allEmployees: fixture.allEmployees,
    allPositions: fixture.positions,
    assessments: fixture.assessments,
    competencyModel: DEFAULT_COMPETENCY_MODEL,
    positionAssignments: fixture.positionAssignments,
    levelConfigs: fixture.levelConfigs,
    competencySummaries: new Map(),
    matchStates: [],
    scopeDeptId,
    includeChildren: true,
    filter: 'all',
  });
}

const LEVELS: LevelConfig[] = DEFAULT_LEVELS.map((c) => ({ ...c }));

/**
 * v2.3.1（T-05）：T09 类回退保护。
 *
 * v2.3.0 的真实用户侧阻断（T09）根因是：`Scenario.positions` 扁平镜像从未被保存路径回写，
 * 而 M4 曾把它当作岗位唯一来源 → 缺口清单变成「岗位 0 / 0」。
 * 修复后 `deriveBoard` 以部门树为唯一结构来源、镜像只在树内完全没有岗位时兜底。
 *
 * 现有 m4/m5 套件的 fixture 让镜像与部门树**同源**，因此「回退到只用扁平镜像」这类回归
 * 在其下全绿（实测 m4.gaplist 8/8、m5.acceptance 6/6 均不受影响）。这里显式构造
 * 「镜像过期/缺失」的形态，让该回退必然被抓到。
 */
describe('v2.3.1 T-05：镜像缺失/过期时岗位仍以部门树为准', () => {
  const dept: Department = {
    id: 'd1',
    name: '研发部',
    level: 1,
    expanded: true,
    children: [],
    employees: [emp('e1', '张三', { positionId: 'p1' })],
    positions: [pos('p1', 'd1', 3), pos('p2', 'd1', 0)],
  };
  const base: Fixture = {
    departments: [dept],
    allEmployees: [emp('e1', '张三', { positionId: 'p1' })],
    positions: [pos('p1', 'd1', 3), pos('p2', 'd1', 0)],
    assessments: [],
    positionAssignments: [],
    levelConfigs: DEFAULT_LEVELS.map((c) => ({ ...c })),
  };

  it('镜像为空（历史形态：保存路径未回写）→ 仍从部门树取到全部岗位', () => {
    const rows = buildGapListRows(build({ ...base, positions: [] }), '基线');
    expect(rows.map((r) => r.position).sort()).toEqual(['岗位-p1', '岗位-p2']);
    // 待补 2（编制 3 − 主岗占用 1）；未配置编制岗位不产生待补
    expect(summarizeGapList(rows).pendingTotal).toBe(2);
  });

  it('镜像过期（只剩一个已归档岗位）→ 仍以部门树为准，不被镜像带偏', () => {
    const stale = [pos('old', 'd1', 99, { status: 'archived' })];
    const rows = buildGapListRows(build({ ...base, positions: stale }), '基线');
    expect(rows.map((r) => r.position).sort()).toEqual(['岗位-p1', '岗位-p2']);
    expect(rows.some((r) => r.position === '岗位-old')).toBe(false);
    expect(summarizeGapList(rows).pendingTotal).toBe(2);
  });
});

describe('A28 待补与超额分别表达，净额只作补充', () => {
  const fixture: Fixture = (() => {
    const pA = pos('pA', 'd1', 3, { name: '甲岗' });
    const pB = pos('pB', 'd1', 1, { name: '乙岗' });
    const employees = [
      emp('b1', '乙一', { positionId: 'pB' }),
      emp('b2', '乙二', { positionId: 'pB' }),
      emp('b3', '乙三', { positionId: 'pB' }),
    ];
    const departments: Department[] = [{
      id: 'd1', name: '研发部', level: 1, children: [], expanded: true, employees,
      positions: [pA, pB],
    }];
    return { departments, allEmployees: employees, positions: [pA, pB], assessments: [], positionAssignments: [], levelConfigs: LEVELS };
  })();

  it('甲岗待补 3、乙岗超额 2，净额 1 仅补充', () => {
    const rows = buildGapListRows(build(fixture), '现状');
    const a = rows.find((r) => r.position === '甲岗')!;
    const b = rows.find((r) => r.position === '乙岗')!;
    expect(a.pendingCount).toBe(3);
    expect(a.overflowCount).toBe(0);
    expect(b.pendingCount).toBe(0);
    expect(b.overflowCount).toBe(2);

    const s = summarizeGapList(rows);
    expect(s.pendingTotal).toBe(3);
    expect(s.overflowTotal).toBe(2);
    expect(s.netTotal).toBe(1); // 净额不等于「待补被抵消」
    expect(s.pendingPositions).toBe(1);
    expect(s.overflowPositions).toBe(1);
  });

  it('单岗位筛选不把另一岗位的净额带进来', () => {
    const rows = buildGapListRows(build(fixture), '现状');
    const onlyPending = filterGapListRows(rows, 'pending');
    expect(onlyPending.map((r) => r.position)).toEqual(['甲岗']);
    expect(summarizeGapList(onlyPending).overflowTotal).toBe(0);
    const onlyOverflow = filterGapListRows(rows, 'overflow');
    expect(onlyOverflow.map((r) => r.position)).toEqual(['乙岗']);
    expect(summarizeGapList(onlyOverflow).pendingTotal).toBe(0);
  });
});

describe('A29 冻结 / 未配置 / 真实满编分别表达', () => {
  const fixture: Fixture = (() => {
    const frozen = pos('pF', 'd1', 5, { name: '冻结岗', status: 'frozen' });
    const unset = pos('pU', 'd1', 0, { name: '未配置岗' });
    const full = pos('pH', 'd1', 2, { name: '满编岗' });
    const employees = [
      emp('f1', '冻结在岗', { positionId: 'pF' }),
      emp('h1', '满编一', { positionId: 'pH' }),
      emp('h2', '满编二', { positionId: 'pH' }),
    ];
    const departments: Department[] = [{
      id: 'd1', name: '研发部', level: 1, children: [], expanded: true, employees,
      positions: [frozen, unset, full],
    }];
    return { departments, allEmployees: employees, positions: [frozen, unset, full], assessments: [], positionAssignments: [], levelConfigs: LEVELS };
  })();

  it('三种状态分别表达，不全部当满编或零缺口', () => {
    const rows = buildGapListRows(build(fixture), '现状');
    const frozen = rows.find((r) => r.position === '冻结岗')!;
    const unset = rows.find((r) => r.position === '未配置岗')!;
    const full = rows.find((r) => r.position === '满编岗')!;

    expect(frozen.statusLabel).toBe('编制冻结');
    expect(frozen.headcountStatusLabel).toBe('编制冻结');
    expect(frozen.pendingCount).toBe(0); // 冻结不计待补缺口
    expect(frozen.primaryOccupied).toBe(1); // 但保留人员关系

    expect(unset.headcountStatusLabel).toBe('未配置编制');
    expect(unset.headcount).toBe(0);
    expect(unset.headcountStatusLabel).not.toBe(full.headcountStatusLabel); // 未配置 ≠ 满编

    expect(full.headcountStatusLabel).toBe('已配置');
    expect(full.pendingCount).toBe(0);
    expect(full.overflowCount).toBe(0);

    const s = summarizeGapList(rows);
    expect(s.frozenPositions).toBe(1);
    expect(s.unconfiguredPositions).toBe(1);
    expect(s.pendingTotal).toBe(0);
    expect(s.overflowTotal).toBe(0);
  });
});

describe('A30 缺成本显示无法估算，不写成 0', () => {
  const fixture: Fixture = (() => {
    const priced = pos('pP', 'd1', 2, { name: '有依据岗', levelBandMin: 'L3.1' });
    const unpriced = pos('pN', 'd1', 2, { name: '无依据岗' });
    const employees = [emp('x1', '无成本员工', { positionId: 'pN', level: 'XX' })];
    const departments: Department[] = [{
      id: 'd1', name: '研发部', level: 1, children: [], expanded: true, employees,
      positions: [priced, unpriced],
    }];
    return { departments, allEmployees: employees, positions: [priced, unpriced], assessments: [], positionAssignments: [], levelConfigs: LEVELS };
  })();

  it('有依据与无依据分别表达；汇总标为已知部分并给出缺失岗位数', () => {
    const rows = buildGapListRows(build(fixture), '现状');
    const priced = rows.find((r) => r.position === '有依据岗')!;
    const unpriced = rows.find((r) => r.position === '无依据岗')!;

    expect(priced.gapCost).not.toBeNull();
    expect(priced.unitCost).toBeCloseTo(3.0, 6); // L3.1 → 3.0 万/月
    expect(priced.gapCost).toBeCloseTo(6.0, 6); // 待补 2 × 3.0
    expect(priced.costStatusLabel).toBe('已估算');

    expect(unpriced.gapCost).toBeNull(); // 缺依据 → null，而不是 0
    expect(unpriced.unitCost).toBeNull();
    expect(unpriced.costStatusLabel).toBe('无法估算');

    const s = summarizeGapList(rows);
    expect(s.pendingTotal).toBe(3); // 有依据岗待补 2 + 无依据岗待补 1
    expect(s.knownCostTotal).toBeCloseTo(6.0, 6);
    expect(s.costMissingPositions).toBe(1);
    expect(s.knownCostPositions).toBe(1);
    expect(s.costPartial).toBe(true);
  });

  it('Excel 中缺成本单元格为空，不写成 0', async () => {
    const XLSX = await import('xlsx');
    const rows = buildGapListRows(build(fixture), '现状');
    const bytes = await buildGapListExcelBytes({
      rows,
      summary: summarizeGapList(rows),
      meta: { projectName: 'P', scenarioName: '现状', scopeLabel: '全公司', filterLabel: '全部岗位', generatedAt: '2026-09-16 10:00' },
    });
    const wb = XLSX.read(bytes, { type: 'array' });
    const list = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['岗位缺口清单']);
    const unpriced = list.find((r) => r['岗位'] === '无依据岗')!;
    expect(unpriced['缺口成本(万元/月)']).not.toBe(0); // 缺成本不得写成 0
    expect(String(unpriced['缺口成本(万元/月)'] ?? '')).toBe(''); // 保持空值
    expect(unpriced['成本估算状态']).toBe('无法估算');
    const meta = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['汇总与口径']);
    const costRow = meta.find((r) => r['项'] === '已知缺口成本合计(万元/月)')!;
    expect(String(costRow['值'])).toContain('已知部分');
    expect(String(costRow['值'])).toContain('1 个岗位无法估算');
  });
});

describe('A31 筛选部门后导出 Excel 与界面一致，且不含个人评价字段', () => {
  const fixture: Fixture = (() => {
    const pA1 = pos('pA1', 'dA1', 2, { name: '后端岗' });
    const pA2 = pos('pA2', 'dA2', 1, { name: '前端岗' });
    const pB1 = pos('pB1', 'dB1', 4, { name: '销售岗' });
    const a1: Department = { id: 'dA1', name: '后端组', level: 2, children: [], expanded: true, employees: [], positions: [pA1] };
    const a2: Department = { id: 'dA2', name: '前端组', level: 2, children: [], expanded: true, employees: [], positions: [pA2] };
    const a: Department = { id: 'dA', name: '研发部', level: 1, children: [a1, a2], expanded: true, employees: [], positions: [] };
    const b: Department = { id: 'dB', name: '销售部', level: 1, children: [], expanded: true, employees: [], positions: [pB1] };
    return {
      departments: [a, b], allEmployees: [], positions: [pA1, pA2, pB1],
      assessments: [], positionAssignments: [], levelConfigs: LEVELS,
    };
  })();

  it('部门筛选后的岗位行、范围与金额与界面一致', async () => {
    const XLSX = await import('xlsx');
    const board = build(fixture, 'dA');
    expect(board.scopeLabel).toBe('研发部（含下级）');
    const rows = buildGapListRows(board, '现状');
    expect(rows.map((r) => r.position).sort()).toEqual(['前端岗', '后端岗']); // 不含销售岗
    expect(rows.every((r) => r.scenario === '现状')).toBe(true);
    expect(rows.every((r) => r.deptPath.startsWith('研发部'))).toBe(true);

    const bytes = await buildGapListExcelBytes({
      rows, summary: summarizeGapList(rows),
      meta: { projectName: 'P', scenarioName: '现状', scopeLabel: board.scopeLabel, filterLabel: '全部岗位', generatedAt: 'G' },
    });
    const wb = XLSX.read(bytes, { type: 'array' });
    const list = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['岗位缺口清单']);
    expect(list).toHaveLength(rows.length); // 逐行对应
    expect(list.map((r) => r['岗位']).sort()).toEqual(['前端岗', '后端岗']);
    expect(list.every((r) => String(r['完整部门路径']).startsWith('研发部'))).toBe(true);
    const meta = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['汇总与口径']);
    expect(meta.find((r) => r['项'] === '范围')!['值']).toBe('研发部（含下级）');

    // 无默认个人评价字段
    const headers = Object.keys(list[0]);
    for (const forbidden of ['姓名', '工号', '评分', '复核依据', '个人薪酬']) {
      expect(headers.some((h) => h.includes(forbidden))).toBe(false);
    }
    expect(headers).toContain('完整部门路径');
    expect(headers).toContain('待补人数');
    expect(headers).toContain('超额人数');
    expect(headers).toContain('成本估算状态');
    expect(headers).toContain('估算依据');
  });

  it('筛选岗位状态后导出与界面一致（逐行同源）', async () => {
    const XLSX = await import('xlsx');
    const board = build(fixture, 'dA');
    const all = buildGapListRows(board, '现状');
    const pendingOnly = filterGapListRows(all, 'pending');
    expect(pendingOnly).toHaveLength(2);
    const bytes = await buildGapListExcelBytes({
      rows: pendingOnly, summary: summarizeGapList(pendingOnly),
      meta: { projectName: 'P', scenarioName: '现状', scopeLabel: board.scopeLabel, filterLabel: '有待补', generatedAt: 'G' },
    });
    const wb = XLSX.read(bytes, { type: 'array' });
    const list = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['岗位缺口清单']);
    expect(list).toHaveLength(pendingOnly.length);
    const meta = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['汇总与口径']);
    expect(meta.find((r) => r['项'] === '筛选')!['值']).toBe('有待补');
  });

  it('无岗位时导出仍生成两张表（不报错、不伪造行）', async () => {
    const XLSX = await import('xlsx');
    const empty = build({ departments: [], allEmployees: [], positions: [], assessments: [], positionAssignments: [], levelConfigs: LEVELS });
    const rows = buildGapListRows(empty, '现状');
    expect(rows).toEqual([]);
    const bytes = await buildGapListExcelBytes({
      rows, summary: summarizeGapList(rows),
      meta: { projectName: 'P', scenarioName: '现状', scopeLabel: '全公司', filterLabel: '全部岗位', generatedAt: 'G' },
    });
    const wb = XLSX.read(bytes, { type: 'array' });
    expect(wb.SheetNames).toContain('岗位缺口清单');
    expect(wb.SheetNames).toContain('汇总与口径');
  });
});
