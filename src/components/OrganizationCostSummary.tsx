import type { HealthReport } from '../utils/analytics';
import { fmt, fmtCost } from '../utils/statusUI';

/** 页面与导出报告消费相同派生，避免重复累加子树。 */
export function OrganizationCostSummary({ data }: { data: HealthReport['costBreakdown'] }) {
  return (
    <section aria-label="层级与管理者成本" className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-600">
      <h3 className="font-semibold mb-2">层级与管理者成本</h3>
      <p>已知月成本 {fmtCost(data.knownCost)} · 管理者已知成本 {fmtCost(data.managerKnownCost)} · 管理者成本占比 {fmt(data.managerCostShare, '%')}</p>
      {data.unknownEmployees > 0 && <p className="mt-1 text-slate-500">另有 {data.unknownEmployees} 人缺少成本依据，以上仅为已知部分，暂不计算管理者成本占比。</p>}
      <table className="mt-2 w-full text-left">
        <thead><tr><th className="py-1 font-medium">所在部门层级</th><th className="font-medium text-right">人数</th><th className="font-medium text-right">已知月成本</th><th className="font-medium text-right">成本缺失人数</th></tr></thead>
        <tbody>{data.layers.map((layer) => (
          <tr key={layer.departmentLevel}><td className="py-1">L{layer.departmentLevel}</td><td className="text-right">{layer.employees}</td><td className="text-right">{fmtCost(layer.knownCost)}</td><td className="text-right">{layer.unknownEmployees}</td></tr>
        ))}</tbody>
      </table>
      <p className="mt-2 text-slate-500">按人员所在部门的声明层级分组，每人只计一次，非上下级子树累加；管理者口径与健康度、胜任度一致。金额单位：万元/月。</p>
    </section>
  );
}
