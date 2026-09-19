import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, Building2, User, CornerDownLeft } from 'lucide-react';
import { Department } from '../types';
import { searchOrg, SearchMatch, SearchResult } from '../utils/search';
import { SearchHighlight } from './SearchContext';
import { useDialogFocus } from '../utils/useDialogFocus';

interface SearchModalProps {
  open: boolean;
  onClose: () => void;
  departments: Department[];
  /** 命中集变化时回调（高亮卡片/员工） */
  onHighlight: (h: SearchHighlight) => void;
  /** 清空高亮 */
  onClearHighlight: () => void;
  /** 点击命中项（展开父级 + 滚动定位） */
  onJump: (match: SearchMatch) => void;
  /** Enter 定位后关闭弹窗但保留高亮（用于定位选中态） */
  onCloseKeepHighlight: () => void;
}

export function SearchModal({
  open,
  onClose,
  departments,
  onHighlight,
  onClearHighlight,
  onJump,
  onCloseKeepHighlight,
}: SearchModalProps) {
  // v2.3.1（F-14）：对话框语义 + 焦点陷阱 + Esc 关闭（与其它弹窗统一）
  const dialogRef = useDialogFocus(open, onClose);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const result: SearchResult = useMemo(
    () => searchOrg(departments, query),
    [departments, query],
  );

  // 命中集变化 → 同步高亮
  useEffect(() => {
    if (!query.trim()) {
      onClearHighlight();
      return;
    }
    const deptIds = new Set<string>();
    const empIds = new Set<string>();
    for (const m of result.matches) {
      if (m.type === 'department') deptIds.add(m.id);
      else empIds.add(m.id);
    }
    onHighlight({ deptIds, empIds });
  }, [query, result.matches, onHighlight, onClearHighlight]);

  // 打开时聚焦输入框（只依赖 open：仅在弹窗打开瞬间重置一次，避免输入过程中
  // 因父组件 onClearHighlight 引用变化而误清空 query，导致中文输入被反复清除）
  useEffect(() => {
    if (open) {
      setQuery('');
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const pick = (m: SearchMatch) => {
    onJump(m);
  };

  return (
    // v2.3.1（F-14）：补 role="dialog"。App 用 `document.querySelector('[role="dialog"]')`
    // 判断「是否在弹窗内」来决定是否放行 Ctrl+Z；缺这个属性时，在本弹窗里按 Ctrl+Z
    // 会穿透到底层画布执行 undo() —— 静默撤销用户看不见的编辑。
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="搜索"
      tabIndex={-1}
      className="fixed inset-0 z-[110] flex items-start justify-center pt-[12vh]"
    >
      {/* 半透明遮罩 */}
      <div className="absolute inset-0 bg-slate-900/20 backdrop-blur-[2px]" onClick={onClose} />

      <div className="relative w-[600px] max-w-[92vw] rounded-2xl glass shadow-2xl animate-fadeInUp overflow-hidden flex flex-col">
        {/* 搜索输入 */}
        <div className="flex items-center gap-2.5 px-4 py-3.5 border-b border-slate-100">
          <Search className="w-5 h-5 text-indigo-500 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="按姓名 / 工号 / 部门名搜索…"
            className="flex-1 text-sm outline-none bg-transparent placeholder:text-slate-400 text-slate-800"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (result.count > 0) {
                  const q = query.trim();
                  const exact = result.matches.find((m) => m.name === q || m.id === q || m.sub?.includes(q));
                  const best = exact ?? result.matches[0];
                  onJump(best);
                  onCloseKeepHighlight();
                }
              }
            }}
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="p-1 rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
              aria-label="清空"
            >
              <X className="w-4 h-4" />
            </button>
          )}
          <span className="text-[10px] text-slate-400 hidden sm:inline">Enter 定位 · Esc 关闭</span>
        </div>

        {/* 结果列表 */}
        <div className="max-h-[46vh] overflow-y-auto p-2">
          {!query.trim() ? (
            <div className="text-sm text-slate-400 text-center py-10">输入关键词开始搜索</div>
          ) : result.count === 0 ? (
            <div className="text-sm text-slate-400 text-center py-10">未找到与「{query}」匹配的部门或员工</div>
          ) : (
            <ul className="space-y-1">
              {result.matches.slice(0, 50).map((m) => (
                <li key={`${m.type}-${m.id}`}>
                  <button
                    onClick={() => pick(m)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-indigo-50 transition-colors text-left group"
                  >
                    <span
                      className={`w-8 h-8 rounded-lg grid place-items-center shrink-0 ${
                        m.type === 'department'
                          ? 'bg-indigo-50 text-indigo-500'
                          : 'bg-emerald-50 text-emerald-500'
                      }`}
                    >
                      {m.type === 'department' ? <Building2 className="w-4 h-4" /> : <User className="w-4 h-4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-slate-800 truncate">{m.name}</span>
                      <span className="block text-xs text-slate-400 truncate">{m.sub}</span>
                    </span>
                    <CornerDownLeft className="w-4 h-4 text-slate-300 group-hover:text-indigo-500 transition-colors shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* 底部统计 */}
        {query.trim() && (
          <div className="px-4 py-2 border-t border-slate-100 text-[10px] text-slate-400 flex items-center justify-between">
            <span>共 {result.count} 个匹配（显示前 50）</span>
            <span>Ctrl+F 快速搜索</span>
          </div>
        )}
      </div>
    </div>
  );
}
