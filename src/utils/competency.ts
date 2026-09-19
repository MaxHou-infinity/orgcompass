import type {
  Assessment,
  AssessmentScope,
  CompetencyGroup,
  CompetencyModel,
  Department,
  Employee,
  Position,
  PositionAssignment,
} from '../types';
import { HealthStatus, parseLevelNumber } from './analytics';

/**
 * —— v2.2.0 胜任度引擎：派生纯函数（design doc §5）——
 *
 * 全部为纯函数、可单测、无 UI/IO 副作用。派生值（gap / worstGap / 灯号 / totalScore /
 * not_competent 候选）一律运行时计算，**不落库**；落库只有 Assessment 原始事实
 * （score/requirement/scale/assessorRole/assessorId/assessedAt/source/note）与
 * PositionAssignment 确认事实（status/confirmedBy/confirmedAt）。
 *
 * 红线：不替用户下结论、不自动定级；未评估 = 中性灰（不伪装绿/红）；
 * 灯号只由最差维度 Gap 决定（木桶原则），权重只影响总分排序。
 */

/** —— §5.2 基准（要求分）与维度 key 生成 —— */

/** 职级数字 → 要求分：n<3→3；n≥3→4；NA(null)→3。不设 5（5 留高潜识别）。 */
export function levelRequirement(n: number | null): number {
  return n == null ? 3 : n >= 3 ? 4 : 3;
}

/** B2 岗位带宽（levelBandMin）→ 要求分：parseLevelNumber(levelBandMin) → levelRequirement；
 *  无 levelBandMin 或无法解析 → null。 */
export function positionBandRequirement(position: Position | undefined): number | null {
  if (!position || !position.levelBandMin) return null;
  const n = parseLevelNumber(position.levelBandMin);
  return n == null ? null : levelRequirement(n);
}

/** 基准档位解析：返回单一 b∈{1..5}，套用到该员工所有维度作 requirement。
 *  优先级 B3 显式 > B2 岗位带宽(levelBandMin) > B1 职级(level) > 缺省 3。 */
export function benchmarkFor(employee: Employee, position?: Position, explicit?: number): number {
  if (explicit != null && explicit >= 1 && explicit <= 5) return explicit; // B3 显式
  const b2 = positionBandRequirement(position); // B2 岗位带宽 → 要求分
  if (b2 != null && b2 >= 1 && b2 <= 5) return b2;
  return levelRequirement(parseLevelNumber(employee.level)); // B1 职级 → 要求分（缺省 3 兜底）
}

/** 生成用户自定义维度 key：`custom_<slug>_<rand6>`，严格匹配 /^[a-z][a-z0-9_]*$/。
 *  中文/不可 slug 化 label 回退 'dim'；随机后缀保证唯一。 */
export function genDimensionKey(label: string): string {
  const slug =
    (label ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24) || 'dim';
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let rand = '';
  for (let i = 0; i < 6; i += 1) rand += chars[Math.floor(Math.random() * chars.length)];
  return `custom_${slug}_${rand}`;
}

/** —— §5.3 维度级 Gap / 灯号 —— */

/** 维度 Gap = requirement − score（整数档；正 = 不足） */
export function dimensionGap(score: number, requirement: number): number {
  return requirement - score;
}

/** 木桶灯号（固定档位，不可调）：worstGap ≤0 → healthy；==1 → warn；≥2 → danger。 */
export function gapStatusFromWorstGap(worstGap: number): HealthStatus {
  if (worstGap <= 0) return 'healthy';
  if (worstGap === 1) return 'warn';
  return 'danger';
}

/** —— §5.4 取数规则（未评估 ≠ 0）——
 *  v2.3 M2 重写：适用范围筛选 + 同日修订链 + 冲突显式标记，替代 F03「同时间先写入者获胜」。
 */

/** 员工当前人岗语境（适用范围判定输入）。App 必须传全量字段；缺省字段会降级为「无法核对」。 */
export interface CompetencyScopeContext {
  /** 应评维度分组（当前分类）。缺省 undefined = 模型全部启用维度（旧调用兼容）。 */
  expectedGroup?: CompetencyGroup;
  /** 当前有效主岗任职关系 id（无套岗 = undefined）。 */
  currentRelationId?: string;
  /** 当前主岗岗位 id。 */
  currentPositionId?: string;
  /** 该员工全部人岗关系；未提供（undefined）= 无法核对任职，仅按岗位匹配。 */
  assignments?: PositionAssignment[];
}

/** 单条评分相对当前任职的适用范围。 */
export type AssessmentApplicability =
  | 'current' // 绑定当前任职关系（relationId 命中）
  | 'current-position' // 旧记录：按当前岗位唯一对上，未绑定关系 ID（来源须标明）
  | 'general' // 通用评价（明确无岗位限制）
  | 'historical'; // 历史岗位评价：适用性待复核，不自动成为当前结论

/** 评价适用范围：显式字段优先；旧记录按 positionId 有无推断（sanitize 不回填伪造）。 */
export function assessmentScopeOf(a: { scope?: AssessmentScope; positionId?: string }): AssessmentScope {
  if (a.scope === 'position' || a.scope === 'general') return a.scope;
  return a.positionId ? 'position' : 'general';
}

/**
 * 评估「自然日」——同日判定的唯一键（v2.3.1 F-08 新增）。
 *
 * 背景：`assessedAt` 是**时刻**，却被当作「同一评估时点」的判定键，而全仓存在两种写入语义：
 * - 批量评估（`BatchAssessmentModal`）：`new Date(\`${date}T12:00:00\`).toISOString()` —— 本地正午归一；
 * - 评分导入（`App.handleImportAssessmentExcel`）：日期列留空时用 `new Date().toISOString()` —— 真实时刻。
 *
 * 后果（与直觉相反）：**同一自然日不被判定为同日**。本地正午可能晚于真实时钟
 * （UTC+8 上午 9 点写入 = 04:00Z，10 点的真实写入 = 02:00Z），于是后写入的记录被当作更早，
 * 既不建立修订边、也不进 `latest` 分组 → **用户刚录入/导入的分数在所有派生视图里永不生效，
 * 且没有任何提示**。
 *
 * 这里用「自然日」做同日键，`assessedAt` 退化为记录时刻：
 * - 新记录写入时显式带上 `assessmentDay`（本地自然日）；
 * - 旧记录没有该字段 → 由 `assessedAt` 按**本地时区**回推自然日（不改写数据、不伪造事实）。
 */
export function assessmentDayOf(a: Pick<Assessment, 'assessmentDay' | 'assessedAt'>): string {
  if (typeof a.assessmentDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.assessmentDay)) return a.assessmentDay;
  return localDayOf(a.assessedAt);
}

/** ISO 时刻 → 本地自然日 `YYYY-MM-DD`（无法解析时退化为原字符串前 10 位，保证可比较）。 */
export function localDayOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 同一人 / 范围 / 维度 / 角色 / **评估日** 的当前修订链终点（写入层关联 revisionOf 用）。 */
export function currentRevisionEndpoint(
  assessments: Assessment[],
  candidate: Pick<Assessment, 'employeeId' | 'dimension' | 'assessorRole' | 'assessedAt' | 'scope' | 'positionId' | 'relationId'> & { assessmentDay?: string },
): Assessment | undefined {
  const scope = assessmentScopeOf(candidate);
  const day = assessmentDayOf(candidate);
  const sameTime = assessments.filter(
    (a) =>
      a.employeeId === candidate.employeeId &&
      a.dimension === candidate.dimension &&
      a.assessorRole === candidate.assessorRole &&
      assessmentDayOf(a) === day &&
      assessmentScopeOf(a) === scope &&
      (a.positionId ?? '') === (candidate.positionId ?? '') &&
      (a.relationId ?? '') === (candidate.relationId ?? ''),
  );
  if (sameTime.length === 0) return undefined;
  const superseded = new Set(sameTime.map((a) => a.revisionOf).filter((x): x is string => !!x));
  return sameTime.find((a) => !superseded.has(a.id));
}

/**
 * 判定一条评分相对当前任职的适用范围（契约 §4.1）。
 * - 通用评价 → general；
 * - 岗位评价带 relationId → 命中当前关系 = current，否则 historical；
 * - 旧记录无 relationId → 仅在「岗位一致 + 唯一在任主岗 + 未曾离岗再回同岗」时算 current-position，
 *   其余一律 historical（不自动用于当前岗位结论）。
 */
export function assessmentApplicability(
  a: Assessment,
  ctx: CompetencyScopeContext = {},
): AssessmentApplicability {
  if (assessmentScopeOf(a) === 'general') return 'general';
  if (a.relationId) return a.relationId === ctx.currentRelationId ? 'current' : 'historical';
  if (!ctx.currentPositionId || a.positionId !== ctx.currentPositionId) return 'historical';
  if (ctx.assignments === undefined) return 'current-position'; // 未提供关系表 → 仅按岗位匹配
  const primaries = ctx.assignments.filter((r) => r.employeeId === a.employeeId && r.type === 'primary');
  const active = primaries.filter((r) => r.status === 'active' && !r.endDate);
  if (active.length !== 1) return 'historical'; // 无在任/多条在任 → 无法核对
  if (primaries.some((r) => r.endDate && r.positionId === a.positionId)) return 'historical'; // 曾离岗再回
  return 'current-position';
}

/** 同一时点两条记录是否内容完全一致（用于折叠重复，不折叠冲突）。 */
function sameContent(x: Assessment, y: Assessment): boolean {
  return x.score === y.score && x.requirement === y.requirement
    && (x.note ?? '') === (y.note ?? '')
    && (x.positionId ?? '') === (y.positionId ?? '')
    && (x.relationId ?? '') === (y.relationId ?? '')
    && assessmentScopeOf(x) === assessmentScopeOf(y);
}

/** 修订链校验：修订必须属于同一人、范围、维度、角色、评估日（契约 §4.2.4）。 */
export function revisionLinkIssue(target: Assessment, revision: Assessment): string | undefined {
  if (target.id === revision.id) return '修订不能指向自身';
  if (target.employeeId !== revision.employeeId) return '修订不能跨员工';
  if (target.dimension !== revision.dimension) return '修订不能跨维度';
  if (target.assessorRole !== revision.assessorRole) return '修订不能跨评分角色';
  // v2.3.1（F-08）：同日判定用自然日，避免「本地正午归一 vs 真实时刻」把同一天的纠正判成跨时点。
  if (assessmentDayOf(target) !== assessmentDayOf(revision)) return '修订不能跨评估日';
  if (assessmentScopeOf(target) !== assessmentScopeOf(revision)) return '修订不能跨评价适用范围';
  if (assessmentScopeOf(target) === 'position'
    && (target.positionId ?? '') !== (revision.positionId ?? '')) return '修订不能跨岗位';
  return undefined;
}

/**
 * 修订链校验（整批）：检查引用存在、同组、无环、无分叉。
 * 返回问题说明；无问题返回 undefined。写入前调用（A18：无效修订链拒绝写入）。
 */
export function revisionChainIssue(assessments: Assessment[], revision: Assessment): string | undefined {
  if (!revision.revisionOf) return undefined;
  const prior = assessments.find((a) => a.id === revision.revisionOf);
  if (!prior) return '被修订记录不存在';
  const linkIssue = revisionLinkIssue(prior, revision);
  if (linkIssue) return linkIssue;
  // 环检测：沿 revisionOf 向上追溯
  const byId = new Map(assessments.map((a) => [a.id, a]));
  const seen = new Set<string>([revision.id]);
  let cursor: Assessment | undefined = prior;
  while (cursor) {
    if (seen.has(cursor.id)) return '修订链存在循环引用';
    seen.add(cursor.id);
    cursor = cursor.revisionOf ? byId.get(cursor.revisionOf) : undefined;
  }
  // 分叉检测：同一被修订记录已有一条纠正记录
  if (assessments.some((a) => a.revisionOf === revision.revisionOf)) return '同一记录已存在修订，不能无提示分叉';
  return undefined;
}

/** 单维度取数结果：有效记录 + 适用范围 + 冲突/重复/修订留痕。 */
export interface ResolvedAssessment {
  /** 有效记录（修订链终点）；无适用记录或存在未解决冲突 → null */
  effective: Assessment | null;
  /** 有效记录的适用范围（effective 为 null 时表示该维度最高适用层级） */
  applicability: AssessmentApplicability | 'none';
  /** 是否存在未解决冲突（同一时点内容冲突且无修订关系） */
  conflict: boolean;
  /** 是否折叠了内容完全一致的重复记录（原记录保留） */
  duplicate: boolean;
  /** 修订链上被替代的历史记录 id（保留可查） */
  revisedIds: string[];
  /** 该维度全部原始记录 id（含历史岗位评价） */
  allIds: string[];
  /** 是否存在「仅历史岗位评价、无当前适用记录」 */
  historicalOnly: boolean;
}

const EMPTY_RESOLUTION: ResolvedAssessment = {
  effective: null,
  applicability: 'none',
  conflict: false,
  duplicate: false,
  revisedIds: [],
  allIds: [],
  historicalOnly: false,
};

/**
 * 取某员工某维度的当前有效 supervisor 评分（契约 §4.2）：
 * 1) 先按适用范围筛选（historical 不参与当前结论）；
 * 2) 取最新适用评估时点；
 * 3) 该时点内按 revisionOf 解析修订链终点；
 * 4) 无修订关系且内容冲突 → conflict，不按数组顺序任选；内容一致 → 折叠为 duplicate。
 */
export function resolveSupervisorAssessment(
  assessments: Assessment[],
  employeeId: string,
  dimension: string,
  ctx: CompetencyScopeContext = {},
): ResolvedAssessment {
  const all = assessments.filter(
    (a) => a.employeeId === employeeId && a.dimension === dimension && a.assessorRole === 'supervisor',
  );
  if (all.length === 0) return EMPTY_RESOLUTION;

  // §4.1 先按来源优先级选层（当前任职 > 旧记录按当前岗位核对 > 通用评价），再在层内取最新时点。
  const TIER_RANK: Record<AssessmentApplicability, number> = { current: 0, 'current-position': 1, general: 2, historical: 3 };
  const applicable = all
    .map((a) => ({ a, tier: assessmentApplicability(a, ctx) }))
    .filter((x) => x.tier !== 'historical');
  if (applicable.length === 0) {
    return { ...EMPTY_RESOLUTION, allIds: all.map((a) => a.id), historicalOnly: true };
  }
  const bestRank = applicable.reduce((min, x) => Math.min(min, TIER_RANK[x.tier]), 3);
  const tierRecords = applicable.filter((x) => TIER_RANK[x.tier] === bestRank).map((x) => x.a);

  // v2.3.1（F-08）：分组键从「时刻」改为「自然日」。
  // 旧实现按 assessedAt 全等分组：同一天由不同入口写入（本地正午归一 vs 真实时刻）会落到不同组，
  // 后写入的那条既不在组内、也不成为端点 → 既不建立修订边、也不报冲突，直接**静默失效**。
  let latestDay = '';
  for (const a of tierRecords) {
    const day = assessmentDayOf(a);
    if (day > latestDay) latestDay = day;
  }
  const group = tierRecords.filter((a) => assessmentDayOf(a) === latestDay);

  const byId = new Map(group.map((a) => [a.id, a]));
  // 修订边：仅在组内、且满足同人/同范围/同维度/同角色/同时点时生效；非法边按「无关系」处理并计入冲突。
  let invalidLink = false;
  const successor = new Map<string, string[]>();
  const superseded = new Set<string>(); // 被修订（历史保留）的记录 id
  for (const a of group) {
    if (!a.revisionOf) continue;
    const target = byId.get(a.revisionOf);
    if (!target || revisionLinkIssue(target, a)) {
      invalidLink = true;
      continue;
    }
    const list = successor.get(target.id) ?? [];
    list.push(a.id);
    successor.set(target.id, list);
    superseded.add(target.id);
  }

  const applicability = assessmentApplicability(group[0], ctx);
  const base = { applicability, allIds: all.map((a) => a.id), historicalOnly: false };

  // 环检测（修订边构成闭环 → 数据问题，不产出有效记录）
  const cyclic = new Set<string>();
  for (const start of group) {
    const seen = new Set<string>();
    let cursor: string | undefined = start.id;
    while (cursor) {
      if (seen.has(cursor)) { for (const id of seen) cyclic.add(id); break; }
      seen.add(cursor);
      cursor = successor.get(cursor)?.[0];
    }
  }
  if (cyclic.size > 0 || invalidLink) {
    return { ...EMPTY_RESOLUTION, ...base, conflict: true };
  }

  const endpoints = group.filter((a) => !(successor.get(a.id)?.length));
  if (endpoints.length === 0) return { ...EMPTY_RESOLUTION, ...base, conflict: true };

  if (endpoints.length > 1) {
    const first = endpoints[0];
    const identical = endpoints.every((a) => sameContent(first, a));
    if (!identical) return { ...EMPTY_RESOLUTION, ...base, conflict: true };
    // 内容完全一致 → 折叠展示（保留原记录），确定性取 createdAt/id 最小者
    const picked = [...endpoints].sort((a, b) =>
      a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt))[0];
    return { ...base, effective: picked, conflict: false, duplicate: true, revisedIds: [...superseded].filter((id) => id !== picked.id) };
  }

  const endpoint = endpoints[0];
  return {
    ...base,
    effective: endpoint,
    conflict: false,
    duplicate: false,
    revisedIds: [...superseded].filter((id) => id !== endpoint.id),
  };
}

/** 某员工某维度当前有效评估：assessorRole==='supervisor' 且通过适用范围/修订链解析。
 *  hrbp 校准分并列呈现、不参与 Gap/灯号；self/peer/subordinate 未实现、不参与。
 *  存在未解决冲突 → null（由 resolveSupervisorAssessment 标记 conflict）。 */
export function latestSupervisorAssessment(
  assessments: Assessment[],
  employeeId: string,
  dimension: string,
  ctx?: CompetencyScopeContext,
): Assessment | null {
  return resolveSupervisorAssessment(assessments, employeeId, dimension, ctx).effective;
}

/**
 * 某员工某维度最新 HRBP 校准分（并列对照；不参与灯号/完整度分子）。
 *
 * v2.3.1（Q-18）：与上级评分同样必须过**岗位适用性**。
 * 旧实现不看 ctx/relationId —— 员工从 P1 调到 P2 后，P1 期间录的校准分仍作为 P2 的「当前校准」展示，
 * 且没有任何「适用性待复核」标记（上级分有，校准分没有），两者口径不一致。
 */
export function latestHrbpAssessment(
  assessments: Assessment[],
  employeeId: string,
  dimension: string,
  ctx?: CompetencyScopeContext,
): Assessment | null {
  let best: Assessment | null = null;
  for (const a of assessments) {
    if (a.employeeId !== employeeId || a.dimension !== dimension) continue;
    if (a.assessorRole !== 'hrbp') continue;
    if (ctx && assessmentApplicability(a, ctx) === 'historical') continue;
    if (best === null || a.assessedAt > best.assessedAt) best = a;
  }
  return best;
}

/** 由「生效评分 + 适用范围 + 校准分」构造可追溯的维度派生值（灯号 = 木桶 worstGap）。 */
function deriveDimension(
  dim: { key: string; label: string; definition: string; group: CompetencyGroup },
  a: Assessment,
  resolved: ResolvedAssessment,
  hrbp: Assessment | null,
  hrbpApplicability?: AssessmentApplicability,
): CompetencyDimensionDerived {
  const gap = dimensionGap(a.score, a.requirement);
  return {
    dimension: dim.key,
    label: dim.label,
    definition: dim.definition,
    group: dim.group,
    score: a.score,
    requirement: a.requirement,
    gap,
    status: gapStatusFromWorstGap(gap),
    assessmentId: a.id,
    assessedAt: a.assessedAt,
    ...(a.assessorId ? { assessorId: a.assessorId } : {}),
    applicability:
      resolved.applicability === 'general' || resolved.applicability === 'current-position'
        ? resolved.applicability
        : 'current',
    revised: resolved.revisedIds.length > 0,
    duplicate: resolved.duplicate,
    hrbpCalibration: hrbp
      ? {
          assessmentId: hrbp.id,
          score: hrbp.score,
          requirement: hrbp.requirement,
          assessedAt: hrbp.assessedAt,
          ...(hrbp.assessorId ? { assessorId: hrbp.assessorId } : {}),
          ...(hrbpApplicability ? { applicability: hrbpApplicability } : {}),
        }
      : null,
  };
}

/** —— §5.5 权重归一化（只影响总分，不影响灯号） —— */

/** 在「已评估维度」间归一化权重（未评估维度不参与总分）。跨组统一归一（干部+员工都有评时合并算）。
 *  只计入 enabled 维度；assessedKeys 中不在 model / 已停用的 key 忽略。
 *  权重之和 ≤0 或全部为 0 → 等权（简单平均）。 */
export function normalizedWeights(
  model: CompetencyModel,
  assessedKeys: ReadonlySet<string>,
): Map<string, number> {
  const dims = model.dimensions.filter((d) => d.enabled !== false && assessedKeys.has(d.key));
  const out = new Map<string, number>();
  if (dims.length === 0) return out;
  const sum = dims.reduce((s, d) => s + (Number.isFinite(d.weight) ? d.weight : 0), 0);
  if (sum <= 0) {
    const w = 1 / dims.length;
    for (const d of dims) out.set(d.key, w);
    return out;
  }
  for (const d of dims) out.set(d.key, d.weight / sum);
  return out;
}

/** —— §5.6 汇总类型 + 入口 —— */

export interface CompetencyDimensionDerived {
  dimension: string; // key（FK）
  label: string; // 从 model 查（可改显示名）
  definition: string; // 从 model 查（AI 语义 + 详情展示）
  group: CompetencyGroup;
  score: number; // supervisor 原始分（1..5）
  requirement: number; // 快照要求分（1..5）
  gap: number; // requirement − score
  status: HealthStatus; // gap≤0 healthy / ==1 warn / ≥2 danger
  // —— v2.3 M2：能力信号可追溯（契约 §5.2「可追到采用的评分、要求分、维度及来源」）——
  /** 采用的评分记录 id */
  assessmentId: string;
  /** 该记录的评估时点 */
  assessedAt: string;
  /** 该记录的实际评分人（本地无账号体系，为录入身份） */
  assessorId?: string;
  /** 来源：当前任职 / 旧记录按当前岗位匹配 / 通用评价 */
  applicability: 'current' | 'current-position' | 'general';
  /** 该维度存在同日修订链，旧分保留可查 */
  revised: boolean;
  /** 该维度同日内容一致的重复记录已折叠（原记录保留） */
  duplicate: boolean;
  /** HRBP 校准对照（并列，不参与灯号与完整度） */
  hrbpCalibration: {
    assessmentId: string;
    score: number;
    requirement: number;
    assessedAt: string;
    assessorId?: string;
    /** v2.3.1（Q-18）：校准分的岗位适用性；historical = 换岗后的旧岗位校准分，仅历史可见 */
    applicability?: AssessmentApplicability;
  } | null;
}

/** v2.3 M2：评分完整度（契约 §4.3）。完整度与能力灯号分开，部分达标不算完整达标。 */
export type CompletenessStatus = 'model-unconfigured' | 'unrated' | 'partial' | 'complete';

export interface CompetencyCompleteness {
  status: CompletenessStatus;
  /** 应评维度数（当前分类下启用维度）；模型未配置 = 0，分母不可算 */
  expected: number;
  /** 有效已评维度数（有唯一有效且适用的 supervisor 评分） */
  assessed: number;
  /** 存在未解决冲突的应评维度 key（不进入已评分子，历史可见） */
  conflicted: string[];
  /** 只有历史岗位评价、未计入的应评维度 key（适用性待复核） */
  historical: string[];
  /** 完整已评且灯号为 healthy —— 部门「完整达标人数」唯一计数口径 */
  qualified: boolean;
  /** 分母是否可算（模型未配置 → false） */
  computable: boolean;
  /** 是否存在未解决冲突（存在数据问题） */
  dataIssue: boolean;
}

export interface CompetencySummary {
  employeeId: string;
  /** 当前分类分组（提供 expectedGroup 时 = expectedGroup）；无评估且无分组 → null。仅 UI 分组用，不影响 overall 计算。 */
  group: CompetencyGroup | null;
  dimensions: CompetencyDimensionDerived[];
  /** 缺全部有效维度 → null（整体未评估） */
  overall: {
    score: number; // totalScore = Σ(score×归一化权重)（仅排序/九宫格，不判灯）
    gap: number; // Σ(requirement×归一化权重) − score（仅展示，不判灯）
    worstGap: number; // max(已评估维度 dimensionGap) —— 唯一决定灯号
    status: HealthStatus; // gapStatusFromWorstGap(worstGap)
  } | null;
  notCompetentCandidate: boolean; // overall.status === 'danger'（worstGap ≥ 2）
  assessedBy: string[]; // 评分人去重
  latestAssessedAt: string | null;
  /** v2.3 M2：完整度（应评/已评/冲突/历史），与灯号分开表达 */
  completeness: CompetencyCompleteness;
}

/** 未评占位完整度（模型可算、0 已评）。 */
function completenessOf(expected: number, assessed: number, conflicted: string[], historical: string[]): CompetencyCompleteness {
  const status: CompletenessStatus =
    expected === 0 ? 'model-unconfigured' : assessed === 0 ? 'unrated' : assessed < expected ? 'partial' : 'complete';
  return {
    status,
    expected,
    assessed,
    conflicted,
    historical,
    qualified: false,
    computable: expected > 0,
    dataIssue: conflicted.length > 0,
  };
}

/** 已评维度的 group 派生：取评估数多的 group；平局取首个已评维度 group（model 顺序）。 */
function deriveGroup(dimensions: CompetencyDimensionDerived[]): CompetencyGroup | null {
  const counts = new Map<CompetencyGroup, number>();
  for (const d of dimensions) counts.set(d.group, (counts.get(d.group) ?? 0) + 1);
  let best: CompetencyGroup | null = null;
  let max = -1;
  for (const [g, c] of counts) {
    if (c > max) {
      best = g;
      max = c;
    }
  }
  return best;
}

/** 应评维度（契约 §4.3）：当前分类下启用的模型维度，按 model 顺序。 */
export function expectedDimensions(model: CompetencyModel, group?: CompetencyGroup) {
  return model.dimensions
    .filter((d) => d.enabled !== false && (group === undefined || d.group === group))
    .slice()
    .sort((a, b) => a.order - b.order);
}

/** 纯函数入口：按「当前分类的应评维度」取唯一有效且适用的 supervisor 评分；
 *  未评估/不适用/冲突维度不进入灯号与完整度分子；无任何有效评估 → null。
 *  ctx 省略时退化为旧行为（应评 = 全部启用维度，不按岗位适用性筛选）。 */
export function computeCompetencySummary(
  assessments: Assessment[],
  employeeId: string,
  model: CompetencyModel,
  ctx?: CompetencyScopeContext,
): CompetencySummary | null {
  const expected = expectedDimensions(model, ctx?.expectedGroup);
  const derived: CompetencyDimensionDerived[] = [];
  const effective: Assessment[] = [];
  const conflicted: string[] = [];
  const historical: string[] = [];
  for (const dim of expected) {
    const resolved = resolveSupervisorAssessment(assessments, employeeId, dim.key, ctx);
    if (resolved.conflict) { conflicted.push(dim.key); continue; }
    if (resolved.historicalOnly) { historical.push(dim.key); continue; }
    const a = resolved.effective;
    if (!a) continue; // 未评估维度不参与（未评估 ≠ 0）
    {
      const hrbp = latestHrbpAssessment(assessments, employeeId, dim.key, ctx);
      derived.push(deriveDimension(dim, a, resolved, hrbp, hrbp ? assessmentApplicability(hrbp, ctx) : undefined));
    }
    effective.push(a);
  }

  const completeness = completenessOf(expected.length, derived.length, conflicted, historical);
  if (derived.length === 0) {
    if (expected.length === 0 && historical.length === 0 && conflicted.length === 0 && ctx?.expectedGroup === undefined) {
      return null; // 旧调用：模型无启用维度 → 整体未评估
    }
    if (ctx?.expectedGroup === undefined) return null;
    // 有明确分类语境：返回完整度占位（未评/模型未配置/仅历史），由 UI 表达，不伪装绿/红
    return {
      employeeId,
      group: ctx.expectedGroup,
      dimensions: [],
      overall: null,
      notCompetentCandidate: false,
      assessedBy: [],
      latestAssessedAt: null,
      completeness,
    };
  }

  const weights = normalizedWeights(model, new Set(derived.map((d) => d.dimension)));
  let scoreSum = 0;
  let reqSum = 0;
  let worstGap = Number.NEGATIVE_INFINITY;
  for (const d of derived) {
    const w = weights.get(d.dimension) ?? 0;
    scoreSum += d.score * w;
    reqSum += d.requirement * w;
    worstGap = Math.max(worstGap, d.gap);
  }
  const status = gapStatusFromWorstGap(worstGap);

  const assessedBy = Array.from(
    new Set(effective.map((a) => a.assessorId).filter((x): x is string => !!x)),
  );
  const latestAssessedAt = effective.reduce<string | null>(
    (max, a) => (max === null || a.assessedAt > max ? a.assessedAt : max),
    null,
  );

  return {
    employeeId,
    group: ctx?.expectedGroup ?? deriveGroup(derived),
    dimensions: derived,
    overall: { score: scoreSum, gap: reqSum - scoreSum, worstGap, status },
    notCompetentCandidate: status === 'danger',
    assessedBy,
    latestAssessedAt,
    completeness: {
      ...completeness,
      qualified: completeness.status === 'complete' && status === 'healthy',
    },
  };
}

/** 未评估/不可算员工的占位汇总（不伪装绿/红）。 */
export function emptyCompetencySummary(
  employeeId: string,
  group: CompetencyGroup | null,
  completeness: CompetencyCompleteness,
): CompetencySummary {
  return {
    employeeId,
    group,
    dimensions: [],
    overall: null,
    notCompetentCandidate: false,
    assessedBy: [],
    latestAssessedAt: null,
    completeness,
  };
}

/** 批量：全量员工 → CompetencySummary[]（**每个员工都返回一条**）。
 *  `contextFor` 提供当前分类与人岗语境；省略时退化为旧行为。 */
export function computeCompetencyStates(
  assessments: Assessment[],
  employees: Employee[],
  model: CompetencyModel,
  contextFor?: (employee: Employee) => CompetencyScopeContext,
): CompetencySummary[] {
  return employees.map((e) => {
    const ctx = contextFor?.(e);
    const s = computeCompetencySummary(assessments, e.id, model, ctx);
    if (s) return s;
    const expected = expectedDimensions(model, ctx?.expectedGroup).length;
    return emptyCompetencySummary(
      e.id,
      ctx?.expectedGroup ?? null,
      completenessOf(expected, 0, [], []),
    );
  });
}

/** —— §5.7 历史轨迹 + orphan 语义 —— */

/** 某员工全部评估历史（含软删维度、orphan 维度），按最近评估 assessedAt 降序分组。
 *  供 CompetencyDetailModal「历史轨迹」用——当前灯号只看 enabled 维度，历史要能看到被删维度的旧分。 */
export function listAssessmentHistory(
  assessments: Assessment[],
  employeeId: string,
  model: CompetencyModel,
): Array<{
  dimension: string;
  /** 维度显示名：model 查得到 → label；查不到（orphan）→ 回退用 key 本身，标注「维度已删除」 */
  label: string;
  definition: string; // orphan → '（维度已删除，定义不可用）'
  enabled: boolean; // 当前是否启用（软删维度 = false，历史可见、当前不计）
  orphan: boolean; // key 不在 model 中 → true（运行时降级，非落库字段）
  group: CompetencyGroup | null;
  records: Assessment[]; // 该维度历次评分（含 supervisor/hrbp），assessedAt 升序
}> {
  const byDim = new Map<string, Assessment[]>();
  for (const a of assessments) {
    if (a.employeeId !== employeeId) continue;
    const list = byDim.get(a.dimension) ?? [];
    list.push(a);
    byDim.set(a.dimension, list);
  }
  const groups = Array.from(byDim.entries());
  for (const [, list] of groups) {
    list.sort((x, y) => x.assessedAt.localeCompare(y.assessedAt)); // 组内升序
  }
  groups.sort((a, b) => {
    const la = a[1][a[1].length - 1].assessedAt;
    const lb = b[1][b[1].length - 1].assessedAt;
    return lb.localeCompare(la); // 组间按最近评估降序
  });
  return groups.map(([dim, records]) => {
    const def = model.dimensions.find((d) => d.key === dim);
    return {
      dimension: dim,
      label: def ? def.label : dim,
      definition: def ? def.definition : '（维度已删除，定义不可用）',
      enabled: def ? def.enabled !== false : false,
      orphan: !def,
      group: def ? def.group : null,
      records,
    };
  });
}

/** —— §5.8 干部「领导力档案」（纯呈现，不输出定级结论） —— */

export interface LeadershipDossier {
  employeeId: string;
  targetLevel?: string; // 复用 Employee.targetLevel（干部语义 = 目标管理职级）
  dimensions: CompetencyDimensionDerived[]; // 仅 group==='leadership' 且 enabled 的维度
  overall: { score: number; gap: number; worstGap: number; status: HealthStatus } | null;
  // ❌ 无「建议定级」输出（roadmap §7 #8：砍 suggestLeadershipGrade）
}

export function buildLeadershipDossier(
  assessments: Assessment[],
  employeeId: string,
  model: CompetencyModel,
  targetLevel?: string,
  ctx?: CompetencyScopeContext,
): LeadershipDossier | null {
  const derived: CompetencyDimensionDerived[] = [];
  for (const dim of model.dimensions) {
    if (dim.group !== 'leadership' || dim.enabled === false) continue;
    const resolved = resolveSupervisorAssessment(assessments, employeeId, dim.key, ctx);
    const a = resolved.effective;
    if (resolved.conflict || !a) continue; // 冲突维度不进结论，历史可查
    {
      const hrbp = latestHrbpAssessment(assessments, employeeId, dim.key, ctx);
      derived.push(deriveDimension(dim, a, resolved, hrbp, hrbp ? assessmentApplicability(hrbp, ctx) : undefined));
    }
  }
  if (derived.length === 0) return null;

  const weights = normalizedWeights(model, new Set(derived.map((d) => d.dimension)));
  let scoreSum = 0;
  let reqSum = 0;
  let worstGap = Number.NEGATIVE_INFINITY;
  for (const d of derived) {
    const w = weights.get(d.dimension) ?? 0;
    scoreSum += d.score * w;
    reqSum += d.requirement * w;
    worstGap = Math.max(worstGap, d.gap);
  }
  const status = gapStatusFromWorstGap(worstGap);

  return {
    employeeId,
    ...(targetLevel !== undefined ? { targetLevel } : {}),
    dimensions: derived,
    overall: { score: scoreSum, gap: reqSum - scoreSum, worstGap, status },
  };
}

/** —— §2 D7：干部/员工识别规则（供 UI 选模型与展示分组） —— */

/** 干部（领导力模型）判定：是某部门负责人（递归整树），或有直管下属（reportsToEmployeeId 指向它）。
 *  归属模型最终以已评维度的 group 为准；isManager 只用于 UI 决定「默认铺哪些维度列 / 默认折叠哪组」。
 *  v2.3.1（Q-24）：单点 API 委托给批量实现，保证与 `computeManagerIdSet` 单一规则、不会漂移。 */
export function isManager(
  employeeId: string,
  departments: Department[],
  allEmployees: Employee[],
): boolean {
  return computeManagerIdSet(departments, allEmployees).has(employeeId);
}

/**
 * 批量计算「干部（管理者）」内部 id 集合（v2.3.1 Q-24 / Q-33）。
 *
 * `isManager` 是单点 API：每次调用都要 find 员工 + 递归遍历部门树 + 全表扫直管关系。
 * 批量场景（批量评估范围、看板完整度分类）对每个员工各调一次 → O(员工 × (部门 + 员工))；
 * 且 App 与批量评估此前各自实现过一份等价规则（双实现一旦漂移，就会出现
 * 「按干部评分、按员工模型算完整度」的静默错配）。
 *
 * 本函数一次遍历得到全量结果，判定规则与 `isManager` 完全一致：
 * - 是本部门（含任意层级）的负责人（leaderId 命中内部 id 或工号）；或
 * - 是某个非虚拟员工的直接上级（reportsToEmployeeId 命中），且不是自己汇报给自己。
 */
export function computeManagerIdSet(departments: Department[], allEmployees: Employee[]): Set<string> {
  const idsByEmployeeNumber = new Map<string, string[]>();
  for (const e of allEmployees) {
    if (e.isVirtual || !e.employeeId) continue;
    idsByEmployeeNumber.set(e.employeeId, [...(idsByEmployeeNumber.get(e.employeeId) ?? []), e.id]);
  }
  /** 一个 leaderId / reportsToEmployeeId 字面值 → 它指向的内部 id 列表（工号优先，其次按内部 id） */
  const resolve = (value: string): string[] => idsByEmployeeNumber.get(value) ?? [value];

  const out = new Set<string>();
  const walk = (list: Department[]) => {
    for (const d of list) {
      if (d.leaderId) for (const id of resolve(d.leaderId)) out.add(id);
      walk(d.children ?? []);
    }
  };
  walk(departments);

  for (const e of allEmployees) {
    if (e.isVirtual || !e.reportsToEmployeeId) continue;
    for (const id of resolve(e.reportsToEmployeeId)) {
      if (id !== e.id) out.add(id);
    }
  }
  return out;
}
