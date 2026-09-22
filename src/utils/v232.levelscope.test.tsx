// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useOrgWorkspace } from './useOrgWorkspace';
import { updateLevelConfigs, resetLevelConfigs, DEFAULT_LEVELS } from './levels';
import { parseProject, serializeProject, createProject, decodeStoredProject } from './project';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * v2.3.2 P2：职级配置（颜色 / 标签 / 成本）是**工作区级**属性，不随演练场景切换而变。
 *
 * 缺陷现场（Chromium 实测）：
 * ```
 * ① 在「基线」把 L1.1 改成红色并保存 → 画布变红
 * ② 切到「调优方案A」               → 变回旧淡紫  ← 用户：「我改的颜色呢？」
 * ③ 切回「基线」                   → 又是红色
 * ```
 * 根因：`Scenario.levelConfigs` 是场景级快照，而 `switchScenario → loadSnapshot → updateLevelConfigs()`
 * 会把目标场景的旧快照覆盖到全局配置上；但编辑入口（右上角「职级管理」）看起来是全局的。
 */

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
  vi.useFakeTimers();
  // 职级 store 有模块级缓存：每个用例从默认配置重新开始，避免相互污染
  resetLevelConfigs();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetLevelConfigs();
});

const red: typeof DEFAULT_LEVELS = [{ code: 'L', number: '1.1', label: '初级专员', color: '#FF0000', cost: 9 }];

describe('v2.3.2 P2 职级配置工作区级', () => {
  it('改配置后切换场景，配置不被旧场景快照覆盖（回退修复即失败）', () => {
    const { result } = renderHook(() => useOrgWorkspace());
    const baseId = result.current.currentScenarioId;

    // 建第二个场景：它的 levelConfigs 是「改动之前」的快照
    act(() => { result.current.createNewScenario('调优方案A'); });
    const newId = result.current.currentScenarioId;
    act(() => { result.current.switchScenario(baseId); });

    // 在当前场景改职级配色
    act(() => { updateLevelConfigs(red); });
    expect(result.current.levelConfigs[0].color).toBe('#FF0000');

    // 切到旧场景 → 仍是新配色（旧实现在这里会变回默认色）
    act(() => { result.current.switchScenario(newId); });
    expect(result.current.levelConfigs[0].color).toBe('#FF0000');

    // 切回来也一样
    act(() => { result.current.switchScenario(baseId); });
    expect(result.current.levelConfigs[0].color).toBe('#FF0000');
  });

  it('配置随场景保存/落盘，但真值写在项目级（重新加载后仍是自定义配色）', () => {
    const { result } = renderHook(() => useOrgWorkspace());
    act(() => { updateLevelConfigs(red); });
    act(() => { vi.advanceTimersByTime(900); }); // 触发 debounce 落盘

    // 落盘可能是压缩形态（lz16:），必须真正解压后再断言 —— 否则这条用例会"假通过"
    const raw = storage.get('org-designer.project.v2')!;
    expect(raw).toBeTruthy();
    const parsed = parseProject(decodeStoredProject(raw)!)!;
    expect(parsed.levelConfigs?.[0]?.color).toBe('#FF0000');
    expect(result.current.levelConfigs[0].color).toBe('#FF0000');
  });

  it('旧文件（无项目级 levelConfigs）→ 从当前场景迁移，不退回默认配色', () => {
    const p = createProject('旧文件');
    p.scenarios[0].levelConfigs = red;
    delete (p as unknown as Record<string, unknown>).levelConfigs;
    expect(parseProject(serializeProject(p))!.levelConfigs).toEqual(red);
  });
});
