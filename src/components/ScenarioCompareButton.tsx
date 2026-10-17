import { useId, useState } from 'react';
import { GitCompare } from 'lucide-react';
import { AppModal } from './AppModal';

/** 软禁用保留鼠标及键盘路径；两个入口共用说明与复制动作。 */
export function ScenarioCompareButton({ canCompare, onCompare, onDuplicateCurrent }: {
  canCompare: boolean; onCompare: () => void; onDuplicateCurrent?: () => boolean | void;
}) {
  const id = useId();
  const [tooltip, setTooltip] = useState(false);
  const [hint, setHint] = useState(false);
  const [error, setError] = useState('');
  return <span className="relative inline-flex">
    <button aria-disabled={!canCompare} aria-describedby={!canCompare && tooltip ? id : undefined}
      onMouseEnter={() => setTooltip(true)} onMouseLeave={() => setTooltip(false)} onFocus={() => setTooltip(true)} onBlur={() => setTooltip(false)}
      onClick={() => { setTooltip(false); if (canCompare) onCompare(); else { setError(''); setHint(true); } }}
      className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm ${canCompare ? 'text-indigo-600 hover:bg-indigo-50' : 'text-slate-400 bg-slate-50 cursor-help'}`}>
      <GitCompare className="w-4 h-4" />场景对比
    </button>
    {!canCompare && tooltip && <span id={id} role="tooltip" className="absolute top-full right-0 z-50 w-56 rounded-lg border border-slate-200 bg-white p-2 text-xs text-slate-600 shadow-lg">需要至少 2 个方案才能对比</span>}
    <AppModal open={hint} onClose={() => setHint(false)} title="先复制一个方案" footer={<>
      <button onClick={() => setHint(false)} className="px-3 py-2 text-sm">取消</button>
      <button disabled={!onDuplicateCurrent} className="rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white disabled:opacity-50" onClick={() => {
        try {
          if (onDuplicateCurrent?.() === false) { setError('复制未保存，请检查本机存储后重试。'); return; }
          setHint(false);
        } catch { setError('复制失败，原方案已保留。'); }
      }}>复制当前方案</button>
    </>}>
      <p className="text-sm text-slate-600">当前只有 1 个方案。复制当前方案后，在副本上调整，再回来对比。</p>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </AppModal>
  </span>;
}
