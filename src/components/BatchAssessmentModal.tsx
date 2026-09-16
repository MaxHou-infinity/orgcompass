import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Upload, ClipboardPaste, Eraser, CheckSquare, FileSpreadsheet, AlertTriangle } from 'lucide-react';
import { AppModal } from './AppModal';
import {
  Assessment,
  AssessmentScope,
  AssessorRole,
  CompetencyModel,
  Department,
  Employee,
  Position,
} from '../types';
import {
  benchmarkFor,
  dimensionGap,
  gapStatusFromWorstGap,
  isManager,
  latestSupervisorAssessment,
  normalizedWeights,
} from '../utils/competency';
import { COMPETENCY_STYLE, COMPETENCY_LABEL, CompetencyStatus, fmt } from '../utils/statusUI';

/**
 * —— v2.2.0 批量评估网格（design §9 = ux §1.3 = visual §5）——
 *
 * 分数格是唯一输入；灯号/总分/Gap 实时派生（复用木桶 + 权重归一化），不落盘。
 * 「未评」是显式状态（中性灰），保存允许部分未评、底栏提示不阻塞。
 * 落每条 Assessment 前调 benchmarkFor(employee, position) 快照 requirement
 * （position 按 emp.positionId 从 allPositions 查；冻结时点标准）。
 * 键盘流：1-5 数字键直接录入 + Enter/↓ 下移一行 + Tab 右移维度。
 * Excel 评分导入走 props.onImportExcel（App 层调 parseAssessmentExcel）。
 *
 * v2.3 M2：
 * - 评分角色显式选择上级原始分 / HRBP 校准分；评分人与批次经办人分开，不把 HRBP 冒充上级；
 * - 评价适用范围显式选择「当前岗位」/「通用评价」，不靠空字段猜用途；
 * - relationId 由 App 按当前在职主岗绑定（本组件只传 employeeId，避免 UI 复制人岗真值）。
 */

/** 保存行（新评估原始事实；id/createdAt/updatedAt 由 App 落库时补） */
export interface NewAssessment {
  employeeId: string;
  positionId?: string;
  /** v2.3 M2：显式评价适用范围（position 岗位评价 / general 通用评价） */
  scope: AssessmentScope;
  dimension: string;
  score: number;
  requirement: number;
  assessorRole: AssessorRole;
  assessorId?: string;
  /** v2.3 M2：批次经办人（与评分人分开留痕） */
  enteredBy?: string;
  assessedAt: string;
  source: 'manual' | 'import';
  note?: string;
}

export type AssessType = 'leadership' | 'staff';

const ASSESS_TYPE_LABEL: Record<AssessType, string> = {
  leadership: '干部领导力',
  staff: '员工胜任度',
};

const ROLE_LABEL: Record<'supervisor' | 'hrbp', string> = {
  supervisor: '上级原始分',
  hrbp: 'HRBP 校准分',
};

const SCOPE_LABEL: Record<AssessmentScope, string> = {
  position: '当前岗位',
  general: '通用评价',
};

interface BatchAssessmentModalProps {
  open: boolean;
  onClose: () => void;
  departments: Department[];
  allEmployees: Employee[];
  allPositions: Position[];
  competencyModel: CompetencyModel;
  /** 现有评估（「上一轮预填」按 assessedAt 取旧值） */
  assessments: Assessment[];
  /** 保存批次（App 层调 ws.setAssessments 追加） */
  onSave: (rows: NewAssessment[]) => void;
  /** Excel 评分导入（App 层调 parseAssessmentExcel(file, competencyModel)） */
  onImportExcel: (file: File) => void;
}

/** 展平部门树为下拉选项 */
function flattenDeptOptions(depts: Department[]): { id: string; name: string; level: number }[] {
  const out: { id: string; name: string; level: number }[] = [];
  const walk = (list: Department[]) => {
    for (const d of list) {
      out.push({ id: d.id, name: d.name, level: d.level });
      walk(d.children);
    }
  };
  walk(depts);
  return out;
}

/** 收集部门（含子树）员工 */
function collectDeptEmployees(dept: Department, includeChildren: boolean): Employee[] {
  const out = [...dept.employees];
  if (includeChildren) {
    for (const c of dept.children) out.push(...collectDeptEmployees(c, true));
  }
  return out;
}

export function BatchAssessmentModal({
  open,
  onClose,
  departments,
  allEmployees,
  allPositions,
  competencyModel,
  assessments,
  onSave,
  onImportExcel,
}: BatchAssessmentModalProps) {
  const [assessType, setAssessType] = useState<AssessType>('leadership');
  const [assessorRole, setAssessorRole] = useState<'supervisor' | 'hrbp'>('supervisor');
  const [assessorName, setAssessorName] = useState('');
  const [scope, setScope] = useState<AssessmentScope>('position');
  const [operator, setOperator] = useState('');
  const [assessDate, setAssessDate] = useState(() => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  });
  const [deptId, setDeptId] = useState('');
  const [includeChildren, setIncludeChildren] = useState(true);
  const [onlyUnrated, setOnlyUnrated] = useState(false);
  const [scores, setScores] = useState<Record<string, Record<string, number | ''>>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [selectedRows, setSelectedRows] = useState<Set<string>>(() => new Set());
  const [batchValue, setBatchValue] = useState(3);
  const [fileInputKey, setFileInputKey] = useState(0);
  const cellRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // 维度列（当前评估类型 enabled 维度，组内按 order 升序）
  const dims = useMemo(
    () =>
      competencyModel.dimensions
        .filter((d) => d.enabled !== false && d.group === assessType)
        .sort((a, b) => a.order - b.order),
    [competencyModel, assessType],
  );

  const positionById = useMemo(
    () => new Map<string, Position>(allPositions.map((p) => [p.id, p])),
    [allPositions],
  );

  // 员工 → 所属一级部门名（供网格「部门」列；树内唯一真值）
  const deptNameById = useMemo(() => {
    const m = new Map<string, string>();
    const walk = (depts: Department[]) => {
      for (const d of depts) {
        for (const e of d.employees) if (!m.has(e.id)) m.set(e.id, d.name);
        walk(d.children);
      }
    };
    walk(departments);
    return m;
  }, [departments]);

  // 范围员工（干部/员工 + 部门 + 只看未评 + 排除虚拟副本）
  const scopeEmployees = useMemo(() => {
    let emps: Employee[] = allEmployees.filter((e) => !e.isVirtual);
    if (deptId) {
      const findDept = (list: Department[]): Department | undefined => {
        for (const dept of list) {
          if (dept.id === deptId) return dept;
          const child = findDept(dept.children);
          if (child) return child;
        }
      };
      const dept = findDept(departments);
      emps = dept ? collectDeptEmployees(dept, includeChildren).filter((e) => !e.isVirtual) : [];
      emps = [...new Map(emps.map((e) => [e.id, e])).values()];
    }
    emps = emps.filter((e) =>
      assessType === 'leadership'
        ? isManager(e.id, departments, allEmployees)
        : !isManager(e.id, departments, allEmployees),
    );
    // v2.3 M2：岗位评价只对已套岗人员成立；未套岗人员不在岗位评价批次内
    if (scope === 'position') emps = emps.filter((e) => !!e.positionId);
    if (onlyUnrated) {
      emps = emps.filter((e) => {
        return dims.some((d) => !latestSupervisorAssessment(assessments, e.id, d.key));
      });
    }
    return emps.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }, [allEmployees, departments, deptId, includeChildren, assessType, onlyUnrated, dims, assessments, scope]);

  /** v2.3 M2：范围内已套岗/未套岗人数（说明岗位评价为何排除某些人） */
  const unplacedInScope = useMemo(() => {
    if (scope !== 'position') return 0;
    let emps: Employee[] = allEmployees.filter((e) => !e.isVirtual && !e.positionId);
    if (deptId) {
      const findDept = (list: Department[]): Department | undefined => {
        for (const dept of list) {
          if (dept.id === deptId) return dept;
          const child = findDept(dept.children);
          if (child) return child;
        }
      };
      const dept = findDept(departments);
      const inDept = new Set(dept ? collectDeptEmployees(dept, includeChildren).map((e) => e.id) : []);
      emps = emps.filter((e) => inDept.has(e.id));
    }
    return emps.filter((e) =>
      assessType === 'leadership' ? isManager(e.id, departments, allEmployees) : !isManager(e.id, departments, allEmployees),
    ).length;
  }, [scope, allEmployees, departments, deptId, includeChildren, assessType]);

  // 打开时重置临时态（未评 = 空，绝不预填伪中立分）
  useEffect(() => {
    if (open) {
      setScores({});
      setNotes({});
      setSelectedRows(new Set());
      setAssessType('leadership');
      setAssessorRole('supervisor');
      setAssessorName('');
      setScope('position');
      setOperator('');
      setDeptId('');
      setIncludeChildren(true);
      setOnlyUnrated(false);
    }
  }, [open]);

  const empRequirement = useCallback(
    (emp: Employee): number => benchmarkFor(emp, emp.positionId ? positionById.get(emp.positionId) : undefined),
    [positionById],
  );

  const cellKey = (empId: string, dimKey: string) => `${empId}::${dimKey}`;

  const setScore = useCallback((empId: string, dimKey: string, value: number | '') => {
    setScores((prev) => {
      const row = { ...(prev[empId] ?? {}) };
      row[dimKey] = value;
      return { ...prev, [empId]: row };
    });
  }, []);

  /** 行内派生：已评分维度 → 总分（归一化权重）/ 最差 Gap / 灯号（木桶，仅展示不判结论） */
  const rowDerived = useCallback(
    (emp: Employee) => {
      const row = scores[emp.id] ?? {};
      const filled: { dim: string; score: number; requirement: number }[] = [];
      for (const d of dims) {
        const v = row[d.key];
        if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5) {
          filled.push({ dim: d.key, score: v, requirement: empRequirement(emp) });
        }
      }
      if (filled.length === 0) {
        return { total: null, worstGap: null, status: 'unrated' as CompetencyStatus, gapSum: null };
      }
      const weights = normalizedWeights(
        competencyModel,
        new Set(filled.map((f) => f.dim)),
      );
      let scoreSum = 0;
      let reqSum = 0;
      let worst = Number.NEGATIVE_INFINITY;
      for (const f of filled) {
        const w = weights.get(f.dim) ?? 0;
        scoreSum += f.score * w;
        reqSum += f.requirement * w;
        worst = Math.max(worst, dimensionGap(f.score, f.requirement));
      }
      const status = gapStatusFromWorstGap(worst);
      return { total: scoreSum, worstGap: worst, status, gapSum: reqSum - scoreSum };
    },
    [scores, dims, competencyModel, empRequirement],
  );

  /** 上一轮预填：按 assessedAt 取该员工该维度最新 supervisor 旧值；无历史保持未评 */
  const prefillPrevious = useCallback(() => {
    setScores((prev) => {
      const next: Record<string, Record<string, number | ''>> = {};
      for (const emp of scopeEmployees) {
        const row: Record<string, number | ''> = {};
        for (const d of dims) {
          const prevRow = prev[emp.id]?.[d.key];
          if (typeof prevRow === 'number') {
            row[d.key] = prevRow; // 保留本次已输入
            continue;
          }
          const latest = latestSupervisorAssessment(assessments, emp.id, d.key);
          row[d.key] = latest ? latest.score : '';
        }
        next[emp.id] = row;
      }
      return { ...prev, ...next };
    });
  }, [scopeEmployees, dims, assessments]);

  /** 清除选中行（一键清空预填/输入） */
  const clearSelectedRows = useCallback(() => {
    setScores((prev) => {
      const next = { ...prev };
      for (const empId of selectedRows) delete next[empId];
      return next;
    });
    setSelectedRows(new Set());
  }, [selectedRows]);

  /** 批量套用：勾选行 × 指定维度 → 同一分值（二次确认防误操作） */
  const applyBatch = useCallback(
    (dimKey: string, value: number) => {
      if (selectedRows.size === 0) return;
      setScores((prev) => {
        const next: Record<string, Record<string, number | ''>> = {};
        for (const empId of selectedRows) {
          next[empId] = { ...(prev[empId] ?? {}), [dimKey]: value };
        }
        return { ...prev, ...next };
      });
    },
    [selectedRows],
  );

  /** 键盘流：数字键 1-5 录入、Enter/↓ 下移一行同列 */
  const handleCellKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>, emp: Employee, dimIdx: number) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key >= '1' && e.key <= '5') {
        e.preventDefault();
        setScore(emp.id, dims[dimIdx].key, Number(e.key));
        return;
      }
      if (['0', '.', '-', '+', 'e', 'E'].includes(e.key)) e.preventDefault();
      if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        const idx = scopeEmployees.findIndex((x) => x.id === emp.id);
        const next = scopeEmployees[idx + 1];
        if (next) {
          cellRefs.current[cellKey(next.id, dims[dimIdx]?.key ?? '')]?.focus();
        }
      }
    },
    [scopeEmployees, dims, setScore],
  );

  const activeDims = useMemo(() => competencyModel.dimensions.filter((d) => d.enabled !== false), [competencyModel]);
  const pendingEmployees = useMemo(() => allEmployees.filter((e) => !e.isVirtual && activeDims.some((d) => {
    const value = scores[e.id]?.[d.key];
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5;
  })), [allEmployees, activeDims, scores]);
  const pendingCells = pendingEmployees.reduce((total, emp) => total + activeDims.filter((d) => typeof scores[emp.id]?.[d.key] === 'number').length, 0);

  /** 保存：只落「已评分」格（部分未评允许）；每条快照 requirement 与显式适用范围 */
  const handleSave = useCallback(() => {
    const rows: NewAssessment[] = [];
    const trimmedAssessor = assessorName.trim() || undefined;
    const trimmedOperator = operator.trim() || undefined;
    for (const emp of pendingEmployees) {
      const row = scores[emp.id] ?? {};
      const note = (notes[emp.id] ?? '').trim() || undefined;
      for (const d of activeDims) {
        const v = row[d.key];
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 5) continue;
        if (scope === 'position' && !emp.positionId) continue; // 未套岗不写岗位评价
        rows.push({
          employeeId: emp.id,
          ...(scope === 'position' && emp.positionId ? { positionId: emp.positionId } : {}),
          scope,
          dimension: d.key,
          score: v,
          requirement: empRequirement(emp),
          assessorRole,
          assessorId: trimmedAssessor,
          enteredBy: trimmedOperator,
          assessedAt: assessDate ? new Date(`${assessDate}T12:00:00`).toISOString() : new Date().toISOString(),
          source: 'manual',
          note,
        });
      }
    }
    if (rows.length === 0) return;
    onSave(rows);
    onClose();
  }, [pendingEmployees, scores, notes, activeDims, empRequirement, assessorRole, assessorName, operator, scope, assessDate, onSave, onClose]);

  const ratedCount = useMemo(() => {
    let n = 0;
    for (const emp of scopeEmployees) {
      const row = scores[emp.id] ?? {};
      if (dims.some((d) => typeof row[d.key] === 'number' && (row[d.key] as number) >= 1 && (row[d.key] as number) <= 5)) n += 1;
    }
    return n;
  }, [scopeEmployees, scores, dims]);
  const unratedCount = scopeEmployees.length - ratedCount;

  const deptOptions = useMemo(() => flattenDeptOptions(departments), [departments]);

  const footer = (
    <>
      <div className="mr-auto flex flex-wrap items-center gap-3 text-xs">
        <span className="text-slate-700">本批 {pendingEmployees.length} 人 · {pendingCells} 格（含筛选外已填）</span>
        <span className="text-emerald-600">已评 {ratedCount} 人</span>
        <span className={unratedCount > 0 ? 'text-amber-600 font-medium' : 'text-slate-500'}>
          {unratedCount > 0 ? (
            <span className="inline-flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" />
              还有 {unratedCount} 人未评（可只保存已评）
            </span>
          ) : (
            scopeEmployees.length === 0 ? '当前范围没有可评估人员' : '空白维度仍为未评'
          )}
        </span>
      </div>
      <button
        onClick={handleSave}
        disabled={!operator.trim() || !assessorName.trim() || pendingEmployees.length === 0}
        className="px-5 py-2 rounded-xl text-sm font-medium text-white bg-gradient-to-r from-indigo-500 to-violet-500 shadow-md hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all"
        title={
          !operator.trim()
            ? '请填写牵头 HRBP（批次经办人）'
            : !assessorName.trim()
              ? `请填写${assessorRole === 'hrbp' ? '校准 HRBP' : '上级评分人'}姓名`
              : pendingEmployees.length === 0
                ? '请至少评一个分数格'
                : `保存本批 ${assessorRole === 'hrbp' ? 'HRBP 校准分' : '上级原始分'}（${SCOPE_LABEL[scope]}）`
        }
      >
        保存批次
      </button>
    </>
  );

  return (
    <AppModal
      open={open}
      dirty={Object.values(scores).some((row) => Object.values(row).some((v) => typeof v === 'number')) || Object.values(notes).some((v) => v.trim())}
      onClose={onClose}
      title="批量评估 · 胜任度评分"
      subtitle="填写 1–5 分；空白表示未评。数字键直接改分，Enter / ↓ 移到下一人，Tab 切换维度。"
      maxWidth="max-w-6xl"
      footer={footer}
    >
      {/* 批次头 */}
      <div className="rounded-xl bg-white border border-slate-200 p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">评估类型</span>
            <div className="flex gap-1.5">
              {(Object.keys(ASSESS_TYPE_LABEL) as AssessType[]).map((t) => (
                <button
                  key={t}
                  onClick={() => {
                    setAssessType(t);
                    setSelectedRows(new Set());
                  }}
                  aria-pressed={assessType === t}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                    assessType === t
                      ? 'bg-indigo-500 text-white border-indigo-500'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'
                  }`}
                >
                  {ASSESS_TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2">
            <span className="text-xs text-slate-500">牵头 HRBP</span>
            <input
              type="text"
              value={operator}
              onChange={(e) => setOperator(e.target.value)}
              placeholder="批次经办人（必填）"
              className="w-40 px-2 py-1 rounded-lg border border-slate-200 text-sm focus-ring"
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-xs text-slate-500">{assessorRole === 'hrbp' ? '校准 HRBP' : '上级评分人'}</span>
            <input
              type="text"
              value={assessorName}
              onChange={(e) => setAssessorName(e.target.value)}
              placeholder="实际评分人（必填）"
              className="w-40 px-2 py-1 rounded-lg border border-slate-200 text-sm focus-ring"
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-xs text-slate-500">评估日期</span>
            <input
              type="date"
              value={assessDate}
              onChange={(e) => setAssessDate(e.target.value)}
              className="px-2 py-1 rounded-lg border border-slate-200 text-sm focus-ring"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">评分角色</span>
            <div className="flex gap-1.5">
              {(['supervisor', 'hrbp'] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setAssessorRole(r)}
                  aria-pressed={assessorRole === r}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                    assessorRole === r
                      ? 'bg-violet-500 text-white border-violet-500'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-violet-300'
                  }`}
                  title={r === 'hrbp' ? '校准分并列对照，不参与原始能力灯号与完整度' : '上级原始分，决定能力灯号'}
                >
                  {ROLE_LABEL[r]}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">适用范围</span>
            <div className="flex gap-1.5">
              {(['position', 'general'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => { setScope(s); setSelectedRows(new Set()); }}
                  aria-pressed={scope === s}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                    scope === s
                      ? 'bg-indigo-500 text-white border-indigo-500'
                      : 'bg-white text-slate-600 border-slate-200 hover:border-indigo-300'
                  }`}
                  title={s === 'position' ? '绑定当前人岗关系：换岗后不自动成为新岗位结论' : '明确不限岗位，可作为缺当前岗位评价时的来源'}
                >
                  {SCOPE_LABEL[s]}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2">
            <span className="text-xs text-slate-500">部门</span>
            <select
              value={deptId}
              onChange={(e) => { setDeptId(e.target.value); setSelectedRows(new Set()); }}
              className="px-2 py-1 rounded-lg border border-slate-200 text-sm bg-white focus-ring"
            >
              <option value="">全公司</option>
              {deptOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {'　'.repeat(Math.min(d.level - 1, 3))}
                  {d.level > 1 ? '└ ' : ''}
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={includeChildren}
              onChange={(e) => { setIncludeChildren(e.target.checked); setSelectedRows(new Set()); }}
              className="accent-indigo-500"
            />
            含下级部门
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={onlyUnrated}
              onChange={(e) => { setOnlyUnrated(e.target.checked); setSelectedRows(new Set()); }}
              className="accent-indigo-500"
            />
            只看未评
          </label>
          <span className="text-[11px] text-slate-500 ml-auto">
            本次将评估 {scopeEmployees.length} 名{assessType === 'leadership' ? '管理者' : '员工'}
            {scope === 'position' && unplacedInScope > 0 ? `（已套岗范围；另有 ${unplacedInScope} 人未套岗，不在岗位评价内）` : ''}
          </span>
        </div>
      </div>

      {/* 批量操作 */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-slate-600">批量分值
          <select aria-label="批量分值" value={batchValue} onChange={(e) => setBatchValue(Number(e.target.value))} className="rounded-lg border border-slate-300 bg-white px-2 py-1">
            {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} 分</option>)}
          </select>
        </label>
        <span className="text-xs text-slate-500">已选 {selectedRows.size} 人</span>
        {dims.map((d) => (
          <span key={d.key} className="inline-flex items-center gap-1">
            <button
              onClick={() => applyBatch(d.key, batchValue)}
              disabled={selectedRows.size === 0}
              className="px-2 py-1 rounded-lg text-xs font-medium border border-slate-200 bg-white text-slate-600 hover:border-indigo-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title={`勾选行后：对「${d.label}」批量套用同一分值`}
            >
              套用{d.label}
            </button>
          </span>
        ))}
        <button
          onClick={prefillPrevious}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium border border-slate-200 bg-white text-slate-600 hover:border-indigo-300 transition-colors"
          title="按 assessedAt 取该员工各维度最新 supervisor 旧值；无历史保持未评"
        >
          <ClipboardPaste className="w-3 h-3" />
          从上一轮预填
        </button>
        <button
          onClick={clearSelectedRows}
          disabled={selectedRows.size === 0}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium border border-slate-200 bg-white text-slate-600 hover:border-red-300 hover:text-red-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="一键清空选中行的预填/输入"
        >
          <Eraser className="w-3 h-3" />
          清除选中行
        </button>
        <button
          onClick={() => setSelectedRows(new Set(scopeEmployees.map((e) => e.id)))}
          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium border border-slate-200 bg-white text-slate-600 hover:border-indigo-300 transition-colors"
          title="全选当前范围行"
        >
          <CheckSquare className="w-3 h-3" />
          全选
        </button>
        {/* Excel 导入 */}
        <label className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium border border-indigo-200 bg-indigo-50 text-indigo-600 hover:bg-indigo-100 cursor-pointer transition-colors">
          <Upload className="w-3 h-3" />
          导入评分表
          <input
            key={fileInputKey}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                onImportExcel(f);
                setFileInputKey((k) => k + 1);
              }
            }}
          />
        </label>
        <span className="text-[10px] text-slate-500">
          <FileSpreadsheet className="w-3 h-3 inline mr-0.5" />
          导入前会校验工号和分值
        </span>
      </div>

      {/* 网格 */}
      <div className="mt-3 overflow-x-auto rounded-xl bg-white border border-slate-200 max-h-[46vh]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-white/90 backdrop-blur">
            <tr className="text-xs text-slate-500 uppercase tracking-wide border-b border-slate-100">
              <th className="w-8 px-2 py-2" />
              <th className="text-left px-3 py-2 font-medium min-w-[110px]">姓名/工号</th>
              <th className="text-left px-2 py-2 font-medium min-w-[90px]">部门</th>
              <th className="text-left px-2 py-2 font-medium min-w-[90px]">岗位</th>
              {dims.map((d) => (
                <th key={d.key} className="text-center px-2 py-2 font-medium min-w-[72px]">
                  <span className="block text-[11px] text-slate-500">{d.label}</span>
                  <span className="block text-[10px] text-slate-500">1–5</span>
                </th>
              ))}
              <th className="text-center px-2 py-2 font-medium min-w-[90px]">灯 / 总分 / 最大差距</th>
              <th className="text-left px-2 py-2 font-medium min-w-[120px]">备注</th>
            </tr>
          </thead>
          <tbody>
            {scopeEmployees.map((emp) => {
              const derived = rowDerived(emp);
              const rowChecked = selectedRows.has(emp.id);
              const row = scores[emp.id] ?? {};
              const deptName = deptNameById.get(emp.id) ?? '—';
              return (
                <tr
                  key={emp.id}
                  className={`border-b border-slate-50 ${rowChecked ? 'bg-indigo-50/40' : 'hover:bg-indigo-50/30'}`}
                >
                  <td className="px-2 py-1.5 text-center">
                    <input
                      type="checkbox"
                      checked={rowChecked}
                      onChange={(e) =>
                        setSelectedRows((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(emp.id);
                          else next.delete(emp.id);
                          return next;
                        })
                      }
                      className="accent-indigo-500"
                      title="勾选行参与批量套用/清除"
                    />
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="text-xs font-medium text-slate-700 truncate">{emp.name}</div>
                    <div className="text-[10px] text-slate-500">{emp.employeeId}</div>
                  </td>
                  <td className="px-2 py-1.5 text-[11px] text-slate-500 truncate">{deptName}</td>
                  <td className="px-2 py-1.5 text-[11px] text-slate-500 truncate max-w-[110px]">
                    {emp.positionId ? positionById.get(emp.positionId)?.name ?? '—' : '未套岗'}
                  </td>
                  {dims.map((d, di) => {
                    const v = row[d.key];
                    const req = empRequirement(emp);
                    const st: CompetencyStatus =
                      typeof v === 'number'
                        ? gapStatusFromWorstGap(dimensionGap(v, req))
                        : 'unrated';
                    return (
                      <td key={d.key} className="p-0.5">
                        <input
                          ref={(node) => {
                            cellRefs.current[cellKey(emp.id, d.key)] = node;
                          }}
                          type="number"
                          min={1}
                          max={5}
                          value={v ?? ''}
                          aria-label={`${emp.name} · ${d.label}`}
                          step={1}
                          onChange={(e) => {
                            const raw = e.target.value;
                            if (raw === '') {
                              setScore(emp.id, d.key, '');
                              return;
                            }
                            const n = Number(raw);
                            if (Number.isInteger(n) && n >= 1 && n <= 5) setScore(emp.id, d.key, n);
                          }}
                          onKeyDown={(e) => handleCellKeyDown(e, emp, di)}
                          placeholder="·"
                          className={`w-12 px-1 py-1.5 rounded-lg border text-right text-sm tabular-nums focus-ring placeholder:text-slate-300 ${
                            st === 'healthy'
                              ? 'border-emerald-300 bg-emerald-50/60'
                              : st === 'warn'
                                ? 'border-amber-300 bg-amber-50/60'
                                : st === 'danger'
                                  ? 'border-red-300 bg-red-50/60'
                                  : 'border-slate-200 bg-white'
                          }`}
                          title={
                            typeof v === 'number'
                              ? `基准 ${req} · Gap ${dimensionGap(v, req)} · ${COMPETENCY_LABEL[st]}`
                              : '未评（中性，不预填）'
                          }
                        />
                      </td>
                    );
                  })}
                  <td className="px-2 py-1.5 text-center">
                    {derived.status === 'unrated' ? (
                      <span className="text-[10px] text-slate-500">未评</span>
                    ) : (
                      <span
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold ${COMPETENCY_STYLE[derived.status].ring} ${COMPETENCY_STYLE[derived.status].text}`}
                        title={`总分 ${fmt(derived.total)} · 最差 Gap ${derived.worstGap} · 加权要求 ${fmt(derived.total != null && derived.gapSum != null ? derived.total + derived.gapSum : null)}`}
                      >
                        {COMPETENCY_STYLE[derived.status].glyph} {fmt(derived.total)} ·{' '}
                        {derived.worstGap != null && derived.worstGap > 0 ? `差距 +${derived.worstGap}` : `差距 ${derived.worstGap}`}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="text"
                      value={notes[emp.id] ?? ''}
                      onChange={(e) => setNotes((prev) => ({ ...prev, [emp.id]: e.target.value }))}
                      placeholder="代评/说明"
                      className="w-full px-1.5 py-1 rounded border border-slate-200 text-xs focus-ring"
                    />
                  </td>
                </tr>
              );
            })}
            {scopeEmployees.length === 0 && (
              <tr>
                <td colSpan={6 + dims.length} className="py-8 text-center text-sm text-slate-500">
                  当前范围内暂无{assessType === 'leadership' ? '管理者' : '员工'}
                  {onlyUnrated ? '（且全部已评）' : ''}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[10px] text-slate-500 leading-snug">
        保存后保留本次评分、当时的要求分、评分角色、实际评分人和日期，供后续复核；
        {scope === 'position'
          ? '当前为「岗位评价」：绑定各人当前任职，换岗或离岗后旧分只作历史，不会自动成为新岗位结论。'
          : '当前为「通用评价」：明确不限岗位，仅在缺当前岗位评价时作为来源并在详情标明。'}
        同日对同一人同一维度再次录入会保留旧分并记为修订。
        本工具只呈现依据，不自动定级 / 晋升 / 淘汰。
      </p>
    </AppModal>
  );
}
