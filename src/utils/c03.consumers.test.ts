import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Department, Employee, LevelConfig, Scenario } from '../types';
import { DEFAULT_HEALTH_THRESHOLDS } from './analytics';
import { computeDiffTotals, computeScenarioDiff, computeScenarioTotals } from './scenarioDiff';
import { formatGapCostDelta, formatGapCostSide } from './statusUI';
import { buildDiffExcelBytes } from '../components/ManagementReport';

const COST: LevelConfig[] = [{ code: 'L', number: '1', label: '一级', color: '#000000', cost: 4 }];
const TH = DEFAULT_HEALTH_THRESHOLDS;
const OUT = process.env.ORGCOMPASS_EVIDENCE_DIR ?? '.test-artifacts/v2.5.3';

function emp(id: string, opts: Partial<Employee> = {}): Employee {
  return { id, name: id, employeeId: id, level: 'L1', ...opts };
}
function dept(id: string, name: string, level: number, opts: Partial<Department> = {}): Department {
  return { id, name, level, children: opts.children ?? [], employees: opts.employees ?? [], expanded: true, ...opts };
}
function scenario(id: string, departments: Department[], allEmployeesFlat: Employee[]): Scenario {
  return { id, name: id, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', departments, allEmployeesFlat, levelConfigs: COST, canvas: { zoom: 100 } };
}

describe('C03 消费面：格式化 / ManagementReport 导出 / A/B 所用同一口径', () => {
  it('A-C03-05 完整真实 0 在格式化与导出中仍是 0，不是空白或无数据', async () => {
    const s = scenario('z', [dept('R', 'R', 1, { headcount: 1, employees: [emp('E1')] })], [emp('E1')]);
    const tot = computeScenarioTotals(s, TH);
    expect(formatGapCostSide(tot)).toBe('0w');
    const diff = computeScenarioDiff(s, s, TH);
    expect(diff.totals.gapCostDelta).toBe(0);
    expect(formatGapCostDelta(0)).toBe('Δ 0w');
    const bytes = await buildDiffExcelBytes('虚构项目', s, s, diff, []);
    const wb = XLSX.read(bytes, { type: 'array' });
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['缺口与成本汇总'], { defval: '' });
    const costRow = rows.find((r) => r['项'] === '缺口成本(w)');
    expect(costRow).toBeTruthy();
    expect(String(costRow!['基线'])).toBe('0w');
    expect(String(costRow!['目标'])).toBe('0w');
    expect(costRow!['Δ']).toBe(0);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/c03-management-report-true-zero.xlsx`, bytes);
    writeFileSync(`${OUT}/c03-management-report-true-zero.xlsx.sha256`, createHash('sha256').update(bytes).digest('hex') + '\n');
  });

  it('A-C03-05 基线未知、目标可估：导出与格式化都是不可比，不出现从 0 到 N', async () => {
    const base = scenario('b', [dept('R', 'R', 1, { headcount: 2 })], []);
    const tgt = scenario('t', [dept('R', 'R', 1, { headcount: 2, employees: [emp('E1')] })], [emp('E1')]);
    const b = computeScenarioTotals(base, TH);
    const t = computeScenarioTotals(tgt, TH);
    expect(formatGapCostSide(b)).not.toBe('0w');
    expect(formatGapCostSide(b)).toContain('未估');
    expect(formatGapCostSide(t)).toBe('4w');
    const diff = computeScenarioDiff(base, tgt, TH);
    expect(diff.totals.gapCostDelta).toBeNull();
    expect(computeDiffTotals(base, tgt, TH).gapCostDelta).toBeNull();
    expect(formatGapCostDelta(null)).toBe('无数据/不可比');
    const bytes = await buildDiffExcelBytes('虚构项目', base, tgt, diff, []);
    const wb = XLSX.read(bytes, { type: 'array' });
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['缺口与成本汇总'], { defval: '' });
    const costRow = rows.find((r) => r['项'] === '缺口成本(w)');
    expect(String(costRow!['基线'])).toContain('未估');
    expect(String(costRow!['目标'])).toBe('4w');
    expect(costRow!['Δ']).toBe('无数据/不可比');
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/c03-management-report-unknown-baseline.xlsx`, bytes);
    writeFileSync(`${OUT}/c03-management-report-unknown-baseline.xlsx.sha256`, createHash('sha256').update(bytes).digest('hex') + '\n');
  });
});
