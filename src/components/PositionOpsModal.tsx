import { useMemo, useState, useEffect } from 'react';
import { AppModal } from './AppModal';
import { fullCode } from '../utils/level';
import { Briefcase, Plus, Users } from 'lucide-react';
import type { Department, Employee, LevelConfig } from '../types';
import type { PositionSummary } from '../utils/analytics';
import type { PositionCreateFields } from './PositionModal';

const JOB_FAMILIES = ['技术', '产品', '设计', '职能', '管理', '销售', '运营'];

interface DeptOpt { id: string; label: string; }

function flattenDepts(depts: Department[], acc: DeptOpt[] = [], depth = 0): DeptOpt[] {
  for (const d of depts) {
    acc.push({ id: d.id, label: '　'.repeat(Math.min(depth, 4)) + (depth > 0 ? '└ ' : '') + d.name });
    flattenDepts(d.children, acc, depth + 1);
  }
  return acc;
}

/**
 * 「岗位操作」应用内弹窗（v2.1.1，顶部菜单「岗位」入口）——把新建岗位/套岗/建虚拟兼岗
 * 从部门卡片解耦出来。用户先选目标部门，再在该部门下：
 *   ① 新建岗位（名称/序列/职级带宽/编制数）；② 套岗（选员工到岗位）；③ 建虚拟兼岗。
 * 卡片上的岗位区改为纯展示，避免小卡片做这些操作观感差。
 */
export function PositionOpsModal({
  open,
  onClose,
  departments,
  allEmployees,
  levelConfigs,
  positionSummaries,
  onCreatePosition,
  onSetPositionHeadcount,
  onAssignEmployeeToPosition,
  onCreateVirtualForPosition,
  onArchivePosition,
}: {
  open: boolean;
  onClose: () => void;
  departments: Department[];
  allEmployees: Employee[];
  levelConfigs: LevelConfig[];
  positionSummaries: PositionSummary[];
  onCreatePosition: (deptId: string, fields: PositionCreateFields) => void;
  onSetPositionHeadcount: (deptId: string, positionId: string, headcount: number) => void;
  onAssignEmployeeToPosition: (empId: string, positionId: string) => void;
  onCreateVirtualForPosition: (deptId: string, positionId: string, empId: string) => void;
  onArchivePosition?: (deptId: string, positionId: string) => void;
}) {
  const deptOpts = useMemo(() => flattenDepts(departments), [departments]);
  const [deptId, setDeptId] = useState('');
  // 目标部门下钻：按 id 查找 dept（含子树）
  const dept = useMemo(() => {
    const find = (list: Department[]): Department | undefined => {
      for (const d of list) {
        if (d.id === deptId) return d;
        const hit = find(d.children);
        if (hit) return hit;
      }
      return undefined;
    };
    return find(departments);
  }, [departments, deptId]);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newFamily, setNewFamily] = useState('');
  const [newBandMin, setNewBandMin] = useState('');
  const [newBandMax, setNewBandMax] = useState('');
  const [newHeadcount, setNewHeadcount] = useState('');
  const [openAssignPos, setOpenAssignPos] = useState<string | null>(null);
  const [openVirtualPos, setOpenVirtualPos] = useState<string | null>(null);

  const summaryById = useMemo(() => new Map(positionSummaries.map((p) => [p.positionId, p])), [positionSummaries]);

  useEffect(() => {
    if (open) {
      // 默认选中第一个部门（若有）
      if (deptOpts.length > 0 && !deptId) setDeptId(deptOpts[0].id);
      setCreating(false);
      setOpenAssignPos(null);
      setOpenVirtualPos(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const positions = (dept?.positions ?? []).filter((p) => p.status !== 'archived');
  const levelOptions = levelConfigs.map((c) => ({ value: fullCode(c), label: fullCode(c) }));

  const create = () => {
    if (!dept || !newName.trim()) return;
    onCreatePosition(dept.id, {
      name: newName.trim(),
      jobFamily: newFamily || undefined,
      levelBandMin: newBandMin || undefined,
      levelBandMax: newBandMax || undefined,
      headcount: newHeadcount === '' ? 0 : Number(newHeadcount),
    });
    setNewName(''); setNewFamily(''); setNewBandMin(''); setNewBandMax(''); setNewHeadcount('');
    setCreating(false);
  };

  const candidatesFor = (posId: string) =>
    allEmployees.filter((e) => !e.isVirtual && e.positionId !== posId);

  const renderPosition = (pos: { id: string; name: string; headcount: number; status: string }) => {
    const s = summaryById.get(pos.id);
    const frozen = pos.status === 'frozen';
    const assignedCount = s?.assignedCount ?? 0;
    const gap = s?.gap ?? null;
    const candidates = candidatesFor(pos.id);
    return (
      <div key={pos.id} className="rounded-lg border border-slate-100 bg-white/60 p-1.5">
        <div className="flex items-center gap-1">
          <Briefcase className="w-3 h-3 shrink-0 text-slate-400" />
          <span className="text-xs font-medium text-slate-700 truncate">{pos.name}</span>
          {frozen && <span className="text-[10px] px-1 rounded bg-slate-100 text-slate-500" title="编制已冻结，不计缺口">冻结</span>}
          <span className="ml-auto flex items-center gap-1">
            <input
              type="number" min="0"
              value={pos.headcount}
              onChange={(e) => {
                const v = e.target.value === '' ? 0 : Number(e.target.value);
                onSetPositionHeadcount(dept!.id, pos.id, Number.isFinite(v) ? v : 0);
              }}
              title="岗位编制"
              className="w-11 px-1 py-0.5 rounded border border-slate-200 text-right text-xs focus-ring"
            />
            <span className="text-[10px] text-slate-400">/ 在岗 {assignedCount}</span>
            <span className={`text-[10px] font-medium ${gap === null ? 'text-slate-400' : gap > 0 ? 'text-amber-600' : gap < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
              {gap === null ? (frozen ? '冻结' : '—') : gap > 0 ? `缺 ${gap}` : gap < 0 ? `超 ${Math.abs(gap)}` : '满编'}
            </span>
          </span>
        </div>
        <div className="mt-1 flex items-center gap-1">
          {onArchivePosition && <button onClick={() => onArchivePosition(dept!.id, pos.id)}
            className="px-2 py-1 text-[11px] text-slate-500 hover:text-red-600">归档岗位</button>}
          <button
            onClick={() => setOpenAssignPos(openAssignPos === pos.id ? null : pos.id)}
            className="flex-1 text-left px-2 py-1 rounded-md text-[11px] text-indigo-600 bg-indigo-50 hover:bg-indigo-100 transition-colors"
          >
            套岗（选员工）
          </button>
          <button
            onClick={() => setOpenVirtualPos(openVirtualPos === pos.id ? null : pos.id)}
            className="flex-1 text-left px-2 py-1 rounded-md text-[11px] text-blue-600 bg-blue-50 hover:bg-blue-100 transition-colors"
          >
            建虚拟兼岗
          </button>
        </div>
        {openAssignPos === pos.id && (
          <div className="mt-1 max-h-32 overflow-y-auto rounded-lg border border-indigo-100 bg-white py-0.5">
            {candidates.length === 0 && <div className="px-2 py-1 text-[11px] text-slate-400">无可套岗员工</div>}
            {candidates.map((e) => (
              <button key={e.id} onClick={() => { onAssignEmployeeToPosition(e.id, pos.id); setOpenAssignPos(null); }}
                className="w-full text-left px-2 py-1 text-[11px] text-slate-700 hover:bg-indigo-50 truncate">
                {e.name}（{e.employeeId}）
              </button>
            ))}
          </div>
        )}
        {openVirtualPos === pos.id && (
          <div className="mt-1 max-h-32 overflow-y-auto rounded-lg border border-blue-100 bg-white py-0.5">
            <div className="px-2 py-1 text-[10px] text-slate-400">从以下员工创建兼岗（跨部门第二角色）</div>
            {candidates.length === 0 && <div className="px-2 py-1 text-[11px] text-slate-400">无可兼岗员工</div>}
            {candidates.map((e) => (
              <button key={e.id} onClick={() => { onCreateVirtualForPosition(dept!.id, pos.id, e.id); setOpenVirtualPos(null); }}
                className="w-full text-left px-2 py-1 text-[11px] text-slate-700 hover:bg-blue-50 truncate">
                {e.name}（{e.employeeId}）
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <AppModal
      open={open}
      onClose={onClose}
      title="岗位操作"
      subtitle="先选目标部门，再新建岗位或调整人员。套岗会同时调整所属部门；本次调整即刻生效。"
      maxWidth="max-w-2xl"
    >
      <div className="space-y-3">
        <label className="block">
          <span className="text-xs text-slate-500">目标部门</span>
          <select
            value={deptId}
            onChange={(e) => { setDeptId(e.target.value); setOpenAssignPos(null); setOpenVirtualPos(null); }}
            className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-700 focus-ring"
          >
            {deptOpts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>

        {/* 新建岗位 */}
        <div className="rounded-xl border border-slate-100 bg-white/60 p-2">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1 text-xs text-gray-500"><Plus className="w-3 h-3" />新建岗位</span>
            <button onClick={() => setCreating((v) => !v)} className="text-[11px] text-indigo-600 hover:underline">
              {creating ? '收起' : '展开'}
            </button>
          </div>
          {creating && (
            <div className="mt-2 space-y-2">
              <input type="text" autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
                placeholder="岗位名称（必填）" className="w-full px-3 py-1.5 rounded-lg border border-slate-200 text-sm focus-ring" />
              <div className="grid grid-cols-2 gap-2">
                <select value={newFamily} onChange={(e) => setNewFamily(e.target.value)}
                  className="px-3 py-1.5 rounded-lg border border-slate-200 text-sm focus-ring">
                  <option value="">序列（未指定）</option>
                  {JOB_FAMILIES.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
                <input type="number" min="0" value={newHeadcount} onChange={(e) => setNewHeadcount(e.target.value)}
                  placeholder="编制数（0=未配置）" className="px-3 py-1.5 rounded-lg border border-slate-200 text-sm focus-ring" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select value={newBandMin} onChange={(e) => setNewBandMin(e.target.value)}
                  className="px-3 py-1.5 rounded-lg border border-slate-200 text-sm focus-ring">
                  <option value="">带宽下限（不限）</option>
                  {levelOptions.map((o) => <option key={o.value} value={o.value}>{o.value}</option>)}
                </select>
                <select value={newBandMax} onChange={(e) => setNewBandMax(e.target.value)}
                  className="px-3 py-1.5 rounded-lg border border-slate-200 text-sm focus-ring">
                  <option value="">带宽上限（不限）</option>
                  {levelOptions.map((o) => <option key={o.value} value={o.value}>{o.value}</option>)}
                </select>
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setCreating(false)} className="px-3 py-1.5 rounded-lg text-sm text-slate-500 hover:bg-slate-100">取消</button>
                <button onClick={create} disabled={!newName.trim()} className="px-3 py-1.5 rounded-lg text-sm text-white bg-indigo-500 hover:bg-indigo-600 disabled:opacity-40">创建</button>
              </div>
            </div>
          )}
        </div>

        {/* 岗位列表 + 套岗/兼岗 */}
        <div>
          <div className="flex items-center gap-1 text-xs text-gray-500 mb-1.5">
            <Users className="w-3 h-3 shrink-0" /> 岗位列表（{positions.length}）
          </div>
          {positions.length === 0 ? (
            <div className="text-[11px] text-slate-400 text-center py-2 rounded-lg border border-dashed border-slate-200">该部门暂无岗位，先「新建岗位」</div>
          ) : (
            <div className="space-y-1 max-h-[40vh] overflow-y-auto">{positions.map(renderPosition)}</div>
          )}
        </div>
      </div>
    </AppModal>
  );
}
