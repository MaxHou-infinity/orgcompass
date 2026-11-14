import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as XLSX from 'xlsx';
import type { Department, Employee } from '../types';
import { buildOrgExcelBytes } from './excel';
import { moveEmployeesBetween } from './departments';
import { moveDepartmentInTree } from './departmentMove';

const OUT_DIR = process.env.ORGCOMPASS_EVIDENCE_DIR ?? '.test-artifacts/v2.5.3';

function emp(id: string, name: string, deptFields: Partial<Employee> = {}): Employee {
  return { id, name, employeeId: id, level: 'L1', ...deptFields };
}

function dept(id: string, name: string, level: number, opts: Partial<Department> = {}): Department {
  return { id, name, level, parentId: opts.parentId, children: opts.children ?? [], employees: opts.employees ?? [], expanded: true, ...opts };
}

function parseSheet(bytes: Uint8Array, sheetName: string): Record<string, string>[] {
  const wb = XLSX.read(bytes, { type: 'array' });
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error(`missing sheet ${sheetName}`);
  return XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: '' });
}

function findRow(rows: Record<string, string>[], employeeId: string) {
  return rows.find((r) => String(r['工号']) === employeeId);
}

function saveArtifact(name: string, bytes: Uint8Array, log: unknown) {
  mkdirSync(OUT_DIR, { recursive: true });
  const file = `${OUT_DIR}/${name}`;
  writeFileSync(file, bytes);
  const sha = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(`${file}.parse.json`, JSON.stringify({ sha256: sha, ...((typeof log === 'object' ? log : { log }) as object) }, null, 2) + '\n');
  return { file, sha };
}

function deepTree(): Department[] {
  const eDeep = emp('E1', '深员工', { dept1: '一级旧', dept2: '二级旧', dept3: '三级旧' });
  const eStay = emp('E2', '未移动', { dept1: '旁支', dept2: '' });
  const eVirt = emp('V1', '兼岗', { dept1: '一级旧', isVirtual: true, primaryEmployeeId: 'E1' });
  return [
    dept('L1', '一级旧', 1, {
      children: [
        dept('L2', '二级旧', 2, {
          parentId: 'L1',
          children: [
            dept('L3', '三级旧', 3, { parentId: 'L2', employees: [eDeep, eVirt] }),
          ],
        }),
      ],
    }),
    dept('SIDE', '旁支', 1, { employees: [eStay] }),
    dept('NEW', '新部门', 1, { employees: [] }),
  ];
}

describe('C02 导出员工信息按当前树路径（真实 xlsx 解析）', () => {
  it('A-C02-01/05/08 移动后导出为当前完整路径，旧尾列清空；持久化 dept 字段不被改写', async () => {
    const moved = moveEmployeesBetween(deepTree(), ['E1'], 'NEW');
    // 持久化字段仍是旧路径（产品决定：不回写）
    const movedEmp = moved.flatMap(function walk(d: Department): Employee[] { return [...d.employees, ...d.children.flatMap(walk)]; }).find((e) => e.id === 'E1')!;
    expect(movedEmp.dept1).toBe('一级旧');
    expect(movedEmp.dept2).toBe('二级旧');
    expect(movedEmp.dept3).toBe('三级旧');

    const bytes = await buildOrgExcelBytes(moved);
    const rows = parseSheet(bytes, '员工信息');
    const row = findRow(rows, 'E1');
    expect(row).toBeTruthy();
    expect(row!['一级部门']).toBe('新部门');
    expect(row!['二级部门']).toBe('');
    expect(row!['三级部门']).toBe('');
    expect(row!['四级部门']).toBe('');
    expect(row!['五级部门']).toBe('');
    expect(row!['六级部门']).toBe('');
    const art = saveArtifact('c02-move-to-new.xlsx', bytes, { sheet: '员工信息', rows });
    expect(art.sha).toHaveLength(64);
  });

  it('A-C02-02 未移动员工与组织架构表保持当前归属；C01 后部门级别与重算 level 一致', async () => {
    const afterEmpMove = moveEmployeesBetween(deepTree(), ['E1'], 'NEW');
    const afterTreeMove = moveDepartmentInTree(afterEmpMove, 'L2', 'NEW').departments;
    const bytes = await buildOrgExcelBytes(afterTreeMove);
    const people = parseSheet(bytes, '员工信息');
    const org = parseSheet(bytes, '组织架构');
    expect(findRow(people, 'E2')!['一级部门']).toBe('旁支');
    const l2row = org.find((r) => String(r['二级部门']) === '二级旧' && String(r['三级部门']) === '');
    expect(l2row).toBeTruthy();
    expect(String(l2row!['部门级别'])).toBe('2');
    const l3row = org.find((r) => String(r['三级部门']) === '三级旧');
    expect(l3row).toBeTruthy();
    expect(String(l3row!['部门级别'])).toBe('3');
    saveArtifact('c02-org-levels-after-c01.xlsx', bytes, { people, org });
  });

  it('A-C02-03 虚拟兼岗不进入员工信息，实体员工仍按当前路径导出', async () => {
    const bytes = await buildOrgExcelBytes(deepTree());
    const rows = parseSheet(bytes, '员工信息');
    expect(rows.map((r) => r['工号']).sort()).toEqual(['E1', 'E2']);
    expect(rows.some((r) => r['工号'] === 'V1' || r['姓名'] === '兼岗')).toBe(false);
    expect(findRow(rows, 'E1')!['一级部门']).toBe('一级旧');
    expect(findRow(rows, 'E1')!['二级部门']).toBe('二级旧');
    expect(findRow(rows, 'E1')!['三级部门']).toBe('三级旧');
    saveArtifact('c02-filter-virtual.xlsx', bytes, { rows });
  });

  it('A-C02-04 至少三级路径各列完整、中间层不缺段', async () => {
    const bytes = await buildOrgExcelBytes(deepTree());
    const row = findRow(parseSheet(bytes, '员工信息'), 'E1')!;
    expect(row['一级部门']).toBe('一级旧');
    expect(row['二级部门']).toBe('二级旧');
    expect(row['三级部门']).toBe('三级旧');
    saveArtifact('c02-three-level-path.xlsx', bytes, { row });
  });

  it('A-C02-06 只改部门名、不移动人员：导出使用新名称', async () => {
    const tree = deepTree();
    tree[0].name = '一级新名';
    const bytes = await buildOrgExcelBytes(tree);
    const row = findRow(parseSheet(bytes, '员工信息'), 'E1')!;
    expect(row['一级部门']).toBe('一级新名');
    expect(row['二级部门']).toBe('二级旧');
    expect(row['三级部门']).toBe('三级旧');
    // 持久化旧字段仍在
    const raw = tree[0].children[0].children[0].employees.find((e) => e.id === 'E1')!;
    expect(raw.dept1).toBe('一级旧');
    saveArtifact('c02-rename-only.xlsx', bytes, { row });
  });

  it('A-C02-07 整棵子树移动、人员未单独点选：导出为移动后完整路径并清尾列', async () => {
    const moved = moveDepartmentInTree(deepTree(), 'L2', 'NEW').departments;
    const bytes = await buildOrgExcelBytes(moved);
    const row = findRow(parseSheet(bytes, '员工信息'), 'E1')!;
    expect(row['一级部门']).toBe('新部门');
    expect(row['二级部门']).toBe('二级旧');
    expect(row['三级部门']).toBe('三级旧');
    expect(row['四级部门']).toBe('');
    const raw = moved.flatMap(function walk(d: Department): Employee[] { return [...d.employees, ...d.children.flatMap(walk)]; }).find((e) => e.id === 'E1')!;
    expect(raw.dept1).toBe('一级旧');
    saveArtifact('c02-subtree-move.xlsx', bytes, { row });
  });
});
