// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import * as XLSX from 'xlsx';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ScenarioDiffView } from './ScenarioDiffView';
import { buildDiffExcelBytes } from './ManagementReport';
import { computeScenarioDiff, computeScenarioTotals } from '../utils/scenarioDiff';
import { computeL3, DEFAULT_HEALTH_THRESHOLDS } from '../utils/analytics';
import { createProject, serializeProject, parseProject } from '../utils/project';
import { formatGapCostSide } from '../utils/statusUI';
import type { Scenario, Department, Position } from '../types';
const OUT = process.env.ORGCOMPASS_EVIDENCE_DIR ?? '.test-artifacts/v2.5.3';
const pos = (id: string, levelBandMin?: string): Position => ({ id, name: id, departmentId: 'R', headcount: 1, status: 'active', createdAt: '2026-11-14T09:41:00Z', updatedAt: '2026-11-14T09:41:00Z', ...(levelBandMin ? { levelBandMin } : {}) });
const dept = (id: string, positions?: Position[], children: Department[] = []): Department => ({ id, name: id, level: id === 'R' ? 1 : 2, employees: [], expanded: true, positions: positions?.map(p => ({ ...p, departmentId: id })), children: children.map(c => ({ ...c, parentId: id })) });
const flatEmployees = (ds: Department[]): NonNullable<Scenario['allEmployeesFlat']> => ds.flatMap(d => [...d.employees, ...flatEmployees(d.children)]);
const scenario = (departments: Department[]): Scenario => ({ id: 's', name: 'synthetic', departments, allEmployeesFlat: flatEmployees(departments), levelConfigs: [{ code: 'L', number: '1', label: 'one', color: '#000000', cost: 4 }, { code: 'Z', number: '0', label: 'zero sentinel', color: '#000000', cost: 0 }], canvas: { zoom: 100 }, createdAt: '2026-11-14T09:41:00Z', updatedAt: '2026-11-14T09:41:00Z' });
const cases = [
  { name: 'same-department-mixed', s: scenario([dept('R', [pos('known', 'L1'), pos('unknown')])]), known: 4, missing: 1 },
  { name: 'two-unknown-positions', s: scenario([dept('R', [pos('unknown1'), pos('unknown2')])]), known: 0, missing: 2 },
  { name: 'same-root-mixed', s: scenario([dept('R', undefined, [dept('K', [pos('known', 'L1')]), dept('U', [pos('unknown')])])]), known: 4, missing: 1 },
  { name: 'all-unconfigured', s: scenario([dept('R')]), known: 0, missing: 1 },
  { name: 'zero-gap-plus-unknown', s: scenario([dept('R', undefined, [ { ...dept('K', [pos('filled')]), employees: [{ id: 'e', name: 'e', employeeId: 'e', level: '', positionId: 'filled' }] }, dept('U', [pos('unknown')])])]), known: 0, missing: 1 },
  { name: 'cross-root-mixed', s: scenario([dept('R', undefined, [dept('K', [pos('known', 'L1')]), dept('U', [pos('unknown')])]), { ...dept('R2', [pos('known2', 'L1')]), level: 1 }]), known: 8, missing: 1 },
  { name: 'configured-zero-is-not-a-cost-basis', s: scenario([dept('R', [pos('zero', 'Z0')])]), known: 0, missing: 1 },
];
afterEach(cleanup);
describe('C03 real L3 → root totals → A/B DOM and generated xlsx', () => {
  it.each(cases)('$name preserves per-position subtotal and incompleteness without double counting', async ({ name, s, known, missing }) => {
    const totals = computeScenarioTotals(s, DEFAULT_HEALTH_THRESHOLDS);
    expect(totals.gapCostKnownSubtotal).toBe(known);
    expect(totals.gapCostUnestimatedCount).toBe(missing);
    expect(totals.totalGapCost).toBeNull(); expect(totals.gapCostIncomplete).toBe(true);
    const diff = computeScenarioDiff(s, s, DEFAULT_HEALTH_THRESHOLDS);
    expect(diff.totals.gapCostDelta).toBeNull();
    const side = formatGapCostSide(totals); expect(side).toContain(`${known}w`); expect(side).toContain('已知小计');
    const view = render(<ScenarioDiffView open onClose={vi.fn()} baseline={s} target={s} scenarios={[s]} onSelectBaseline={vi.fn()} onSelectTarget={vi.fn()} onLocateDept={vi.fn()} onLocateEmployee={vi.fn()} onExportReport={vi.fn()} />);
    const label = [...view.container.querySelectorAll('div')].find(r => r.textContent === '缺口成本')!;
    const row = label.parentElement!;
    expect(row).toBeTruthy(); expect(row.textContent).toContain(side); expect(row.textContent).toContain('无数据/不可比');
    const bytes = await buildDiffExcelBytes('synthetic', s, s, diff, []);
    mkdirSync(OUT, { recursive: true }); writeFileSync(`${OUT}/${name}.xlsx`, bytes);
    const wb = XLSX.read(bytes, { type: 'array' });
    const parsed = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['缺口与成本汇总']);
    const cost = parsed.find(r => r['项'] === '缺口成本(w)')!;
    expect(cost['基线']).toBe(side); expect(cost['目标']).toBe(side); expect(cost['Δ']).toBe('无数据/不可比');
    writeFileSync(`${OUT}/${name}.json`, JSON.stringify({ totals, l3: computeL3(s.departments, s.levelConfigs), dom: row.textContent, parsed }, null, 2));
  });
  it.each(cases.flatMap(c => [{ ...c, direction: 'baseline' }, { ...c, direction: 'target' }]))('$name unknown on $direction side keeps real DOM/report delta incomparable', async ({ name, s, direction }) => {
    const known = scenario([dept('R', [pos('known', 'L1')])]);
    const [b, t] = direction === 'baseline' ? [s, known] : [known, s];
    const diff = computeScenarioDiff(b, t);
    expect(diff.totals.gapCostDelta).toBeNull();
    const view = render(<ScenarioDiffView open onClose={vi.fn()} baseline={b} target={t} scenarios={[b, t]} onSelectBaseline={vi.fn()} onSelectTarget={vi.fn()} onLocateDept={vi.fn()} onLocateEmployee={vi.fn()} onExportReport={vi.fn()} />);
    const row = [...view.container.querySelectorAll('div')].find(r => r.textContent === '缺口成本')!.parentElement!;
    expect(row.textContent).toContain(formatGapCostSide(computeScenarioTotals(s)));
    expect(row.textContent).toContain('4w'); expect(row.textContent).toContain('无数据/不可比');
    const bytes = await buildDiffExcelBytes('synthetic', b, t, diff, []);
    mkdirSync(OUT, { recursive: true }); writeFileSync(`${OUT}/${name}-${direction}.xlsx`, bytes);
    const wb = XLSX.read(bytes, { type: 'array' });
    const parsed = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['缺口与成本汇总']);
    const cost = parsed.find(r => r['项'] === '缺口成本(w)')!;
    expect(cost['基线']).toBe(formatGapCostSide(computeScenarioTotals(b)));
    expect(cost['目标']).toBe(formatGapCostSide(computeScenarioTotals(t)));
    expect(cost['Δ']).toBe('无数据/不可比');
  });
  it('writes valid synthetic format4 cases for subsequent parent GUI; no runtime unknown fields persisted', () => {
    const project = createProject('C03 revision3 synthetic cases');
    project.levelConfigs = cases[0].s.levelConfigs;
    project.scenarios = cases.map(({ s, name }) => {
      const collect = (ds: Department[]): Department[] => ds.flatMap(d => [d, ...collect(d.children)]);
      return { ...s, id: name, name, allEmployeesFlat: collect(s.departments).flatMap(d => d.employees) };
    });
    project.scenarios.push({ ...scenario([{ ...dept('R', [pos('filled')]), employees: [{ id: 'e', name: 'e', employeeId: 'e', level: '', positionId: 'filled' }] }]), id: 'true-zero-no-cost', name: 'true-zero-no-cost' });
    project.currentScenarioId = project.scenarios[0].id;
    const raw = serializeProject(project); const opened = parseProject(raw)!;
    expect(opened).not.toBeNull(); expect(opened.version).toBe(4);
    expect(raw).not.toContain('gapCostKnownSubtotal'); expect(raw).not.toContain('gapCostUnestimatedCount');
    for (const c of cases) expect(computeScenarioTotals(opened.scenarios.find(s => s.id === c.name)!).gapCostKnownSubtotal).toBe(c.known);
    mkdirSync(OUT, { recursive: true }); writeFileSync(`${OUT}/revision3-c03-scenarios.orgproj`, raw);
    writeFileSync(`${OUT}/revision3-c03-scenarios.expected.json`, JSON.stringify(opened.scenarios.map(s => ({ id: s.id, ...computeScenarioTotals(s) })), null, 2));
  });
  it('no gap with no cost configured is true zero in actual DOM and xlsx, not unknown', async () => {
    const s = scenario([{ ...dept('R', [pos('filled')]), employees: [{ id: 'e', name: 'e', employeeId: 'e', level: '', positionId: 'filled' }] }]);
    expect(computeScenarioTotals(s).totalGapCost).toBe(0); expect(computeScenarioTotals(s).gapCostIncomplete).toBe(false);
    const view = render(<ScenarioDiffView open onClose={vi.fn()} baseline={s} target={s} scenarios={[s]} onSelectBaseline={vi.fn()} onSelectTarget={vi.fn()} onLocateDept={vi.fn()} onLocateEmployee={vi.fn()} onExportReport={vi.fn()} />);
    const row = [...view.container.querySelectorAll('div')].find(r => r.textContent === '缺口成本')!.parentElement!;
    expect(row.textContent).toContain('0w'); expect(row.textContent).not.toContain('未估'); expect(row.textContent).not.toContain('不可比');
    const bytes = await buildDiffExcelBytes('synthetic', s, s, computeScenarioDiff(s, s), []);
    mkdirSync(OUT, { recursive: true }); writeFileSync(`${OUT}/true-zero-no-cost.xlsx`, bytes);
    const wb = XLSX.read(bytes, { type: 'array' });
    const parsed = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets['缺口与成本汇总']);
    const cost = parsed.find(r => r['项'] === '缺口成本(w)')!;
    expect(cost['基线']).toBe('0w'); expect(cost['目标']).toBe('0w'); expect(cost['Δ']).toBe(0);
  });
});
