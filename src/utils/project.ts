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

/**
 * 把源对象里「不在已知字段清单内」的字段原样带回目标对象（v2.3.1 Q-10）。
 *
 * 背景：`sanitize*` 系列都是**重建**对象并只拷贝白名单字段，未知字段被静默丢弃；
 * 而 `allEmployeesFlat` 却是原样 filter 保留 —— 同一份文件里两种态度。
 * 后果：未来在同一格式（format 4）下给某实体加字段时，旧版应用打开并保存一次就会**丢掉新字段**。
 *
 * 安全边界（避免绕过清洗）：
 * - 只有 `known` 清单里**没有**的键才会被带回，因此任何已知字段（含校验失败的）仍走各自清洗逻辑，
 *   不会被原始值直接透传；
 * - `__proto__` / `constructor` / `prototype` 一律不带回（不做原型链注入的搬运工）。
 */
function carryUnknownFields<T extends object>(target: T, source: object, known: readonly string[]): T {
  const knownSet = new Set(known);
  const src = source as Record<string, unknown>;
  for (const key of Object.keys(src)) {
    if (knownSet.has(key) || UNSAFE_KEYS.has(key)) continue;
    (target as Record<string, unknown>)[key] = src[key];
  }
  return target;
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Department 的已知持久化字段（不在其中的视为「未来新增字段」，原样带回） */
const DEPARTMENT_KEYS = ['id', 'name', 'level', 'parentId', 'children', 'employees', 'expanded', 'headcount', 'leaderId', 'leaderName', 'leaderType', 'positions'] as const;
const POSITION_KEYS = ['id', 'departmentId', 'name', 'jobFamily', 'levelBandMin', 'levelBandMax', 'headcount', 'status', 'createdAt', 'updatedAt'] as const;
const LEVEL_CONFIG_KEYS = ['code', 'number', 'label', 'color', 'cost'] as const;
const SCENARIO_KEYS = ['id', 'name', 'createdAt', 'updatedAt', 'departments', 'allEmployeesFlat', 'levelConfigs', 'canvas', 'positions', 'competencyModel', 'assessments', 'positionAssignments', 'seedLegacyRelations'] as const;
const PROJECT_KEYS = ['id', 'name', 'version', 'currentScenarioId', 'scenarios', 'meta'] as const;
const META_KEYS = ['createdAt', 'updatedAt', 'version'] as const;

/** 递归清洗部门树（丢弃非法节点，归一化缺失字段） */
function sanitizeDepartments(list: unknown[]): Department[] {
  const out: Department[] = [];
  for (const item of list) {
    if (!isDepartmentLike(item)) continue;
    const children = Array.isArray(item.children) ? sanitizeDepartments(item.children) : [];
    const now = new Date().toISOString();
    const leaderType = isLeaderType(item.leaderType) ? item.leaderType : undefined;
    out.push(carryUnknownFields({
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
    }, item, DEPARTMENT_KEYS));
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
    out.push(carryUnknownFields({
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
    }, p, POSITION_KEYS));
  }
  return out;
}

function sanitizeLevelConfigs(list: unknown[]): LevelConfig[] {
  const out: LevelConfig[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    if (typeof c.code !== 'string' || typeof c.number !== 'string' || typeof c.label !== 'string' || typeof c.color !== 'string') continue;
    out.push(carryUnknownFields({
      code: c.code,
      number: c.number,
      label: c.label,
      color: c.color,
      cost: typeof c.cost === 'number' && Number.isFinite(c.cost) ? c.cost : undefined,
    }, c, LEVEL_CONFIG_KEYS));
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
    // v2.3.1（F-08）：保留评估自然日；缺失不回填（由 assessmentDayOf 按 assessedAt 本地回推，不伪造事实）。
    if (typeof a.assessmentDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.assessmentDay)) {
      assessment.assessmentDay = a.assessmentDay;
    }
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

/**
 * 以部门树为准，把树内已有岗位引用同步到名册中**缺失**的同一员工（v2.3.1 F-09）。
 *
 * 背景：v2.1.1 的 v1→v2 迁移只给部门树里的员工套岗，从未触碰名册 `allEmployeesFlat`；
 * 而 v3→v4 迁移的 legacy 任职种子却以名册为准 → 老用户升级后：
 *   ① 首屏弹「画布与名册的岗位引用不一致」；② 匹配三态把全员判成「未套岗」；
 *   ③ 一条 legacy 任职关系都建不出来（旧任职历史被静默判为「从未任职」）。
 *
 * 边界（与「迁移不伪造事实」一致）：
 * - 只补**缺失**的 positionId，绝不覆盖名册里已存在的值 —— 名册与树真正冲突时
 *   仍由 `inspectPlacements` 如实报给用户，不静默抹平；
 * - 树内没有该员工（未入架构）时不补，保持「未知」。
 */
function alignRosterPositionsFromTree(departments: Department[], roster: Employee[]): void {
  if (roster.length === 0) return;
  const positionByEmployeeId = new Map<string, string>();
  const walk = (list: Department[]) => {
    for (const d of list) {
      for (const e of d.employees) {
        if (e.isVirtual) continue;
        if (typeof e.id === 'string' && typeof e.positionId === 'string' && !positionByEmployeeId.has(e.id)) {
          positionByEmployeeId.set(e.id, e.positionId);
        }
      }
      walk(d.children ?? []);
    }
  };
  walk(departments);
  if (positionByEmployeeId.size === 0) return;
  for (const e of roster) {
    if (e.isVirtual) continue;
    if (e.positionId == null) {
      const pid = positionByEmployeeId.get(e.id);
      if (pid) e.positionId = pid;
    }
  }
}

function sanitizeScenario(raw: Record<string, unknown>, index: number): Scenario | null {
  const now = new Date().toISOString();
  const id = typeof raw.id === 'string' ? raw.id : uid('scene');
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : `场景 ${index + 1}`;
  const departments = Array.isArray(raw.departments) ? sanitizeDepartments(raw.departments) : [];
  const allEmployeesFlat = Array.isArray(raw.allEmployeesFlat)
    ? (raw.allEmployeesFlat as Employee[]).filter((e) => e && typeof e.id === 'string')
    : [];
  // v2.3.1（F-09）：先对齐名册的岗位引用（只补缺失），再做 legacy 任职种子。
  alignRosterPositionsFromTree(departments, allEmployeesFlat);
  const levelConfigs = Array.isArray(raw.levelConfigs) ? sanitizeLevelConfigs(raw.levelConfigs) : DEFAULT_LEVELS.map((c) => ({ ...c }));

  const canvasRaw = raw.canvas && typeof raw.canvas === 'object' ? (raw.canvas as Record<string, unknown>) : {};
  const canvas: ScenarioCanvas = {
    zoom:
      typeof canvasRaw.zoom === 'number' && Number.isFinite(canvasRaw.zoom)
        ? Math.round(Math.min(Math.max(canvasRaw.zoom, 50), 200))
        : 100,
    lastFocusedDeptId: typeof canvasRaw.lastFocusedDeptId === 'string' ? canvasRaw.lastFocusedDeptId : undefined,
  };

  return carryUnknownFields({
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
  }, raw, SCENARIO_KEYS);
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

/**
 * 从文件读取数据模型版本（v2.3.1 Q-11）。
 * - 数字 → 原值；
 * - 纯数字字符串（如 "5"）→ 按数字处理，**不得绕过「高版本拒绝」**；
 * - 缺失 / 非数字 → undefined（意为「按当前格式对待」，不做任何迁移与推断）。
 */
export function readProjectVersion(data: Record<string, unknown>): number | undefined {
  const v = data.version;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
}

/** 将已支持版本迁移到当前 PROJECT_VERSION；更高版本在 parseProject 入口拒绝。 */
function migrateToCurrent(data: Record<string, unknown>): Record<string, unknown> {
  // v2.3.1（Q-11）：旧实现把「缺失/非数字版本」当作 v1 → 会跑 v1→v2 迁移，
  // 把「已有岗位引用」的员工按部门默认岗位重新套岗（**伪造人岗关联**）。
  // 没有版本号不等于最老的版本，按当前格式对待才是不臆造事实的做法。
  let v = readProjectVersion(data) ?? PROJECT_VERSION;
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
  // v2.3.1（Q-11）：字符串版本 "5" 也必须被识别并拒绝（旧实现只认 number → 被当成无版本而放行）。
  const inputVersion = readProjectVersion(data as Record<string, unknown>);
  if (inputVersion !== undefined && inputVersion > PROJECT_VERSION) throw new UnsupportedProjectVersionError(inputVersion);
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

  return carryUnknownFields({
    id: typeof p.id === 'string' ? p.id : uid('proj'),
    name,
    version,
    currentScenarioId,
    scenarios,
    meta: carryUnknownFields({
      createdAt: typeof metaRaw.createdAt === 'string' ? metaRaw.createdAt : now,
      updatedAt: typeof metaRaw.updatedAt === 'string' ? metaRaw.updatedAt : now,
      version,
    }, metaRaw, META_KEYS),
  }, p, PROJECT_KEYS);
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

/** —— v2.3.1（F-12）：破坏性写入前的可恢复快照 —— */

const BACKUP_INDEX_KEY = `${PROJECT_BACKUP_KEY}.index`;
/** 最多保留的快照份数（超出按时间从旧到新淘汰，避免 localStorage 无限增长）。 */
const MAX_SNAPSHOTS = 5;

export interface ProjectBackupInfo {
  /** localStorage key */
  key: string;
  /** 快照时间（ISO） */
  at: string;
  /** 触发原因（导入 / 清空 / 恢复） */
  reason: string;
}

/** 读取快照索引（损坏时回退为空数组，不阻塞主流程）。 */
export function listProjectBackups(): ProjectBackupInfo[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(BACKUP_INDEX_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is ProjectBackupInfo =>
        !!x && typeof x === 'object' && typeof (x as ProjectBackupInfo).key === 'string' && typeof (x as ProjectBackupInfo).at === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * 破坏性写入（导入 .orgproj / 清空工作区 / 恢复快照）前，把当前自动保存**原样**快照一份。
 *
 * 背景（v2.3.1 F-12）：导入与清空会整体覆盖 `PROJECT_STORAGE_KEY`（唯一持久化副本），
 * 而此前的备份只在「存量格式 < 4 且本次 ≥ 4」这个一次性迁移窗口里发生 →
 * 误选一个 .orgproj 就会把多个场景的工作区覆盖且不可回退。
 *
 * @returns 是否真的写入了快照（没有现存数据 / 存储不可用时为 false）
 */
export function snapshotCurrentProject(reason: string): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    const raw = localStorage.getItem(PROJECT_STORAGE_KEY);
    if (!raw) return false;
    const at = new Date().toISOString();
    // 快照键必须唯一：同一毫秒内连续快照（导入后立刻恢复等）若复用同名键，
    // 淘汰旧项时会把仍被索引引用的键删掉，导致「有记录、无内容」。
    const key = `${PROJECT_BACKUP_KEY}.${at}.${uid('bk')}`;
    localStorage.setItem(key, raw);
    const index = listProjectBackups();
    index.unshift({ key, at, reason });
    while (index.length > MAX_SNAPSHOTS) {
      const dropped = index.pop();
      if (dropped) localStorage.removeItem(dropped.key);
    }
    localStorage.setItem(BACKUP_INDEX_KEY, JSON.stringify(index));
    return true;
  } catch (error) {
    console.error('写入项目快照失败:', error);
    return false;
  }
}

/** 读取快照并解析为 ProjectFile（不可解析/不存在返回 null）。 */
export function readProjectBackup(key: string): ProjectFile | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const json = decodeStoredProject(raw);
    if (!json) return null;
    return parseProject(json);
  } catch (error) {
    console.error('读取项目快照失败:', error);
    return null;
  }
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
