import { useSyncExternalStore } from 'react';

/**
 * 画布显示设置（v2.0.7 新增）：是否在画布上显示员工的 title(岗位) 与职级。
 * 默认都开；持久化到 localStorage；纯 UI 偏好，与数据解耦。
 */
export interface DisplaySettings {
  showLevel: boolean;
  showTitle: boolean;
}

const KEY = 'org-designer.display-settings';
const DEFAULTS: DisplaySettings = { showLevel: true, showTitle: true };

let cache: DisplaySettings | null = null;
const listeners = new Set<() => void>();

function load(): DisplaySettings {
  if (cache) return cache;
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const p = JSON.parse(raw) as Partial<DisplaySettings>;
        cache = {
          showLevel: typeof p.showLevel === 'boolean' ? p.showLevel : DEFAULTS.showLevel,
          showTitle: typeof p.showTitle === 'boolean' ? p.showTitle : DEFAULTS.showTitle,
        };
        return cache;
      }
    }
  } catch {
    /* ignore */
  }
  cache = { ...DEFAULTS };
  return cache;
}

function save(s: DisplaySettings): void {
  cache = s;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
}

export function getDisplaySettings(): DisplaySettings {
  return load();
}

export function setDisplaySetting(key: keyof DisplaySettings, value: boolean): void {
  save({ ...getDisplaySettings(), [key]: value });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useDisplaySettings(): DisplaySettings {
  return useSyncExternalStore(subscribe, getDisplaySettings, getDisplaySettings);
}

/** 仅测试用：清空内存缓存，使下一次读取重新从 localStorage 载入。
 *  v2.3.1（T-04）：原注释写「回默认」与实现不符 —— 有持久化值时重新载入的就是持久化值；
 *  只有存储不可用/无记录时才回默认。 */

export function resetDisplaySettingsCache(): void {
  cache = null;
  listeners.clear();
}
