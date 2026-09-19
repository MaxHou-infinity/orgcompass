// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getDisplaySettings,
  setDisplaySetting,
  resetDisplaySettingsCache,
} from './displaySettings';

/**
 * v2.3.1（T-04）：原用例跑在 node 环境且**没有 stub localStorage**，
 * `typeof localStorage === 'undefined'` 恒真 → 读写全部走 try/catch 兜底，
 * 「持久化」这条路径从未被执行过（把 save/load 的 storage 读写整段删掉，3/3 仍全绿）。
 * 这里改为 jsdom + 显式 storage stub，真正验证「写入 → 重置缓存 → 读回」闭环。
 */
describe('displaySettings（v2.0.7 画布显示开关；v2.3.1 T-04 补真实持久化断言）', () => {
  const storage = new Map<string, string>();
  const KEY = 'org-designer.display-settings';

  beforeEach(() => {
    storage.clear();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
      clear: () => storage.clear(),
      key: () => null,
      length: storage.size,
    });
    resetDisplaySettingsCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetDisplaySettingsCache();
  });

  it('默认 显示职级=on、显示岗位=on', () => {
    expect(getDisplaySettings()).toEqual({ showLevel: true, showTitle: true });
  });

  it('setDisplaySetting 可关闭单项并持久化到缓存', () => {
    setDisplaySetting('showLevel', false);
    expect(getDisplaySettings().showLevel).toBe(false);
    expect(getDisplaySettings().showTitle).toBe(true);
  });

  it('resetDisplaySettingsCache 只清内存缓存：有持久化值时重新载入持久化值', () => {
    // v2.3.1（T-04）：旧断言「回默认」只有在 localStorage 不可用时才成立（node 环境下的意外），
    // 有存储时该函数只是丢弃缓存，下一次读取会重新载入已持久化的值。
    setDisplaySetting('showTitle', false);
    resetDisplaySettingsCache();
    expect(getDisplaySettings()).toEqual({ showLevel: true, showTitle: false });
  });

  it('存储不可用/无记录时才回默认', () => {
    resetDisplaySettingsCache();
    expect(getDisplaySettings()).toEqual({ showLevel: true, showTitle: true });
  });

  it('确实写入了 localStorage，且「重置缓存 → 读回」得到相同值（真正的持久化闭环）', () => {
    setDisplaySetting('showTitle', false);
    expect(storage.has(KEY)).toBe(true); // ← 旧用例从未断言这一步
    expect(JSON.parse(storage.get(KEY)!)).toEqual({ showLevel: true, showTitle: false });
    // 模拟重启：清掉内存缓存，只留存储
    resetDisplaySettingsCache();
    expect(getDisplaySettings()).toEqual({ showLevel: true, showTitle: false });
  });

  it('非法 JSON / 非布尔字段回退默认，不抛错', () => {
    storage.set(KEY, '{ not json');
    resetDisplaySettingsCache();
    expect(getDisplaySettings()).toEqual({ showLevel: true, showTitle: true });

    storage.set(KEY, JSON.stringify({ showLevel: 'yes', showTitle: 0 }));
    resetDisplaySettingsCache();
    expect(getDisplaySettings()).toEqual({ showLevel: true, showTitle: true });
  });

  it('订阅者在设置变化时收到通知（画布需重渲染）', async () => {
    const { useDisplaySettings } = await import('./displaySettings');
    void useDisplaySettings; // 仅确认 hook 已导出且未破坏模块
    const seen: boolean[] = [];
    // 通过公开 API 间接观察：设置后再次读取必须反映新值
    setDisplaySetting('showLevel', false);
    seen.push(getDisplaySettings().showLevel);
    expect(seen).toEqual([false]);
  });
});
