// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * v2.3.2 部门卡「卡身不透明」不变量（用户实测缺陷回归）。
 *
 * 现象：**四级及以下部门的引导线纵穿整张卡片**（一~三级正常）。
 *
 * 机制（Chromium 实测确认）：
 * - 引导线是 SVG，画在卡片下层；父卡的连线按设计「从卡内起画、靠卡面遮住上半段」
 *   （OrgChart.computeConnectors：「从父卡内部起线，由不透明卡片遮盖」）。
 * - 四级往下当时兜底到 `.level-bg-1`，它只写了 `background: linear-gradient(rgba(...,0.05~0.1))`：
 *   渐变本身近乎全透明，而 `background` **简写**又把 `.department-card` 的白色底一并清掉
 *   → 卡身 `background-color` 实测为 `rgba(0,0,0,0)` → 连线整条透出来。
 * - 一~三级之所以正常，只因它们走 Tailwind 类、白色底来自 `.department-card`，纯属侥幸。
 *
 * 这类 bug 用 jsdom 测不到（不跑 CSS 引擎、不做层叠），所以这里直接守 CSS 源码的不变量。
 */

// 先剥掉注释：注释里会提到 `background` / `background-color` 等字样，
// 且声明前一个非空字符可能是 `*/` 而不是 `;`，都会让朴素正则误判。
const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule { selector: string; body: string }

function rules(): Rule[] {
  const out: Rule[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().split('\n').pop()!.trim();
    if (selector) out.push({ selector, body: m[2] });
  }
  return out;
}

/** 值是否为不透明底色 */
function isOpaqueColor(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v || v === 'transparent' || v === 'none' || v === 'inherit' || v === 'initial') return false;
  if (v === 'white' || v === '#fff' || v === '#ffffff') return true;
  const rgba = /^rgba\(([^)]*)\)$/.exec(v);
  if (rgba) {
    const parts = rgba[1].split(',').map((p) => p.trim());
    return parts.length === 4 && Number(parts[3]) >= 1;
  }
  if (/^rgb\(/.test(v)) return true;
  if (/^#[0-9a-f]{3}$/.test(v) || /^#[0-9a-f]{6}$/.test(v)) return true;
  // var(--x) 之类无法在此求值：要求它至少不是透明关键字（已在上面拦掉），予以放行
  return /^var\(/.test(v);
}

/** 该声明块生效的底色：`background-color` 优先，否则看 `background` 简写里的颜色部分 */
function effectiveBaseColor(body: string): string | null {
  const longhand = /(?:^|;)\s*background-color\s*:\s*([^;}]+)/.exec(body);
  if (longhand) return longhand[1].trim();
  const shorthand = /(?:^|;)\s*background\s*:\s*([^;}]+)/.exec(body);
  if (!shorthand) return null;
  const value = shorthand[1].trim();
  // 简写里如果只有渐变/图片，等于没有底色（正是当初穿卡的写法）
  if (/gradient|url\(/.test(value)) return null;
  return value;
}

describe('v2.3.2 部门卡卡身必须不透明（否则引导线穿卡）', () => {
  it('.department-card 声明了不透明的底色（这是唯一的遮挡层）', () => {
    const card = rules().filter((r) => r.selector === '.department-card');
    expect(card.length, '.department-card 规则缺失').toBeGreaterThan(0);
    const merged = card.map((r) => r.body).join(';');
    const color = effectiveBaseColor(merged);
    expect(color, '.department-card 没有可用的不透明底色 → 引导线会穿过卡片').not.toBeNull();
    expect(isOpaqueColor(color!), `.department-card 的底色「${color}」不是不透明色`).toBe(true);
  });

  it('不得用「含渐变的 background 简写」给部门卡设底色（这正是当初穿卡的写法）', () => {
    for (const rule of rules()) {
      if (!/department-card/.test(rule.selector)) continue;
      const shorthand = /(?:^|;)\s*background\s*:\s*([^;}]+)/.exec(rule.body);
      if (!shorthand) continue;
      // 纯色简写（background: #ffffff）是安全的：它自己就提供了不透明底色。
      // 危险的是「渐变/图片简写」—— 它会把不透明底色一并清成 transparent。
      if (!/gradient|url\(/.test(shorthand[1])) continue;
      const color = /(?:^|;)\s*background-color\s*:\s*([^;}]+)/.exec(rule.body)?.[1]?.trim();
      expect(
        color && isOpaqueColor(color),
        `${rule.selector} 用了含渐变的 background 简写，却没留下不透明 background-color`,
      ).toBe(true);
    }
  });

  it('不得存在「只给透明渐变、不给底色」的层级卡身类（旧 .level-bg-* 的坑）', () => {
    const gradientRules = rules().filter((r) => /gradient/.test(r.body) && /level-bg/.test(r.selector));
    for (const rule of gradientRules) {
      const color = effectiveBaseColor(rule.body);
      expect(
        color && isOpaqueColor(color),
        `${rule.selector} 只有渐变没有不透明底色 —— 卡身会透明、引导线穿卡`,
      ).toBe(true);
    }
  });
});
