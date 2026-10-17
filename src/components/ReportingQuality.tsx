import type { ReportingCoverage } from '../utils/management';

/** 页面、打印与导出共用同一份覆盖率和排除清单。 */
export function ReportingQuality({ data, onFocusEmployee }: {
  data: ReportingCoverage;
  onFocusEmployee?: (employeeId: string, deptId: string) => void;
}) {
  return <section aria-label="汇报线覆盖率" className="mt-3 rounded-xl border border-slate-200 p-3 text-xs text-slate-600">
    <h3 className="font-semibold">汇报线覆盖率 {data.coverage === null ? '—' : `${(data.coverage * 100).toFixed(1)}%`}</h3>
    <p>纳入 {data.included}/{data.total} 名去重真人；无上级的合法根节点保留，异常关系排除。</p>
    {data.excluded.length > 0 && <table className="w-full mt-2 text-left"><thead><tr><th>人员</th><th>所在部门</th><th>剔除原因</th></tr></thead>
      <tbody>{data.excluded.map((person) => <tr key={person.employeeKey}>
        <td>{onFocusEmployee ? <button className="text-indigo-600 underline py-1" onClick={() => onFocusEmployee(person.employeeId, person.deptId)}>{person.name}</button> : person.name}</td>
        <td>{person.deptName}</td><td>{person.reason}</td>
      </tr>)}</tbody></table>}
  </section>;
}
