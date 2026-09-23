// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { normalizeLevelColor, withAlpha, autoColor } from './level';
import { findUnconfiguredLevels } from './levels';
import { generateUnconfiguredLevelSuggestions, collectAllSuggestions, computeHealthReport } from './analytics';
import { parseProject, serializeProject, createProject } from './project';
import { DEFAULT_LEVELS } from './levels';
import type { Department, Employee, LevelConfig } from '../types';

/**
 * v2.3.2 第四组：职级配置落到画布上的四个缺陷修复。
 *
 * 诊断结论（全部有 Chromium 实测证据）：
 * - P1 职级取值不在配置里 → 静默三重降级：卡片灰色、**成本按 0 计**、职级分布单独分档。
 *      真实数据里就有 `L3.2Acting`（全员月成本低估 4.0w/月 ≈ 48w/年），界面上没有任何提示。
 * - P2 职级配置是「每场景一份」，但编辑入口看起来是全局的 → 在场景 A 改完颜色，切到场景 B 会变回去。
 * - P3 颜色值未校验 → 非 6 位 hex 会拼出非法 CSS（`red40`），卡片底色静默变全透明。
 * - P4 改/删职级没有任何「被引用」提示 → 用户自己就能造出 P1。
 */

beforeEach(() => {
  vi.restoreAllMocks();
});

// ───────────────────────── P3：颜色值加固 ─────────────────────────

describe('v2.3.2 P3 颜色值加固', () => {
  it('6 位 hex 原样保留（大小写与 # 归一）', () => {
    expect(normalizeLevelColor('#a8a7ec', 'L1.1')).toBe('#a8a7ec');
    expect(normalizeLevelColor('A8A7EC', 'L1.1')).toBe('#A8A7EC');
  });

  it('3 位短 hex 展开为 6 位', () => {
    expect(normalizeLevelColor('#fff', 'L1.1')).toBe('#FFFFFF');
    expect(normalizeLevelColor('#0a0', 'L1.1')).toBe('#00AA00');
  });

  it('命名色 / rgb() / 非字符串 → 回落该职级的自动配色（不再拼出非法 CSS）', () => {
    for (const bad of ['red', 'rgb(1,2,3)', '', undefined, null, 42, {}]) {
      expect(normalizeLevelColor(bad as unknown, 'L1.1')).toBe(autoColor('L1.1'));
    }
  });

  it('withAlpha 永远输出合法 8 位 hex（旧实现裸拼 color + "40"）', () => {
    expect(withAlpha('#A8A7EC', '40')).toBe('#A8A7EC40');
    // 非法输入退回中性灰，而不是产出 `red40` 这种被浏览器静默丢弃的值
    expect(withAlpha('red', '40')).toBe('#CCCCCC40');
    expect(withAlpha('#fff', '40')).toBe('#CCCCCC40');
    expect(withAlpha(undefined as unknown as string, '40')).toBe('#CCCCCC40');
  });

  it('.orgproj 边界：非法颜色在清洗时就被归一（Chromium 实测那时卡片底色为 rgba(0,0,0,0)）', () => {
    const p = createProject('配色边界');
    const bad: LevelConfig[] = [
      { code: 'L', number: '1.1', label: '初级', color: 'red' },
      { code: 'L', number: '1.2', label: '中级', color: '#fff' },
      { code: 'L', number: '1.3', label: '高级', color: '#123456' },
    ];
    p.levelConfigs = bad;
    p.scenarios[0].levelConfigs = bad;

    const parsed = parseProject(serializeProject(p))!;
    expect(parsed.levelConfigs![0].color).toBe(autoColor('L1.1')); // 命名色 → 自动配色
    expect(parsed.levelConfigs![1].color).toBe('#FFFFFF'); // 短 hex → 展开
    expect(parsed.levelConfigs![2].color).toBe('#123456'); // 合法值不动
  });
});

// ───────────────────────── P1：职级未在配置中 ─────────────────────────

const emp = (name: string, level: string, extra: Partial<Employee> = {}): Employee =>
  ({ id: name, name, employeeId: name, level, ...extra });

describe('v2.3.2 P1 职级未在配置中必须可见', () => {
  const configs: LevelConfig[] = [
    { code: 'L', number: '1.1', label: '初级', color: '#A8A7EC' },
    { code: 'L', number: '3.2', label: '部门经理', color: '#7F7DE3', cost: 4 },
  ];

  it('检出「名册里有、配置里没有」的职级，并带人数与样例姓名', () => {
    const list = findUnconfiguredLevels(
      [emp('张三', 'L1.1'), emp('林清越', 'L3.2Acting'), emp('李四', 'L3.2Acting'), emp('王五', 'NA')],
      configs,
    );
    expect(list).toEqual([
      { level: 'L3.2Acting', count: 2, sampleNames: ['林清越', '李四'] },
      { level: 'NA', count: 1, sampleNames: ['王五'] },
    ]);
  });

  it('空格与大小写先归一（不把纯粹的空格问题报成未配置）', () => {
    expect(findUnconfiguredLevels([emp('张三', ' l1.1 ')], configs)).toEqual([]);
  });

  it('虚拟兼岗记录不参与统计（它们不是真实职级占用）', () => {
    expect(findUnconfiguredLevels([emp('兼岗', 'X9', { isVirtual: true })], configs)).toEqual([]);
  });

  it('全部配得上时返回空数组（正常组织零噪音）', () => {
    expect(findUnconfiguredLevels([emp('张三', 'L1.1'), emp('林清越', 'L3.2')], configs)).toEqual([]);
  });

  it('产出一条 major 级建议，并写清三个后果（颜色 / 成本 / 分布）', () => {
    const tree: Department[] = [{
      id: 'd1', name: '技术部', level: 1, expanded: true, positions: [], children: [],
      employees: [emp('林清越', 'L3.2Acting')],
    }];
    const suggestions = generateUnconfiguredLevelSuggestions(tree, configs);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ id: 'level-unconfigured', severity: 'major' });
    expect(suggestions[0].title).toContain('1 人');
    expect(suggestions[0].detail).toContain('L3.2Acting');
    expect(suggestions[0].detail).toContain('成本按 0 计');
  });

  it('经 collectAllSuggestions 汇总（缺省不传配置则跳过，保持既有调用方安全）', () => {
    const tree: Department[] = [{
      id: 'd1', name: '技术部', level: 1, expanded: true, positions: [], children: [],
      employees: [emp('林清越', 'L3.2Acting')],
    }];
    const report = computeHealthReport(tree, DEFAULT_LEVELS);
    expect(collectAllSuggestions(report, tree, undefined, configs).some((s) => s.id === 'level-unconfigured')).toBe(true);
    expect(collectAllSuggestions(report, tree).some((s) => s.id === 'level-unconfigured')).toBe(false);
  });
});
