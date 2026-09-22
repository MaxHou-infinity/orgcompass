import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import {
  MAX_IMPORT_FILE_BYTES,
  WARN_IMPORT_FILE_BYTES,
  MAX_IMPORT_ROWS,
  SUPPORTED_EXCEL_EXTENSIONS,
  ExcelImportError,
  getExcelFileExtension,
  getImportErrorMessage,
  validateImportFile,
  parseExcelFromBuffer,
  parseEmployeeExcel,
  mapEmployeeRows,
  mapOrgTemplateRows,
  buildDepartmentTree,
  parsePositionExcel,
} from './excel';
import type { Department } from '../types';

// ───────────── 工作簿构造工具（用 XLSX 生成 buffer，与真实上传路径一致） ─────────────

/** 由「表头+数据」二维数组生成 xlsx 字节（避免对象字面量对 __proto__ 的干扰） */
function buildWorkbookBytes(aoa: unknown[][]): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return out as ArrayBuffer;
}

function findDept(depts: Department[], name: string): Department | undefined {
  for (const d of depts) {
    if (d.name === name) return d;
    const found = findDept(d.children, name);
    if (found) return found;
  }
  return undefined;
}

describe('Excel 导入输入加固（SEC-1..7）', () => {
  it('SEC-1 原型污染：__proto__/constructor/prototype 单元不污染 Object.prototype', async () => {
    const aoa = [
      ['__proto__', 'constructor', 'prototype', 'polluted', '姓名', '一级部门'],
      ['x', 'y', 'z', 'p', '张三', '技术部'],
    ];
    const buf = buildWorkbookBytes(aoa);
    const rows = await parseExcelFromBuffer(buf);

    expect(rows).toHaveLength(1);
    // 解析后不污染全局原型
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();

    // 字段映射不会因危险 key 抛错或读脏值
    const emps = mapEmployeeRows(rows);
    expect(emps[0].name).toBe('张三');
    expect(emps[0].dept1).toBe('技术部');
    // 映射后再确认原型仍干净
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('SEC-2 超大文件触发 size-exceeded；超大 sheet 被拒绝（v2.3.1 F-10：不再静默截断）', async () => {
    // 大小硬上限护栏（在读取前触发）
    const bigFile = { name: 'huge.xlsx', size: MAX_IMPORT_FILE_BYTES + 1 };
    await expect(
      parseEmployeeExcel(bigFile as unknown as File),
    ).rejects.toMatchObject({ kind: 'size-exceeded' });

    // 单表行数上限：超过 MAX_IMPORT_ROWS 必须**显式拒绝**。
    // v2.3.0 只解析到上限并静默丢弃其余行（60001 行只导入 49999 行且无任何提示），
    // 用户会以为数据完整 → 人数/编制/健康度全部失真。
    const aoa: unknown[][] = [['姓名', '一级部门']];
    for (let i = 0; i < MAX_IMPORT_ROWS + 100; i++) aoa.push([`员工${i}`, '技术部']);
    const buf = buildWorkbookBytes(aoa);
    await expect(parseExcelFromBuffer(buf)).rejects.toMatchObject({ kind: 'invalid-structure' });
  });

  it('SEC-3 缺必填列 → missing-columns，message 可行动且含缺失列', async () => {
    const aoa = [['工号', '职级'], ['E001', 'L3.2']]; // 缺唯一的必填列 姓名
    const buf = buildWorkbookBytes(aoa);
    const file = new File([buf], '员工.xlsx');

    await expect(parseEmployeeExcel(file)).rejects.toMatchObject({
      kind: 'missing-columns',
      missingColumns: ['姓名'],
    });

    const err = await parseEmployeeExcel(file).catch((e) => e) as ExcelImportError;
    expect(err).toBeInstanceOf(ExcelImportError);
    expect(err.kind).toBe('missing-columns');
    expect(err.message).toContain('姓名');
    expect(err.message).toMatch(/请对照示例模板补充表头/);
  });

  it('SEC-3b v2.3.2：一级部门不再是必填列 —— 整列缺失仍可导入，员工进「未入架构员工」', async () => {
    const aoa = [['姓名', '工号'], ['张三', 'E001'], ['李四', 'E002']];
    const file = new File([buildWorkbookBytes(aoa)], '只有姓名的名册.xlsx');

    const { employees } = await parseEmployeeExcel(file);
    expect(employees.map((e) => e.name)).toEqual(['张三', '李四']);
    // 无部门列 → 不生成任何部门节点（他们会被画布的「未入架构员工」接住，而不是静默消失）
    expect(buildDepartmentTree(employees, [])).toEqual([]);
  });

  it('SEC-4 空表 / 仅表头无数据 → empty，不静默生成空树', async () => {
    // 仅表头、无数据行
    const headerBuf = buildWorkbookBytes([['姓名', '一级部门']]);
    const headerFile = new File([headerBuf], '员工.xlsx');
    await expect(parseEmployeeExcel(headerFile)).rejects.toMatchObject({ kind: 'empty' });

    // 完全空表（无表头）
    const emptyBuf = buildWorkbookBytes([]);
    await expect(parseExcelFromBuffer(emptyBuf)).resolves.toEqual([]);
    const emptyFile = new File([emptyBuf], '员工.xlsx');
    await expect(parseEmployeeExcel(emptyFile)).rejects.toMatchObject({ kind: 'empty' });

    // 空数据不会生成空树（语义：明确抛错而非静默空树）
    let threw = false;
    try {
      await parseEmployeeExcel(headerFile);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('SEC-5 结构冲突（重复同部门/异常行）→ 去重且给出可解释结果，不静默', async () => {
    // 重复「技术部/研发组」行 + 正常行
    const aoa = [
      ['一级部门', '二级部门'],
      ['技术部', '研发组'],
      ['技术部', '研发组'],   // 重复
      ['技术部', '测试组'],
      ['人力资源部', ''],
    ];
    const buf = buildWorkbookBytes(aoa);
    const rows = await parseExcelFromBuffer(buf);
    const templates = mapOrgTemplateRows(rows);
    const tree = buildDepartmentTree([], templates);

    // 重复「技术部/研发组」只保留一个节点（可解释、不再出现两份研发组）
    const tech = findDept(tree, '技术部');
    expect(tech).toBeDefined();
    expect(tech!.children.map((c) => c.name).sort()).toEqual(['研发组', '测试组'].sort());
    expect(tech!.children.filter((c) => c.name === '研发组')).toHaveLength(1);

    // 一级部门正常、无脏名/undefined
    expect(tree.map((d) => d.name).sort()).toEqual(['人力资源部', '技术部'].sort());
    expect(tree.every((d) => typeof d.name === 'string' && d.name.length > 0)).toBe(true);

    // 异常行（整行空白）会在读取层被识别为结构异常或空，而不是静默透传
    const brokenAoa = [['', ''], ['', '']];
    const brokenBuf = buildWorkbookBytes(brokenAoa);
    await expect(parseExcelFromBuffer(brokenBuf)).rejects.toBeInstanceOf(Error);
  });

  it('SEC-6 扩展名护栏：非 .xlsx/.xls → unsupported-type；.xls 仍可', async () => {
    const buf = buildWorkbookBytes([['姓名', '一级部门'], ['张三', '技术部']]);

    await expect(parseEmployeeExcel(new File([buf], '员工.csv') as File))
      .rejects.toMatchObject({ kind: 'unsupported-type' });
    await expect(parseEmployeeExcel(new File([buf], '员工.txt') as File))
      .rejects.toMatchObject({ kind: 'unsupported-type' });

    // .xls 扩展名被允许，内容仍可解析
    const xlsFile = new File([buf], '员工.xls');
    const { employees } = await parseEmployeeExcel(xlsFile as File);
    expect(employees[0].name).toBe('张三');
  });

  it('SEC-7 回归一致性：同一份样例经 parseExcelFromBuffer → 字段映射与升级前一致', async () => {
    const aoa = [
      ['姓名', '工号', '职级', '岗位', '一级部门', '二级部门', '三级部门'],
      ['张三', 'E001', 'L3.2', '前端工程师', '技术部', '研发组', '前端组'],
      ['李四', 'E002', 'L2.1', '', '技术部', '研发组', '前端组'],
      ['王五', 'E003', '', '经理', '技术部', '研发组', ''],
      ['赵六', 'E004', 'L4.2', '', '', '', ''],
    ];
    const buf = buildWorkbookBytes(aoa);
    const rows = await parseExcelFromBuffer(buf);
    const emps = mapEmployeeRows(rows);

    expect(emps).toHaveLength(4);
    expect(emps[0]).toMatchObject({
      name: '张三',
      employeeId: 'E001',
      level: 'L3.2',
      title: '前端工程师',
      dept1: '技术部',
      dept2: '研发组',
      dept3: '前端组',
    });
    // 空职级 → NA（数据侧哨兵值不变）；空岗位 → 不再落 'NA'（v2.3.2：空 = 不显示 + 不套岗）
    expect(emps[1].title).toBeUndefined();
    expect(emps[2]).toMatchObject({ level: 'NA', title: '经理' });
    // 无部门列 → 空字符串（不产生 undefined 脏值）
    expect(emps[3]).toMatchObject({ dept1: '', dept2: '', dept3: '' });

    // 组织模板也回归一致
    const orgBuf = buildWorkbookBytes([
      ['一级部门', '二级部门', '部门级别'],
      ['技术部', '研发组', '2'],
    ]);
    const orgRows = await parseExcelFromBuffer(orgBuf);
    const orgs = mapOrgTemplateRows(orgRows);
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toMatchObject({ dept1: '技术部', dept2: '研发组', deptLevel: '2' });
  });
});

describe('Excel 导入校验工具', () => {
  it('常量导出正确', () => {
    expect(MAX_IMPORT_FILE_BYTES).toBe(50 * 1024 * 1024);
    expect(WARN_IMPORT_FILE_BYTES).toBe(10 * 1024 * 1024);
    expect(WARN_IMPORT_FILE_BYTES).toBeLessThan(MAX_IMPORT_FILE_BYTES);
    expect(MAX_IMPORT_ROWS).toBe(50000);
    expect(SUPPORTED_EXCEL_EXTENSIONS).toEqual(['.xlsx', '.xls']);
  });

  it('getExcelFileExtension 解析扩展名（小写、含点、处理后缀）', () => {
    expect(getExcelFileExtension('员工.XLSX')).toBe('.xlsx');
    expect(getExcelFileExtension('a.b.xls')).toBe('.xls');
    expect(getExcelFileExtension('noext')).toBe('');
    expect(getExcelFileExtension('')).toBe('');
  });

  it('validateImportFile 对大小/扩展名做轻量校验', () => {
    expect(validateImportFile({ name: '员工.xlsx', size: 100 })).toEqual({ ok: true });
    expect(validateImportFile({ name: '员工.xls', size: 100 })).toEqual({ ok: true });

    const badExt = validateImportFile({ name: '员工.csv', size: 100 });
    expect(badExt.ok).toBe(false);
    if (!badExt.ok) expect(badExt.error.kind).toBe('unsupported-type');

    const big = validateImportFile({ name: '员工.xlsx', size: MAX_IMPORT_FILE_BYTES + 1 });
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.error.kind).toBe('size-exceeded');
  });

  it('getImportErrorMessage 返回可行动中文（ExcelImportError 用其 message，其它兜底）', async () => {
    const buf = buildWorkbookBytes([['工号'], ['E001']]);
    const file = new File([buf], '员工.xlsx');
    const err = await parseEmployeeExcel(file).catch((e) => e);
    expect(getImportErrorMessage(err)).toContain('缺少必填列');

    const generic = new Error('boom');
    expect(getImportErrorMessage(generic)).toBe('导入失败，请检查文件后重试');
    expect(getImportErrorMessage(undefined)).toBe('导入失败，请检查文件后重试');
  });
});

describe('岗位表 sheet 结构校验（SEC-8..9）', () => {
  it('SEC-8 缺必填列「岗位名称」→ missing-columns', async () => {
    const aoa = [['一级部门', '编制数'], ['技术部', '2']];
    const buf = buildWorkbookBytes(aoa);
    const file = new File([buf], '岗位表.xlsx');
    await expect(parsePositionExcel(file)).rejects.toMatchObject({
      kind: 'missing-columns',
      missingColumns: ['岗位名称'],
    });
  });

  it('SEC-9 空表/仅表头无数据 → empty，不静默生成', async () => {
    const buf = buildWorkbookBytes([['岗位名称', '一级部门']]); // 仅表头
    const file = new File([buf], '岗位表.xlsx');
    await expect(parsePositionExcel(file)).rejects.toMatchObject({ kind: 'empty' });
  });
});
