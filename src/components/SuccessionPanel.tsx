import { useState } from 'react';
import type { Department, Successor, SuccessorReadiness } from '../types';
import { deriveManagementLoads } from '../utils/management';
import { SUCCESSOR_READINESS_LABELS, validateSuccessorImport, type computeSuccession } from '../utils/succession';
import { buildSuccessionTemplateBytes, parseSuccessionExcel } from '../utils/excel';
import { HEALTH_STATUS_LABEL } from '../utils/analytics';
import { STATUS_STYLE } from '../utils/statusUI';

export type PositionPlanPatch = { departmentId: string; positionId: string; patch: { isCritical?: boolean; successors?: Successor[] } };
export function SuccessionPanel({ data, departments, onUpdatePlans }: {
  data: ReturnType<typeof computeSuccession>; departments: Department[];
  onUpdatePlans?: (updates: PositionPlanPatch[]) => void;
}) {
  const people = [...deriveManagementLoads(departments).employeesByKey.values()];
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [candidate, setCandidate] = useState('');
  const [readiness, setReadiness] = useState<SuccessorReadiness>('ready_now');
  const [positionId, setPositionId] = useState('');
  const patch = (id: string, value: PositionPlanPatch['patch']) => {
    const position = data.all.find((p) => p.positionId === id);
    if (position) onUpdatePlans?.([{ departmentId: position.departmentId, positionId: id, patch: value }]);
  };
  return <section aria-label="关键岗位与继任" className="rounded-xl border border-slate-200 p-4 text-xs space-y-3">
    <h3 className="font-semibold text-sm">关键岗位与继任</h3>
    <p className={STATUS_STYLE[data.status].text}>继任覆盖率 {data.coverage === null ? '—' : `${data.coverage.toFixed(1)}%`} · {data.coveredCount}/{data.criticalCount} 个关键岗位 · {HEALTH_STATUS_LABEL[data.status]}</p>
    <p>未配置继任人 {data.unconfigured} 个关键岗位；{data.invalidCandidates} 条无效候选（不计覆盖）；随时可接及 1–2 年可接才算覆盖。只计算正常岗位，关键属性默认为正职负责人所在岗位，手动取消优先。</p>
    <h4 className="font-semibold">单点风险（无有效继任人，按配置职级从高到低）</h4>
    <ul>{data.risks.map((risk) => <li key={risk.positionId}>{risk.departmentName} / {risk.positionName} · 未配置有效继任人</li>)}</ul>
    {data.concentration.map((person) => <p key={person.employeeId} className="text-amber-700">继任人过度集中：{person.name} → {person.positions.length} 个关键岗位（{person.positions.join('、')}）</p>)}
    {onUpdatePlans && <details><summary>配置关键岗位和继任人</summary>
      <div className="space-y-2 my-2">{data.all.map((position) => <div key={position.positionId} className="border-b py-2">
        <label><input type="checkbox" aria-label={`${position.departmentName}/${position.positionName}关键岗位`} checked={position.critical} onChange={(e) => patch(position.positionId, { isCritical: e.target.checked })} /> {position.departmentName} / {position.positionName}（ID：{position.positionId}）</label>
        <ul>{position.rawCandidates.map((successor) => <li key={successor.employeeId}>{people.find((person) => person.id === successor.employeeId)?.name ?? `${successor.employeeId}（引用待核对）`} · {SUCCESSOR_READINESS_LABELS[successor.readiness]}
          <button className="ml-2 underline" onClick={() => patch(position.positionId, { successors: position.rawCandidates.filter((candidate) => candidate.employeeId !== successor.employeeId) })}>移除该候选</button></li>)}</ul>
      </div>)}</div>
      <div className="flex flex-wrap gap-2">
        <select aria-label="继任岗位" value={positionId} onChange={(e) => setPositionId(e.target.value)}><option value="">选择岗位</option>{data.all.map((position) => <option key={position.positionId} value={position.positionId}>{position.departmentName}/{position.positionName}</option>)}</select>
        <select aria-label="继任人" value={candidate} onChange={(e) => setCandidate(e.target.value)}><option value="">选择人员</option>{people.map((person) => <option key={person.id} value={person.id}>{person.name} · {person.employeeId}</option>)}</select>
        <select aria-label="继任准备度" value={readiness} onChange={(e) => setReadiness(e.target.value as SuccessorReadiness)}>{Object.entries(SUCCESSOR_READINESS_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
        <button onClick={() => {
          const position = data.all.find((p) => p.positionId === positionId);
          const person = people.find((p) => p.id === candidate);
          if (!position || !person || person.positionId === positionId) { setError('请选择岗位和继任人；现任人不能作为自己的继任人。'); return; }
          patch(positionId, { successors: [...position.rawCandidates.filter((successor) => successor.employeeId !== candidate), { employeeId: candidate, readiness }] });
          setError('');
        }}>保存继任人</button>
      </div>
      <div className="flex gap-3 items-center mt-3">
        <button disabled={busy} onClick={async () => { setBusy(true); try {
          const bytes = await buildSuccessionTemplateBytes(data.all);
          const { saveFile } = await import('../utils/tauri');
          await saveFile('继任人模板.xlsx', bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        } catch (error) { setError(String(error)); } finally { setBusy(false); } }}>下载继任模板</button>
        <label>导入继任 Excel<input aria-label="导入继任 Excel" type="file" accept=".xlsx,.xls" disabled={busy} onChange={async (event) => {
          const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (!file) return;
          setBusy(true); try {
            const rows = await parseSuccessionExcel(file);
            const validated = validateSuccessorImport(rows, departments);
            onUpdatePlans([...validated].map(([positionId, entry]) => ({ departmentId: entry.departmentId, positionId, patch: { successors: entry.successors } })));
            setError('');
          } catch (error) { setError(String(error)); } finally { setBusy(false); }
        }} /></label>
      </div>
    </details>}
    {error && <p role="alert" className="text-red-700">{error}</p>}
  </section>;
}
