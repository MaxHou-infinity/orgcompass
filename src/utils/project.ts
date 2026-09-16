import {
  ProjectFile,
  Scenario,
  LevelConfig,
  Employee,
  Department,
  Position,
  ScenarioCanvas,
  Assessment,
  AssignmentStatus,
  AssignmentType,
  CompetencyDimensionDef,
  CompetencyModel,
  PositionAssignment,
  DEFAULT_COMPETENCY_MODEL,
  COMPETENCY_SCALE,
} from '../types';
import { seedLegacyAssignments } from './placement';
import { DEFAULT_LEVELS } from './levels';
import { compressToUTF16, decompressFromUTF16 } from 'lz-string';

/**
 * 项目 / 场景 / .orgproj 数据层（纯函数 + localStorage IO）。
 *
 * 领域模型：
 * - 一个工作区 = 一个 ProjectFile = 一个项目 + 多场景快照。
 * - .orgproj 项目文件即 ProjectFile 的 JSON 序列化（Web 下载 / Tauri saveFile）。
 * - 浏览器版持久化到 localStorage（自动保存），Tauri 版可另存为 .orgproj。
 */

/** 数据模型版本（用于迁移）。v2.1.1 升为 2：引入岗位（Position）实体。v2.2.0 升为 3：胜任度引擎（CompetencyModel / Assessment / PositionAssignment）。 */
/** V2.3 M1 格式 4：当前任职关联 ID、未知日期与独立确认关联；产品版本独立管理。 */
export const PROJECT_VERSION = 4;

/** localStorage key */
export const PROJECT_STORAGE_KEY = 'org-designer.project.v2';
export const PROJECT_BACKUP_KEY = `${PROJECT_STORAGE_KEY}.before-v4`;
export let projectLoadIssue: string | null = null;
export class UnsupportedProjectVersionError extends Error {
  constructor(version: number) { super(`此项目使用格式 ${version}，请使用支持该格式的新版应用打开。`); }
}

/** 自动保存使用压缩格式，避免大型组织与胜任度明细触发 WebView 存储配额。 */
const COMPRESSED_STORAGE_PREFIX = 'lz16:';

/** 默认场景名 */
export const DEFAULT_SCENARIO_NAME = '基线';

/** 生成一个稳定唯一 id（前缀 + 时间戳 + 随机）。供岗位/员工/部门等实体用。 */
export function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 空场景快照（初始场景用）。v2.2.0：补齐胜任度三字段（默认模型深拷贝 + 两张空表）。 */
export function emptyScenarioSnapshot(): {
  departments: Department[];
  allEmployeesFlat: Employee[];
  levelConfigs: LevelConfig[];
  canvas: ScenarioCanvas;
  competencyModel: CompetencyModel;
  assessments: Assessment[];
  positionAssignments: PositionAssignment[];
} {
  return {
    departments: [],
    allEmployeesFlat: [],
    levelConfigs: DEFAULT_LEVELS.map((c) => ({ ...c })),
    canvas: { zoom: 100 },
    competencyModel: structuredClone(DEFAULT_COMPETENCY_MODEL),
    assessments: [],
    positionAssignments: [],
  };
}

/** 用当前快照创建一个场景（v2.2.0：快照缺三字段时按缺省回退，兼容旧调用方） */
export function createScenario(
  name: string,
  snapshot: {
    departments: Department[];
    allEmployeesFlat: Employee[];
    levelConfigs: LevelConfig[];
    canvas: ScenarioCanvas;
    competencyModel?: CompetencyModel;
    assessments?: Assessment[];
    positionAssignments?: PositionAssignment[];
  },
  now: string = new Date().toISOString(),
): Scenario {
  return {
    id: uid('scene'),
    name: name || DEFAULT_SCENARIO_NAME,
    createdAt: now,
    updatedAt: now,
    departments: snapshot.departments,
    allEmployeesFlat: snapshot.allEmployeesFlat,
    levelConfigs: snapshot.levelConfigs,
    canvas: snapshot.canvas,
    competencyModel: snapshot.competencyModel
      ? structuredClone(snapshot.competencyModel)
      : structuredClone(DEFAULT_COMPETENCY_MODEL),
    assessments: snapshot.assessments ? structuredClone(snapshot.assessments) : [],
    positionAssignments: snapshot.positionAssignments ? structuredClone(snapshot.positionAssignments) : [],
  };
}

/** 复制一个场景（生成「{原名} 副本」）。v2.2.0：胜任度三字段一并深拷贝，不共享引用。 */
export function cloneScenario(scenario: Scenario, now: string = new Date().toISOString()): Scenario {
  return {
    id: uid('scene'),
    name: `${scenario.name} 副本`,
    createdAt: now,
    updatedAt: now,
    departments: structuredClone(scenario.departments),
    allEmployeesFlat: structuredClone(scenario.allEmployeesFlat),
    levelConfigs: scenario.levelConfigs.map((c) => ({ ...c })),
    canvas: { ...scenario.canvas },
    competencyModel: structuredClone(scenario.competencyModel ?? DEFAULT_COMPETENCY_MODEL),
    assessments: structuredClone(scenario.assessments ?? []),
    positionAssignments: structuredClone(scenario.positionAssignments ?? []),
  };
}

/** 创建一个默认项目（含一个「基线」场景） */
export function createProject(name: string, now: string = new Date().toISOString()): ProjectFile {
  const baseline = createScenario(DEFAULT_SCENARIO_NAME, emptyScenarioSnapshot(), now);
  return {
    id: uid('proj'),
    name: name || '组织架构项目',
    version: PROJECT_VERSION,
    currentScenarioId: baseline.id,
    scenarios: [baseline],
    meta: { createdAt: now, updatedAt: now, version: PROJECT_VERSION },
  };
}

/** —— 序列化 —— */

export function serializeProject(project: ProjectFile): string {
  return JSON.stringify(project, null, 2);
}

/** 类型守卫：判断一个对象是否为合理部门（仅顶层字段检查，健壮迁移用） */
function isDepartmentLike(v: unknown): v is Department {
  if (!v || typeof v !== 'object') return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.id === 'string' &&
    typeof d.name === 'string' &&
    typeof d.level === 'number' &&
    Array.isArray(d.employees) &&
    Array.isArray(d.children)
  );
}

/** 递归清洗部门树（丢弃非法节点，归一化缺失字段） */
function sanitizeDepartments(list: unknown[]): Department[] {
  const out: Department[] = [];
  for (const item of list) {
    if (!isDepartmentLike(item)) continue;
    const children = Array.isArray(item.children) ? sanitizeDepartments(item.children) : [];
    const now = new Date().toISOString();
    const leaderType = isLeaderType(item.leaderType) ? item.leaderType : undefined;
    out.push({
      id: item.id,
      name: item.name,
      level: item.level,
      leaderId: typeof item.leaderId === 'string' ? item.leaderId : undefined,
      leaderName: typeof item.leaderName === 'string' ? item.leaderName : undefined,
      parentId: typeof item.parentId === 'string' ? item.parentId : undefined,
      children,
      employees: (Array.isArray(item.employees) ? item.employees : []).filter(
        (e: unknown): e is Employee => !!e && typeof (e as Employee).id === 'string',
      ),
      expanded: typeof item.expanded === 'boolean' ? item.expanded : item.level <= 3,
      headcount:
        typeof item.headcount === 'number' && Number.isFinite(item.headcount)
          ? item.headcount
          : undefined,
      // —— v2.1.1 岗位化 ——
      positions: Array.isArray(item.positions) ? sanitizePositions(item.positions, now) : [],
      ...(leaderType !== undefined ? { leaderType } : {}),
    });
  }
  return out;
}

function isLeaderType(v: unknown): v is import('../types').LeaderType {
  return v === 'owner' || v === 'deputy' || v === 'acting' || v === 'external' || v === 'vacant';
}

function sanitizePositions(list: unknown[], now: string): Position[] {
  const out: Position[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    if (typeof p.id !== 'string' || typeof p.name !== 'string') continue;
    const status = p.status === 'active' || p.status === 'frozen' || p.status === 'archived' ? p.status : 'active';
    out.push({
      id: p.id,
      departmentId: typeof p.departmentId === 'string' ? p.departmentId : '',
      name: p.name,
      jobFamily: typeof p.jobFamily === 'string' ? p.jobFamily : undefined,
      levelBandMin: typeof p.levelBandMin === 'string' ? p.levelBandMin : undefined,
      levelBandMax: typeof p.levelBandMax === 'string' ? p.levelBandMax : undefined,
      headcount: typeof p.headcount === 'number' && Number.isFinite(p.headcount) ? p.headcount : 0,
      status,
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : now,
      updatedAt: typeof p.updatedAt === 'string' ? p.updatedAt : now,
    });
  }
  return out;
}

function sanitizeLevelConfigs(list: unknown[]): LevelConfig[] {
  const out: LevelConfig[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    if (typeof c.code !== 'string' || typeof c.number !== 'string' || typeof c.label !== 'string' || typeof c.color !== 'string') continue;
    out.push({
      code: c.code,
      number: c.number,
      label: c.label,
      color: c.color,
      cost: typeof c.cost === 'number' && Number.isFinite(c.cost) ? c.cost : undefined,
    });
  }
  return out.length > 0 ? out : DEFAULT_LEVELS.map((c) => ({ ...c }));
}

// —— v2.2.0：胜任度三张表 sanitize（沿用逐条校验、非法丢单条、缺省回退风格） ——

/** 维度 key 合法形式（AI 稳定 ID + 结构化枚举）：小写字母开头，仅小写字母/数字/下划线。 */
const DIMENSION_KEY_RE = /^[a-z][a-z0-9_]*$/;

/** 清洗场景级胜任度模型：维度逐条校验，非法丢单条；结果为空 → 回退默认预设深拷贝。 */
function sanitizeCompetencyModel(raw: unknown): CompetencyModel {
  if (!raw || typeof raw !== 'object') return structuredClone(DEFAULT_COMPETENCY_MODEL);
  const model = raw as Record<string, unknown>;
  const list = Array.isArray(model.dimensions) ? model.dimensions : [];
  const dimensions: CompetencyDimensionDef[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const d = item as Record<string, unknown>;
    if (typeof d.key !== 'string' || !DIMENSION_KEY_RE.test(d.key)) continue;
    if (typeof d.label !== 'string') continue;
    if (typeof d.definition !== 'string') continue;
    if (typeof d.weight !== 'number' || !Number.isFinite(d.weight) || d.weight < 0) continue;
    if (d.group !== 'leadership' && d.group !== 'staff') continue;
    if (typeof d.order !== 'number' || !Number.isInteger(d.order)) continue;
    if (typeof d.enabled !== 'boolean') continue;
    const dim: CompetencyDimensionDef = {
      key: d.key,
      label: d.label,
      definition: d.definition,
      weight: d.weight,
      group: d.group,
      order: d.order,
      enabled: d.enabled,
    };
    if (typeof d.builtin === 'boolean') dim.builtin = d.builtin;
    dimensions.push(dim);
  }
  return dimensions.length > 0 ? { dimensions } : structuredClone(DEFAULT_COMPETENCY_MODEL);
}

/** 清洗评估长表：必填缺失/score 非 1..5 整数/dimension 非法形式/assessorRole 非 supervisor|hrbp → 丢单条；
 *  scale 强制 {min:1,max:5}；requirement 非 1..5 → 回填 3；source 非法 → manual。
 *  注意：dimension 指向「当前模型不存在的 key」（orphan）【不丢】，由运行时 lookup 降级。 */
function sanitizeAssessments(raw: unknown, now: string): Assessment[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: Assessment[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    if (typeof a.id !== 'string' || !a.id) continue;
    if (typeof a.employeeId !== 'string' || !a.employeeId) continue;
    if (typeof a.assessedAt !== 'string' || !a.assessedAt) continue;
    const score = a.score;
    if (
      typeof score !== 'number' ||
      !Number.isInteger(score) ||
      score < COMPETENCY_SCALE.min ||
      score > COMPETENCY_SCALE.max
    ) continue;
    if (typeof a.dimension !== 'string' || !DIMENSION_KEY_RE.test(a.dimension)) continue;
    // MVP 只认 supervisor/hrbp 有效（self/peer/subordinate 枚举留位，不参与录入/算法）
    if (a.assessorRole !== 'supervisor' && a.assessorRole !== 'hrbp') continue;
    const req = a.requirement;
    const requirement =
      typeof req === 'number' && Number.isFinite(req) && req >= COMPETENCY_SCALE.min && req <= COMPETENCY_SCALE.max
        ? req
        : 3;
    const assessment: Assessment = {
      id: a.id,
      employeeId: a.employeeId,
      dimension: a.dimension,
      score,
      scale: COMPETENCY_SCALE,
      requirement,
      assessorRole: a.assessorRole,
      assessedAt: a.assessedAt,
      source: a.source === 'import' ? 'import' : 'manual',
      createdAt: typeof a.createdAt === 'string' ? a.createdAt : now,
      updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : now,
    };
    if (typeof a.positionId === 'string') assessment.positionId = a.positionId;
    if (typeof a.assessorId === 'string') assessment.assessorId = a.assessorId;
    if (typeof a.note === 'string') assessment.note = a.note;
    // —— v2.3 M2：适用范围 / 任职关联 / 同日修订（缺省不回填伪造；未知保持未知）——
    if (a.scope === 'position' || a.scope === 'general') assessment.scope = a.scope;
    if (typeof a.relationId === 'string' && a.relationId) assessment.relationId = a.relationId;
    if (typeof a.revisionOf === 'string' && a.revisionOf) assessment.revisionOf = a.revisionOf;
    if (typeof a.revisionNote === 'string') assessment.revisionNote = a.revisionNote;
    if (typeof a.enteredBy === 'string') assessment.enteredBy = a.enteredBy;
    out.push(assessment);
  }
  return out;
}

/** 清洗人岗时态关系表：id/employeeId/positionId/startDate 缺失 → 丢单条；
 *  type/status 非法 → 回退 primary/active（沿用 sanitizePositions 缺省回退风格）。 */
function sanitizePositionAssignments(raw: unknown, now: string): PositionAssignment[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: PositionAssignment[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    if (typeof a.id !== 'string' || !a.id) continue;
    if (typeof a.employeeId !== 'string' || !a.employeeId) continue;
    if (typeof a.positionId !== 'string' || !a.positionId) continue;
    const type: AssignmentType = a.type === 'secondary' ? 'secondary' : 'primary';
    const status: AssignmentStatus =
      a.status === 'ended' ? 'ended' : a.status === 'not_competent' ? 'not_competent' : 'active';
    const assignment: PositionAssignment = {
      id: a.id,
      employeeId: a.employeeId,
      positionId: a.positionId,
      type,
      startDate: typeof a.startDate === 'string' && a.startDate ? a.startDate : undefined,
      status,
      createdAt: typeof a.createdAt === 'string' ? a.createdAt : now,
      updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : now,
    };
    assignment.source = a.source === 'operation' ? 'operation' : 'legacy';
    for (const key of ['relationId', 'revokedAt', 'positionName', 'departmentName'] as const) {
      if (typeof a[key] === 'string') assignment[key] = a[key];
    }
    if (typeof a.endDate === 'string') assignment.endDate = a.endDate;
    if (typeof a.confirmedBy === 'string') assignment.confirmedBy = a.confirmedBy;
    if (typeof a.confirmedAt === 'string') assignment.confirmedAt = a.confirmedAt;
    // —— v2.3 M2：复核留痕（依据、引用评分、撤销人/原因）；缺失保持未知，不编造 ——
    if (typeof a.reviewNote === 'string') assignment.reviewNote = a.reviewNote;
    if (Array.isArray(a.reviewAssessmentIds)) {
      const ids = a.reviewAssessmentIds.filter((x): x is string => typeof x === 'string' && !!x);
      if (ids.length > 0) assignment.reviewAssessmentIds = ids;
    }
    if (typeof a.revokedBy === 'string') assignment.revokedBy = a.revokedBy;
    if (typeof a.revokeReason === 'string') assignment.revokeReason = a.revokeReason;
    out.push(assignment);
  }
  return out;
}

function sanitizeScenario(raw: Record<string, unknown>, index: number): Scenario | null {
  const now = new Date().toISOString();
  const id = typeof raw.id === 'string' ? raw.id : uid('scene');
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : `场景 ${index + 1}`;
  const departments = Array.isArray(raw.departments) ? sanitizeDepartments(raw.departments) : [];
  const allEmployeesFlat = Array.isArray(raw.allEmployeesFlat)
    ? (raw.allEmployeesFlat as Employee[]).filter((e) => e && typeof e.id === 'string')
    : [];
  const levelConfigs = Array.isArray(raw.levelConfigs) ? sanitizeLevelConfigs(raw.levelConfigs) : DEFAULT_LEVELS.map((c) => ({ ...c }));

  const canvasRaw = raw.canvas && typeof raw.canvas === 'object' ? (raw.canvas as Record<string, unknown>) : {};
  const canvas: ScenarioCanvas = {
    zoom:
      typeof canvasRaw.zoom === 'number' && Number.isFinite(canvasRaw.zoom)
        ? Math.round(Math.min(Math.max(canvasRaw.zoom, 50), 200))
        : 100,
    lastFocusedDeptId: typeof canvasRaw.lastFocusedDeptId === 'string' ? canvasRaw.lastFocusedDeptId : undefined,
  };

  return {
    id,
    name,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
    departments,
    allEmployeesFlat,
    levelConfigs,
    canvas,
    positions: Array.isArray(raw.positions) ? sanitizePositions(raw.positions, now) : [],
    // —— v2.2.0：胜任度三张表（缺省回退，不丢旧文件） ——
    competencyModel: sanitizeCompetencyModel(raw.competencyModel),
    assessments: sanitizeAssessments(raw.assessments, now),
    positionAssignments: raw.seedLegacyRelations === true
      ? seedLegacyAssignments(allEmployeesFlat, departments, sanitizePositionAssignments(raw.positionAssignments, now), now)
      : sanitizePositionAssignments(raw.positionAssignments, now),
  };
}

/** —— v2.1.1：显式迁移链（.orgproj 数据模型版本升级）—— */

type Migration = (data: Record<string, unknown>) => Record<string, unknown>;

const MIGRATIONS: Record<number, Migration> = {
  // v1 → v2：引入岗位。旧部门级 headcount>0 派生「默认岗位」，部门内非虚拟员工自动套岗；
  // dept.headcount 保留为冗余派生（= 部门直属岗位编制之和），保证报告/诊断数字与迁移前一致。
  1: (data) => migrateV1ToV2(data),
  // v2 → v3：胜任度引擎。competencyModel 缺省回填默认预设 + 两张新表空数组占位（positionAssignments 不回填，不造数据）。
  2: (data) => migrateV2ToV3(data),
  3: (data) => {
    for (const raw of Array.isArray(data.scenarios) ? data.scenarios : []) {
      if (raw && typeof raw === 'object') (raw as Record<string, unknown>).seedLegacyRelations = true;
    }
    return data;
  },
};

/** 将已支持版本迁移到当前 PROJECT_VERSION；更高版本在 parseProject 入口拒绝。 */
function migrateToCurrent(data: Record<string, unknown>): Record<string, unknown> {
  let v = typeof data.version === 'number' ? data.version : 1;
  let out = data;
  while (v < PROJECT_VERSION) {
    const fn = MIGRATIONS[v];
    if (!fn) break;
    out = fn(out);
    out.version = v + 1;
    v += 1;
  }
  return out;
}

function migrateV1ToV2(data: Record<string, unknown>): Record<string, unknown> {
  const now = new Date().toISOString();
  const scenarios = Array.isArray(data.scenarios) ? data.scenarios : [];
  for (const sRaw of scenarios) {
    const s = sRaw as Record<string, unknown>;
    const depts = Array.isArray(s.departments) ? s.departments : [];
    const allPositions: Record<string, unknown>[] = [];
    migrateDepts(depts, allPositions, now);
    s.positions = allPositions;
  }
  return data;
}

function migrateDepts(depts: unknown[], allPositions: Record<string, unknown>[], now: string): void {
  for (const dRaw of depts) {
    const d = dRaw as Record<string, unknown>;
    const positions = Array.isArray(d.positions) ? (d.positions as Record<string, unknown>[]) : [];
    const hc =
      typeof d.headcount === 'number' && Number.isFinite(d.headcount) && d.headcount > 0
        ? d.headcount
        : null;

    let defaultPosId: string | null = null;
    if (hc != null) {
      if (positions.length === 0) {
        // 首次迁移：派生「默认岗位」，编制数 = 旧 headcount（数字不变）
        defaultPosId = uid('pos');
        const pos: Record<string, unknown> = {
          id: defaultPosId,
          departmentId: d.id,
          name: '默认岗位',
          headcount: hc,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        };
        positions.push(pos);
        allPositions.push(pos);
      } else {
        // 二次迁移（幂等）：已有岗位则套岗到第一个 active 岗位，不重复建岗
        const firstActive = positions.find((p) => p.status === 'active') ?? positions[0];
        defaultPosId = (firstActive?.id as string) ?? null;
      }
    }

    // 部门内非虚拟员工：无 positionId → 套岗到默认岗位（幂等：已有则不覆盖）
    const emps = Array.isArray(d.employees) ? d.employees : [];
    for (const eRaw of emps) {
      const e = eRaw as Record<string, unknown>;
      if (e.isVirtual) continue;
      if (e.positionId == null && defaultPosId) {
        e.positionId = defaultPosId;
      }
    }

    d.positions = positions;
    const children = Array.isArray(d.children) ? d.children : [];
    migrateDepts(children, allPositions, now);
  }
}

/**
 * v2 → v3（幂等 + 无损 + 不造数据）：
 * 1) competencyModel 缺省回填默认预设（深层拷贝，避免共享引用）；有维度即保留；
 * 2) assessments 空数组占位（有值即保留）；
 * 3) positionAssignments 空数组占位、【不回填】——避免伪造 startDate，也避免 project.ts ↔ assignment.ts 循环依赖；
 *    v2 旧数据仍以 Employee.positionId + 虚拟副本投影为 active 真值；前向写操作时才产生 assignment 记录。
 * 不触碰 headcount / 职级 / positionId / targetLevel 等既有字段 → 空岗率 / 缺口 / 匹配三态 / 职级差距与 v2 完全一致。
 */
function migrateV2ToV3(data: Record<string, unknown>): Record<string, unknown> {
  const scenarios = Array.isArray(data.scenarios) ? data.scenarios : [];
  for (const sRaw of scenarios) {
    const s = sRaw as Record<string, unknown>;
    if (!s.competencyModel || !Array.isArray((s.competencyModel as { dimensions?: unknown }).dimensions)) {
      s.competencyModel = structuredClone(DEFAULT_COMPETENCY_MODEL);
    }
    s.assessments = Array.isArray(s.assessments) ? s.assessments : [];
    s.positionAssignments = Array.isArray(s.positionAssignments) ? s.positionAssignments : [];
  }
  return data;
}

/**
 * 解析 + 迁移 .orgproj JSON 字符串。
 * 先跑迁移链（v1→v2：岗位派生 + 员工套岗），再做 sanitize（归一化 + 校验）。
 * @returns 合法 ProjectFile；解析失败或结构非法返回 null。
 */
export function parseProject(raw: string): ProjectFile | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const inputVersion = (data as Record<string, unknown>).version;
  if (typeof inputVersion === 'number' && inputVersion > PROJECT_VERSION) throw new UnsupportedProjectVersionError(inputVersion);
  const migratedRaw = migrateToCurrent(data as Record<string, unknown>);
  const p = migratedRaw;

  const now = new Date().toISOString();
  const scenariosRaw = Array.isArray(p.scenarios) ? p.scenarios : [];
  const scenarios = scenariosRaw
    .map((s, i) => sanitizeScenario(s as Record<string, unknown>, i))
    .filter((s): s is Scenario => s !== null);

  const name = typeof p.name === 'string' && p.name.trim() ? p.name : '组织架构项目';
  let currentScenarioId = typeof p.currentScenarioId === 'string' ? p.currentScenarioId : '';

  if (scenarios.length === 0) {
    const baseline = createScenario(DEFAULT_SCENARIO_NAME, emptyScenarioSnapshot(), now);
    scenarios.push(baseline);
    currentScenarioId = baseline.id;
  } else if (!scenarios.some((s) => s.id === currentScenarioId)) {
    // 迁移持有未知/失效的场景 id → 回退到第一个场景
    currentScenarioId = scenarios[0].id;
  }

  const version = typeof p.version === 'number' ? p.version : PROJECT_VERSION;
  const metaRaw = p.meta && typeof p.meta === 'object' ? (p.meta as Record<string, unknown>) : {};

  return {
    id: typeof p.id === 'string' ? p.id : uid('proj'),
    name,
    version,
    currentScenarioId,
    scenarios,
    meta: {
      createdAt: typeof metaRaw.createdAt === 'string' ? metaRaw.createdAt : now,
      updatedAt: typeof metaRaw.updatedAt === 'string' ? metaRaw.updatedAt : now,
      version,
    },
  };
}

/** —— localStorage IO —— */

export function loadProject(): ProjectFile | null {
  projectLoadIssue = null;
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(PROJECT_STORAGE_KEY);
    if (!raw) return null;
    const json = decodeStoredProject(raw);
    if (!json) throw new Error('自动保存内容无法解压，原数据已保留。');
    const parsed = parseProject(json);
    if (!parsed) throw new Error('自动保存内容无法读取，原数据已保留。');
    return parsed;
  } catch (error) {
    projectLoadIssue = error instanceof Error ? error.message : '项目读取失败，原数据已保留';
    console.error('加载项目失败:', error);
    return null;
  }
}

export function decodeStoredProject(raw: string): string | null {
  return raw.startsWith(COMPRESSED_STORAGE_PREFIX)
    ? decompressFromUTF16(raw.slice(COMPRESSED_STORAGE_PREFIX.length)) : raw;
}

export function persistProject(project: ProjectFile): boolean {
  if (typeof localStorage === 'undefined') return true;
  try {
    const raw = localStorage.getItem(PROJECT_STORAGE_KEY);
    if (raw) {
      const json = decodeStoredProject(raw);
      if (!json) throw new Error('原自动保存无法读取，禁止覆盖');
      const existing = JSON.parse(json) as { version?: number };
      if ((existing.version ?? 1) > PROJECT_VERSION) throw new UnsupportedProjectVersionError(existing.version!);
      if ((existing.version ?? 1) < 4 && project.version >= 4) {
        // 先保存原字节；备份写入失败时整个保存失败，不能跳过。
        const backup = localStorage.getItem(PROJECT_BACKUP_KEY);
        if (!backup) localStorage.setItem(PROJECT_BACKUP_KEY, raw);
        else if (backup !== raw) localStorage.setItem(`${PROJECT_BACKUP_KEY}.${crypto.randomUUID()}`, raw);
      }
    }
    const compactJson = JSON.stringify(project);
    localStorage.setItem(
      PROJECT_STORAGE_KEY,
      `${COMPRESSED_STORAGE_PREFIX}${compressToUTF16(compactJson)}`,
    );
    return true;
  } catch (error) {
    console.error('保存项目失败:', error);
    return false;
  }
}

/** 取当前场景；无则回退第一个（并返回它）。 */
export function getCurrentScenario(project: ProjectFile): Scenario {
  return (
    project.scenarios.find((s) => s.id === project.currentScenarioId) ?? project.scenarios[0]
  );
}
