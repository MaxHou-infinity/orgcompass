import type { ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';

/**
 * V2.4.0：应用内**子页面**的统一外壳。
 *
 * 为什么要有它：「岗位与编制」验证了页面级子界面的交互比弹窗好得多（空间够、可并排、
 * 不打断上下文）。用户要求「组织健康度」与「胜任度」与它保持一致，而不是继续用抽屉弹窗。
 *
 * 三个子页面共用这一个外壳，因此以下交互天然一致：
 * - 左上角「返回画布」的位置与样式；
 * - 标题 / 副标题 / 右侧操作区的位置；
 * - 内容区独立滚动（页面本身不滚，画布区不跟着动）；
 * - `data-page` 锚点（测试与视觉回归统一按它定位）。
 */
export interface SubPageShellProps {
  /** 测试与视觉回归用的页面锚点，如 'health' */
  name: string;
  title: string;
  subtitle?: string;
  icon: ReactNode;
  onBack: () => void;
  /** 标题右侧的操作区（如「导出诊断报告」「发起批量评估」） */
  actions?: ReactNode;
  /** 是否由内容区自己滚动（默认 true）。false 时由调用方自行处理滚动。 */
  scroll?: boolean;
  children: ReactNode;
}

export function SubPageShell({
  name, title, subtitle, icon, onBack, actions, scroll = true, children,
}: SubPageShellProps) {
  return (
    <div className="flex flex-col h-full min-h-0" data-page={name}>
      {/*
        标题行**定高**：不同页面的右侧操作区按钮高度不同（有的没有操作区），
        不定高会让「返回画布」的 y 坐标随页面差 2px（视觉回归实测 72 vs 74）。
        三个子页面必须完全对齐 —— 这正是用户要求的"交互体验一致"。
      */}
      <div className="pb-3 mb-3 border-b border-slate-200 shrink-0">
      {/* 内容行定高 36px（与操作区按钮等高）：定高之前「返回画布」的 y 会随页面差 2px
          （没有操作区的页面行更矮）—— 三个子页面必须像素级对齐。 */}
      <div className="flex flex-wrap items-center gap-3 h-9">
        <button
          onClick={onBack}
          className="flex items-center gap-1 h-9 px-2.5 rounded-lg text-sm text-slate-600 border border-slate-200 bg-white hover:bg-slate-50 transition-colors shrink-0"
        >
          <ArrowLeft className="w-4 h-4" />
          返回画布
        </button>
        <h1 className="text-lg font-bold text-slate-900 flex items-center gap-2">
          {icon}
          {title}
        </h1>
        {subtitle && <span className="text-xs text-slate-400">{subtitle}</span>}
        {actions && <div className="ml-auto flex items-center gap-2 flex-wrap h-9">{actions}</div>}
      </div>
      </div>
      <div className={scroll ? 'flex-1 min-h-0 overflow-y-auto' : 'flex-1 min-h-0 flex flex-col'}>
        {children}
      </div>
    </div>
  );
}
