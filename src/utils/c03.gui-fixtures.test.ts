import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Department, Employee, LevelConfig, ProjectFile, Scenario } from '../types';
import { DEFAULT_COMPETENCY_MODEL } from '../types';
import { parseProject, serializeProject, PROJECT_VERSION } from './project';
import { computeDiffTotals, computeScenarioTotals } from './scenarioDiff';
import { formatGapCostDelta, formatGapCostSide } from './statusUI';
import { DEFAULT_HEALTH_THRESHOLDS } from './analytics';

/** 本轮产出写入可指定的证据目录，不覆盖旧候选 */
const OUT = process.env.ORGCOMPASS_EVIDENCE_DIR ?? '.test-artifacts/v2.5.3';
const NOW = '2026-11-14T09:21:00.000Z';
const TH = DEFAULT_HEALTH_THRESHOLDS;
const COST: LevelConfig[] = [{ code: 'L', number: '1', label: '一级', color: '#334155', cost: 4 }];

function emp(id: string, name: string, dept1: string): Employee {
  return { id, name, employeeId: id, level: 'L1', dept1 };
}

function dept(id: string, name: string, level: number, opts: Partial<Department> = {}): Department {
  return {
    id, name, level,
    parentId: opts.parentId,
    children: opts.children ?? [],
    employees: opts.employees ?? [],
    expanded: true,
    headcount: opts.headcount,
    ...opts,
  };
}

function scenario(id: string, name: string, departments: Department[], allEmployeesFlat: Employee[]): Scenario {
  return {
    id, name, createdAt: NOW, updatedAt: NOW,
    departments, allEmployeesFlat, levelConfigs: COST, canvas: { zoom: 100 },
    competencyModel: structuredClone(DEFAULT_COMPETENCY_MODEL),
    assessments: [],
    positionAssignments: [],
    positions: [],
  };
}

function save(name: string, raw: string) {
  mkdirSync(OUT, { recursive: true });
  const file = `${OUT}/${name}`;
  writeFileSync(file, raw);
  const sha = createHash('sha256').update(raw).digest('hex');
  writeFileSync(`${file}.sha256`, `${sha}  ${name}\n`);
  return { file, sha };
}

/**
 * GUI 用格式 4 多场景对照夹具（合法虚构）：
 * - sc-unknown：有编制缺口但全部无法估算
 * - sc-partial：部分已知小计 + 未估项
 * - sc-known：完整可估（缺口 1 × 4w）
 * - sc-zero：无需估算即可判定的真实 0
 */
function buildC03GuiProject(): ProjectFile {
  const e1 = emp('E1', '对照员工一', 'Known');
  const e2 = emp('E2', '对照员工二', 'Zero');
  const unknown = scenario('sc-unknown', '全部未估', [dept('Unknown', '未估部门', 1, { headcount: 2 })], []);
  const partial = scenario('sc-partial', '部分已知', [
    dept('KnownPart', '已知部门', 1, { headcount: 2, employees: [e1] }),
    dept('UnknownPart', '未估旁支', 1, { headcount: 2 }),
  ], [e1]);
  const known = scenario('sc-known', '完整可估', [dept('Known', '可估部门', 1, { headcount: 2, employees: [e1] })], [e1]);
  const zero = scenario('sc-zero', '真实0', [dept('Zero', '满编部门', 1, { headcount: 1, employees: [e2] })], [e2]);
  return {
    id: 'proj-f4-c03-gui',
    name: '格式4缺口成本对照夹具',
    version: 4,
    currentScenarioId: 'sc-unknown',
    scenarios: [unknown, partial, known, zero],
    levelConfigs: COST,
    meta: { createdAt: NOW, updatedAt: NOW, version: 4 },
  };
}

describe('C03 GUI 格式4对照夹具', () => {
  it('生成合法 format4 多场景夹具，口径与 A-C03 一致', () => {
    expect(PROJECT_VERSION).toBe(4);
    const project = buildC03GuiProject();
    const raw = serializeProject(project);
    const opened = parseProject(raw);
    expect(opened).not.toBeNull();
    expect(opened!.version).toBe(4);
    expect(opened!.meta.version).toBe(4);
    expect(opened!.scenarios.map((s) => s.id)).toEqual(['sc-unknown', 'sc-partial', 'sc-known', 'sc-zero']);

    const [unknown, partial, known, zero] = opened!.scenarios;
    const u = computeScenarioTotals(unknown, TH);
    const p = computeScenarioTotals(partial, TH);
    const k = computeScenarioTotals(known, TH);
    const z = computeScenarioTotals(zero, TH);

    expect(u.gapCostIncomplete).toBe(true);
    expect(u.totalGapCost).toBeNull();
    expect(formatGapCostSide(u)).not.toBe('0w');
    expect(formatGapCostSide(u)).toContain('未估');

    expect(p.gapCostIncomplete).toBe(true);
    expect(p.totalGapCost).toBeNull();
    expect(p.gapCostKnownSubtotal).toBe(4);
    expect(p.gapCostUnestimatedCount).toBe(1);
    expect(formatGapCostSide(p)).toBe('4w（已知小计，另有 1 项无法估算）');

    expect(k.gapCostIncomplete).toBe(false);
    expect(k.totalGapCost).toBe(4);
    expect(formatGapCostSide(k)).toBe('4w');

    expect(z.gapCostIncomplete).toBe(false);
    expect(z.totalGapCost).toBe(0);
    expect(formatGapCostSide(z)).toBe('0w');

    expect(computeDiffTotals(unknown, known, TH).gapCostDelta).toBeNull();
    expect(formatGapCostDelta(null)).toBe('无数据/不可比');
    expect(computeDiffTotals(zero, zero, TH).gapCostDelta).toBe(0);
    expect(formatGapCostDelta(0)).toBe('Δ 0w');
    expect(computeDiffTotals(known, zero, TH).gapCostDelta).toBe(-4);

    const saved = save('c03-gui-scenarios.orgproj', raw);
    const expected = {
      sha256: saved.sha,
      version: 4,
      scenarios: opened!.scenarios.map((s) => {
        const tot = computeScenarioTotals(s, TH);
        return {
          id: s.id,
          name: s.name,
          formatGapCostSide: formatGapCostSide(tot),
          totalGapCost: tot.totalGapCost,
          gapCostKnownSubtotal: tot.gapCostKnownSubtotal,
          gapCostUnestimatedCount: tot.gapCostUnestimatedCount,
          gapCostIncomplete: tot.gapCostIncomplete,
        };
      }),
      compare: {
        '全部未估 → 完整可估': formatGapCostDelta(computeDiffTotals(unknown, known, TH).gapCostDelta),
        '真实0 → 真实0': formatGapCostDelta(computeDiffTotals(zero, zero, TH).gapCostDelta),
        '完整可估 → 真实0': formatGapCostDelta(computeDiffTotals(known, zero, TH).gapCostDelta),
      },
    };
    writeFileSync(`${saved.file}.expected.json`, JSON.stringify(expected, null, 2) + '\n');
    expect(saved.sha).toHaveLength(64);
  });
});
