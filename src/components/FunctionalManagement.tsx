import { useState } from 'react';
import type { Department } from '../types';
import type { HealthThresholds } from '../utils/healthThresholds';
import { computeFunctionalSpans, MANAGEMENT_TYPE_LABELS, DEFAULT_MANAGEMENT_RANGES, DEFAULT_JOB_FAMILY_TYPES, type ManagementStage, type ManagementType, type ManagementRange } from '../utils/managementBenchmarks';
import { HEALTH_STATUS_LABEL } from '../utils/analytics';

export function FunctionalSpanTable({ data }: { data: ReturnType<typeof computeFunctionalSpans> }) {
  return <div aria-label="按管理类型的幅度" className="mt-3 text-xs overflow-x-auto">
    <table className="w-full text-left"><thead><tr><th>类型</th><th>管理者</th><th>中位幅度</th><th>健康区间</th><th>健康占比</th><th>状态</th></tr></thead>
      <tbody>{data.types.map((row) => <tr key={row.type}><td>{MANAGEMENT_TYPE_LABELS[row.type]}</td><td>{row.count}</td><td>{row.median ?? '—'}</td><td>{row.range.min}–{row.range.max}</td><td>{row.healthyShare === null ? '—' : `${Math.round(row.healthyShare * 100)}%`}</td><td>{HEALTH_STATUS_LABEL[row.status]}</td></tr>)}</tbody>
    </table><p className="mt-2 text-slate-500">每类至少 3 位管理者才参与总灯号；{data.defaultedReports} 名下属未配置可用序列/部门类型，暂按知识型计算。同票优先部门默认类型，否则按知识、操作、专家顺序。</p>
  </div>;
}

export function ManagementSettings({ thresholds, onChange, departments, onDepartmentTypeChange }: {
  thresholds: HealthThresholds; onChange: (patch: Partial<HealthThresholds>) => void;
  departments: Department[]; onDepartmentTypeChange?: (deptId: string, type?: ManagementType) => void;
}) {
  const [newFamily, setNewFamily] = useState('');
  const [newType, setNewType] = useState<ManagementType>('knowledge');
  const [error, setError] = useState('');
  const ranges = thresholds.managementRanges ?? DEFAULT_MANAGEMENT_RANGES;
  const mapping = thresholds.jobFamilyTypes ?? DEFAULT_JOB_FAMILY_TYPES;
  const options = (Object.keys(MANAGEMENT_TYPE_LABELS) as ManagementType[]).map((type) => <option key={type} value={type}>{MANAGEMENT_TYPE_LABELS[type]}</option>);
  const flat: Department[] = [];
  const walk = (list: Department[]) => list.forEach((d) => { flat.push(d); walk(d.children); });
  walk(departments);
  const updateRange = (stage: ManagementStage, type: ManagementType, key: keyof ManagementRange, value: number) => {
    const range = { ...ranges[stage][type], [key]: value };
    if (!Number.isFinite(value) || value < 0 || !(range.warnMin <= range.min && range.min <= range.max && range.max <= range.warnMax)) {
      setError('请保持：关注下限 ≤ 健康下限 ≤ 健康上限 ≤ 关注上限。'); return;
    }
    setError('');
    onChange({ managementRanges: { ...ranges, [stage]: { ...ranges[stage], [type]: range } } });
  };
  return <section aria-label="管理类型基准设置" className="space-y-3 text-xs">
    <p>职能与阶段基准（随项目保存；仅为校准起点）</p>
    {error && <p role="alert">{error}</p>}
    <table className="w-full"><thead><tr><th>阶段/类型</th><th>关注下限</th><th>健康下限</th><th>健康上限</th><th>关注上限</th></tr></thead><tbody>
      {(Object.keys(ranges) as ManagementStage[]).flatMap((stage) => (Object.keys(ranges[stage]) as ManagementType[]).map((type) => <tr key={`${stage}-${type}`}>
        <th>{({ startup: '初创', growth: '成长', mature: '成熟' })[stage]} / {MANAGEMENT_TYPE_LABELS[type]}</th>
        {(['warnMin', 'min', 'max', 'warnMax'] as const).map((key) => <td key={key}><input aria-label={`${stage}-${type}-${key}`} type="number" min="0" className="w-16 border rounded p-1" value={ranges[stage][type][key]} onChange={(e) => updateRange(stage, type, key, Number(e.target.value))} /></td>)}
      </tr>))}</tbody></table>
    <details><summary>岗位序列映射（精确匹配，不按名称猜测）</summary><div className="grid grid-cols-2 gap-2 mt-2">
      {Object.entries(mapping).map(([family, type]) => <label key={family}>{family}<select aria-label={`${family}管理类型`} value={type} onChange={(e) => onChange({ jobFamilyTypes: { ...mapping, [family]: e.target.value as ManagementType } })}>{options}</select></label>)}
      <input aria-label="新增岗位序列" value={newFamily} onChange={(e) => setNewFamily(e.target.value)} placeholder="岗位序列原文" />
      <select aria-label="新增映射管理类型" value={newType} onChange={(e) => setNewType(e.target.value as ManagementType)}>{options}</select>
      <button type="button" onClick={() => { if (newFamily.trim()) { onChange({ jobFamilyTypes: { ...mapping, [newFamily.trim()]: newType } }); setNewFamily(''); } }}>保存序列映射</button>
    </div></details>
    {onDepartmentTypeChange && <details><summary>部门默认管理类型</summary>{flat.map((dept) => <label key={dept.id} className="flex justify-between py-1">{dept.name}
      <select aria-label={`${dept.name}默认管理类型`} value={dept.defaultManagementType ?? ''} onChange={(e) => onDepartmentTypeChange(dept.id, (e.target.value || undefined) as ManagementType | undefined)}><option value="">未配置</option>{options}</select>
    </label>)}</details>}
  </section>;
}
