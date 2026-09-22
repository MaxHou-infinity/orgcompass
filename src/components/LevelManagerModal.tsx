import { useState } from 'react';
import { X, Plus, Trash2, RotateCcw, AlertCircle, Check, Sparkles } from 'lucide-react';
import {
  useLevelConfigs,
  updateLevelConfigs,
  resetLevelConfigs,
  DEFAULT_LEVELS,
} from '../utils/levels';
import {
  validateLevelCode,
  validateLevelNumber,
  normalizeLevelNumber,
  fullCode,
  autoColor,
} from '../utils/level';
import { Employee, LevelConfig } from '../types';
import { useDialogFocus } from '../utils/useDialogFocus';

interface LevelManagerModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * v2.3.2：当前名册。用于在改/删职级前提示「有多少人正在用这个职级」——
   * 改 code/number（主键）或删一行，会让这些员工**静默掉色 + 成本归零**，
   * 而这正是「职级未在配置中」那类问题的成因之一（用户自己就能造出来）。
   */
  allEmployees: Employee[];
}

type Draft = LevelConfig;

/** 空职级：color 留空表示「自动配色」（保存时由 fullCode 哈希分配） */
function emptyDraft(): Draft {
  return { code: 'L', number: '', label: '', color: '' };
}

export function LevelManagerModal({ open, onClose, allEmployees }: LevelManagerModalProps) {
  // v2.3.1（F-14）：补对话框语义 —— App 用 [role="dialog"] 判断是否在弹窗内，
  // 缺它会让 Ctrl+Z 穿透到底层画布，静默撤销用户看不见的编辑。
  const dialogRef = useDialogFocus(open, onClose);
  const configs = useLevelConfigs();
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    configs.map((c) => ({ ...c })),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  /** v2.3.2：保存会把哪些「仍有人用」的职级改没（改码/删除），需二次确认 */
  const [pendingLoss, setPendingLoss] = useState<{ code: string; count: number; samples: string[] }[] | null>(null);

  /** 职级码 → 使用人数（归一化：去空格、转大写，与 findUnconfiguredLevels 同一口径） */
  const usageByCode = new Map<string, { count: number; samples: string[] }>();
  for (const e of allEmployees) {
    if (e.isVirtual) continue;
    const key = (e.level ?? '').trim().toUpperCase();
    if (!key) continue;
    const hit = usageByCode.get(key);
    if (hit) {
      hit.count += 1;
      if (hit.samples.length < 3) hit.samples.push(e.name);
    } else {
      usageByCode.set(key, { count: 1, samples: [e.name] });
    }
  }
  /** v2.0.12：当前展示「自定义颜色」控件的行；null = 默认只读自动色块 */
  const [customColorIdx, setCustomColorIdx] = useState<number | null>(null);

  if (!open) return null;

  const updateDraft = (index: number, patch: Partial<Draft>) => {
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
    setSaved(false);
  };

  const addDraft = () => {
    setDrafts((prev) => [...prev, emptyDraft()]);
    setSaved(false);
  };

  const removeDraft = (index: number) => {
    setDrafts((prev) => prev.filter((_, i) => i !== index));
    setSaved(false);
  };

  const validateAll = (): Record<string, string> => {
    const errs: Record<string, string> = {};
    drafts.forEach((d, i) => {
      if (!validateLevelCode(d.code)) errs[`${i}.code`] = '序列代码为 1-2 位大写英文字母';
      if (!validateLevelNumber(d.number)) errs[`${i}.number`] = '编号为整数或一位小数';
      if (!d.label.trim()) errs[`${i}.label`] = '中文标签不能为空';
      if (d.label.trim().length > 20) errs[`${i}.label`] = '标签不能超过 20 字';
    });
    // 检查重复完整编码
    const seen = new Set<string>();
    drafts.forEach((d, i) => {
      const code = fullCode({ code: d.code, number: d.number });
      if (seen.has(code)) errs[`${i}.dup`] = `职级码「${code}」重复`;
      seen.add(code);
    });
    return errs;
  };

  /** 本次保存会让哪些「仍有人用」的职级消失（改码或删除都会） */
  const computePendingLoss = (): { code: string; count: number; samples: string[] }[] => {
    const after = new Set(drafts.map((d) => fullCode({ code: d.code, number: d.number })));
    return configs
      .map((c) => fullCode(c))
      .filter((code) => !after.has(code))
      .map((code) => ({ code, ...(usageByCode.get(code) ?? { count: 0, samples: [] }) }))
      .filter((x) => x.count > 0);
  };

  const handleSave = () => {
    const errs = validateAll();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      setSaved(false);
      setPendingLoss(null);
      return;
    }
    // v2.3.2：会造成「有人用但配置没了」时，先讲清后果再保存（不静默）
    if (!pendingLoss) {
      const loss = computePendingLoss();
      if (loss.length > 0) {
        setPendingLoss(loss);
        setSaved(false);
        return;
      }
    }
    setPendingLoss(null);
    updateLevelConfigs(
      drafts.map((d) => ({
        code: d.code.toUpperCase(),
        number: normalizeLevelNumber(d.number),
        label: d.label.trim(),
        color: d.color || autoColor(fullCode(d)),
        cost: typeof d.cost === 'number' && Number.isFinite(d.cost) ? d.cost : undefined,
      })),
    );
    setErrors({});
    setSaved(true);
  };

  const handleReset = () => {
    resetLevelConfigs();
    setDrafts(DEFAULT_LEVELS.map((c) => ({ ...c })));
    setErrors({});
    setSaved(false);
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="职级管理"
      tabIndex={-1}
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
    >
      {/* 遮罩 */}
      <div
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm animate-fadeIn"
        onClick={onClose}
      />
      {/* 面板 */}
            {/*
        v2.3.2：max-w-2xl → max-w-3xl。
        一行有 6 组控件（职级码 / 标签 / 成本 / 使用人数 / 颜色 / 删除），
        Chromium 实测：内容实需 644px，而 max-w-2xl 只给 596px ——
        加入「N 人使用」徽标后必然溢出到卡片背景之外（颜色块与删除按钮跑到框外）。
      */}
      <div className="relative w-full max-w-3xl max-h-[85vh] flex flex-col rounded-3xl bg-white/90 backdrop-blur-xl border border-white/40 shadow-2xl overflow-hidden animate-fadeInUp">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 bg-gradient-to-r from-indigo-500/5 to-transparent">
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            职级管理
            <span className="text-xs font-normal text-slate-400">自定义职级序列 / 编号 / 标签 / 颜色</span>
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
            aria-label="关闭"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 列表 */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {drafts.length === 0 && (
            <p className="text-sm text-slate-400 text-center py-8">暂无职级，点击下方「新增职级」添加</p>
          )}
          {drafts.map((d, i) => {
            const errCode = errors[`${i}.code`];
            const errNumber = errors[`${i}.number`];
            const errLabel = errors[`${i}.label`];
            const rowErr = errCode || errNumber || errLabel || errors[`${i}.dup`];
            const borderCls = (err?: string) => `border ${err ? 'border-red-300' : 'border-slate-200'}`;
            const effectiveColor = d.color || autoColor(fullCode(d));
            // v2.3.2：这一行当前被多少人使用（改码/删除会让他们掉色、成本归零）
            const usage = usageByCode.get(fullCode(d).toUpperCase());
            return (
              <div
                key={i}
                data-level-row={i}
                className="p-3 rounded-2xl border border-slate-200/70 bg-white hover:shadow-sm transition-shadow"
              >
                {/* v2.3.2：不再 sm:flex-nowrap —— 禁止换行 + 各控件近似固定宽 = 内容溢出到卡片背景外。
                    保留 flex-wrap，窄窗口下优雅换行（宁可换行，不可出框）。 */}
                <div data-level-row-items className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-slate-400">#{i + 1}</span>
                    {/* 序列代码 */}
                    <input
                      type="text"
                      value={d.code}
                      onChange={(e) => {
                        const v = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
                        updateDraft(i, { code: v });
                      }}
                      className={`w-14 px-2 py-1.5 rounded-lg text-center font-semibold text-slate-700 focus-ring ${borderCls(errCode)}`}
                      placeholder="L"
                      maxLength={2}
                      aria-label={`第 ${i + 1} 行 序列代码`}
                    />
                    {/* 编号 */}
                    <input
                      type="text"
                      value={d.number}
                      onChange={(e) => updateDraft(i, { number: e.target.value })}
                      className={`w-16 px-2 py-1.5 rounded-lg text-center text-sm text-slate-700 focus-ring ${borderCls(errNumber)}`}
                      placeholder="1.1"
                      inputMode="decimal"
                      aria-label={`第 ${i + 1} 行 职级编号`}
                    />
                    {/* 完整编码预览 */}
                    <span className="px-2 py-1 rounded-md bg-indigo-50 text-indigo-600 font-mono text-xs font-semibold">
                      {fullCode(d) || '—'}
                    </span>
                  </div>
                  {/* 中文标签 */}
                  <input
                    type="text"
                    value={d.label}
                    onChange={(e) => updateDraft(i, { label: e.target.value })}
                    className={`flex-1 min-w-[120px] px-3 py-1.5 rounded-lg text-sm text-slate-700 focus-ring ${borderCls(errLabel)}`}
                    placeholder="中文标签，如 初级专员"
                    maxLength={20}
                    aria-label={`第 ${i + 1} 行 中文标签`}
                  />
                  {/* 月均成本 */}
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      value={d.cost ?? ''}
                      onChange={(e) => updateDraft(i, { cost: e.target.value === '' ? undefined : Number(e.target.value) })}
                      className="w-16 px-2 py-1.5 rounded-lg text-sm text-slate-700 focus-ring border border-slate-200"
                      placeholder="成本"
                    />
                    <span className="text-[10px] text-slate-400 w-6">w</span>
                  </div>
                  {usage && (
                    <span
                      className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200"
                      title={`当前有 ${usage.count} 名员工使用该职级：${usage.samples.join('、')}${usage.count > usage.samples.length ? ' 等' : ''}。改动职级码或删除该行，他们会掉色且成本归零。`}
                    >
                      {usage.count} 人使用
                    </span>
                  )}
                  {/* 颜色（v2.0.12：默认语义化自动配色——序列色系+级别深浅；点击色块可自定义） */}
                  <div className="flex items-center gap-1.5">
                    {customColorIdx === i ? (
                      <>
                        <input
                          type="color"
                          value={effectiveColor}
                          onChange={(e) => updateDraft(i, { color: e.target.value })}
                          onBlur={() => setCustomColorIdx(null)}
                          className="w-9 h-9 rounded-lg cursor-pointer border border-slate-200 bg-transparent p-0.5"
                          aria-label="自定义颜色"
                        />
                        <span className="font-mono text-[10px] text-slate-400 w-16">{effectiveColor}</span>
                        {d.color && (
                          <button
                            onClick={() => {
                              updateDraft(i, { color: '' });
                              setCustomColorIdx(null);
                            }}
                            className="text-[10px] text-violet-500 hover:underline shrink-0"
                          >
                            恢复自动
                          </button>
                        )}
                      </>
                    ) : (
                      <button
                        onClick={() => setCustomColorIdx(i)}
                        title="颜色随序列与级别自动生成；点击可自定义"
                        className="flex items-center gap-1.5 px-1.5 h-9 rounded-lg border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/50 transition-colors"
                      >
                        <span
                          className="w-6 h-6 rounded-md border border-black/10 shrink-0"
                          style={{ backgroundColor: effectiveColor }}
                        />
                        <span className="font-mono text-[10px] text-slate-400">{effectiveColor}</span>
                        {!d.color && (
                          <span className="flex items-center gap-0.5 text-[10px] text-violet-500 font-medium">
                            <Sparkles className="w-3 h-3" />
                            自动
                          </span>
                        )}
                      </button>
                    )}
                  </div>
                  <button
                    onClick={() => removeDraft(i)}
                    className="p-1.5 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                    aria-label="删除该职级"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
                {rowErr && (
                  <div className="mt-2 flex items-center gap-1 text-xs text-red-500">
                    <AlertCircle className="w-3.5 h-3.5" />
                    {rowErr}
                  </div>
                )}
              </div>
            );
          })}

          <button
            onClick={addDraft}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 border-2 border-dashed border-indigo-200 rounded-xl text-sm font-medium text-indigo-500 hover:border-indigo-400 hover:bg-indigo-50/50 transition-colors"
          >
            <Plus className="w-4 h-4" />
            新增职级
          </button>
        </div>

        {/* v2.3.2：改动会让「仍有人用」的职级消失时，先把后果讲清楚再保存 */}
        {pendingLoss && (
          <div role="alert" className="mx-6 mb-2 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-semibold">有 {pendingLoss.length} 个职级仍被员工使用，保存后会消失</p>
                <ul className="space-y-0.5">
                  {pendingLoss.map((l) => (
                    <li key={l.code}>
                      「{l.code}」— {l.count} 人（{l.samples.join('、')}{l.count > l.samples.length ? ' 等' : ''}）
                    </li>
                  ))}
                </ul>
                <p>这些人不会丢名册，但会<strong className="font-medium">掉色（灰底）且成本按 0 计</strong>，并出现在「职级不在配置中」的提示里。</p>
              </div>
            </div>
            <div className="mt-2 flex justify-end gap-2">
              <button
                onClick={() => setPendingLoss(null)}
                className="px-3 py-1.5 rounded-lg border border-amber-200 bg-white text-amber-900 hover:bg-amber-100 transition-colors"
              >
                返回修改
              </button>
              <button
                onClick={handleSave}
                className="px-3 py-1.5 rounded-lg bg-amber-600 text-white hover:bg-amber-700 transition-colors"
              >
                仍然保存
              </button>
            </div>
          </div>
        )}

        {/* 底部操作 */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-slate-100 bg-slate-50/50">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="inline-block w-3 h-3 rounded-full" style={{ backgroundColor: autoColor('L1.1') }} />
            修改将在应用内即时生效（人员卡片 / 部门卡 / 导出图片）
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleReset}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-slate-500 border border-slate-200 hover:bg-slate-100 transition-colors"
            >
              <RotateCcw className="w-4 h-4" />
              恢复默认
            </button>
            {saved && (
              <span className="flex items-center gap-1 text-xs text-emerald-600">
                <Check className="w-3.5 h-3.5" />
                已保存
              </span>
            )}
            <button
              onClick={handleSave}
              className="px-5 py-2 rounded-xl text-sm font-medium text-white bg-gradient-to-r from-indigo-500 to-violet-500 shadow-md hover:shadow-lg hover:-translate-y-0.5 transition-all"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
