// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useOrgWorkspace } from './useOrgWorkspace';
import { parseProject, readProjectVersion, decodeStoredProject, PROJECT_STORAGE_KEY, UnsupportedProjectVersionError } from './project';
import { DEFAULT_LEVELS } from './levels';

/**
 * —— v2.3.1 工程加固回归（审计报告 Q-09 / Q-11 / Q-12）——
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const storage = new Map<string, string>();
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
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules(); // Q-12 的 doMock 不得泄漏到后续用例
  vi.useRealTimers();
});

// ───────────────────── Q-11：版本号不得被臆造为 v1 ─────────────────────

describe('v2.3.1 Q-11：缺失 / 非法版本号不得被当作 v1', () => {
  const now = '2026-09-01T00:00:00.000Z';

  /** 当前格式（v4）形态、但故意不写 version：有岗位引用，且部门有 headcount>0 */
  const shapeless = () => ({
    id: 'proj',
    name: '项目',
    currentScenarioId: 's1',
    scenarios: [
      {
        id: 's1',
        name: '基线',
        createdAt: now,
        updatedAt: now,
        levelConfigs: DEFAULT_LEVELS.map((c) => ({ ...c })),
        canvas: { zoom: 100 },
        competencies: undefined,
        departments: [
          {
            id: 'd1',
            name: '研发部',
            level: 1,
            expanded: true,
            headcount: 5,
            children: [],
            employees: [{ id: 'e1', name: '张三', employeeId: 'E001', level: 'L1' }],
          },
        ],
        allEmployeesFlat: [{ id: 'e1', name: '张三', employeeId: 'E001', level: 'L1' }],
      },
    ],
    meta: { createdAt: now, updatedAt: now },
  });

  it('readProjectVersion：数字、纯数字字符串可识别；缺失/非数字为 undefined', () => {
    expect(readProjectVersion({ version: 3 })).toBe(3);
    expect(readProjectVersion({ version: '5' })).toBe(5);
    expect(readProjectVersion({})).toBeUndefined();
    expect(readProjectVersion({ version: 'v5' })).toBeUndefined();
    expect(readProjectVersion({ version: null })).toBeUndefined();
  });

  it('无版本号的文件按当前格式对待：不跑 v1 迁移、不伪造岗位关联', () => {
    const parsed = parseProject(JSON.stringify(shapeless()))!;
    expect(parsed).not.toBeNull();
    const sc = parsed.scenarios[0];
    // ← v2.3.0 会把版本当 1 → 派生「默认岗位」并把员工套上去（伪造人岗关联）
    expect(sc.positions ?? []).toHaveLength(0);
    expect(sc.departments[0].employees[0].positionId).toBeUndefined();
    expect(sc.allEmployeesFlat[0].positionId).toBeUndefined();
  });

  it('字符串版本 "5" 也必须被拒绝（旧实现只认 number → 放行）', () => {
    const data = { ...shapeless(), version: '5' };
    expect(() => parseProject(JSON.stringify(data))).toThrowError(UnsupportedProjectVersionError);
  });

  it('真正的 v1 文件（version: 1）仍照常迁移（不误伤）', () => {
    const parsed = parseProject(JSON.stringify({ ...shapeless(), version: 1 }))!;
    const sc = parsed.scenarios[0];
    expect(parsed.version).toBe(4);
    expect(sc.positions?.length).toBe(1); // 派生默认岗位
    expect(sc.allEmployeesFlat[0].positionId).toBeTruthy(); // 名册同步套岗（F-09）
  });
});

// ───────────────────── Q-12：保存失败不得静默改道下载 ─────────────────────

describe('v2.3.1 Q-12：Tauri 写入失败不得静默回退浏览器下载', () => {
  const clicks: string[] = [];

  beforeEach(() => {
    clicks.length = 0;
    // 记录 a.click()（浏览器下载路径）
    const originalCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = originalCreate(tag) as HTMLElement;
      if (tag === 'a') {
        (el as HTMLAnchorElement).click = () => {
          clicks.push((el as HTMLAnchorElement).download);
        };
      }
      return el;
    });
  });

  it('非 Tauri 环境：走浏览器下载并返回 true', async () => {
    const { saveFile } = await import('./tauri');
    const ok = await saveFile('a.txt', new Uint8Array([1]), 'text/plain');
    expect(ok).toBe(true);
    expect(clicks).toEqual(['a.txt']);
  });

  it('Tauri 用户取消 → 返回 false，且不改道下载', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    vi.doMock('@tauri-apps/plugin-dialog', () => ({ save: async () => null }));
    vi.doMock('@tauri-apps/plugin-fs', () => ({ writeFile: vi.fn() }));
    const { saveFile } = await import('./tauri');
    const ok = await saveFile('a.orgproj', new Uint8Array([1]), 'application/json');
    expect(ok).toBe(false);
    expect(clicks).toEqual([]);
  });

  it('Tauri 写入失败 → 抛错（调用方可见失败），不得返回 true 并偷偷下载', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    vi.doMock('@tauri-apps/plugin-dialog', () => ({ save: async () => '/tmp/x.orgproj' }));
    vi.doMock('@tauri-apps/plugin-fs', () => ({
      writeFile: async () => {
        throw new Error('permission denied');
      },
    }));
    const { saveFile } = await import('./tauri');
    await expect(saveFile('a.orgproj', new Uint8Array([1]), 'application/json')).rejects.toThrow('permission denied');
    // ← v2.3.0：这里会静默回退成浏览器下载并 resolve(true)，调用方 toast「已导出」
    expect(clicks).toEqual([]);
  });
});

// ───────────────────── Q-09：离开页面前必须落盘 ─────────────────────

describe('v2.3.1 Q-09：pagehide / 切后台必须把待写快照落盘', () => {
  it('编辑后 800ms 内触发 pagehide → 修改已落盘（旧实现直接丢失）', () => {
    const { result } = renderHook(() => useOrgWorkspace());
    act(() => {
      result.current.setDepartments(() => [
        { id: 'd1', name: '研发部', level: 1, expanded: true, children: [], employees: [] },
      ]);
    });
    // 尚未到 800ms debounce 窗口 → 磁盘上还没有这次修改
    const before = storage.get(PROJECT_STORAGE_KEY) ?? '';
    expect(before.includes('研发部')).toBe(false);

    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    const after = storage.get(PROJECT_STORAGE_KEY) ?? '';
    expect(after).not.toBe('');
    expect(after).not.toBe(before);
    // 落盘内容可被解析回，且包含刚编辑的部门（用与运行时同一个解码入口）
    const json = decodeStoredProject(after);
    expect(json).not.toBeNull();
    const restored = parseProject(json!);
    expect(restored?.scenarios[0].departments[0].name).toBe('研发部');
  });

  it('当前无待写内容时 pagehide 不产生额外写入', () => {
    renderHook(() => useOrgWorkspace());
    const before = storage.get(PROJECT_STORAGE_KEY) ?? null;
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    expect(storage.get(PROJECT_STORAGE_KEY) ?? null).toBe(before);
  });
});
