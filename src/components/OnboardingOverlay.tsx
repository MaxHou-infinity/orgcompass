import { X, Download, Sparkles, MousePointerClick, Share2 } from 'lucide-react';
import { APP_VERSION } from '../version';
import { useDialogFocus } from '../utils/useDialogFocus';

interface OnboardingOverlayProps {
  open: boolean;
  onClose: () => void;
  onDownloadTemplate: () => void;
  onLoadTemplate: (id: string) => void;
}

/**
 * 首次进入引导（v2.0.3 P2-6）：
 * 三步走（导入 → 拖拽 → 导出），帮助新用户快速上手。
 */
export function OnboardingOverlay({ open, onClose, onDownloadTemplate, onLoadTemplate }: OnboardingOverlayProps) {
  // v2.3.1（F-14）：补对话框语义 —— App 用 [role="dialog"] 判断是否在弹窗内，
  // 缺它会让 Ctrl+Z 穿透到底层画布，静默撤销用户看不见的编辑。
  const dialogRef = useDialogFocus(open, onClose);
  if (!open) return null;

  const steps = [
    {
      icon: <Sparkles className="w-6 h-6" />,
      n: '01',
      title: '先载入虚构示例',
      desc: '五套内置行业模板都是合成人名和编制。公开演示请从这里开始，不要粘贴真实员工名册。',
    },
    {
      icon: <MousePointerClick className="w-6 h-6" />,
      n: '02',
      title: '拖拽调整',
      desc: '拖拽员工、部门到目标位置；支持框选批量移动，滚轮缩放画布。',
    },
    {
      icon: <Share2 className="w-6 h-6" />,
      n: '03',
      title: '导出或留在本地',
      desc: '可导出 PNG / Excel / 诊断报告。浏览器把项目自动写进 localStorage；桌面版再用 .orgproj 另存为文件。',
    },
  ];

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="首次使用引导"
      tabIndex={-1}
      className="fixed inset-0 z-[130] flex items-center justify-center p-6"
    >
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[560px] max-w-[92vw] rounded-3xl glass shadow-2xl overflow-hidden animate-fadeInUp">
        <div className="bg-indigo-700 p-7 text-white relative">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 p-1.5 rounded-lg text-white/70 hover:bg-white/15 hover:text-white transition-colors"
            aria-label="关闭引导"
          >
            <X className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2 text-white/80 text-xs font-medium uppercase tracking-wider mb-2">
            <Sparkles className="w-4 h-4" />
            v{APP_VERSION} 快速上手
          </div>
          <h2 className="text-2xl font-bold tracking-tight">先用虚构示例看组织</h2>
          <p className="text-sm text-white/80 mt-1.5">数据只留在这台浏览器，不会上传到服务器。请不要粘贴真实员工名册。</p>
        </div>

        <div className="p-7">
          <div className="space-y-4">
            {steps.map((s, i) => (
              <div key={s.n} className="flex items-start gap-4">
                <span className="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 grid place-items-center shrink-0">
                  {s.icon}
                </span>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-slate-800">{s.title}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 font-medium">
                      第 {i + 1} 步
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1 leading-relaxed">{s.desc}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <button
              onClick={() => { onLoadTemplate('internet'); onClose(); }}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 transition-colors"
            >
              <Sparkles className="w-4 h-4" />
              载入虚构示例
            </button>
            <button
              onClick={onDownloadTemplate}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-white border border-slate-200 text-slate-600 text-sm font-medium hover:bg-slate-50 transition-colors"
            >
              <Download className="w-4 h-4" />
              下载空白模板
            </button>
            <button
              onClick={onClose}
              className="ml-auto px-5 py-2.5 rounded-xl text-sm font-medium text-slate-500 hover:text-slate-800 transition-colors"
            >
              稍后再说
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
