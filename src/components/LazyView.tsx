import { Component, Suspense, type ReactNode } from 'react';

export function ViewSkeleton({ label }: { label: string }) {
  return <div role="status" aria-live="polite" aria-label="正在载入页面" className="p-6 space-y-4 w-full">
    <span className="text-sm text-slate-600">正在载入{label}…</span>
    <div className="h-6 w-1/3 rounded bg-slate-200 motion-safe:animate-pulse" />
    <div className="grid grid-cols-2 gap-4">{[0, 1, 2, 3].map((key) => <div key={key} className="h-32 rounded-xl bg-slate-100 motion-safe:animate-pulse" />)}</div>
  </div>;
}

class ViewBoundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() {
    return this.state.error ? <div role="alert" className="p-6 text-sm text-red-700">页面加载失败。请检查本地安装文件是否完整，再重新打开应用。</div>
      : this.props.children;
  }
}

/** 边界位于主画布/顶栏之外，延迟页面加载时保留导航与骨架，不在关闭态预加载。 */
export function LazyView({ label, children }: { label: string; children: ReactNode }) {
  const labels: Record<string, string> = { HealthPage: '组织健康度', CompetencyPage: '胜任度', ScenarioDiffView: '场景对比', DiagnosticReport: '诊断报告', LevelManagerModal: '职级管理', PositionBoardPage: '岗位与编制', ManagementReport: '管理层报告', CompetencyDetailModal: '胜任度详情', CompetencyModelModal: '胜任度维度', BatchAssessmentModal: '批量评估' };
  return <ViewBoundary><Suspense fallback={<ViewSkeleton label={labels[label] ?? label} />}>{children}</Suspense></ViewBoundary>;
}
