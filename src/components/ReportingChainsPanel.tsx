import type { computeReportingChains } from '../utils/reportingChains';

export function ReportingChainsPanel({ data, onFocusEmployee }: {
  data: ReturnType<typeof computeReportingChains>;
  onFocusEmployee?: (employeeId: string, deptId: string) => void;
}) {
  const maxCount = Math.max(1, ...data.distribution.map((row) => row.count));
  const jump = (name: string, id: string, dept: string) => onFocusEmployee ? <button className="text-indigo-600 underline" onClick={() => onFocusEmployee(id, dept)}>{name}</button> : name;
  return <section aria-label="汇报链与职级" className="rounded-xl border border-slate-200 p-4 text-xs space-y-3">
    <h3 className="font-semibold text-sm">汇报链与职级</h3>
    <p>P50 {data.p50 ?? '—'} · P90 {data.p90 ?? '—'} · 最长 {data.max ?? '—'} 位管理者；完整链 {data.count}/{data.total} 人，{data.incomplete} 人未能核对完整链；{data.missingLevels} 人职级未配置，跳过职级比较。</p>
    <div role="img" aria-label="汇报链长度分布柱状图">{data.distribution.map((row) => <div key={row.length} className="flex items-center gap-2 my-1"><span className="w-24">{row.length} 位管理者</span><div className="h-3 bg-indigo-400 rounded" style={{ width: `${row.count / maxCount * 60}%` }} /><span>{row.count} 人</span></div>)}</div>
    <h4 className="font-semibold">最长前五条汇报链（人员 → 根负责人）</h4>
    <ul>{data.longest.map((chain) => <li key={chain.employeeId} className="py-1">{jump(chain.names.join(' → '), chain.employeeId, chain.deptId)} · {chain.length} 层</li>)}</ul>
    <h4 className="font-semibold">职级倒挂与平级提示</h4>
    <p>按职级管理列表从低到高的配置顺序比较。平级只提示，不参与总评；跨序列压缩不作等价推断。</p>
    {data.inversions.length ? <ul>{data.inversions.map((pair) => <li key={`${pair.managerId}-${pair.employeeId}`} className={pair.kind === 'inversion' ? 'text-red-700 py-1' : 'text-amber-700 py-1'}>
      {pair.kind === 'inversion' ? '倒挂' : '平级'}：{pair.managerName}（{pair.managerLevel}）→ {jump(pair.employeeName, pair.employeeId, pair.deptId)}（{pair.employeeLevel}）
    </li>)}</ul> : <p>已核对关系中未见倒挂或平级；未知职级不作正常结论。</p>}
    {data.compressed.map((chain) => <p key={chain.employeeId} className="text-amber-700">职级带过窄，管理层级多于职级层级：{jump(chain.names.join(' → '), chain.employeeId, chain.deptId)}</p>)}
  </section>;
}
