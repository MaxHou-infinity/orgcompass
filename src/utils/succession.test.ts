import { expect, it } from 'vitest';
import type { Department, Position } from '../types';
import { computeSuccession, mapSuccessorImportRows, validateSuccessorImport } from './succession';
import { createProject, parseProject, serializeProject } from './project';
import { buildSuccessionTemplateBytes } from './excel';

export function successionFixture(): Department[] {
  return Array.from({ length: 5 }, (_, i) => ({ id: `d${i}`, name: `部门${i}`, level: 1, expanded: true, leaderId: `m${i}`, children: [],
    positions: [{ id: `p${i}`, departmentId: `d${i}`, name: `负责人岗${i}`, headcount: 1, status: 'active', createdAt: '', updatedAt: '', levelBandMax: `P${i + 1}`,
      ...(i < 2 ? { successors: [{ employeeId: `c${i}`, readiness: i === 0 ? 'ready_now' : 'ready_1_2y' }] } : {}) } as Position],
    employees: [{ id: `m${i}`, employeeId: `M${i}`, name: `经理${i}`, level: `P${i + 1}`, positionId: `p${i}` },
      { id: `c${i}`, employeeId: `C${i}`, name: `候选${i}`, level: 'P1' }] }));
}

it('5 个关键岗、2 个准备好的继任覆盖 40% 判预警，3 个单点风险按职级降序', () => {
  const roots = successionFixture();
  const report = computeSuccession(roots, Array.from({ length: 5 }, (_, i) => ({ code: 'P', number: String(i + 1), label: '', color: '#000000' })));
  expect(report).toMatchObject({ criticalCount: 5, coveredCount: 2, coverage: 40, status: 'danger', unconfigured: 3 });
  expect(report.risks.map((position) => position.positionId)).toEqual(['p4', 'p3', 'p2']);
  expect(roots[2].positions![0].successors).toBeUndefined();
});

it('手动取消关键属性优先，样本少于 5 不判灯；远期、无效引用、现任人不充当覆盖', () => {
  const roots = successionFixture();
  roots[4].positions![0].isCritical = false;
  roots[0].positions![0].successors = [{ employeeId: 'c0', readiness: 'ready_3y_plus' }, { employeeId: 'm0', readiness: 'ready_now' }, { employeeId: 'missing', readiness: 'ready_now' }];
  expect(computeSuccession(roots)).toMatchObject({ criticalCount: 4, coveredCount: 1, coverage: 25, status: 'nodata', invalidCandidates: 2 });
});

it('同一人覆盖至少 3 个关键岗时提示集中，重复候选不重复计数', () => {
  const roots = successionFixture();
  for (const dept of roots.slice(0, 3)) dept.positions![0].successors = [{ employeeId: 'c0', readiness: 'ready_now' }, { employeeId: 'c0', readiness: 'ready_now' }];
  expect(computeSuccession(roots).concentration).toMatchObject([{ employeeId: 'c0', positions: ['负责人岗0', '负责人岗1', '负责人岗2'] }]);
});

it('Excel 精确工号验证整批，未知岗位/同名而无工号/现任人/非法准备度均拒绝', async () => {
  const roots = successionFixture();
  const rows = mapSuccessorImportRows([{ '岗位 ID': 'p2', 继任人工号: 'C2', 准备度: 'ready_1_2y' }]);
  expect(validateSuccessorImport(rows, roots).get('p2')?.successors).toEqual([{ employeeId: 'c2', readiness: 'ready_1_2y' }]);
  expect(() => validateSuccessorImport([...rows, { positionId: 'missing', employeeNumber: 'C1', readiness: 'ready_now' }], roots)).toThrow();
  expect(() => validateSuccessorImport([{ positionId: 'p2', employeeNumber: 'M2', readiness: 'ready_now' }], roots)).toThrow();
  expect(() => mapSuccessorImportRows([{ '岗位 ID': 'p2', 继任人工号: 'C2', 准备度: '随便' }])).toThrow();
  const XLSX = await import('xlsx');
  const book = XLSX.read(await buildSuccessionTemplateBytes(computeSuccession(roots).all), { type: 'array' });
  const exported = XLSX.utils.sheet_to_json<Record<string, unknown>>(book.Sheets[book.SheetNames[0]], { defval: '' });
  expect(Object.keys(exported[0])).toContain('岗位 ID');
  expect(Object.keys(exported[0])).toContain('继任人工号');
});

it('关键与继任配置随项目往返，不污染原场景或改变手动 false', () => {
  const project = createProject('继任');
  project.scenarios[0].departments = successionFixture();
  project.scenarios[0].departments[4].positions![0].isCritical = false;
  const restored = parseProject(serializeProject(project))!;
  expect(restored.scenarios[0].departments[0].positions![0].successors).toEqual(project.scenarios[0].departments[0].positions![0].successors);
  expect(restored.scenarios[0].departments[4].positions![0].isCritical).toBe(false);
});
