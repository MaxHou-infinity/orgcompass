import { useMemo } from 'react';
import { X, LayoutTemplate } from 'lucide-react';
import { INDUSTRY_TEMPLATES, IndustryTemplate } from '../utils/industryTemplates';
import { useDialogFocus } from '../utils/useDialogFocus';

interface TemplatePreviewModalProps {
  open: boolean;
  onClose: () => void;
  onLoadTemplate: (id: string) => void;
  onToast?: (msg: string) => void;
}

/** 模板迷你缩略图：根部门(第一行) + 子部门(第二行)，纯装饰展示组织轮廓 */
function MiniTree({ tpl }: { tpl: IndustryTemplate }) {
  const l1 = useMemo(
    () => [...new Set(tpl.orgTemplates.map((o) => o.dept1).filter(Boolean))] as string[],
    [tpl],
  );
  const l2 = useMemo(
    () => [...new Set(tpl.orgTemplates.filter((o) => o.dept2).map((o) => o.dept2))] as string[],
    [tpl],
  );
  const roots = l1.slice(0, 3);
  const children = (l2.length ? l2 : roots).slice(0, 4);

  return (
    <div className="relative w-full aspect-[16/9] bg-slate-50 border border-slate-100 rounded-xl p-3 flex flex-col items-center justify-center gap-2 overflow-hidden">
      <div className="flex gap-2 justify-center">
        {roots.map((name) => (
          <div
            key={name}
            className="px-2 py-1 rounded-md text-[10px] font-semibold text-white shadow-sm"
            style={{ backgroundColor: tpl.accent, maxWidth: '80px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {name}
          </div>
        ))}
      </div>
      <div className="w-px h-3 bg-slate-300" />
      <div className="flex gap-1.5 justify-center">
        {children.map((name) => (
          <div
            key={name}
            className="px-1.5 py-0.5 rounded text-[9px] text-slate-600 bg-white border border-slate-200 shadow-sm"
            style={{ maxWidth: '70px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {name}
          </div>
        ))}
      </div>
    </div>
  );
}

export function TemplatePreviewModal({
  open,
  onClose,
  onLoadTemplate,
  onToast,
}: TemplatePreviewModalProps) {
  // v2.3.1（F-14）：补对话框语义 —— App 用 [role="dialog"] 判断是否在弹窗内，
  // 缺它会让 Ctrl+Z 穿透到底层画布，静默撤销用户看不见的编辑。
  const dialogRef = useDialogFocus(open, onClose);
  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="行业模板"
      tabIndex={-1}
      className="fixed inset-0 z-[95] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" />
      <div
        className="relative w-[720px] max-w-full max-h-[82vh] overflow-y-auto rounded-3xl bg-white/95 backdrop-blur-xl shadow-2xl p-6 animate-fadeInUp"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <LayoutTemplate className="w-5 h-5 text-indigo-500" />
            <h2 className="text-lg font-bold text-slate-900">行业模板</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 transition-colors" aria-label="关闭">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {INDUSTRY_TEMPLATES.map((tpl) => (
            <div key={tpl.id} className="rounded-2xl border border-slate-100 shadow-soft p-4 flex flex-col">
              <MiniTree tpl={tpl} />
              <div className="mt-3">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: tpl.accent }} />
                  <span className="text-sm font-bold text-slate-800">{tpl.name}</span>
                </div>
                <p className="text-xs text-slate-400 mt-1 leading-snug">{tpl.description}</p>
                <div className="text-[10px] text-slate-400 mt-1">
                  {tpl.orgTemplates.length} 部门 · {tpl.employees.length} 员工
                </div>
              </div>
              <button
                onClick={() => {
                  onLoadTemplate(tpl.id);
                  onClose();
                  onToast?.(`已载入「${tpl.name}」模板`);
                }}
                className="mt-3 w-full px-3 py-2 rounded-xl text-sm font-medium bg-indigo-500 text-white hover:bg-indigo-600 transition-colors"
              >
                使用此模板
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
