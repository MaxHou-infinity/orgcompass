import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { buildDepartmentTree, mapEmployeeRows, mapPositionRows, resolveReportsToEmployeeIds } from './excel';
import type { Employee, OrgTemplate, Department } from '../types';

/**
 * 集成测试：直接读取仓库根目录下真实生成的测试 xlsx，
 * 模拟「上传 → 解析 → 建树」的用户数据流，验证画布能真正渲染出结构。
 * （纯 node 环境无 FileReader，故绕过 parse*Excel 的 FileReader 包装，
 *   直接复用与 parse*Excel 完全一致的字段映射逻辑。）
 */

function cellString(value: unknown): string {
  const str = String(value ?? '');
  return str === 'undefined' ? '' : str;
}

function rowsToEmployees(rows: Record<string, unknown>[]): Employee[] {
  return rows.map((row, index) => ({
    id: `emp-${index}-${Date.now()}`,
    name: cellString(row['姓名']),
    employeeId: cellString(row['工号']),
    level: cellString(row['职级']),
    dept1: cellString(row['一级部门']),
    dept2: cellString(row['二级部门']),
    dept3: cellString(row['三级部门']),
    dept4: cellString(row['四级部门']),
    dept5: cellString(row['五级部门']),
    dept6: cellString(row['六级部门']),
  }));
}

function rowsToOrgTemplates(rows: Record<string, unknown>[]): OrgTemplate[] {
  return rows.map((row) => ({
    dept1: cellString(row['一级部门']),
    dept2: cellString(row['二级部门']),
    dept3: cellString(row['三级部门']),
    dept4: cellString(row['四级部门']),
    dept5: cellString(row['五级部门']),
    dept6: cellString(row['六级部门']),
    deptLevel: cellString(row['部门级别']),
    leaderId: cellString(row['部门负责人工号']),
    leaderName: cellString(row['部门负责人']),
  }));
}

/**
 * V2.4.0：Excel 测试夹具从仓库根目录移到 `tests/fixtures/excel/`（根目录此前混着 4 个 xlsx）。
 * 这里用相对**测试文件**的绝对路径解析，不再依赖 vitest 的 cwd。
 */
const FIXTURES = fileURLToPath(new URL('../../tests/fixtures/excel/', import.meta.url));

function readRows(file: string): Record<string, unknown>[] {
  // 与 App 的 parse*Excel 一致：用 fs 读文件 → Uint8Array → XLSX.read({type:'array'})。
  // （xlsx 0.20.3 在 Node ESM 下 readFile 的 fs 绑定不可用，改用与解析入口一致的 buffer 路径。）
  const data = new Uint8Array(readFileSync(file.startsWith('/') ? file : FIXTURES + file));
  const wb = XLSX.read(data, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
}

function findDept(depts: Department[], name: string): Department | undefined {
  for (const d of depts) {
    if (d.name === name) return d;
    const found = findDept(d.children, name);
    if (found) return found;
  }
  return undefined;
}

function collectEmployees(dept: Department): Employee[] {
  return [...dept.employees, ...dept.children.flatMap(collectEmployees)];
}

describe('真实测试文件集成：员工+组织架构 → 树渲染（P0 bug #1）', () => {
  it('test_employee_import.xlsx + test_org_import.xlsx → 完整部门树且员工正确归属', () => {
    const employees = rowsToEmployees(readRows('test_employee_import.xlsx'));
    const orgTemplates = rowsToOrgTemplates(readRows('test_org_import.xlsx'));

    // 两个文件解析出的数据量符合预期
    expect(employees).toHaveLength(10);
    expect(orgTemplates).toHaveLength(9);

    // 用「组织架构模板重建部门结构 + 员工路径归属」建树（与 App 上传逻辑一致）
    const tree = buildDepartmentTree(employees, orgTemplates);

    // 三个一级部门（按中文拼音排序：技术部 < 人力资源部 < 销售部）
    const topNames = tree.map((d) => d.name);
    expect(topNames).toEqual(['技术部', '人力资源部', '销售部']);

    // 技术部(L1) → 研发组/测试组(L2) → 后端/前端/功能测试/自动化测试(L3)
    const 技术部 = findDept(tree, '技术部');
    expect(技术部).toBeDefined();
    expect(技术部!.level).toBe(1);
    const 研发组 = findDept(tree, '研发组');
    expect(研发组!.parentId).toBe(技术部!.id);
    const 后端 = findDept(tree, '后端');
    const 前端 = findDept(tree, '前端');
    expect(后端!.level).toBe(3);
    expect(前端!.level).toBe(3);
    // 后端应含 张伟(E001,L3.2)+李娜(E002,L2.1) = 2 人
    expect(collectEmployees(后端!).map((e) => e.employeeId).sort()).toEqual(['E001', 'E002']);
    expect(collectEmployees(前端!).map((e) => e.employeeId)).toEqual(['E003']);

    // 模板负责人传承：后端负责人=张伟
    expect(后端!.leaderId).toBe('E001');
    expect(后端!.leaderName).toBe('张伟');

    // 销售部：华北区/华东区/华南区（L2），无三级可归属则落在二级部门
    const 销售部 = findDept(tree, '销售部');
    expect(销售部!.children.map((c) => c.name).sort()).toEqual(['华东区', '华南区', '华北区'].sort());
    const 华北区 = findDept(tree, '华北区');
    expect(collectEmployees(华北区!).map((e) => e.employeeId)).toEqual(['E007']);

    // 人力资源部：招聘组/薪酬福利组
    const 人力资源部 = findDept(tree, '人力资源部');
    expect(人力资源部).toBeDefined();
    expect(人力资源部!.children.map((c) => c.name).sort()).toEqual(['招聘组', '薪酬福利组'].sort());

    // 员工总数=10（不重复、无丢失）
    const allEmps = tree.flatMap((d) => collectEmployees(d));
    expect(allEmps.length).toBe(10);
  });

  it('员工文件无有效数据 → 空树（上传提示「员工文件无有效数据」的判定路径）', () => {
    const tree = buildDepartmentTree([], []);
    expect(tree).toEqual([]);
  });
});

/**
 * 端到端：富字段 Excel（员工表内嵌 岗位名称/个人成本/目标职级/直接上级 + 独立岗位表）
 * → 岗位树（find-or-create / 先建岗）+ 员工套岗 + 岗位级编制正确。
 * 用 XLSX 生成字节 → sheet_to_json（与 parseExcelFromBuffer 一致）→ 真实 map*Rows → buildDepartmentTree。
 */
describe('真实富字段文件集成：员工富字段 + 岗位表 → 岗位树与套岗', () => {
  function rowsOf(aoa: unknown[][]): Record<string, unknown>[] {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const read = XLSX.read(buf, { type: 'array' });
    return XLSX.utils.sheet_to_json<Record<string, unknown>>(read.Sheets[read.SheetNames[0]]);
  }

  it('员工富字段 + 岗位表：岗位 find-or-create、套岗、部门级岗位编制正确', () => {
    const empRows = rowsOf([
      ['姓名', '工号', '职级', '岗位名称', '个人成本', '目标职级', '直接上级', '一级部门'],
      ['张三', 'E001', 'L3.2', '前端工程师', '24000', 'L4.1', '', '技术部'],
      ['李四', 'E002', 'L2.1', '前端工程师', '18000', '', '张三', '技术部'],
      ['王五', 'E003', 'L4.2', '研发经理', '36000', '', '', '技术部'],
      ['赵六', 'E004', 'L2.1', '销售专员', '15000', '', '', '销售部'],
    ]);
    const posRows = rowsOf([
      ['一级部门', '岗位名称', '序列', '职级带宽下限', '职级带宽上限', '编制数'],
      ['技术部', '前端工程师', '技术', 'L1', 'L3.2', '3'],
      ['技术部', '研发经理', '管理', '', '', '1'],
    ]);

    const employees = resolveReportsToEmployeeIds(mapEmployeeRows(empRows));
    expect(employees[2].cost).toBe(36000);
    expect(employees[0].targetLevel).toBe('L4.1');
    const positions = mapPositionRows(posRows);
    const tree = buildDepartmentTree(employees, [], positions);

    const 技术部 = tree.find((d) => d.name === '技术部')!;
    // v2.3.1（T-08）：Department.positions 为可选字段，先取本地列表再做断言。
    const 技术部岗位 = 技术部.positions ?? [];
    // 岗位表先建岗（2 个岗位，编制=3 / 1；序列/带宽正确）
    expect(技术部岗位).toHaveLength(2);
    const 前端 = 技术部岗位.find((p) => p.name === '前端工程师')!;
    expect(前端.headcount).toBe(3);
    expect(前端.jobFamily).toBe('技术');
    expect(前端.levelBandMin).toBe('L1');
    expect(前端.levelBandMax).toBe('L3.2');

    // 员工套岗：张三/李四 → 前端岗位（只查不建，复用岗位表），王五 → 研发经理
    const 张三 = 技术部.employees.find((e) => e.employeeId === 'E001')!;
    const 李四 = 技术部.employees.find((e) => e.employeeId === 'E002')!;
    const 王五 = 技术部.employees.find((e) => e.employeeId === 'E003')!;
    expect(张三.positionId).toBe(前端.id);
    expect(李四.positionId).toBe(前端.id);
    const 研发经理 = 技术部岗位.find((p) => p.name === '研发经理')!;
    expect(王五.positionId).toBe(研发经理.id);

    // 销售部：岗位名不在岗位表（只查不建）→ 保持未套岗，且不新建岗位
    const 销售部 = tree.find((d) => d.name === '销售部')!;
    expect(销售部.positions ?? []).toHaveLength(0);
    expect(销售部.employees[0].positionId).toBeUndefined();

    // 汇报线：李四的直接上级=张三，按姓名兜底解析到张三的内部 id
    expect(李四.reportsToEmployeeId).toBe(张三.id);
  });
});
