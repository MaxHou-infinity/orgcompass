import { Employee, Department, OrgTemplate, Position, CompetencyModel } from '../types';
import type { WorkBook } from 'xlsx';
import { uid } from './project';

/** 懒加载 xlsx（体积 ~400KB，仅在上传/导出时按需加载） */
let xlsxModule: typeof import('xlsx') | null = null;
async function loadXlsx(): Promise<typeof import('xlsx')> {
  if (!xlsxModule) {
    xlsxModule = await import('xlsx');
  }
  return xlsxModule;
}

// ───────────────────────── 导入输入加固常量 ─────────────────────────

/** 单个导入文件的硬上限（字节）。超过则拒绝导入。 */
export const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024; // 50MB
/** 单个导入文件的软提醒阈值（字节）。超过但未达硬上限时，可提示用户拆分。 */
export const WARN_IMPORT_FILE_BYTES = 10 * 1024 * 1024; // 10MB
/** 单个工作表最多导入的**数据行**数（不含表头）。防超大表拖垮内存/渲染；超过即拒绝，不静默截断。 */
export const MAX_IMPORT_ROWS = 50000;
/** 支持的 Excel 文件扩展名。 */
export const SUPPORTED_EXCEL_EXTENSIONS = ['.xlsx', '.xls'] as const;

// ───────────────────────── 导入错误类型 ─────────────────────────

export type ExcelImportErrorKind =
  | 'size-exceeded'
  | 'unsupported-type'
  | 'empty'
  | 'missing-columns'
  | 'invalid-structure'
  | 'parse-failed';

const IMPORT_ERROR_MESSAGES: Record<ExcelImportErrorKind, string> = {
  'size-exceeded': `文件超过 ${MAX_IMPORT_FILE_BYTES / 1048576}MB，请拆分为多个文件后导入`,
  'unsupported-type': '不支持的文件类型，请另存为 .xlsx 或 .xls 后导入',
  'empty': '文件中没有有效的表头或数据行，请使用示例模板整理后再导入',
  'missing-columns': '文件缺少必填列，请对照示例模板检查表头',
  'invalid-structure': '文件结构异常，请使用示例模板整理表格后再导入',
  'parse-failed': '文件解析失败，请确认文件为有效的 Excel 文件',
};

/**
 * 导入错误：带 `kind` 便于上层分支处理，`message` 为中文可行动提示。
 * - kind === 'missing-columns' 时附带 `missingColumns`（缺失的必填列名）。
 */
export class ExcelImportError extends Error {
  readonly kind: ExcelImportErrorKind;
  readonly missingColumns?: string[];

  constructor(kind: ExcelImportErrorKind, message?: string, missingColumns?: string[]) {
    if (missingColumns && missingColumns.length > 0) {
      super(`缺少必填列：${missingColumns.join('、')}，请对照示例模板补充表头后导入`);
      this.kind = 'missing-columns';
      this.missingColumns = missingColumns;
    } else {
      super(message ?? IMPORT_ERROR_MESSAGES[kind]);
      this.kind = kind;
    }
    this.name = 'ExcelImportError';
  }
}

/** 提取文件扩展名（小写，含点，如 '.xlsx'；无扩展名返回 ''） */
export function getExcelFileExtension(fileName: string): string {
  const trimmed = (fileName ?? '').trim();
  const match = /\.[^.]+$/.exec(trimmed);
  return match ? match[0].toLowerCase() : '';
}

function isSupportedExtension(ext: string): boolean {
  return (SUPPORTED_EXCEL_EXTENSIONS as readonly string[]).includes(ext);
}

/** employee 工作表必填列；org 模板工作表必填列；岗位表工作表必填列 */
const REQUIRED_EMPLOYEE_COLUMNS = ['姓名'];
const REQUIRED_ORG_COLUMNS = ['一级部门'];
const REQUIRED_POSITION_COLUMNS = ['岗位名称'];

/**
 * v2.3.2：岗位列合并为**一列**。
 *
 * 变更前是两列各管一摊，语义完全不同却看着像重复字段（样例模板还填了相同的值）：
 * - `岗位`（兼容旧名 `职位`）→ `Employee.title`，**纯展示文本**，空则硬编码落 'NA'（画布真的显示 "NA"）；
 * - `岗位名称` → 瞬态 `_positionName`，在所属部门 find-or-create 一条 `Position` 实体并套岗。
 *
 * 合并后**一个值同时驱动两件事**：卡片上的岗位文字 + 该部门的岗位实体。
 * 读取优先级 `岗位` → `岗位名称` → `职位`（模板导出只用 `岗位`，旧文件仍可导入）。
 * 若同一行两列都填且取值不同，取 `岗位` 为准并计数，由调用方向用户提示（不静默丢弃）。
 */
export const POSITION_COLUMN = '岗位';
const POSITION_COLUMN_ALIASES = ['岗位', '岗位名称', '职位'] as const;

/**
 * 读取一行里的岗位值。返回 `value`（首个非空别名）与 `conflict`（两列都非空且不一致）。
 * 单列文件（新模板）永远 conflict=false，零额外成本。
 */
export function readPositionCell(row: Record<string, unknown>): { value: string; conflict: boolean } {
  const values = POSITION_COLUMN_ALIASES.map((key) => cellString(row[key]).trim());
  const first = values.find((v) => Boolean(v)) ?? '';
  const distinct = new Set(values.filter((v) => Boolean(v)));
  return { value: first, conflict: distinct.size > 1 };
}


/**
 * 员工导入行（扩展自 Employee，携带导入侧独有的瞬态字段，用于：
 * - find-or-create 岗位（`_positionName` 不在 Employee 持久字段内）
 * - 直接上级按姓名兜底匹配（`_reportsToName`）
 * 这些 `_` 前缀字段仅存在于导入内存态，不会写入持久化。
 */
interface EmployeeImportRow extends Employee {
  _positionName?: string;
  _reportsToId?: string;
  _reportsToName?: string;
}

/** 岗位表导入行（解析自独立「岗位表」sheet，落地为 Position 前的中间结构）。 */
export interface PositionImportRow {
  /** 部门路径（一级~六级，按顺序）；用于解析到具体 Department */
  deptPath: string[];
  /** 岗位名称（必填） */
  name: string;
  /** 岗位序列（jobFamily，如 技术/产品/设计/职能/管理/销售/运营） */
  jobFamily?: string;
  /** 职级带宽下限（fullCode） */
  levelBandMin?: string;
  /** 职级带宽上限（fullCode） */
  levelBandMax?: string;
  /** 编制数（>=0） */
  headcount: number;
}

/** 将单元格值安全转换为数字；空/非有限数返回 undefined（不落 0）。 */
function cellNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const str = String(value).trim();
  if (str === '' || str === 'undefined') return undefined;
  const n = Number(str);
  return Number.isFinite(n) ? n : undefined;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Excel 日期序列号 → 自然日 `YYYY-MM-DD`。epoch = 1899-12-30（补偿 Excel 的 1900 闰年 bug，序列号 ≥ 61 时正确）。 */
function excelSerialToDay(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const days = Math.floor(serial);
  const d = new Date(Date.UTC(1899, 11, 30) + days * 86400000);
  const y = d.getUTCFullYear();
  if (y < 1900 || y > 2100) return null;
  return `${y}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * 「评估日期」单元格 → 规范化的自然日 `YYYY-MM-DD`（v2.3.1 F-07 新增）。
 *
 * 背景：`XLSX.read` 未开启 `cellDates`，日期格式单元格经 `sheet_to_json` 返回的是**序列号**
 * （如 2026-09-16 → 46281）。旧实现直接把它拼成 `${value}T12:00:00` 再 `toISOString()`，
 * 于是 `new Date("46281T12:00:00")` 抛 `RangeError: Invalid time value` ——
 * 而「在 Excel 里直接键入 2026-09-16」默认就是日期单元格，即最自然的用户操作必然整批导入失败。
 *
 * 支持：Excel 序列号（数字或数字文本）、Date 实例、`YYYY-M-D` / `YYYY/M/D` / `YYYY.M.D` /
 * `YYYY年M月D日`、以及 ISO 日期时间。无法解析返回 undefined，由调用方带行号报错（不静默吞）。
 */
export function cellDateString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined;
    return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
  }
  if (typeof value === 'number') return excelSerialToDay(value) ?? undefined;
  const raw = String(value).trim();
  if (raw === '' || raw === 'undefined') return undefined;
  // 纯数字文本 = Excel 序列号（日期列的 raw 值被字符串化）
  if (/^\d+(\.\d+)?$/.test(raw)) return excelSerialToDay(Number(raw)) ?? undefined;
  // ISO 日期时间（含 Date 对象被序列化后的形态）
  const iso = /^(\d{4})-(\d{2})-(\d{2})T/.exec(raw);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // YYYY-M-D / YYYY/M/D / YYYY.M.D / YYYY年M月D日（允许不补零）
  const ymd = /^(\d{4})\s*[-/.\u5e74]\s*(\d{1,2})\s*[-/.\u6708]\s*(\d{1,2})\s*\u65e5?$/.exec(raw);
  if (ymd) {
    const y = Number(ymd[1]);
    const m = Number(ymd[2]);
    const d = Number(ymd[3]);
    if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
    const probe = new Date(Date.UTC(y, m - 1, d));
    // 拒绝 2026-02-31 这类溢出日期（Date 会自动进位）
    if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return undefined;
    return `${y}-${pad2(m)}-${pad2(d)}`;
  }
  return undefined;
}

/** 判断岗位表「同名岗位去重」是否冲突：同一部门重复出现同名岗位 → 报错（不静默吞）。 */
function assertNoDuplicatePositions(rows: PositionImportRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.deptPath.join('/')}::${row.name}`;
    if (seen.has(key)) {
      throw new ExcelImportError(
        'invalid-structure',
        `岗位表存在同名岗位：部门「${row.deptPath.join('/') || '（未指定部门）'}」下「${row.name}」重复，请去重后重新导入`,
      );
    }
    seen.add(key);
  }
}

// ───────────────────────── 读取与解析 ─────────────────────────

/**
 * 从内存 buffer 读取第一个工作表并转为 JSON 行。
 * 测试可直接复用，避免依赖浏览器 FileReader。
 */
export async function parseExcelFromBuffer(buffer: ArrayBuffer | Uint8Array): Promise<Record<string, unknown>[]> {
  const XLSX = await loadXlsx();
  return sheetToRows(XLSX, readWorkbook(XLSX, buffer));
}

function readWorkbook(XLSX: typeof import('xlsx'), buffer: ArrayBuffer | Uint8Array): WorkBook {
  try {
    // v2.3.1（F-10）：多读 2 行（表头 + 1 行探测）用于**探测溢出**。
    // 旧实现读满 MAX_IMPORT_ROWS 行即静默截断（60001 行只导入 49999 行且无任何提示），
    // 用户会以为数据完整，人数/编制/健康度随之失真。宁可拒绝，也不静默丢数据。
    return XLSX.read(buffer, { type: 'array', dense: true, sheetRows: MAX_IMPORT_ROWS + 2 });
  } catch {
    throw new ExcelImportError('parse-failed', IMPORT_ERROR_MESSAGES['parse-failed']);
  }
}

function sheetToRows(XLSX: typeof import('xlsx'), workbook: WorkBook): Record<string, unknown>[] {
  const firstSheetName = workbook?.SheetNames?.[0];
  const firstSheet = firstSheetName ? workbook.Sheets?.[firstSheetName] : undefined;
  if (!firstSheet) {
    throw new ExcelImportError('empty', IMPORT_ERROR_MESSAGES['empty']);
  }
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(firstSheet);
  // v2.3.1（F-10）：触及上限即为「被截断」，显式报错而不是把半份数据当成全部。
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new ExcelImportError(
      'invalid-structure',
      `文件数据超过 ${MAX_IMPORT_ROWS} 行上限（已检测到更多行），为避免静默丢失数据已拒绝导入；请按部门/批次拆分为多个文件后导入`,
    );
  }  // 结构异常：sheet 存在但表头为空/非有效列名（SheetJS 会生成 ''、'__N' 之类的占位 key），
  // 无法据此做字段映射，应视为结构异常而非静默透传。
  const hasMeaningfulColumn = rows.some((row) =>
    Object.keys(row).some((key) => key.trim() !== '' && !/^_[0-9]+$/.test(key)),
  );
  if (rows.length > 0 && !hasMeaningfulColumn) {
    throw new ExcelImportError('invalid-structure', IMPORT_ERROR_MESSAGES['invalid-structure']);
  }
  return rows;
}

/** File → ArrayBuffer（浏览器走 FileReader；Node/测试环境用 Blob.arrayBuffer()） */
async function readFileBuffer(file: File): Promise<ArrayBuffer> {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(file);
    });
  }
  return file.arrayBuffer();
}

/** 大小/扩展名护栏 + 读取 + 必填列校验，返回 JSON 行 */
async function readAndValidateFile(file: File, requiredColumns: string[]): Promise<Record<string, unknown>[]> {
  const ext = getExcelFileExtension(file.name);
  if (!isSupportedExtension(ext)) {
    throw new ExcelImportError('unsupported-type', IMPORT_ERROR_MESSAGES['unsupported-type']);
  }
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    throw new ExcelImportError('size-exceeded', IMPORT_ERROR_MESSAGES['size-exceeded']);
  }
  const buffer = await readFileBuffer(file);
  const rows = await parseExcelFromBuffer(buffer);
  assertRequiredColumns(rows, requiredColumns);
  return rows;
}

function assertRequiredColumns(rows: Record<string, unknown>[], requiredColumns: string[]): void {
  if (rows.length === 0) {
    throw new ExcelImportError('empty', IMPORT_ERROR_MESSAGES['empty']);
  }
  const present = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) present.add(key);
  }
  const missing = requiredColumns.filter((col) => !present.has(col));
  if (missing.length > 0) {
    throw new ExcelImportError('missing-columns', IMPORT_ERROR_MESSAGES['missing-columns'], missing);
  }
}

/**
 * UI 在解析前做一次轻量文件校验（大小 + 扩展名），避免直接进入读取流程。
 */
export function validateImportFile(file: { name: string; size: number }): { ok: true } | { ok: false; error: ExcelImportError } {
  const ext = getExcelFileExtension(file.name);
  if (!isSupportedExtension(ext)) {
    return { ok: false, error: new ExcelImportError('unsupported-type', IMPORT_ERROR_MESSAGES['unsupported-type']) };
  }
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    return { ok: false, error: new ExcelImportError('size-exceeded', IMPORT_ERROR_MESSAGES['size-exceeded']) };
  }
  return { ok: true };
}

/** 将任意错误转换为对用户友好的中文提示（复用 ExcelImportError.message，其余兜底）。 */
export function getImportErrorMessage(error: unknown): string {
  if (error instanceof ExcelImportError) {
    return error.message;
  }
  return '导入失败，请检查文件后重试';
}

/** 将单元格值安全转换为字符串，过滤空值/'undefined' */
function cellString(value: unknown): string {
  const str = String(value ?? '');
  return str === 'undefined' ? '' : str;
}

// ───────────────────────── 行 → 领域对象映射 ─────────────────────────

/** 员工行 → 员工对象（独立导出，测试可复用；字段映射与升级前完全一致，v2.1.1 增富字段） */
export function mapEmployeeRows(rows: Record<string, unknown>[]): Employee[] {
  return rows.map((row, index) => {
    const position = readPositionCell(row).value;
    const emp: EmployeeImportRow = {
      id: `emp-${index}-${Date.now()}`,
      name: cellString(row['姓名']).trim(),
      employeeId: cellString(row['工号']).trim(),
      level: cellString(row['职级']).trim() || 'NA',
      // v2.3.2：岗位列合并为一列。空值**不再落 'NA'** —— 原来会在画布上真的渲染出 "NA"，
      // 把「用户没填」显示成「岗位叫 NA」。空 = 不显示 + 不套岗。
      title: position,
      dept1: cellString(row['一级部门']).trim(),
      dept2: cellString(row['二级部门']).trim(),
      dept3: cellString(row['三级部门']).trim(),
      dept4: cellString(row['四级部门']).trim(),
      dept5: cellString(row['五级部门']).trim(),
      dept6: cellString(row['六级部门']).trim(),
    };
    if (!emp.title) delete emp.title;
    // ── v2.1.1 富字段（可选列，缺省降级为 undefined，不填 0）──
    // 个人成本
    const cost = cellNumber(row['个人成本']);
    if (cost !== undefined) emp.cost = cost;
    // 目标职级
    const targetLevel = cellString(row['目标职级']).trim();
    if (targetLevel) emp.targetLevel = targetLevel;
    // 直接上级：先在行内留存工号/姓名，待全量员工已知后统一解析为内部 id（见 resolveReportsToEmployeeIds）
    const reportsToId = cellString(row['直接上级工号']).trim();
    const reportsToName = cellString(row['直接上级']).trim();
    emp._reportsToId = reportsToId || undefined;
    emp._reportsToName = reportsToName || undefined;
    // 岗位（v2.3.2 合并列：find-or-create 岗位 + 卡片展示文字，同一来源；非持久字段）
    emp._positionName = position || undefined;
    return emp;
  });
}

/**
 * v2.3.2：统计「岗位」「岗位名称」两列同时填写且取值不一致的行数。
 *
 * 合并后一列只有一个值，冲突行必须按 `岗位` 为准；但**不静默**——
 * 交给 UI 提示「N 行两列取值不一致，已按『岗位』为准」，让用户能自查表格。
 */
export function countPositionConflicts(rows: Record<string, unknown>[]): number {
  let conflicts = 0;
  for (const row of rows) if (readPositionCell(row).conflict) conflicts++;
  return conflicts;
}

/**
 * 把「直接上级」解析为 reportsToEmployeeId（统一指向被汇报人的内部 id）。
 * - 优先按「直接上级工号」（employeeId）匹配，兜底「直接上级姓名」；
 * - 两者都按本批导入的员工 id 解析；工号/姓名均无法命中时，若提供了工号则保留字面值（避免丢引用），否则 undefined。
 */
export function resolveReportsToEmployeeIds(employees: Employee[]): Employee[] {
  const byEmployeeId = new Map<string, string>(); // employeeId -> id
  const byName = new Map<string, string>(); // name -> id（同名取首个，不静默）
  for (const e of employees) {
    if (e.employeeId) byEmployeeId.set(e.employeeId, e.id);
    if (e.name && !byName.has(e.name)) byName.set(e.name, e.id);
  }
  return employees.map((e) => {
    const row = e as EmployeeImportRow;
    if (e.reportsToEmployeeId) return e; // 已显式设置则不覆盖
    const byId = row._reportsToId ? byEmployeeId.get(row._reportsToId) : undefined;
    const resolved = byId ?? (row._reportsToName ? byName.get(row._reportsToName) : undefined);
    if (resolved) return { ...e, reportsToEmployeeId: resolved };
    // 工号提供了但未在批次内命中 → 保留字面工号作为悬空引用（不丢信息）
    if (row._reportsToId) return { ...e, reportsToEmployeeId: row._reportsToId };
    return e;
  });
}

/** 组织模板行 → OrgTemplate 对象（独立导出，测试可复用） */
export function mapOrgTemplateRows(rows: Record<string, unknown>[]): OrgTemplate[] {
  return rows.map((row) => ({
    dept1: cellString(row['一级部门']).trim(),
    dept2: cellString(row['二级部门']).trim(),
    dept3: cellString(row['三级部门']).trim(),
    dept4: cellString(row['四级部门']).trim(),
    dept5: cellString(row['五级部门']).trim(),
    dept6: cellString(row['六级部门']).trim(),
    deptLevel: cellString(row['部门级别']).trim(),
    leaderId: cellString(row['部门负责人工号']).trim(),
    leaderName: cellString(row['部门负责人']).trim(),
  }));
}

// ───────────────────────── 导入入口 ─────────────────────────

/**
 * 员工表导入结果（v2.3.2）。
 * 除员工本身外，带回**导入侧诊断**供 UI 一次性说清「发生了什么」，而不是静默继续：
 * - `positionConflicts`：两列岗位写法并存且取值不一致的行数（已按「岗位」为准）；
 * - `blankNameRows`：姓名为空的行数（仍会生成卡片，但用户应当知道）。
 */
export interface EmployeeImportResult {
  employees: Employee[];
  positionConflicts: number;
  blankNameRows: number;
}

export async function parseEmployeeExcel(file: File): Promise<EmployeeImportResult> {
  const rows = await readAndValidateFile(file, REQUIRED_EMPLOYEE_COLUMNS);
  const employees = resolveReportsToEmployeeIds(mapEmployeeRows(rows));
  return {
    employees,
    positionConflicts: countPositionConflicts(rows),
    blankNameRows: employees.filter((e) => !e.name).length,
  };
}

export async function parseOrgTemplateExcel(file: File): Promise<OrgTemplate[]> {
  const rows = await readAndValidateFile(file, REQUIRED_ORG_COLUMNS);
  return mapOrgTemplateRows(rows);
}

/** 岗位表行 → PositionImportRow（独立导出，测试可复用；含同名岗位去重冲突校验） */
export function mapPositionRows(rows: Record<string, unknown>[]): PositionImportRow[] {
  const out: PositionImportRow[] = [];
  for (const row of rows) {
    const name = cellString(row['岗位名称']);
    if (!name) continue; // 无岗位名的行不落地
    const deptPath = [
      cellString(row['一级部门']),
      cellString(row['二级部门']),
      cellString(row['三级部门']),
      cellString(row['四级部门']),
      cellString(row['五级部门']),
      cellString(row['六级部门']),
    ].filter((n) => Boolean(n));
    out.push({
      deptPath,
      name,
      jobFamily: cellString(row['序列']) || undefined,
      levelBandMin: cellString(row['职级带宽下限']) || undefined,
      levelBandMax: cellString(row['职级带宽上限']) || undefined,
      headcount: cellNumber(row['编制数']) ?? 0,
    });
  }
  assertNoDuplicatePositions(out);
  return out;
}

/** 解析「岗位表」独立 sheet（进阶）：必填列=岗位名称；产出 PositionImportRow[] */
export async function parsePositionExcel(file: File): Promise<PositionImportRow[]> {
  const rows = await readAndValidateFile(file, REQUIRED_POSITION_COLUMNS);
  return mapPositionRows(rows);
}

// ───────────────────────── v2.2.0 胜任度评分导入 ─────────────────────────

/** 评分导入行（一条 = 员工 × 各维度分；employeeKey 为导入侧员工标识，UI 层再解析为内部 employeeId） */
export interface AssessmentImportRow {
  /** 员工标识：工号优先，缺省回退姓名（导入侧键，UI 层解析到 Employee.id） */
  employeeKey: string;
  /** 保留标识来源，禁止工号与姓名共享一个索引。 */
  employeeKeyType?: 'employeeId' | 'name';
  /** 维度分：dimension key → 1..5 整数（只含已填维度；未评维度不出现） */
  scores: Record<string, number>;
  /** 评分人（批次级人工字段，可追溯） */
  assessorName?: string;
  /** 评估日期（用户原样字符串；落库时由 UI 层归一为 ISO） */
  assessedAt?: string;
  /** 备注/评分依据（行为锚点引用，可追溯） */
  note?: string;
}

/** 评分表非维度元数据列（模板与解析共用白名单；其余列一律视为未知维度列报错，不静默吞） */
const ASSESSMENT_META_COLUMNS = ['工号', '姓名', '评分人', '评估日期', '备注'] as const;

/**
 * 评分行 → AssessmentImportRow（独立导出，测试可复用）。
 * - 维度列 = model 中 enabled 维度的 label → key 映射；未启用维度不参与（软删维度历史走详情，不进导入）。
 * - 员工标识「工号」或「姓名」至少其一，否则该行报错。
 * - 维度分非 1..5 整数 / 未知维度列 → 抛 ExcelImportError（kind='invalid-structure'），报错不静默。
 */
export function mapAssessmentRows(
  rows: Record<string, unknown>[],
  model: CompetencyModel,
): AssessmentImportRow[] {
  const enabledDims = model.dimensions.filter((d) => d.enabled);
  const labelToKey = new Map(enabledDims.map((d) => [d.label, d.key]));
  const knownColumns = new Set<string>([...ASSESSMENT_META_COLUMNS, ...labelToKey.keys()]);

  return rows.map((row, index) => {
    const line = index + 2; // 表头在第 1 行，数据从第 2 行起
    // 未知列（既非元数据列也非已启用维度列）→ 报错不静默（防维度名拼错/结构漂移被静默吞掉）
    for (const key of Object.keys(row)) {
      if (!knownColumns.has(key)) {
        const dimHint = enabledDims.length > 0 ? `；已启用维度列为：${enabledDims.map((d) => d.label).join('、')}` : '';
        throw new ExcelImportError(
          'invalid-structure',
          `评分表第 1 行存在未知列「${key}」：必须是工号/姓名/评分人/评估日期/备注或已启用维度列${dimHint}，请对照示例模板整理后再导入`,
        );
      }
    }
    const employeeNumber = cellString(row['工号']).trim();
    const employeeKey = employeeNumber || cellString(row['姓名']).trim();
    if (!employeeKey) {
      throw new ExcelImportError(
        'invalid-structure',
        `评分表第 ${line} 行缺少员工标识：工号与姓名均为空，请补充后再导入`,
      );
    }
    const scores: Record<string, number> = {};
    for (const dim of enabledDims) {
      const raw = row[dim.label];
      if (raw === null || raw === undefined || String(raw).trim() === '') continue; // 未评 = 显式留空跳过
      const value = cellNumber(raw);
      if (value === undefined || !Number.isInteger(value) || value < 1 || value > 5) {
        throw new ExcelImportError(
          'invalid-structure',
          `评分表第 ${line} 行「${employeeKey}」的「${dim.label}」分数为「${String(raw)}」，必须是 1–5 整数（未评请留空）`,
        );
      }
      scores[dim.key] = value;
    }
    const out: AssessmentImportRow = { employeeKey, employeeKeyType: employeeNumber ? 'employeeId' : 'name', scores };
    const assessorName = cellString(row['评分人']);
    if (assessorName) out.assessorName = assessorName;
    // v2.3.1（F-07）：日期列必须容错解析（序列号 / Date / 多种文本），
    // 非空但无法解析 → 带行号报错，不再让 RangeError 把整批导入打成「导入失败」。
    const rawDate = row['评估日期'];
    if (rawDate !== null && rawDate !== undefined && String(rawDate).trim() !== '') {
      const day = cellDateString(rawDate);
      if (!day) {
        throw new ExcelImportError(
          'invalid-structure',
          `评分表第 ${line} 行「${employeeKey}」的「评估日期」为「${String(rawDate)}」，无法识别为日期；请使用 2026-09-16 这类格式（或留空按导入时点记录）`,
        );
      }
      out.assessedAt = day;
    }
    const note = cellString(row['备注']);
    if (note) out.note = note;
    return out;
  });
}

/** 整批身份检查，全部唯一匹配才返回；不回退到同名第一人。 */
export function resolveAssessmentEmployees(rows: AssessmentImportRow[], employees: Employee[]): Employee[] {
  const byNumber = new Map<string, Employee[]>();
  const byName = new Map<string, Employee[]>();
  const byInternalId = new Map<string, number>();
  for (const e of employees) {
    if (e.isVirtual) continue;
    byInternalId.set(e.id, (byInternalId.get(e.id) ?? 0) + 1);
    for (const [map, value] of [[byNumber, e.employeeId], [byName, e.name]] as const) {
      const k = value?.trim();
      if (k) map.set(k, [...(map.get(k) ?? []), e]);
    }
  }
  const seen = new Set<string>();
  return rows.map((row, i) => {
    const index = row.employeeKeyType === 'name' ? byName : byNumber;
    const matches = index.get(row.employeeKey.trim()) ?? [];
    if (matches.length !== 1 || byInternalId.get(matches[0].id) !== 1) throw new ExcelImportError('invalid-structure',
      `评分表第 ${i + 2} 行「${row.employeeKey}」${matches.length ? '存在身份歧义，请使用唯一工号' : '未找到对应员工'}；本批未写入`);
    for (const dim of Object.keys(row.scores)) {
      const k = JSON.stringify([matches[0].id, dim, row.assessedAt ?? '']);
      if (seen.has(k)) throw new ExcelImportError('invalid-structure', `评分表第 ${i + 2} 行存在同人同维度同日期的重复评分；请核对后导入，本批未写入`);
      seen.add(k);
    }
    return matches[0];
  });
}

/** 评分导入必填元数据列（员工标识「工号/姓名」至少其一 + 维度列在 parseAssessmentExcel 内动态校验） */
const REQUIRED_ASSESSMENT_COLUMNS = ['评分人', '评估日期'] as const;

/**
 * 解析胜任度评分 Excel：必填列 = 员工标识「工号/姓名」至少其一 + 当前 model enabled 维度列（label 表头）+ 评分人 + 评估日期。
 * 复用 readAndValidateFile/loadXlsx/cellNumber/cellString/ExcelImportError/文件护栏常量。
 */
export async function parseAssessmentExcel(
  file: File,
  model: CompetencyModel,
): Promise<AssessmentImportRow[]> {
  const enabledLabels = model.dimensions.filter((d) => d.enabled).map((d) => d.label);
  const rows = await readAndValidateFile(file, [...REQUIRED_ASSESSMENT_COLUMNS, ...enabledLabels]);
  // 员工标识「工号/姓名」至少其一：两者都缺 → missing-columns（带缺失列名，可行动提示）
  const present = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) present.add(key);
  }
  const missingIdentifiers = ['工号', '姓名'].filter((col) => !present.has(col));
  if (missingIdentifiers.length === 2) {
    throw new ExcelImportError('missing-columns', IMPORT_ERROR_MESSAGES['missing-columns'], ['工号', '姓名']);
  }
  return mapAssessmentRows(rows, model);
}

/** 递归收集全树所有直属岗位（扁平镜像，供 Scenario.positions / analytics 用）。 */
export function collectAllPositions(depts: Department[]): Position[] {
  let acc: Position[] = [];
  for (const d of depts) {
    acc = acc.concat(d.positions ?? []);
    acc = acc.concat(collectAllPositions(d.children));
  }
  return acc;
}

// ───────────────────────── 部门树构建 / 组织模板补充层（v2.3.2） ─────────────────────────

/** 部门去重键：**层级 + 名称**（沿用既有口径：同名同层级复用同一节点，避免同一部门出现两个节点）。 */
const deptKey = (level: number, name: string) => `${level}-${name}`;

interface DeptRegistry {
  /** (层级-名称) → 部门 */
  byKey: Map<string, Department>;
  /** 部门 id → 部门 */
  byId: Map<string, Department>;
}

/**
 * 员工行 / 组织模板行的「一~六级部门」单元格 → 「声明层级 + 名称」序列。
 *
 * v2.3.2 关键修复：**列位置即声明层级，留空不压缩**。
 * 旧实现把非空单元格按 1、2、3… 顺次编号，于是「一级=技术部、二级=空、三级=前端组」
 * 被压成 技术部 > 前端组(L2)；而组织架构模板同一行仍按 L3 建节点 → 同一部门出现两个节点
 * （一个装着人、一个空着）。改为按列位置声明层级后，两侧的 deptKey 一致，重复节点自然消失，
 * 且「向上无归属」这件事可以被如实识别出来（见 deptLevel.ts 的断档判定）。
 */
export function declaredDeptCells(source: {
  dept1?: string; dept2?: string; dept3?: string; dept4?: string; dept5?: string; dept6?: string;
}): { level: number; name: string }[] {
  return [source.dept1, source.dept2, source.dept3, source.dept4, source.dept5, source.dept6]
    .map((raw, idx) => ({ level: idx + 1, name: cellString(raw).trim() }))
    .filter((c) => Boolean(c.name) && c.name !== 'undefined');
}

/** 获取或创建部门节点。已存在的节点**不重复创建、也不被重新挂父**（沿用既有口径）。 */
function ensureDept(
  reg: DeptRegistry,
  name: string,
  level: number,
  parentId: string | undefined,
): { dept: Department; created: boolean } {
  const key = deptKey(level, name);
  const existing = reg.byKey.get(key);
  if (existing) return { dept: existing, created: false };
  const dept: Department = {
    id: uid('dept'), name, level, parentId,
    children: [], employees: [], expanded: level <= 3, positions: [],
  };
  reg.byKey.set(key, dept);
  reg.byId.set(dept.id, dept);
  return { dept, created: true };
}

/** 用各节点的 parentId 重建 children 与根列表（幂等；新增节点后调用一次）。父节点缺失 → 提升为根，不丢节点。 */
function relinkTree(reg: DeptRegistry): Department[] {
  for (const d of reg.byId.values()) d.children = [];
  const roots: Department[] = [];
  for (const d of reg.byId.values()) {
    const parent = d.parentId ? reg.byId.get(d.parentId) : undefined;
    if (parent) parent.children.push(d);
    else roots.push(d);
  }
  return roots;
}

/** 递归按中文名称排序子部门（原地，返回同一数组）。 */
function sortDeptTree(depts: Department[]): Department[] {
  depts.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  for (const d of depts) sortDeptTree(d.children);
  return depts;
}

/** 组织模板补充层的应用报告（供 UI 说清「这次补充层实际做了什么」，不静默）。 */
export interface OrgTemplateApplyReport {
  /** 本次新增出来的部门名称路径 */
  addedPaths: string[];
  /** 被写入负责人的部门 id */
  leaderDeptIds: string[];
  /** 需要用户注意但未阻断导入的异常 */
  warnings: string[];
}

/**
 * 把组织架构模板作为**补充层**应用到既有部门结构上：
 * ① 补「没有任何员工的空部门」；② 补「部门负责人」。
 * **不重建员工结构、不动岗位与编制、不动评估数据。**
 */
function applyOrgTemplates(reg: DeptRegistry, templates: OrgTemplate[]): OrgTemplateApplyReport {
  const report: OrgTemplateApplyReport = { addedPaths: [], leaderDeptIds: [], warnings: [] };
  // 名称 → 已存在的层级集合：用于发现「同名不同层级」的跨来源冲突（员工表 vs 组织模板）
  const levelsByName = new Map<string, Set<number>>();
  const noteLevel = (name: string, level: number) => {
    const set = levelsByName.get(name) ?? new Set<number>();
    set.add(level);
    levelsByName.set(name, set);
  };
  for (const d of reg.byId.values()) noteLevel(d.name, d.level);

  for (const tpl of templates) {
    const cells = declaredDeptCells(tpl);
    if (cells.length === 0) continue;
    const path: string[] = [];
    const resolved: { level: number; dept: Department }[] = [];
    let parentId: string | undefined;

    for (const cell of cells) {
      path.push(cell.name);
      const otherLevels = levelsByName.get(cell.name);
      if (otherLevels && !otherLevels.has(cell.level)) {
        report.warnings.push(
          `「${path.join('/')}」在员工表/已有结构中为 L${[...otherLevels].sort((a, b) => a - b).join('、L')}，组织架构模板按 L${cell.level} 声明，` +
          `已按模板新增一个 L${cell.level} 部门；请确认以哪份数据为准`,
        );
      }
      const { dept, created } = ensureDept(reg, cell.name, cell.level, parentId);
      if (created) {
        report.addedPaths.push(path.join('/'));
        noteLevel(dept.name, dept.level);
      }
      resolved.push({ level: cell.level, dept });
      parentId = dept.id;
    }

    // 未提供负责人 → 不写入、也**不清除**已有负责人（手工录入的负责人不该被模板误删）
    if (!tpl.leaderId && !tpl.leaderName) continue;
    const target = resolveTemplateLeaderTarget(tpl, resolved, path.join('/'), report);
    if (!target) continue;
    target.leaderId = tpl.leaderId || undefined;
    target.leaderName = tpl.leaderName || undefined;
    report.leaderDeptIds.push(target.id);
  }
  return report;
}

/**
 * 解析「部门负责人」应挂到哪一级。
 *
 * v2.3.2 修复：旧实现只在 `部门级别` 非空**且**恰好等于行内某一层级时才写入负责人，
 * 于是「部门级别留空」或「填错」都会让负责人**静默丢失**（用户毫无察觉，只看到图上没负责人）。
 * 现在：留空 → 挂到本行最深一级；填了但不是数字 / 行内没有该层级 → 明确警告，不猜、不静默。
 */
function resolveTemplateLeaderTarget(
  tpl: OrgTemplate,
  resolved: { level: number; dept: Department }[],
  rowPath: string,
  report: OrgTemplateApplyReport,
): Department | undefined {
  const raw = (tpl.deptLevel ?? '').trim();
  if (!raw) return resolved[resolved.length - 1]?.dept;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n)) {
    report.warnings.push(`「${rowPath}」的部门级别「${raw}」不是数字，该行负责人未应用`);
    return undefined;
  }
  const hit = resolved.find((r) => r.level === n);
  if (!hit) {
    report.warnings.push(`「${rowPath}」的部门级别为 L${n}，但该行没有 L${n} 的部门单元格，该行负责人未应用`);
    return undefined;
  }
  return hit.dept;
}

export interface OrgTemplateMergeResult extends OrgTemplateApplyReport {
  departments: Department[];
}

/**
 * v2.3.2：把组织架构模板**原地合并**到给定部门树上（纯函数，返回新树）。
 *
 * 与旧「整体重建」路径的关键区别：员工的部门归属、岗位、编制、评估数据**全部不受影响**。
 * 旧路径（`handleOrgTemplateUpload`）会用模板重建整棵树，副作用是把所有岗位编制清零、
 * 并把评估数据一起冲掉 —— 这正是「组织架构模板不适配」的根因。
 */
export function mergeOrgTemplates(tree: Department[], templates: OrgTemplate[]): OrgTemplateMergeResult {
  const clone = structuredClone(tree);
  const reg: DeptRegistry = { byKey: new Map(), byId: new Map() };
  const walk = (depts: Department[]) => {
    for (const d of depts) {
      reg.byKey.set(deptKey(d.level, d.name), d);
      reg.byId.set(d.id, d);
      walk(d.children);
    }
  };
  walk(clone);
  const report = applyOrgTemplates(reg, templates);
  return { ...report, departments: sortDeptTree(relinkTree(reg)) };
}

export interface OrgTemplatePruneResult {
  departments: Department[];
  removedPaths: string[];
}

/** 模板行的「名称路径」集合（用于判断某个部门是否由组织模板声明过）。 */
function templatePathSet(templates: OrgTemplate[]): Set<string> {
  const set = new Set<string>();
  for (const tpl of templates) {
    const cells = declaredDeptCells(tpl);
    if (cells.length > 0) set.add(cells.map((c) => c.name).join('/'));
  }
  return set;
}

/**
 * v2.3.2：收回**上一份组织模板**留下的空部门（「可替换」语义）。
 *
 * 只回收同时满足两条的部门：① 整棵子树没有任何员工；② 名称路径出现在上一份模板里。
 * 因此「有人或有子部门的部门」「用户手工新建的部门」「员工表带来的部门」都不会被误删。
 * 效果：重传模板 = 「员工表 + 新模板」，而不是「员工表 + 旧模板 + 新模板」无限叠加。
 */
export function pruneTemplateOnlyEmptyDepts(
  tree: Department[],
  previousTemplates: OrgTemplate[],
): OrgTemplatePruneResult {
  const removedPaths: string[] = [];
  const removable = templatePathSet(previousTemplates);
  if (removable.size === 0) return { departments: tree, removedPaths };

  const prune = (depts: Department[], prefix: string[]): Department[] => {
    const kept: Department[] = [];
    for (const d of depts) {
      const path = [...prefix, d.name];
      const children = prune(d.children, path);
      if (d.employees.length === 0 && children.length === 0 && removable.has(path.join('/'))) {
        removedPaths.push(path.join('/'));
        continue;
      }
      kept.push({ ...d, children });
    }
    return kept;
  };
  return { departments: prune(tree, []), removedPaths };
}

export interface PositionInheritResult {
  departments: Department[];
  /** 沿用原有配置（编制/序列/职级带宽/状态）的岗位数 */
  inherited: number;
  /** 原岗位在新名册中没人提及、但部门仍在 → 保留回来的岗位数 */
  restored: number;
}

/** 部门名称路径 → (岗位名 → Position) 索引。 */
function indexPositionsByPath(tree: Department[]): Map<string, Map<string, Position>> {
  const out = new Map<string, Map<string, Position>>();
  const walk = (depts: Department[], prefix: string[]) => {
    for (const d of depts) {
      const path = [...prefix, d.name].join('/');
      out.set(path, new Map((d.positions ?? []).map((p) => [p.name, p])));
      walk(d.children, [...prefix, d.name]);
    }
  };
  walk(tree, []);
  return out;
}

/**
 * v2.3.2：重新导入名册时**继承岗位配置**，修复「重导入把编制清零」。
 *
 * 员工信息表不含编制/序列/职级带宽列，`find-or-create` 主路径只能落 `headcount=0`；
 * 旧实现因此每次重传员工表（以及上传组织架构模板）都会把用户手工配置的编制**全部抹成 0**，
 * 缺口清单随之集体失真。
 *
 * 现在按「部门名称路径 + 岗位名」匹配，把上一棵树的岗位配置原样搬过来：
 * - 仍存在的岗位 → 沿用 headcount / 序列 / 职级带宽 / 状态（含冻结）；
 * - 新名册里暂时没人提及的岗位 → 只要其部门还在就**保留回来**（编制是配置数据，名册不携带，
 *   不能静默丢；保留后会在缺口清单里显式表现为空岗，可被看见）；
 * - 已归档（软删）的岗位不复活，尊重用户的删除意图。
 */
export function inheritPositionSetup(tree: Department[], previous: Department[]): PositionInheritResult {
  const clone = structuredClone(tree);
  const prevIndex = indexPositionsByPath(previous);
  const now = new Date().toISOString();
  let inherited = 0;
  let restored = 0;

  const walk = (depts: Department[], prefix: string[]) => {
    for (const d of depts) {
      const path = [...prefix, d.name].join('/');
      const prev = prevIndex.get(path);
      if (prev) {
        d.positions ??= [];
        for (const p of d.positions) {
          const before = prev.get(p.name);
          if (!before) continue;
          p.headcount = before.headcount;
          p.jobFamily = before.jobFamily;
          p.levelBandMin = before.levelBandMin;
          p.levelBandMax = before.levelBandMax;
          p.status = before.status;
          inherited++;
        }
        const present = new Set(d.positions.map((p) => p.name));
        for (const [name, before] of prev) {
          if (present.has(name) || before.status === 'archived') continue;
          d.positions.push({
            id: uid('pos'),
            departmentId: d.id,
            name,
            jobFamily: before.jobFamily,
            levelBandMin: before.levelBandMin,
            levelBandMax: before.levelBandMax,
            headcount: before.headcount,
            status: before.status,
            createdAt: before.createdAt || now,
            updatedAt: now,
          });
          restored++;
        }
      }
      walk(d.children, [...prefix, d.name]);
    }
  };
  walk(clone, []);
  return { departments: clone, inherited, restored };
}

/**
 * 构建部门树（v2.3.2 架构：**员工表是主结构来源，组织模板是补充层**）。
 *
 * 阶段：
 * ① 员工的一~六级部门列 → 主结构（列位置 = 声明层级，留空不压缩）；
 * ② 组织架构模板 → 补充层：补「无人的空部门」+ 补「部门负责人」；
 * ③ 岗位表先行建岗（进阶路径）；
 * ④ 员工归属到部门 + 按「岗位」列 find-or-create 套岗；
 * ⑤ 按中文名称排序。
 */
export function buildDepartmentTree(
  employees: Employee[],
  orgTemplates: OrgTemplate[],
  positionRows: PositionImportRow[] = [],
): Department[] {
  const reg: DeptRegistry = { byKey: new Map(), byId: new Map() };

  // ① 员工部门 → 主结构
  for (const emp of employees) {
    let parentId: string | undefined;
    for (const cell of declaredDeptCells(emp)) {
      const { dept } = ensureDept(reg, cell.name, cell.level, parentId);
      parentId = dept.id;
    }
  }

  // ② 组织架构模板 → 补充层（补空部门 + 负责人）
  applyOrgTemplates(reg, orgTemplates);

  const rootDepts = relinkTree(reg);

  /** 按部门路径（一级~六级名称）解析到具体部门；找不到返回 undefined。 */
  const findDeptByDeptPath = (path: string[]): Department | undefined => {
    if (path.length === 0) return undefined;
    // 优先按「列位置 = 层级」精确命中（岗位表路径沿用压缩口径）
    let found: Department | undefined;
    for (let i = 0; i < path.length; i++) {
      found = reg.byKey.get(deptKey(i + 1, path[i]));
      if (!found) break;
    }
    if (found) return found;
    // 兜底：按名称从根逐级下钻（覆盖层级断档等非压缩路径）
    let siblings = rootDepts;
    let node: Department | undefined;
    for (const name of path) {
      const hit = siblings.find((d) => d.name === name);
      if (!hit) return undefined;
      node = hit;
      siblings = hit.children;
    }
    return node;
  };

  // ③ 岗位表先行：把「岗位表 sheet」解析出的岗位按部门路径落到对应部门（先建岗）
  const createdPositions = new Set<string>(); // 去重，防重复建岗
  // deptId -> (岗位名 -> Position)，供员工套岗「只查不建」
  const positionByName = new Map<string, Map<string, Position>>();
  for (const row of positionRows) {
    const dept = findDeptByDeptPath(row.deptPath);
    if (!dept || createdPositions.has(`${dept.id}::${row.name}`)) continue;
    const now = new Date().toISOString();
    const pos: Position = {
      id: uid('pos'),
      departmentId: dept.id,
      name: row.name,
      jobFamily: row.jobFamily,
      levelBandMin: row.levelBandMin,
      levelBandMax: row.levelBandMax,
      headcount: row.headcount,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    (dept.positions ??= []).push(pos);
    createdPositions.add(`${dept.id}::${row.name}`);
    let m = positionByName.get(dept.id);
    if (!m) {
      m = new Map<string, Position>();
      positionByName.set(dept.id, m);
    }
    m.set(pos.name, pos);
  }

  // ④ 员工归属 + 套岗（沿树路径逐级精确匹配）
  for (const emp of employees) {
    const cells = declaredDeptCells(emp);
    if (cells.length === 0) continue; // 没有部门的员工不强行入树 → 进「未入架构员工」

    // 从根部门开始，逐级在 children 中按名称精确查找
    let matchedDept: Department | undefined;
    let candidates: Department[] = rootDepts;
    for (const { name } of cells) {
      const found = candidates.find((dept) => dept.name === name);
      if (!found) break;
      matchedDept = found;
      candidates = found.children;
    }

    // 兜底：路径未完全匹配时，按 (最后一级的**声明层级**, 最后一级名称) 查找
    // （v2.3.2：不再用「非空单元格个数」当层级，否则断档行会查错层级）
    if (!matchedDept) {
      const last = cells[cells.length - 1];
      matchedDept = reg.byKey.get(deptKey(last.level, last.name));
    }

    if (!matchedDept) continue;
    matchedDept.employees.push(emp);

    // ── v2.1.1 套岗：按岗位 find-or-create / 只查不建 ──
    const posName = (emp as EmployeeImportRow)._positionName;
    if (!posName) continue;
    const existing = positionByName.get(matchedDept.id)?.get(posName);
    if (existing) {
      // 岗位表先行：员工套岗「只查不建」
      emp.positionId = existing.id;
    } else if (positionRows.length === 0) {
      // 主路径：find-or-create（同部门同岗复用，避免重复建岗）
      let pos = (matchedDept.positions ?? []).find((p) => p.name === posName);
      if (!pos) {
        const now = new Date().toISOString();
        // 主路径（无编制列）：岗位 headcount=0 = 编制未配置（不伪装满编、不掩盖缺口；
        // 编制由用户显式配置，重导入时由 inheritPositionSetup 继承，不再被清零。）
        pos = {
          id: uid('pos'),
          departmentId: matchedDept.id,
          name: posName,
          headcount: 0,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        };
        (matchedDept.positions ??= []).push(pos);
      }
      emp.positionId = pos.id;
    }
    // positionRows 存在但该岗位未在表中（且无同名岗位）→ 不建岗，保持未套岗
  }

  return sortDeptTree(rootDepts);
}

/**
 * 生成组织架构 Excel 文件字节（含「员工信息」与「组织架构」两个工作表）。
 * 调用方决定保存方式（浏览器下载 / Tauri 另存为）。
 */
export async function buildOrgExcelBytes(departments: Department[]): Promise<Uint8Array> {
  const XLSX = await loadXlsx();
  const collectAllEmployees = (depts: Department[]): Employee[] => {
    let result: Employee[] = [];
    depts.forEach(dept => {
      result = result.concat(dept.employees);
      result = result.concat(collectAllEmployees(dept.children));
    });
    return result;
  };
  
  const allEmployees = collectAllEmployees(departments);
  
  // 过滤掉虚拟员工（兼岗），不影响人数统计
  const realEmployees = allEmployees.filter(emp => !emp.isVirtual);
  
  const data = realEmployees.map(emp => ({
    '姓名': emp.name,
    '工号': emp.employeeId,
    '职级': emp.level,
    '一级部门': emp.dept1 || '',
    '二级部门': emp.dept2 || '',
    '三级部门': emp.dept3 || '',
    '四级部门': emp.dept4 || '',
    '五级部门': emp.dept5 || '',
    '六级部门': emp.dept6 || '',
  }));
  
  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '员工信息');
  
  // 添加组织架构表
  const orgData: Record<string, string>[] = [];
  const collectDepts = (depts: Department[], prefix: string = '') => {
    depts.forEach(dept => {
      const prefixParts = prefix.split('/').filter(Boolean);
      orgData.push({
        '一级部门': dept.level === 1 ? dept.name : prefixParts[0] || '',
        '二级部门': dept.level === 2 ? dept.name : prefixParts[1] || '',
        '三级部门': dept.level === 3 ? dept.name : prefixParts[2] || '',
        '四级部门': dept.level === 4 ? dept.name : prefixParts[3] || '',
        '五级部门': dept.level === 5 ? dept.name : prefixParts[4] || '',
        '六级部门': dept.level === 6 ? dept.name : prefixParts[5] || '',
        '部门级别': String(dept.level),
        '部门负责人工号': dept.leaderId || '',
        '部门负责人': dept.leaderName || '',
      });
      collectDepts(dept.children, prefix + '/' + dept.name);
    });
  };
  collectDepts(departments);
  
  if (orgData.length > 0) {
    const orgWorksheet = XLSX.utils.json_to_sheet(orgData);
    XLSX.utils.book_append_sheet(workbook, orgWorksheet, '组织架构');
  }
  
  const out = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  return new Uint8Array(out as ArrayBuffer);
}

export async function exportToExcel(departments: Department[]): Promise<void> {
  const bytes = await buildOrgExcelBytes(departments);
  const { saveFile } = await import('./tauri');
  await saveFile('组织架构数据.xlsx', bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * 构建「员工信息」示例模板的 Excel 字节（调用方决定保存方式：Tauri 另存为 / 浏览器下载）。
 *
 * v2.3.2：`岗位` 与 `岗位名称` 合并为**一列** `岗位`（此前两列语义完全不同却看着像重复字段）。
 * 部门列按「列位置 = 层级」声明，示例保持层级连续（中间层留空会在画布上触发层级断档提示，
 * 属异常用法，不放进示例模板以免被照抄）。
 */
export async function buildSampleEmployeeTemplateBytes(): Promise<Uint8Array> {
  const XLSX = await loadXlsx();
  const data = [
    { '姓名': '张三', '工号': 'E001', '职级': 'L3.2', '岗位': '前端工程师', '个人成本': '24000', '目标职级': 'L4.1', '直接上级工号': 'E002', '一级部门': '技术部', '二级部门': '研发部', '三级部门': '前端组', '四级部门': '', '五级部门': '', '六级部门': '' },
    { '姓名': '李四', '工号': 'E002', '职级': 'L2.1', '岗位': '前端开发', '个人成本': '18000', '目标职级': '', '直接上级工号': 'E001', '一级部门': '技术部', '二级部门': '研发部', '三级部门': '前端组', '四级部门': '', '五级部门': '', '六级部门': '' },
    { '姓名': '王五', '工号': 'E003', '职级': 'L4.2', '岗位': '研发经理', '个人成本': '36000', '目标职级': '', '直接上级工号': '', '一级部门': '技术部', '二级部门': '研发部', '三级部门': '', '四级部门': '', '五级部门': '', '六级部门': '' },
  ];

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '员工信息');
  const out = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  return new Uint8Array(out as ArrayBuffer);
}

/** 构建「员工信息」示例模板文件（Tauri 原生另存为 / 浏览器下载） */
export async function generateSampleEmployeeTemplate(): Promise<void> {
  const bytes = await buildSampleEmployeeTemplateBytes();
  const { saveFile } = await import('./tauri');
  await saveFile('员工信息模板.xlsx', bytes, XLSX_MIME);
}

/** 构建「组织架构」示例模板的 Excel 字节 */
export async function buildSampleOrgTemplateBytes(): Promise<Uint8Array> {
  const XLSX = await loadXlsx();
  const data = [
    { '一级部门': '技术部', '二级部门': '研发部', '三级部门': '前端组', '四级部门': '', '五级部门': '', '六级部门': '', '部门级别': '3', '部门负责人工号': 'E001', '部门负责人': '张三' },
    { '一级部门': '技术部', '二级部门': '研发部', '三级部门': '后端组', '四级部门': '', '五级部门': '', '六级部门': '', '部门级别': '3', '部门负责人工号': '', '部门负责人': '' },
    { '一级部门': '技术部', '二级部门': '测试部', '三级部门': '', '四级部门': '', '五级部门': '', '六级部门': '', '部门级别': '2', '部门负责人工号': '', '部门负责人': '' },
    { '一级部门': '人力资源部', '二级部门': '', '三级部门': '', '四级部门': '', '五级部门': '', '六级部门': '', '部门级别': '1', '部门负责人工号': '', '部门负责人': '' },
  ];

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '组织架构');
  const out = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  return new Uint8Array(out as ArrayBuffer);
}

/** 构建「组织架构」示例模板文件（Tauri 原生另存为 / 浏览器下载） */
export async function generateSampleOrgTemplate(): Promise<void> {
  const bytes = await buildSampleOrgTemplateBytes();
  const { saveFile } = await import('./tauri');
  await saveFile('组织架构模板.xlsx', bytes, XLSX_MIME);
}

/**
 * 构建「胜任度评分」示例模板的 Excel 字节（调用方决定保存方式：Tauri 另存为 / 浏览器下载）。
 * 沿用 buildSampleEmployeeTemplateBytes 的 workbook 生成模式；维度列按 model 中 enabled 维度动态生成、
 * 列头为维度 label（停用维度不生成列，保证模板 ↔ parseAssessmentExcel/mapAssessmentRows 往返一致）。
 */
export async function buildSampleAssessmentTemplateBytes(model: CompetencyModel): Promise<Uint8Array> {
  const XLSX = await loadXlsx();
  const enabledDims = model.dimensions.filter((d) => d.enabled);
  const sampleRow: Record<string, string> = { '工号': 'E001', '姓名': '张三' };
  for (const dim of enabledDims) {
    sampleRow[dim.label] = '3';
  }
  sampleRow['评分人'] = 'HRBP 示例';
  sampleRow['评估日期'] = new Date().toISOString().slice(0, 10);
  sampleRow['备注'] = '分数为 1–5 整数；未评请留空';
  const worksheet = XLSX.utils.json_to_sheet([sampleRow]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '胜任度评分');
  const out = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
  return new Uint8Array(out as ArrayBuffer);
}
