export interface Employee {
  id: string;
  name: string;
  employeeId: string;
  level: string;
  dept1?: string;
  dept2?: string;
  dept3?: string;
  dept4?: string;
  dept5?: string;
  dept6?: string;
  isVirtual?: boolean;
  /** 个人月均成本（可选；L3 成本分析用）。缺省时降级按职级成本映射核算。 */
  cost?: number;
  /** 目标职级（可选；员工层职级差距红黄绿分析用）。 */
  targetLevel?: string;
  /** 岗位/职位名称（可选；画布显示用，录入为空时落 'NA'）。 */
  title?: string;
  // —— v2.1.1 岗位化 ——
  /** 主岗外键 → Position.id；未套岗 = undefined */
  positionId?: string;
  /** 主岗/兼岗（缺省 primary） */
  assignmentType?: 'primary' | 'secondary';
  /** 兼岗虚拟记录回指真人员工 id */
  primaryEmployeeId?: string;
  /** 汇报线/直接上级（外键 → Employee.id 或 employeeId） */
  reportsToEmployeeId?: string;
}

export interface Department {
  id: string;
  name: string;
  level: number;
  leaderId?: string;
  leaderName?: string;
  parentId?: string;
  children: Department[];
  employees: Employee[];
  expanded: boolean;
  /** 部门编制人数（冗余派生字段，= 部门直属岗位编制之和；向下兼容）。 */
  headcount?: number;
  // —— v2.1.1 岗位化 ——
  /** 本部门直属岗位（嵌套镜像，画布向下钻用；旧版文件缺省为空数组） */
  positions?: Position[];
  /** 负责人类型（缺省视为 'owner' 兼容旧数据） */
  leaderType?: LeaderType;
}

/** —— v2.1.1 岗位化 —— */

/** 岗位状态：active 正常 / frozen 编制冻结（headcount 不计待补缺口）/ archived 软删除 */
export type PositionStatus = 'active' | 'frozen' | 'archived';

/** 岗位（编制名额的载体）：岗位 = 工作定义，编制 = 岗位的计数属性，员工 = 实际占用。 */
export interface Position {
  id: string;                // 稳定 uuid（uid('pos')），AI 可引用
  departmentId: string;      // 显式外键 → Department.id
  name: string;              // 岗位名称（如「前端工程师」）
  jobFamily?: string;        // 岗位序列（技术/产品/设计/职能/管理/销售/运营）
  levelBandMin?: string;     // 职级带宽下限（fullCode，如 'L1'）
  levelBandMax?: string;     // 职级带宽上限（fullCode，如 'L3.2'）
  headcount: number;         // 编制名额（>=0；frozen 时不计缺口）
  status: PositionStatus;
  createdAt: string;         // 时态/审计
  updatedAt: string;
}

/** 负责人类型：owner 正职 / deputy 副职 / acting 代理 / external 外部挂名 / vacant 空缺 */
export type LeaderType = 'owner' | 'deputy' | 'acting' | 'external' | 'vacant';

/** 人岗匹配状态：进图 / 未进图（未套岗）/ 超编 / 不胜任（仅预留，v2.2.0 判定） */
export type MatchStatus = 'placed' | 'unassigned' | 'overstaffed' | 'not_competent';

export interface OrgTemplate {
  dept1?: string;
  dept2?: string;
  dept3?: string;
  dept4?: string;
  dept5?: string;
  dept6?: string;
  deptLevel?: string;
  leaderId?: string;
  leaderName?: string;
}

/**
 * 职级配置项。
 * - code: 职级序列代码，1-2 位大写英文字母（如 L / E / MD）。
 * - number: 职级编号，整数或一位小数（如 1 / 1.1 / 2.5），以字符串存储避免浮点精度损失。
 * - label: 中文标签（如「初级专员」）。
 * - color: 关联色（十六进制），新建时可走 12 色哈希自动分配。
 * 完整职级码 fullCode = code + number（如 "L1.1"），用作去重 / 查找 key。
 */
export interface LevelConfig {
  code: string;
  number: string;
  label: string;
  color: string;
  /** 该职级的月均成本（可选；用于健康度 L3 成本核算，如 2.4 表示 2.4w/月）。 */
  cost?: number;
}

/**
 * 工作区 + 场景快照模型（v2.0.2 数据可信层）。
 * - 一个工作区 = 一个 ProjectFile = 一个项目 + 多场景快照。
 * - 场景用于演练对比（「现状」「调优方案A/B」），互不覆盖。
 * - .orgproj 项目文件即 ProjectFile 的 JSON 序列化。
 */

/** 画布状态（随场景保存） */
export interface ScenarioCanvas {
  /** 缩放百分比（50-200） */
  zoom: number;
  /** 最近聚焦的部门 id（可选，供画布定位回放） */
  lastFocusedDeptId?: string;
}

/** 单一场景快照 */
export interface Scenario {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** 组织树（完整快照） */
  departments: Department[];
  /** 全量员工扁平列表（供负责人搜索 / 模板重建） */
  allEmployeesFlat: Employee[];
  /**
   * 职级配置**兼容镜像**（v2.3.2 起不再作为真值来源）。
   *
   * 真值在工作区级 `ProjectFile.levelConfigs`：颜色/标签/成本是**组织属性**，不是某个演练方案的属性。
   * 此前它是场景级的，而编辑入口（右上角「职级管理」）看起来是全局的 →
   * 用户在场景 A 改完颜色、切到场景 B（旧快照）时颜色会"变回去"（Chromium 实测确认）。
   * 这里继续按工作区配置回写，只为让更早版本的应用仍能读到正确的配色。
   */
  levelConfigs: LevelConfig[];
  /** 画布状态 */
  canvas: ScenarioCanvas;
  /** v2.1.1：全量岗位扁平列表（所有部门岗位的镜像，作 analytics/AI/反查用；旧版文件缺省为空数组） */
  positions?: Position[];
  /** v2.2.0：场景级胜任度模型（维度集合；缺省 = DEFAULT_COMPETENCY_MODEL，迁移/创建时回填） */
  competencyModel?: CompetencyModel;
  /** v2.2.0：扁平评估长表（原始事实，落库；派生值运行时算，不落库） */
  assessments?: Assessment[];
  /** v2.2.0：人岗时态关系表（追加式历史 + 人工确认落点；前向新增事实，迁移不回填） */
  positionAssignments?: PositionAssignment[];
}

/** 项目 / .orgproj 文件的元信息 */
export interface ProjectMeta {
  createdAt: string;
  updatedAt: string;
  /** 数据模型版本（用于迁移） */
  version: number;
}

/** 项目 / .orgproj 文件根结构 */
export interface ProjectFile {
  id: string;
  name: string;
  version: number;
  currentScenarioId: string;
  scenarios: Scenario[];
  meta: ProjectMeta;
  /**
   * v2.3.2：职级配置（颜色 / 标签 / 成本）——**工作区级真值来源**。
   *
   * 与 `Scenario.levelConfigs`（兼容镜像）的关系：这里是真值，场景里那份只是回写副本。
   * 旧文件没有该字段时，从当前场景的配置迁移上来（见 `parseProject`）。
   */
  levelConfigs?: LevelConfig[];
  /**
   * v2.3.2：当前生效的「组织架构模板」——组织结构的**补充层数据源**（不是结构本身）。
   *
   * 语义变更（v2.3.2）：画布的组织结构**主要由员工信息表产出**；组织架构模板只承担两件
   * 员工表装不下的事：① 补「没有任何员工的空部门」；② 补「部门负责人」。
   *
   * 存在工作区级（不是场景级）：它是数据来源配置，不属于某个具体演练方案，
   * 因此切换场景后仍然生效，避免「换个场景重传员工表就丢负责人」。
   * 旧文件缺省 = []（无补充层），不推断、不伪造。
   */
  orgTemplates?: OrgTemplate[];
}

/** 当前工作区（App 运行时状态，导出/持久化的统一快照口径） */
export interface WorkspaceSnapshot {
  projectName: string;
  currentScenarioId: string;
  scenarios: Scenario[];
}

// —— v2.2.0 胜任度引擎 ——

/** 胜任度维度分组：leadership 干部 / staff 员工 */
export type CompetencyGroup = 'leadership' | 'staff';

/** 胜任度维度配置实体（可配置：维度名/定义/权重可自定义，key 稳定不可改） */
export interface CompetencyDimensionDef {
  /** 稳定 snake_case id（AI 语义 + 数据关联）。内置保留字 + 用户 `custom_*`（genDimensionKey 生成）；建后不可改。 */
  key: string;
  /** 显示名（可改，如「战略解码」） */
  label: string;
  /** 维度定义：① 用户理解「这维度衡量什么」；② 结构化语义供未来 AI 理解（受控词表 + 语义说明） */
  definition: string;
  /** 权重（>=0）。只影响总分排序，不影响木桶灯号；组内按已评维度归一化 */
  weight: number;
  /** 分组：leadership 干部 / staff 员工 */
  group: CompetencyGroup;
  /** 展示顺序（组内升序） */
  order: number;
  /** 软删：false = 停用（保留历史评估关联，不物理删） */
  enabled: boolean;
  /** 是否预设维度（内置维度不可物理删除，只可停用） */
  builtin?: boolean;
}

/** 场景级胜任度模型（维度集合） */
export interface CompetencyModel {
  dimensions: CompetencyDimensionDef[];
}

/** 默认预设（可恢复起点）：干部 4 维各 0.25（等权）+ 员工 2 维各 0.5（等权）。 */
export const DEFAULT_COMPETENCY_MODEL: CompetencyModel = {
  dimensions: [
    { key: 'leadership_strategy', label: '战略解码', definition: '把组织目标拆成团队可执行动作、分清优先级；能对齐上级目标拆解里程碑，资源与优先级取舍有依据。', weight: 0.25, group: 'leadership', order: 1, enabled: true, builtin: true },
    { key: 'leadership_team', label: '带队育人', definition: '选人用人、辅导反馈、梯队建设；敢用敢换人、用人所长，给下属及时反馈，团队里有人可接班。', weight: 0.25, group: 'leadership', order: 2, enabled: true, builtin: true },
    { key: 'leadership_results', label: '结果担当', definition: '拿结果、扛压、复盘迭代；对结果负责说到做到，高压下不甩锅，失败后复盘改进。', weight: 0.25, group: 'leadership', order: 3, enabled: true, builtin: true },
    { key: 'leadership_collab', label: '协同影响', definition: '跨团队拉通、向上管理、冲突化解；跨部门协作不设卡，向上沟通清晰，化解团队内/间冲突。', weight: 0.25, group: 'leadership', order: 4, enabled: true, builtin: true },
    { key: 'business', label: '业务能力', definition: '岗位专业深度、领域知识、交付质量；本岗硬技能熟练，交付稳定返工少，能独立解决复杂问题。', weight: 0.5, group: 'staff', order: 1, enabled: true, builtin: true },
    { key: 'individual', label: '单兵能力', definition: '自驱、学习、协作沟通、解决问题、抗压；主动不推诿，学习快复用产出，沟通顺畅扛得住压力。', weight: 0.5, group: 'staff', order: 2, enabled: true, builtin: true },
  ],
};

/** 评分人角色。MVP 只实现 supervisor（上级原始分）+ hrbp（校准并列呈现）；
 *  self/peer/subordinate 为 360 枚举留位，不实现录入/算法。 */
export type AssessorRole = 'supervisor' | 'hrbp' | 'self' | 'peer' | 'subordinate';

/** 固定评分刻度（1-5 行为锚点，不可配） */
export const COMPETENCY_SCALE = { min: 1, max: 5 } as const;

/**
 * v2.3 M2：评价适用范围。
 * - `position` 岗位评价：绑定具体人岗关系（`relationId`），只在同一段任职内适用；
 * - `general` 通用评价：明确无岗位限制，可在缺当前岗位评价时作为来源（详情须标明）。
 * 旧记录缺省由 `positionId` 有无推断；新录入必须显式给出，不靠空字段猜用途。
 */
export type AssessmentScope = 'position' | 'general';

/** 胜任度评估记录（一条 = 被评人 × 维度 × 评分人 × 时间；原始事实，落库） */
export interface Assessment {
  id: string;                  // uid('asm')
  employeeId: string;          // FK → Employee.id（被评人，真人，非虚拟副本）
  positionId?: string;         // FK → Position.id（可空 = 通用能力/干部）
  dimension: string;           // FK → CompetencyDimensionDef.key（string，非硬枚举）
  score: number;               // 原始分（1..5 整数）
  scale: typeof COMPETENCY_SCALE; // 固定 {min:1,max:5}（快照落库，AI 归一化用）
  requirement: number;         // 要求分（缺省 3；评估时快照落库，冻结时点标准）
  assessorRole: AssessorRole;  // supervisor 原始分 / hrbp 校准
  assessorId?: string;         // 评分人名称或 FK（本地无账号体系，明确为录入身份）
  assessedAt: string;          // 评分时间（ISO，时态）
  /** v2.3.1（F-08）：评估**自然日** `YYYY-MM-DD`，同日判定（修订链 / 取数分组）的唯一键。
   *  `assessedAt` 退化为「记录时刻」；旧记录缺省时由 assessedAt 按本地时区回推，不改写数据。 */
  assessmentDay?: string;
  source: 'manual' | 'import';
  note?: string;               // 评分依据/行为锚点引用（可追溯，可选）
  /** v2.3 M2：评价适用范围；旧记录缺省按 positionId 推断，sanitize 不回填伪造。 */
  scope?: AssessmentScope;
  /** v2.3 M2：岗位评价绑定的人岗任职关系 id（同一段任职才算当前适用）。 */
  relationId?: string;
  /** v2.3 M2：同日纠错显式引用被修订记录；旧记录保留，修订链终点才是有效记录。 */
  revisionOf?: string;
  /** v2.3 M2：修订/冲突处理的依据说明（可追溯，可选）。 */
  revisionNote?: string;
  /** v2.3 M2：批次经办人（如牵头 HRBP）。与实际评分人分开，避免把经办人冒充上级评分人。 */
  enteredBy?: string;
  createdAt: string;
  updatedAt: string;
}

/** 人岗时态关系类型：primary 主岗 / secondary 兼岗 */
export type AssignmentType = 'primary' | 'secondary';

/** 人岗时态关系状态：active 当前有效 / ended 已结束 / not_competent 已确认不胜任 */
export type AssignmentStatus = 'active' | 'ended' | 'not_competent';

/** 人岗时态关系记录（追加式历史 + 人工确认落点；前向新增事实） */
export interface PositionAssignment {
  id: string;                  // uid('asg')
  employeeId: string;          // FK → Employee.id（真人，非虚拟副本）
  positionId: string;          // FK → Position.id
  type: AssignmentType;        // primary 主岗 / secondary 兼岗
  startDate?: string;          // 本次调整生效时点；旧快照不知道到岗时间时留空
  endDate?: string;            // 离岗日期（可空 = 至今）
  status: AssignmentStatus;    // active 当前有效 / ended 已结束 / not_competent 已确认不胜任
  confirmedBy?: string;        // 人工确认人名称（本地无账号体系，明确为录入身份）
  confirmedAt?: string;        // 确认时间
  createdAt: string;
  updatedAt: string;
  /** v2.3：操作事实与旧快照分开；旧快照不能用于推断先后入岗顺序。 */
  source?: 'operation' | 'legacy';
  /** 确认记录关联的一次连续任职；确认不代替 active/ended 任职记录。 */
  relationId?: string;
  /** 撤销确认保留原记录（完整复核事件在 M2 实施）。 */
  revokedAt?: string;
  /** v2.3 M2：确认依据说明（复核留痕；未知保持未知，不编造）。 */
  reviewNote?: string;
  /** v2.3 M2：确认所引用的评分记录 id（复核依据可追溯）。 */
  reviewAssessmentIds?: string[];
  /** v2.3 M2：撤销人名称（本地无账号体系，明确为录入身份）。 */
  revokedBy?: string;
  /** v2.3 M2：撤销原因（撤销事件必须留痕）。 */
  revokeReason?: string;
  positionName?: string;
  departmentName?: string;
}
