import { useSyncExternalStore } from 'react';
import { Employee, LevelConfig } from '../types';
import { validateLevelCode, validateLevelNumber, fullCode, normalizeLevelNumber, autoColor, normalizeLevelColor } from './level';

/**
 * 职级配置系统。
 * 应用内所有职级颜色 / 标签均来自这份动态配置（而非硬编码常量）。
 * - 默认配置见 DEFAULT_LEVELS，首次启动时写入 localStorage 并作为初始值。
 * - 用户通过「职级管理」面板修改后，经 updateLevelConfigs 持久化（浏览器版 localStorage）。
 * - 多处组件（人员卡片、颜色图例、负责人圆点）通过 useLevelConfigs() 订阅，保持一致。
 * - 序列代码 / 编号校验与 fullCode/配色派生委托给 ./level（纯函数模块），避免与状态 store 耦合。
 */

const STORAGE_KEY = 'org-designer.level-configs';

/**
 * 默认职级配置（cost 为月均成本，单位 w）。
 * v2.0.12 起 color 由语义化 autoColor 统一生成（L=indigo 系、E=emerald 系，随级别递进深浅），
 * 与用户自建职级的自动配色规则保持一致。
 */
export const DEFAULT_LEVELS: LevelConfig[] = [
  { code: 'L', number: '0', label: '实习生', color: autoColor('L0'), cost: 0.5 },
  { code: 'L', number: '1.1', label: '初级专员', color: autoColor('L1.1'), cost: 1.2 },
  { code: 'L', number: '1.2', label: '中级专员', color: autoColor('L1.2'), cost: 1.5 },
  { code: 'L', number: '2.1', label: '高级专员', color: autoColor('L2.1'), cost: 2.0 },
  { code: 'L', number: '2.2', label: '资深专员', color: autoColor('L2.2'), cost: 2.4 },
  { code: 'L', number: '3.1', label: '团队经理', color: autoColor('L3.1'), cost: 3.0 },
  { code: 'E', number: '3.1', label: '专家', color: autoColor('E3.1'), cost: 3.6 },
  { code: 'L', number: '3.2', label: '部门经理', color: autoColor('L3.2'), cost: 4.0 },
  { code: 'E', number: '3.2', label: '高级专家', color: autoColor('E3.2'), cost: 4.8 },
  { code: 'L', number: '4.1', label: '高级经理', color: autoColor('L4.1'), cost: 5.5 },
  { code: 'E', number: '4.1', label: '资深专家', color: autoColor('E4.1'), cost: 6.5 },
  { code: 'L', number: '4.2', label: '总监', color: autoColor('L4.2'), cost: 8.0 },
  { code: 'L', number: '5', label: '副总裁', color: autoColor('L5'), cost: 12.0 },
];

/**
 * 完整职级码（如 "L1.1"）。
 * 直接复用 ./level 的 fullCode 派生。
 */
export { fullCode };

/** 完整展示标签 = fullCode + '-' + label（如 "L1.1-初级专员"） */
export function levelFullLabel(config: Pick<LevelConfig, 'code' | 'number' | 'label'>): string {
  return `${fullCode(config)}-${config.label}`;
}

/** 校验单个职级配置，返回错误信息（空数组表示通过） */
export function validateLevel(config: Pick<LevelConfig, 'code' | 'number' | 'label'>): string[] {
  const errors: string[] = [];
  if (!validateLevelCode(config.code)) {
    errors.push('职级序列代码必须为 1-2 位大写英文字母（如 L / E / MD）');
  }
  if (!validateLevelNumber(config.number)) {
    errors.push('职级编号必须为整数或一位小数（如 1 / 1.1）');
  }
  if (!config.label.trim()) {
    errors.push('中文标签不能为空');
  }
  return errors;
}

/** 从 localStorage 读取配置，解析失败或结构非法时回退默认值（迁移默认值） */
function loadFromStorage(): LevelConfig[] {
  if (typeof localStorage === 'undefined') {
    return DEFAULT_LEVELS;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_LEVELS;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_LEVELS;
    const cleaned = parsed
      .filter(
        (item): item is LevelConfig =>
          !!item &&
          typeof item === 'object' &&
          typeof (item as LevelConfig).code === 'string' &&
          typeof (item as LevelConfig).number === 'string' &&
          typeof (item as LevelConfig).label === 'string' &&
          typeof (item as LevelConfig).color === 'string',
      )
      // 归一化防御：code 转大写、编号规范化、标签去空、**颜色归一为 #RRGGBB**；再校验一次。
      // v2.3.2：颜色此前只检查 `typeof === 'string'`，`#fff`/`red` 这类值会让员工卡底色
      // 拼出非法 CSS 而静默变透明（见 normalizeLevelColor 的说明）。
      .map((item) => {
        const code = item.code.toUpperCase();
        const number = normalizeLevelNumber(item.number);
        return {
          code,
          number,
          label: item.label.trim(),
          color: normalizeLevelColor(item.color, fullCode({ code, number })),
          cost: typeof item.cost === 'number' && Number.isFinite(item.cost) ? item.cost : undefined,
        };
      })
      .filter((item) => validateLevel(item).length === 0);
    return cleaned.length > 0 ? cleaned : DEFAULT_LEVELS;
  } catch {
    return DEFAULT_LEVELS;
  }
}

let cache: LevelConfig[] | null = null;
const listeners = new Set<() => void>();

export function getLevelConfigs(): LevelConfig[] {
  if (!cache) cache = loadFromStorage();
  return cache;
}

function emit(): void {
  listeners.forEach((listener) => listener());
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/** 更新并持久化职级配置（浏览器版写 localStorage） */
export function updateLevelConfigs(next: LevelConfig[]): void {
  cache = next;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }
  emit();
}

/** 恢复默认职级配置 */
export function resetLevelConfigs(): void {
  updateLevelConfigs(DEFAULT_LEVELS);
}

/**
 * React Hook：订阅当前职级配置。
 * 所有依赖职级颜色/标签的组件都用它，保证配置变更后全局一致刷新。
 */
export function useLevelConfigs(): LevelConfig[] {
  return useSyncExternalStore(subscribe, getLevelConfigs, getLevelConfigs);
}

/** 根据职级码从配置中取颜色，找不到时用浅灰兜底 */
export function getLevelColor(configs: LevelConfig[], code: string): string {
  const match = configs.find((c) => fullCode(c) === code);
  return match?.color || '#CCCCCC';
}

/** 根据职级码从配置中取完整标签，找不到时返回原职级码 */
export function getLevelLabel(configs: LevelConfig[], code: string): string {
  const match = configs.find((c) => fullCode(c) === code);
  return match ? levelFullLabel(match) : code;
}

// ───────────────────────── v2.3.2：职级配置覆盖率 ─────────────────────────

/** 名册里出现了、但职级配置里查不到的职级。 */
export interface UnconfiguredLevel {
  /** 员工数据里的原始职级取值（如 "L3.2Acting"、"NA"） */
  level: string;
  /** 使用该取值的人数 */
  count: number;
  /** 示例姓名（最多 3 个，便于用户定位到人） */
  sampleNames: string[];
}

/**
 * 找出「名册里有、配置里没有」的职级取值。
 *
 * 为什么要单独检测：这一条此前是**静默降级**的 ——
 * `getLevelColor` 回落灰色 `#CCCCCC`（与「未配置职级」同色，看不出异常）、
 * `costForLevel` 回落 **0**（不报错）、职级分布按原始字符串单独分档。
 * 真实数据里就有这种情况（`L3.2Acting`，实测使全员月成本低估 4.0w/月 ≈ 48w/年），
 * 但界面上没有任何提示。现在把它变成一条可见、可行动的结论。
 *
 * 空格与大小写差异先归一（` l1.1 ` → `L1.1`），避免把纯粹的空格问题报成"未配置"。
 */
export function findUnconfiguredLevels(employees: Employee[], configs: LevelConfig[]): UnconfiguredLevel[] {
  const known = new Set(configs.map((c) => fullCode(c)));
  const byLevel = new Map<string, UnconfiguredLevel>();
  for (const e of employees) {
    if (e.isVirtual) continue;
    const raw = (e.level ?? '').trim();
    if (!raw) continue;
    const key = raw.toUpperCase();
    if (known.has(key)) continue;
    const hit = byLevel.get(key);
    if (hit) {
      hit.count += 1;
      if (hit.sampleNames.length < 3) hit.sampleNames.push(e.name);
    } else {
      byLevel.set(key, { level: raw, count: 1, sampleNames: [e.name] });
    }
  }
  return [...byLevel.values()].sort((a, b) => b.count - a.count || a.level.localeCompare(b.level));
}
