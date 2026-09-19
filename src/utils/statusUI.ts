import { HealthStatus } from './analytics';

/** 红黄绿状态 → 视觉类（供健康度抽屉 / 诊断报告共用） */
export interface StatusStyle {
  /** 状态点背景 */
  dot: string;
  /** 状态文字颜色 */
  text: string;
  /** 卡片/容器底色 */
  bg: string;
  /** 边框 */
  border: string;
}

export const STATUS_STYLE: Record<HealthStatus, StatusStyle> = {
  healthy: {
    dot: 'bg-emerald-500',
    text: 'text-emerald-600',
    bg: 'bg-emerald-50/70',
    border: 'border-emerald-300',
  },
  warn: {
    dot: 'bg-amber-500',
    text: 'text-amber-600',
    bg: 'bg-amber-50/70',
    border: 'border-amber-300',
  },
  danger: {
    dot: 'bg-red-500',
    text: 'text-red-600',
    bg: 'bg-red-50/70',
    border: 'border-red-300',
  },
};

// —— v2.2.0 胜任度灯（design §8.1 = visual §3.2 原样；画布标签 / 看板 / 评分表共用）——

/** 胜任度四态：复用健康三态 + 未评分（未评估 ≠ 0，中性灰不伪装绿/红） */
export type CompetencyStatus = 'healthy' | 'warn' | 'danger' | 'unrated';

/** 胜任度灯样式（环形 + 图标 + 文字色 + 胶囊底色） */
export interface CompetencyStyle {
  /** 环形边框（含胶囊底色，紧凑态环 + 展开态胶囊共用） */
  ring: string;
  /** 中心图标（unicode，紧凑态 9px 用；≥16px 场景换 lucide） */
  glyph: string;
  /** 文字色（正文用 -700 对比；-600 仅保留给 14px+ 加粗大数字） */
  text: string;
  /** 胶囊底色（展开态 / 看板） */
  bg: string;
}

export const COMPETENCY_STYLE: Record<CompetencyStatus, CompetencyStyle> = {
  healthy: { ring: 'border-emerald-500 bg-emerald-50/70', glyph: '✓', text: 'text-emerald-700', bg: 'bg-emerald-50' },
  warn: { ring: 'border-amber-500 bg-amber-50/70', glyph: '!', text: 'text-amber-700', bg: 'bg-amber-50' },
  danger: { ring: 'border-red-500 bg-red-50/70', glyph: '×', text: 'text-red-700', bg: 'bg-red-50' },
  unrated: { ring: 'border-slate-300 bg-white/70', glyph: '–', text: 'text-slate-500', bg: 'bg-slate-50' },
};

export const COMPETENCY_LABEL: Record<CompetencyStatus, string> = {
  healthy: '胜任',
  warn: '待提升',
  danger: '待复核',
  unrated: '未评分',
};

/** 单值格式化：null / 非有限数 → '—'（v2.3.1 Q-06：Infinity/NaN 不再漏成 "Infinity"） */
export function fmt(value: number | null, unit = ''): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const v = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${v}${unit}`;
}

/** 金额格式化（单位 w）：保留 1 位小数；null / 非有限数 → '—'（v2.3.1 Q-06） */
export function fmtCost(value: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const v = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${v}w`;
}
