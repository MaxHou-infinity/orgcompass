import type { Assessment, AssignmentType, Employee, Position, PositionAssignment } from '../types';

/**
 * —— v2.2.0 人岗时态关系表（design doc §7）——
 *
 * 双轨兼容过渡（Captain #1）：
 * - 投影（`Employee.positionId` + 虚拟副本）= **active 状态源**，画布/状态机零改动；
 * - `positionAssignments` = **追加式历史 + 确认表**，只承载「前向新增事实」：
 *   时态（startDate/endDate）、primary/secondary、`not_competent` 人工确认。
 *
 * 纪律：迁移不回填（不伪造 startDate）；`project.ts` 不 import 本文件（无循环依赖）；
 * 同步只做「前向 diff/upsert」，绝不自动 end/删除已有记录（保留 ended 历史与确认态）。
 */

/** 本地生成 assignment id（不 import project.ts，避免任何循环依赖风险；样式对齐 uid('asg')）。 */
function genAsgId(): string {
  return `asg-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 前向同步（diff/upsert）：把「当前 active 投影」diff 进 assignment 表。
 *  按 (employeeId, positionId, type) 去重：已有记录（active/ended/not_competent）一律保留、不重复追加；
 *  新 active 记录 startDate 缺省「操作当日」（= now 入参），可编辑。
 *  虚拟副本（isVirtual，primaryEmployeeId 指向真人）不产生独立主体——其岗位归属到真人员工（type='secondary'）。
 *  幂等：重复调用不产生重复 active 记录。 */
export function projectionToAssignments(
  employees: Employee[],
  _positions: Position[], // 契约保留参数（岗位校验/归档过滤留待 P2 写入层）
  assignments: PositionAssignment[],
  now: string,
): PositionAssignment[] {
  const wanted: Array<{ employeeId: string; positionId: string; type: AssignmentType }> = [];
  for (const e of employees) {
    if (e.isVirtual) continue;
    if (e.positionId) wanted.push({ employeeId: e.id, positionId: e.positionId, type: 'primary' });
  }
  for (const v of employees) {
    if (!v.isVirtual) continue;
    if (!v.primaryEmployeeId || !v.positionId) continue; // 无法归属的虚拟副本跳过
    wanted.push({ employeeId: v.primaryEmployeeId, positionId: v.positionId, type: 'secondary' });
  }

  const out = [...assignments];
  for (const w of wanted) {
    const exists = assignments.some(
      (a) => a.employeeId === w.employeeId && a.positionId === w.positionId && a.type === w.type,
    );
    if (exists) continue; // 幂等 + 保留历史/确认态：已有任何状态记录都不重复追加
    out.push({
      id: genAsgId(),
      employeeId: w.employeeId,
      positionId: w.positionId,
      type: w.type,
      startDate: now,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  }
  return out;
}

/** 恢复路径（有损，仅应急）：从 assignment 表重建 active 主岗/兼岗投影。
 *  ended 历史与 not_competent 确认态不进入投影（投影是 active 快照）；仅当投影被清空/损坏时使用。
 *  无 active 记录的员工保持原样（表是前向事实，旧数据无记录——不能反向清空投影）。
 *  `now`：契约保留参数（Employee 投影上无时态字段落点；P2 写入层恢复流程可用）。 */
export function assignmentsToProjection(
  employees: Employee[],
  assignments: PositionAssignment[],
  now: string,
): Employee[] {
  void now; // 契约保留参数：恢复路径当前不落时态字段
  const primaryByEmp = new Map<string, string>(); // employeeId → positionId
  const secondaryByEmp = new Map<string, string[]>(); // employeeId → positionId[]
  for (const a of assignments) {
    if (a.status !== 'active') continue; // ended / not_competent 不进投影
    if (a.type === 'primary') {
      if (!primaryByEmp.has(a.employeeId)) primaryByEmp.set(a.employeeId, a.positionId);
    } else {
      const list = secondaryByEmp.get(a.employeeId) ?? [];
      if (!list.includes(a.positionId)) list.push(a.positionId);
      secondaryByEmp.set(a.employeeId, list);
    }
  }

  const out = employees.map((e) => {
    if (e.isVirtual) return e;
    const pid = primaryByEmp.get(e.id);
    return pid ? { ...e, positionId: pid } : e;
  });

  const realById = new Map(
    employees.filter((e) => !e.isVirtual).map((e) => [e.id, e]),
  );
  const extra: Employee[] = [];
  for (const [empId, pids] of secondaryByEmp) {
    const real = realById.get(empId);
    if (!real) continue;
    for (const pid of pids) {
      const hasCopy = out.some(
        (x) => x.isVirtual && x.primaryEmployeeId === empId && x.positionId === pid,
      );
      if (hasCopy) continue; // 已有虚拟副本 → 保留原样
      extra.push({
        id: genAsgId(),
        name: real.name,
        employeeId: real.employeeId,
        level: real.level,
        isVirtual: true,
        primaryEmployeeId: empId,
        positionId: pid,
        assignmentType: 'secondary',
      });
    }
  }
  return [...out, ...extra];
}

/** 只投影到当前有效主岗；旧岗、已结束任职、兼岗和已撤销确认不传播到主岗。 */
export function confirmedNotCompetentSet(
  assignments: PositionAssignment[], employees: Employee[] = [],
): Set<string> {
  const active = new Map(assignments.filter((a) => a.status === 'active' && !a.endDate).map((a) => [a.id, a]));
  const primaryByEmployee = new Map<string, PositionAssignment[]>();
  for (const a of assignments) {
    if (a.status !== 'active' || a.endDate || a.type !== 'primary') continue;
    const rows = primaryByEmployee.get(a.employeeId) ?? [];
    rows.push(a); primaryByEmployee.set(a.employeeId, rows);
  }
  const out = new Set<string>();
  for (const a of assignments) {
    if (a.status !== 'not_competent' || a.revokedAt || !a.relationId || a.type !== 'primary') continue;
    const relation = active.get(a.relationId);
    if (!relation || relation.type !== 'primary' || relation.employeeId !== a.employeeId || relation.positionId !== a.positionId) continue;
    const current = employees.filter((e) => !e.isVirtual && e.id === a.employeeId);
    if (primaryByEmployee.get(a.employeeId)?.length === 1 && current.length === 1 && current[0].positionId === relation.positionId) out.add(a.employeeId);
  }
  return out;
}

/** —— v2.3 M2：人工复核事件（契约 §5.2）——

 * 确认与撤销都是事实，分别留痕：撤销不删除原确认，只标记当前确认取消。
 * 复核记录与人岗任职生命周期分开：任职继续有效，同时存在能力确认。
 * 关系结束后原确认只作历史；同人重回同岗的新关系不继承旧确认。
 */

export interface ReviewEvent {
  /** 确认记录 id（PositionAssignment.id，status === 'not_competent'） */
  id: string;
  employeeId: string;
  positionId: string;
  relationId: string;
  positionName?: string;
  departmentName?: string;
  /** 确认人名称（本地无账号体系，明确为录入身份）；历史记录缺失 → undefined */
  confirmedBy?: string;
  confirmedAt?: string;
  /** 确认依据说明 */
  note?: string;
  /** 确认引用的评分记录 id（可追溯） */
  assessmentIds: string[];
  /** 当前确认是否已撤销（原确认事实仍保留） */
  revoked: boolean;
  revokedBy?: string;
  revokedAt?: string;
  revokeReason?: string;
  /** 确认依据之后出现新评分 → 原确认仍可查，但标记「待复核」 */
  staleAfterNewAssessment: boolean;
  /** 关联任职是否仍有效（关系结束后仅作历史） */
  relationActive: boolean;
  /** 是否作用于当前在职关系（同人重回同岗的新关系不继承） */
  appliesToCurrentRelation: boolean;
}

/** 评分记录的落库时刻（用于判断「确认之后是否出现新评分」）。 */
function assessmentRecordedAt(a: Assessment): string {
  return a.createdAt || a.assessedAt;
}

/** 收集某员工的全部人工复核事件（含已撤销、已结束任职的历史确认），按确认时间倒序。 */
export function listReviewEvents(
  assignments: PositionAssignment[],
  assessments: Assessment[],
  employeeId?: string,
): ReviewEvent[] {
  const activeRelations = new Map(
    assignments.filter((a) => a.status === 'active' && !a.endDate).map((a) => [a.id, a]),
  );
  const out: ReviewEvent[] = [];
  for (const a of assignments) {
    if (a.status !== 'not_competent') continue;
    if (employeeId && a.employeeId !== employeeId) continue;
    const relation = a.relationId ? activeRelations.get(a.relationId) : undefined;
    const relationActive = Boolean(relation);
    const appliesToCurrentRelation =
      relationActive && relation!.employeeId === a.employeeId && relation!.positionId === a.positionId;
    // 「依据之后有新评分」：同一员工、时刻晚于确认时刻、且适用范围覆盖本次任职的 supervisor 评分
    const after = a.confirmedAt
      ? assessments.filter((x) => x.employeeId === a.employeeId && x.assessorRole === 'supervisor'
          && assessmentRecordedAt(x) > a.confirmedAt!
          && (!x.positionId || x.positionId === a.positionId))
      : [];
    out.push({
      id: a.id,
      employeeId: a.employeeId,
      positionId: a.positionId,
      relationId: a.relationId ?? '',
      positionName: a.positionName,
      departmentName: a.departmentName,
      confirmedBy: a.confirmedBy,
      confirmedAt: a.confirmedAt,
      note: a.reviewNote,
      assessmentIds: a.reviewAssessmentIds ?? [],
      revoked: Boolean(a.revokedAt),
      revokedBy: a.revokedBy,
      revokedAt: a.revokedAt,
      revokeReason: a.revokeReason,
      staleAfterNewAssessment: appliesToCurrentRelation && !a.revokedAt && after.length > 0,
      relationActive,
      appliesToCurrentRelation,
    });
  }
  return out.sort((x, y) => (y.confirmedAt ?? '').localeCompare(x.confirmedAt ?? ''));
}
