import { useEffect, useMemo, useState } from 'react';
import { AppModal } from './AppModal';
import { UserPlus, Briefcase, AlertCircle, Plus } from 'lucide-react';
import { flattenDeptOptions, findDeptById } from '../utils/departments';
import type { Department, Employee } from '../types';

/**
 * V2.4.0：「创建虚拟员工（兼岗）」新流程。
 *
 * 背景（用户实测反馈 + 代码核对）：旧入口挂在员工所在的部门卡右键菜单上，
 * 直接把虚拟副本加进**同一个部门**、且 `positionId: undefined` —— 于是
 * ① 同一部门里出现两次同一个人；② 这条兼岗没有岗位，在缺口清单里表现为「未套岗」、
 * 也不计入任何岗位的在岗数。
 *
 * 产品规则（用户确认）：
 * - 同一员工必然不会在同一部门出现两次 → **目标部门必须不同于现属部门**；
 * - 既然在别的部门，承担的必然是不同的岗位 → **目标岗位必填，且来自目标部门**；
 * - 目标部门若还没有岗位，允许**顺手新建一个**，不让用户为此中断流程。
 */

export interface VirtualAssignmentDraft {
  employeeId: string;
  /** 现属部门 id（用于从目标部门里排除）；员工未入架构时为 undefined */
  currentDeptId?: string;
}

export interface VirtualAssignmentResult {
  employeeId: string;
  deptId: string;
  /** 选定已有岗位时给出 */
  positionId?: string;
  /** 顺手新建岗位时给出（由调用方与虚拟副本在同一次变更里落地，保证原子性） */
  newPosition?: { name: string; headcount?: number };
}

interface VirtualAssignmentModalProps {
  open: boolean;
  onClose: () => void;
  draft: VirtualAssignmentDraft | null;
  departments: Department[];
  employees: Employee[];
  onConfirm: (result: VirtualAssignmentResult) => void;
}

export function VirtualAssignmentModal({
  open,
  onClose,
  draft,
  departments,
  employees,
  onConfirm,
}: VirtualAssignmentModalProps) {
  const deptOptions = useMemo(() => flattenDeptOptions(departments), [departments]);

  /** 可选的目标部门：排除员工现属部门（产品规则：不会在同一部门出现两次） */
  const targetDeptOptions = useMemo(
    () => deptOptions.filter((o) => o.id !== draft?.currentDeptId),
    [deptOptions, draft?.currentDeptId],
  );

  const source = useMemo(
    () => (draft ? employees.find((e) => e.id === draft.employeeId && !e.isVirtual) ?? null : null),
    [draft, employees],
  );
  const currentDept = draft?.currentDeptId ? findDeptById(departments, draft.currentDeptId) : undefined;
  const currentPositionName = useMemo(() => {
    if (!source?.positionId) return null;
    const walk = (list: Department[]): string | null => {
      for (const d of list) {
        const p = d.positions?.find((x) => x.id === source.positionId);
        if (p) return p.name;
        const hit = walk(d.children);
        if (hit) return hit;
      }
      return null;
    };
    return walk(departments);
  }, [source?.positionId, departments]);

  const [deptId, setDeptId] = useState('');
  const [positionId, setPositionId] = useState('');
  /** 用户选择「＋ 新建岗位」时展开内联表单 */
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newHeadcount, setNewHeadcount] = useState('');

  // 每次打开重置：默认选第一个可选部门（多数组织只有一个"别的部门"时省一步）
  useEffect(() => {
    if (!open) return;
    setDeptId(targetDeptOptions[0]?.id ?? '');
    setPositionId('');
    setCreating(false);
    setNewName('');
    setNewHeadcount('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft?.employeeId]);

  const targetDept = deptId ? findDeptById(departments, deptId) : undefined;
  const positions = (targetDept?.positions ?? []).filter((p) => p.status !== 'archived');

  // 换部门后原选中的岗位不再适用
  useEffect(() => {
    setPositionId('');
    setCreating(false);
  }, [deptId]);

  if (!open || !draft || !source) return null;

  const canSubmit = Boolean(deptId) && (creating ? newName.trim().length > 0 : Boolean(positionId));

  const submit = () => {
    if (!canSubmit) return;
    if (creating) {
      const hc = newHeadcount.trim() === '' ? undefined : Number(newHeadcount);
      onConfirm({
        employeeId: source.id,
        deptId,
        newPosition: { name: newName.trim(), headcount: Number.isFinite(hc) ? hc : undefined },
      });
    } else {
      onConfirm({ employeeId: source.id, deptId, positionId });
    }
    onClose();
  };

  return (
    <AppModal
      open={open}
      onClose={onClose}
      title="创建虚拟员工（兼岗）"
      footer={
        <>
          <button className="px-3 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-100" onClick={onClose}>
            取消
          </button>
          <button
            onClick={submit}
            disabled={!canSubmit}
            className="px-4 py-2 rounded-lg text-sm text-white bg-indigo-500 hover:bg-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            创建兼岗
          </button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        {/* 源员工 */}
        <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 space-y-1">
          <div className="flex items-center gap-2">
            <UserPlus className="w-4 h-4 text-indigo-500 shrink-0" />
            <span className="font-medium text-slate-800">{source.name}</span>
            <span className="text-xs text-slate-500">（{source.employeeId || '无工号'}）</span>
          </div>
          <div className="text-xs text-slate-500 pl-6">
            现属：{currentDept ? currentDept.name : '未入架构'}
            {currentPositionName ? ` › ${currentPositionName}` : ' › 未套岗'}
          </div>
        </div>

        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            将在<strong className="font-medium">目标部门</strong>生成一张兼岗卡片，回指本人；该部门在岗数 +1，原部门不变。
            目标部门不能是本人现属部门（同一部门不会出现两次）。
          </span>
        </div>

        {/* 目标部门 */}
        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-slate-600">
            目标部门 <span className="text-rose-500">*</span>
          </span>
          <select
            aria-label="目标部门"
            value={deptId}
            onChange={(e) => setDeptId(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus-ring"
          >
            {targetDeptOptions.length === 0 && <option value="">（没有可作为兼岗目标的其他部门）</option>}
            {targetDeptOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          {draft.currentDeptId && (
            <span className="block text-[10px] text-slate-400">
              已排除本人现属部门（{currentDept?.name}）
            </span>
          )}
        </label>

        {/* 目标岗位 */}
        <div className="space-y-1.5">
          <span className="text-xs font-medium text-slate-600">
            目标岗位 <span className="text-rose-500">*</span>
          </span>
          {!creating ? (
            <>
              <select
                aria-label="目标岗位"
                value={positionId}
                onChange={(e) => setPositionId(e.target.value)}
                disabled={positions.length === 0}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus-ring disabled:bg-slate-50"
              >
                <option value="">
                  {positions.length === 0 ? '（该部门还没有岗位）' : '请选择岗位'}
                </option>
                {positions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                onClick={() => setCreating(true)}
                disabled={!deptId}
                className="flex items-center gap-1 text-[11px] text-indigo-600 hover:underline disabled:opacity-40"
              >
                <Plus className="w-3 h-3" />
                该部门没有合适岗位？顺手新建一个
              </button>
            </>
          ) : (
            <div className="rounded-xl border border-indigo-100 bg-indigo-50/40 p-2.5 space-y-2">
              <div className="flex items-center gap-1.5 text-[11px] text-indigo-700">
                <Briefcase className="w-3 h-3" />
                在「{targetDept?.name}」下新建岗位
              </div>
              <input
                aria-label="新岗位名称"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="岗位名称，如 交付管理专员"
                className="w-full px-3 py-1.5 rounded-lg border border-slate-200 text-sm focus-ring"
              />
              <div className="flex items-center gap-2">
                <input
                  aria-label="新岗位编制"
                  type="number"
                  min="0"
                  value={newHeadcount}
                  onChange={(e) => setNewHeadcount(e.target.value)}
                  placeholder="编制（可留空）"
                  className="w-32 px-2 py-1.5 rounded-lg border border-slate-200 text-sm focus-ring"
                />
                <button onClick={() => setCreating(false)} className="text-[11px] text-slate-500 hover:underline">
                  改回选已有岗位
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppModal>
  );
}
