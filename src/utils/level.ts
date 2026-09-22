import { LevelConfig } from '../types';

/**
 * 职级校验与配色纯函数（UI 表单与单元测试共用）。
 * 与 levels.ts（职级配置 store）解耦：这里只做纯计算，不含任何持久化状态。
 */

/** 职级序列代码：1-2 位大写英文字母（如 L / E / MD） */
export const LEVEL_CODE_RE = /^[A-Z]{1,2}$/;
/** 职级编号：整数或一位小数（如 1 / 1.1 / 2.5） */
export const LEVEL_NUMBER_RE = /^\d+(\.\d)?$/;

// v2.0.12：配色改为语义化自动分配（序列色系 + 级别深浅），原 12 色固定调色板 LEVEL_PALETTE 已移除，见 autoColor。

/** 校验职级序列代码是否为 1-2 位大写英文字母。自动忽略大小写（内部转大写后比对）。 */
export function validateLevelCode(code: string): boolean {
  return LEVEL_CODE_RE.test(code.toUpperCase());
}

/** 校验职级编号是否为整数或一位小数（如 1 / 1.1 / 2.5）。 */
export function validateLevelNumber(num: string): boolean {
  return LEVEL_NUMBER_RE.test(num.trim());
}

/** 规范化职级编号：去除前导 0、尾随 .0、尾随点（如 01→1、1.0→1、1.→1）。 */
export function normalizeLevelNumber(num: string): string {
  const t = num.trim().replace(/^0+(?=\d)/, '');
  return t.replace(/\.0+$/, '').replace(/\.$/, '');
}

/** 派生完整职级码 = code + number（如 "L1.1"）。 */
export function fullCode(config: Pick<LevelConfig, 'code' | 'number'>): string {
  return `${config.code.toUpperCase()}${config.number}`;
}

/** 稳定哈希（基于 fullCode），用于自动配色不随增删/重排漂移。 */
function hashFullCode(code: string): number {
  let hash = 0;
  for (let i = 0; i < code.length; i++) {
    hash = (hash * 31 + code.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** 序列 → 色系主色相（HSL）：L=indigo（241）、E=emerald（158）；其余序列由稳定哈希从备选色系分配 */
const SEQUENCE_HUES: Record<string, number> = {
  L: 241,
  E: 158,
};
/** 备选色系（蓝/橙/粉/黄/紫/青/红/深紫）——给自定义序列使用 */
const FALLBACK_HUES = [210, 25, 325, 40, 283, 183, 5, 262];

/** HSL → HEX（大写），自动配色输出用。 */
function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sN * Math.min(lN, 1 - lN);
  const f = (n: number) => lN - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`.toUpperCase();
}

/**
 * 语义化自动配色（v2.0.12，替代旧 12 色随机哈希）：
 * - 序列 → 色系：L=indigo、E=emerald、其余序列按稳定哈希分配独有色系；
 * - 级别编号 → 同一色系内随编号递进深浅（编号越大越深，如 L1.1 浅 → L3.2 深）。
 * 用途：员工卡底色 / 职级分布色带 / 颜色图例 —— 一眼分清「序列」与「级别」，
 * 不再出现同序列两级颜色毫无关联、跨序列颜色却相近的问题。
 * 仍基于 fullCode 稳定哈希：不随增删/重排漂移；同样输入恒得同样输出。
 */
export function autoColor(code: string): string {
  const m = /^([A-Za-z]+)(\d+(?:\.\d+)?)$/.exec(code);
  const seq = m ? m[1].toUpperCase() : '';
  const num = m ? Math.max(0, parseFloat(m[2])) : 0;
  const hue = SEQUENCE_HUES[seq] ?? FALLBACK_HUES[hashFullCode(seq) % FALLBACK_HUES.length];
  const lightness = Math.max(42, Math.min(90, 90 - num * 10));
  return hslToHex(hue, 64, lightness);
}

// ───────────────────────── v2.3.2：颜色值加固 ─────────────────────────

/** 6 位 hex（可带 #，大小写不敏感） */
const HEX6_RE = /^#?([0-9a-fA-F]{6})$/;
/** 3 位 hex 简写 */
const HEX3_RE = /^#?([0-9a-fA-F]{3})$/;

/**
 * 颜色归一化为 `#RRGGBB`；无法识别时回落到该职级的自动配色。
 *
 * 为什么需要：员工卡底色是「职级色 + 一层透明度」拼出来的（见 `withAlpha`），
 * 这要求颜色必须是 6 位 hex。旧实现两个持久化边界（localStorage 读回、`.orgproj` 清洗）
 * 都只检查 `typeof color === 'string'`，于是外部文件或手改数据里的 `#fff` / `red` / `rgb(1,2,3)`
 * 会拼出 `#fff40` / `red40` 这类**非法 CSS**，被浏览器静默忽略 → 卡片底色变全透明，
 * 用户完全看不出哪里错了（Chromium 实测：底色为 rgba(0,0,0,0)）。
 *
 * @param code 该职级的 fullCode（回落自动配色的种子，保证同职级同色）
 */
export function normalizeLevelColor(value: unknown, code: string): string {
  if (typeof value === 'string') {
    const six = HEX6_RE.exec(value.trim());
    if (six) return `#${six[1]}`;
    const three = HEX3_RE.exec(value.trim());
    if (three) {
      const [r, g, b] = three[1].split('');
      return `#${r}${r}${g}${g}${b}${b}`.toUpperCase();
    }
  }
  return autoColor(code);
}

/**
 * 给 `#RRGGBB` 叠一层透明度（Tailwind 的 `/NN` 等价写法：8 位 hex 的 alpha 通道）。
 *
 * 旧实现是裸的 `color + '40'` —— 颜色若不是 6 位 hex 就拼出非法值、被浏览器丢弃。
 * 这里在拼接前再兜一次：非法输入退回中性灰 `#CCCCCC`，**永远输出合法的 8 位 hex**。
 */
export function withAlpha(color: string, alphaHex: string): string {
  const six = HEX6_RE.exec(color ?? '');
  const base = six ? `#${six[1]}` : '#CCCCCC';
  return `${base}${alphaHex}`;
}
