// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  cellDateString,
  mapAssessmentRows,
  parseExcelFromBuffer,
  MAX_IMPORT_ROWS,
} from './excel';
import {
  parseProject,
  serializeProject,
  persistProject,
  createProject,
  snapshotCurrentProject,
  listProjectBackups,
  readProjectBackup,
  PROJECT_STORAGE_KEY,
  decodeStoredProject,
} from './project';
import { computePositionSummary } from './analytics';
import { inspectPlacements } from './placement';
import { computeMatchStates } from './match';
import { DEFAULT_LEVELS } from './levels';
import { DEFAULT_COMPETENCY_MODEL } from '../types';
import type { Department, Employee, LevelConfig, Position, ProjectFile, Scenario } from '../types';

/**
 * —— v2.3.1 数据安全回归（审计报告 F-07 / F-09 / F-10 / F-11 / F-12）——
 *
 * 目标同样是「回退修复即失败」：每一条都能在把实现改回 v2.3.0 写法后变红。
 */

// ───────────────────────── F-07 评分表日期解析 ─────────────────────────

describe('v2.3.1 F-07：cellDateString 容错解析「评估日期」', () => {
  it('Excel 日期序列号 → 自然日（旧实现拼成 "46281T12:00:00" 会抛 RangeError）', () => {
    expect(cellDateString(46281)).toBe('2026-09-16');
    expect(cellDateString(46270)).toBe('2026-09-05');
    expect(cellDateString('46281')).toBe('2026-09-16'); // sheet_to_json 会把 raw 值字符串化
  });

  it('Date 实例与常见文本格式', () => {
    expect(cellDateString(new Date(2026, 8, 16))).toBe('2026-09-16');
    expect(cellDateString('2026-09-16')).toBe('2026-09-16');
    expect(cellDateString('2026/9/16')).toBe('2026-09-16');
    expect(cellDateString('2026.9.6')).toBe('2026-09-06');
    expect(cellDateString('2026年9月16日')).toBe('2026-09-16');
    expect(cellDateString('2026-9-5')).toBe('2026-09-05'); // 未补零
    expect(cellDateString('2026-09-16T00:00:00.000Z')).toBe('2026-09-16');
  });

  it('空值返回 undefined；非法值不静默编造', () => {
    expect(cellDateString('')).toBeUndefined();
    expect(cellDateString(null)).toBeUndefined();
    expect(cellDateString(undefined)).toBeUndefined();
    expect(cellDateString('昨天')).toBeUndefined();
    expect(cellDateString('2026-02-31')).toBeUndefined(); // 溢出日期
    expect(cellDateString(0)).toBeUndefined();
  });

  it('mapAssessmentRows：日期单元格不再让整批导入失败，非法日期带行号报错', () => {
    const rows = [
      { 工号: 'E001', 评估日期: 46281, 业务能力: 4 },
      { 工号: 'E002', 评估日期: '2026/9/16', 业务能力: 3 },
    ];
    const mapped = mapAssessmentRows(rows, DEFAULT_COMPETENCY_MODEL);
    expect(mapped[0].assessedAt).toBe('2026-09-16');
    expect(mapped[1].assessedAt).toBe('2026-09-16');

    expect(() => mapAssessmentRows([{ 工号: 'E003', 评估日期: '下周三', 业务能力: 4 }], DEFAULT_COMPETENCY_MODEL))
      .toThrowError(/第 2 行/); // 行号可行动
  });

  it('端到端：真实日期单元格的 xlsx 可以解析（这是用户最自然的操作）', async () => {
    const XLSX = await import('xlsx');
    const dim = DEFAULT_COMPETENCY_MODEL.dimensions[0];
    const ws = XLSX.utils.aoa_to_sheet([
      ['工号', '评估日期', dim.label],
      ['E001', new Date(2026, 8, 16), 4],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '评分表');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    const rows = await parseExcelFromBuffer(buf);
    const mapped = mapAssessmentRows(rows, DEFAULT_COMPETENCY_MODEL);
    expect(mapped[0].assessedAt).toBe('2026-09-16');
    expect(mapped[0].scores[dim.key]).toBe(4);
  });
});

// ───────────────────────── F-10 超行数必须拒绝而非截断 ─────────────────────────

describe('v2.3.1 F-10：超过行数上限必须拒绝，不得静默截断', () => {
  it(`${MAX_IMPORT_ROWS + 1} 行 → 抛 invalid-structure（旧实现只导入前 ${MAX_IMPORT_ROWS} 行且不提示）`, async () => {
    const XLSX = await import('xlsx');
    const aoa: unknown[][] = [['姓名', '工号']];
    for (let i = 0; i <= MAX_IMPORT_ROWS; i++) aoa.push([`员工${i}`, `E${i}`]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '员工');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    await expect(parseExcelFromBuffer(buf)).rejects.toMatchObject({ kind: 'invalid-structure' });
  }, 30000);

  it('恰好等于上限仍可导入（边界不误伤）', async () => {
    const XLSX = await import('xlsx');
    const aoa: unknown[][] = [['姓名', '工号']];
    for (let i = 0; i < MAX_IMPORT_ROWS; i++) aoa.push([`员工${i}`, `E${i}`]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '员工');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;

    const rows = await parseExcelFromBuffer(buf);
    expect(rows.length).toBe(MAX_IMPORT_ROWS);
  }, 30000);
});

// ───────────────────────── F-09 迁移后名册与树一致 ─────────────────────────

/** v1 fixture（无岗位、无胜任度字段）：d1(编制5) / d2(编制3，2 员工) / d3(未配置，1 员工) */
function v1Fixture(): ProjectFile {
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

function treeEmployee(scenario: Scenario, id: string): Employee | undefined {
  const walk = (list: Scenario['departments']): Employee | undefined => {
    for (const d of list) {
      const hit = d.employees.find((e) => e.id === id);
      if (hit) return hit;
      const deeper = walk(d.children ?? []);
      if (deeper) return deeper;
    }
    return undefined;
  };
  return walk(scenario.departments);
}

describe('v2.3.1 F-09：v1→v4 迁移后名册必须与部门树一致', () => {
  const parsed = parseProject(serializeProject(v1Fixture()))!;
  const sc = parsed.scenarios[0];

  it('名册员工的 positionId 与树内同人一致（旧实现名册恒为 undefined）', () => {
    for (const id of ['e1', 'e2', 'e3']) {
      const flat = sc.allEmployeesFlat.find((e) => e.id === id)!;
      const tree = treeEmployee(sc, id)!;
      expect(tree.positionId).toBeTruthy();
      expect(flat.positionId).toBe(tree.positionId);
    }
  });

  it('未建岗部门的员工仍保持未套岗（不编造岗位）', () => {
    const e4 = sc.allEmployeesFlat.find((e) => e.id === 'e4')!;
    expect(treeEmployee(sc, 'e4')!.positionId).toBeUndefined();
    expect(e4.positionId).toBeUndefined();
  });

  it('不再产生「画布与名册的岗位引用不一致」告警', () => {
    expect(inspectPlacements(sc.allEmployeesFlat, sc.departments, sc.positionAssignments ?? [])).toEqual([]);
  });

  it('legacy 任职种子非空，且匹配三态不把已套岗员工判成「未套岗」', () => {
    // 旧实现里名册没有 positionId → 种子产出 0 条，之后全员被判 unassigned
    expect((sc.positionAssignments ?? []).length).toBeGreaterThan(0);
    const positions = [
      ...(sc.positions ?? []),
    ];
    const states = computeMatchStates(sc.allEmployeesFlat, positions, undefined, sc.positionAssignments ?? [], sc.departments);
    const byId = new Map(states.map((s) => [s.employeeId, s.status]));
    expect(byId.get('e1')).not.toBe('unassigned');
    expect(byId.get('e3')).not.toBe('unassigned');
  });
});

// ───────────────────────── F-11 「无法估算」不写成 0 ─────────────────────────

describe('v2.3.1 F-11：缺口成本找不到依据时必须是 null（无法估算）', () => {
  const pos: Position = {
    id: 'p1',
    departmentId: 'd1',
    name: '前端工程师',
    headcount: 3,
    status: 'active',
    createdAt: 't',
    updatedAt: 't',
  };

  it('无职级带宽、无在岗人员 → gapCost 为 null（旧实现为 0）', () => {
    const summaries = computePositionSummary([pos], [], DEFAULT_LEVELS);
    expect(summaries[0].gap).toBe(3);
    expect(summaries[0].gapCost).toBeNull();
  });

  it('有职级带宽 → 正常估算', () => {
    const configs: LevelConfig[] = DEFAULT_LEVELS.map((c) => ({ ...c }));
    const withBand: Position = { ...pos, levelBandMin: 'L1.1' };
    const summaries = computePositionSummary([withBand], [], configs);
    expect(summaries[0].gapCost).not.toBeNull();
    expect(summaries[0].gapCost!).toBeGreaterThan(0);
  });

  it('无缺口（满编）仍为 0，不得误报「无法估算」', () => {
    const emp: Employee = { id: 'e1', name: 'A', employeeId: 'E1', level: 'L1', positionId: 'p1' };
    const summaries = computePositionSummary([{ ...pos, headcount: 1 }], [emp], DEFAULT_LEVELS);
    expect(summaries[0].gap).toBe(0);
    expect(summaries[0].gapCost).toBe(0);
  });

  it('诊断报告渲染「无法估算」而不是 0w（可导出报告不得印错事实）', async () => {
    const { render, screen, cleanup } = await import('@testing-library/react');
    const { default: React } = await import('react');
    const { DiagnosticReport } = await import('../components/DiagnosticReport');
    const summaries = computePositionSummary([pos], [], DEFAULT_LEVELS);
    const dept: Department = {
      id: 'd1',
      name: '研发部',
      level: 1,
      expanded: true,
      children: [],
      employees: [],
      positions: [pos],
    };
    render(
      React.createElement(DiagnosticReport, {
        open: true,
        onClose: () => {},
        departments: [dept],
        levelConfigs: DEFAULT_LEVELS,
        positionSummaries: summaries,
        projectName: '测试项目',
        scenarioName: '基线',
        onToast: () => {},
      }),
    );
    expect(screen.getAllByText('无法估算').length).toBeGreaterThan(0);
    cleanup();
  });
});

// ───────────────────────── F-12 破坏性写入前的可恢复快照 ─────────────────────────

describe('v2.3.1 F-12：导入 / 清空 / 恢复前的快照可恢复', () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    storage = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
      clear: () => storage.clear(),
      key: () => null,
      length: storage.size,
    } as unknown as Storage;
  });

  afterEach(() => {
    delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
  });

  it('snapshotCurrentProject 保留导入前的原始字节，且可解析回同一项目', () => {
    const original = createProject('原始项目');
    original.scenarios[0].name = '基线场景';
    expect(persistProject(original)).toBe(true);
    // 模拟用户开始导入别的文件（先留快照）
    expect(snapshotCurrentProject('导入 .orgproj')).toBe(true);

    const backups = listProjectBackups();
    expect(backups).toHaveLength(1);
    expect(backups[0].reason).toBe('导入 .orgproj');

    const restored = readProjectBackup(backups[0].key)!;
    expect(restored.name).toBe('原始项目');
    expect(restored.scenarios[0].name).toBe('基线场景');

    // 快照内容必须与当时的自动保存字节一致（原样，不是重新序列化）
    const rawNow = storage.get(PROJECT_STORAGE_KEY)!;
    expect(decodeStoredProject(storage.get(backups[0].key)!)).toBe(decodeStoredProject(rawNow));
  });

  it('没有现存数据时不产生空快照', () => {
    expect(snapshotCurrentProject('导入 .orgproj')).toBe(false);
    expect(listProjectBackups()).toHaveLength(0);
  });

  it('快照最多保留 5 份，旧的被淘汰（不无限增长 localStorage）', () => {
    expect(persistProject(createProject('项目'))).toBe(true);
    for (let i = 0; i < 7; i++) snapshotCurrentProject(`第 ${i} 次`);
    expect(listProjectBackups()).toHaveLength(5);
    // 索引里提到的 key 都真实存在（淘汰时同步删除）
    for (const b of listProjectBackups()) expect(storage.has(b.key)).toBe(true);
  });

  it('索引损坏时不影响主流程', () => {
    expect(persistProject(createProject('项目'))).toBe(true);
    storage.set(`${PROJECT_STORAGE_KEY}.before-v4.index`, '{ not json');
    expect(listProjectBackups()).toEqual([]);
    expect(snapshotCurrentProject('导入 .orgproj')).toBe(true);
    expect(listProjectBackups()).toHaveLength(1);
  });
});
