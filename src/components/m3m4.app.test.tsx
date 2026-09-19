// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from '../App';
import { createProject, loadProject, PROJECT_STORAGE_KEY } from '../utils/project';
import type { Department, Employee } from '../types';

/**
 * V2.3 M3/M4 应用入口联调：
 * 看板抽屉（统一范围派生 + 筛选 + 下钻）与岗位缺口清单（当前场景直读 + 导出）在真实 App 中可用。
 */

const storage = new Map<string, string>();
const t = '2026-09-01T00:00:00.000Z';

function seed() {
  const boss: Employee = { id: 'boss', name: '负责人', employeeId: 'E00', level: 'L3.1' };
  const e1: Employee = { id: 'e1', name: '张三', employeeId: 'E01', level: 'L1.1', positionId: 'p1' };
  const e2: Employee = { id: 'e2', name: '李四', employeeId: 'E02', level: 'L1.1', positionId: 'p2' };
  const e3: Employee = { id: 'e3', name: '王五', employeeId: 'E03', level: 'L1.1', positionId: 'p3' };
  const dev: Department = {
    id: 'dev', name: '研发部', level: 1, expanded: true, leaderId: 'E00', employees: [boss],
    children: [{ id: 'be', name: '后端组', level: 2, expanded: true, employees: [e1, e2], children: [] }],
    positions: [],
  };
  const sales: Department = {
    id: 'sales', name: '销售部', level: 1, expanded: true, employees: [e3], children: [],
    positions: [{ id: 'p3', departmentId: 'sales', name: '销售岗', headcount: 5, status: 'active', createdAt: t, updatedAt: t }],
  };
  const tree = [
    { ...dev, children: [{ ...dev.children[0], positions: [
      { id: 'p1', departmentId: 'be', name: '后端岗', headcount: 3, status: 'active', createdAt: t, updatedAt: t },
      { id: 'p2', departmentId: 'be', name: '无依据岗', headcount: 2, status: 'active', createdAt: t, updatedAt: t },
    ] }] },
    sales,
  ];
  const p = createProject('M3M4测试');
  Object.assign(p.scenarios[0], {
    departments: tree,
    allEmployeesFlat: [boss, e1, e2, e3],
    positions: [
      { id: 'p1', departmentId: 'be', name: '后端岗', headcount: 3, status: 'active', createdAt: t, updatedAt: t },
      { id: 'p2', departmentId: 'be', name: '无依据岗', headcount: 2, status: 'active', createdAt: t, updatedAt: t },
      { id: 'p3', departmentId: 'sales', name: '销售岗', headcount: 5, status: 'active', createdAt: t, updatedAt: t },
    ],
    assessments: [],
    positionAssignments: [],
  });
  storage.set(PROJECT_STORAGE_KEY, JSON.stringify(p));
  return p;
}

beforeEach(() => {
  storage.clear();
  storage.set('org-designer.onboarded', '1');
  storage.set('org-designer.display-hint', '1');
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  tauriMock.saveFile.mockReset();
  tauriMock.saveFile.mockResolvedValue(true);
  tauriMock.saveTextFile.mockReset();
  tauriMock.saveTextFile.mockResolvedValue(true);
  vi.useFakeTimers();
});
// v2.3.1（T-01）：resetModules 保证每个用例的 `vi.doMock('../utils/tauri')` 真正生效
// （不重置时，前一个用例已经加载过的真实模块会被缓存，mock 形同虚设）。
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });
/**
 * v2.3.1（T-01）：`../utils/tauri` 在 App 里是**静态导入**的，模块在文件加载时就已进入注册表，
 * 用例内的 `vi.doMock` 对它无效（mock 形同虚设，导出断言因此长期零保护）。
 * 这里改用顶层 `vi.hoisted` + `vi.mock`，静态与动态导入都会拿到同一个 mock 实例。
 */
const tauriMock = vi.hoisted(() => ({ saveFile: vi.fn(), saveTextFile: vi.fn() }));
vi.mock('../utils/tauri', () => ({
  saveFile: tauriMock.saveFile,
  saveTextFile: tauriMock.saveTextFile,
  isTauri: () => false,
}));

const save = () => act(() => vi.advanceTimersByTime(850));

/**
 * v2.3.1（T-01 稳定性）：导出内部是异步链（动态 import xlsx → 生成 workbook → 调 saveFile）。
 * 若不在本用例内把它排空，这次 saveFile 调用会落到下一个用例的 await 窗口里，
 * 污染其 mock 调用记录。
 *
 * 注意：纯 `await Promise.resolve()` 的微任务排空**不够** —— 动态 import 与 workbook 生成
 * 需要真实时间推进（覆盖率插桩下尤其明显），因此这里临时切回真实定时器轮询等待，
 * 结束后恢复假定时器（用例其余部分依赖 800ms 自动保存的假时钟）。
 */
async function drainExport(expectedCalls: number): Promise<void> {
  vi.useRealTimers();
  try {
    for (let i = 0; i < 200; i++) {
      if (tauriMock.saveFile.mock.calls.length >= expectedCalls) break;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    }
  } finally {
    vi.useFakeTimers();
  }
}

describe('M3 看板：统一范围、筛选与下钻', () => {
  it('展示五类口径，且筛选与下钻联动', () => {
    seed(); render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '胜任度' }));
    const drawer = screen.getByRole('dialog', { name: '胜任度看板' });

    // 五块口径并列（不合成总分）
    for (const label of ['组织指标', '岗位缺口', '评价完整度', '能力风险 · 待复核']) {
      expect(within(drawer).getByText(label)).toBeTruthy();
    }
    // 全公司范围（未入架构 0 人 → 不显示独立提示）
    expect(within(drawer).getByText('全公司')).toBeTruthy();
    expect(within(drawer).queryByText(/未进入组织架构/)).toBeNull();

    // 下钻到子部门：范围标签与卡片随之变化
    fireEvent.click(within(drawer).getByRole('button', { name: /研发部\s*3 人/ }));
    fireEvent.click(within(drawer).getByRole('button', { name: /后端组\s*2 人/ }));
    expect(within(drawer).getByText('研发部 / 后端组（含下级）')).toBeTruthy();
    // 后端组两个岗位都在（含"无依据岗"：零配置缺口不显示无胜任者）
    expect(within(drawer).getByText('后端岗')).toBeTruthy();
    expect(within(drawer).getByText('无依据岗')).toBeTruthy();
    expect(within(drawer).queryByText('无胜任者')).toBeNull();

    // 筛选：未评（无评分 → 全部未评）
    fireEvent.click(within(drawer).getByRole('button', { name: '未评' }));
    expect(within(drawer).getByText(/明细 2 \/ 2 人/)).toBeTruthy();
    fireEvent.click(within(drawer).getByRole('button', { name: '待复核' }));
    expect(within(drawer).getByText(/明细 0 \/ 2 人/)).toBeTruthy();
  });

  it('未入架构人员独立提示，不混入部门分母', () => {
    const p = seed();
    p.scenarios[0].allEmployeesFlat.push({ id: 'ghost', name: '未入架构', employeeId: 'E99', level: 'L1.1' });
    storage.set(PROJECT_STORAGE_KEY, JSON.stringify(p));
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '胜任度' }));
    const drawer = screen.getByRole('dialog', { name: '胜任度看板' });
    expect(within(drawer).getByText(/全公司另有 1 人已入名册但未进入组织架构/)).toBeTruthy();
    expect(within(drawer).queryByText('未入架构')).toBeNull(); // 不进入明细
  });
});

describe('T09 回归：缺口清单与胜任度看板同源（岗位只存在于部门树）', () => {
  /**
   * 复现验收记录 M4-UI-001 的真实形态：
   * useOrgWorkspace 只维护 departments[].positions，不回写 Scenario.positions 镜像，
   * 因此真实项目里 scenario.positions 常为空 —— 修复前缺口清单会读到 0 个岗位。
   */
  function seedTreeOnlyPositions() {
    const e1: Employee = { id: 'e1', name: '张三', employeeId: 'E01', level: 'L2.1', positionId: 'pos-x' };
    const dept: Department = {
      id: 'd1', name: '产品部', level: 1, expanded: true, employees: [e1], children: [],
      positions: [{ id: 'pos-x', departmentId: 'd1', name: '体验验证岗位', headcount: 2, status: 'active', createdAt: t, updatedAt: t }],
    };
    const p = createProject('T09');
    Object.assign(p.scenarios[0], {
      departments: [dept],
      allEmployeesFlat: [e1],
      positions: [], // 过期镜像：真实项目形态
      assessments: [],
      positionAssignments: [],
    });
    storage.set(PROJECT_STORAGE_KEY, JSON.stringify(p));
  }

  it('看板与缺口清单显示同一岗位与同一待补数', () => {
    seedTreeOnlyPositions();
    render(<App />);

    // 1) 胜任度看板（既有正确路径）
    fireEvent.click(screen.getByRole('button', { name: '胜任度' }));
    const drawer = screen.getByRole('dialog', { name: '胜任度看板' });
    expect(within(drawer).getByText('体验验证岗位')).toBeTruthy();
    const drawerGap = within(drawer).getByText('岗位缺口').parentElement!;
    expect(within(drawerGap).getByText('1')).toBeTruthy(); // 待补 1
    fireEvent.click(within(drawer).getByRole('button', { name: '关闭' }));

    // 2) 缺口清单（修复前为 岗位 0 / 0、待补 0）
    fireEvent.click(screen.getByRole('button', { name: '缺口清单' }));
    const modal = screen.getByRole('dialog', { name: '岗位缺口清单' });
    expect(within(modal).getByText(/岗位 1 \/ 1/)).toBeTruthy();
    expect(within(modal).getByText('体验验证岗位')).toBeTruthy();
    const pendingCard = within(modal).getByText('待补人数').parentElement!;
    expect(within(pendingCard).getByText('1')).toBeTruthy();
    expect(within(modal).queryByText('当前范围与筛选下没有岗位')).toBeNull();
  });

  it('修复后导出的 Excel 含该岗位行（界面与导出一致）', async () => {
    seedTreeOnlyPositions();
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '缺口清单' }));
    const modal = screen.getByRole('dialog', { name: '岗位缺口清单' });
    await act(async () => {
      fireEvent.click(within(modal).getByRole('button', { name: '导出 Excel' }));
    });
    // v2.3.1（T-01）：把导出内部的异步链（xlsx 动态导入 → 写文件）在本用例内跑完
    await drainExport(1);
    expect(tauriMock.saveFile).toHaveBeenCalledTimes(1);
    tauriMock.saveFile.mockClear(); // 用后清空，保证不泄漏到后续用例
    // 导出不应抛错，且页面仍显示 1 行（导出消费与界面同一份 rows）
    expect(within(modal).getByText(/岗位 1 \/ 1/)).toBeTruthy();
    expect(loadProject()!.scenarios).toHaveLength(1);
    save();
  });
});

describe('M4 岗位缺口清单：当前场景直读与导出', () => {
  it('从当前场景打开清单，展示待补/超额与成本缺失，不要求第二个场景', () => {
    seed(); render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '缺口清单' }));
    const modal = screen.getByRole('dialog', { name: '岗位缺口清单' });

    expect(within(modal).getByText('岗位缺口清单')).toBeTruthy();
    // 后端岗 编制 3 / 占用 2 → 待补 1；无依据岗 编制 2 / 占用 0 → 待补 2；销售岗 编制 5 / 占用 1 → 待补 4
    expect(within(modal).getByText('后端岗')).toBeTruthy();
    expect(within(modal).getByText('无依据岗')).toBeTruthy();
    expect(within(modal).getByText('销售岗')).toBeTruthy();
    // 待补合计 7，缺失成本岗位 ≥1（无依据岗无人且无带宽/职级成本）
    const pendingCard = within(modal).getByText('待补人数').parentElement!;
    expect(within(pendingCard).getByText('7')).toBeTruthy();
    // 缺成本显示「无法估算」而不是 0
    expect(within(modal).getAllByText(/无法估算/).length).toBeGreaterThan(0);

    // 岗位状态筛选：有待补
    fireEvent.click(within(modal).getByRole('button', { name: '有待补' }));
    expect(within(modal).getByText(/岗位 3 \/ 3/)).toBeTruthy();
  });

  it('按部门筛选后导出 Excel，消费与界面同一份结果', async () => {
    seed(); render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '缺口清单' }));
    const modal = screen.getByRole('dialog', { name: '岗位缺口清单' });

    fireEvent.change(within(modal).getByRole('combobox', { name: '部门范围' }), { target: { value: 'dev' } });
    // 研发部（含下级）只有后端组两个岗位 → 销售岗被排除
    expect(within(modal).queryByText('销售岗')).toBeNull();
    expect(within(modal).getByText('后端岗')).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(modal).getByRole('button', { name: '导出 Excel' }));
    });
    await drainExport(1);

    // v2.3.1（T-01）：旧断言是 `expect(typeof realSave).toBe('function')` —— 恒真、零保护，
    // 把 buildGapListExcelBytes 改成必抛异常后本文件仍 6/6 全绿。
    // 现在断言真实行为：确实调用了保存、文件名/字节/MIME 正确、且逐行对应当前筛选范围。
    // 按「本用例的场景名」筛选调用，避免任何跨用例的异步泄漏影响判别力。
    const expectedName = `岗位缺口清单-${loadProject()!.scenarios[0].name}.xlsx`;
    const ownCalls = tauriMock.saveFile.mock.calls.filter((c) => c[0] === expectedName);
    expect(ownCalls).toHaveLength(1);
    const [, bytes, mime] = ownCalls[0] as [string, Uint8Array, string];
    expect(mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(bytes.byteLength).toBeGreaterThan(0);
    // 筛选后的导出只含研发部岗位（销售岗被排除），与界面同一份 rows
    const XLSX = await import('xlsx');
    const wb = XLSX.read(bytes, { type: 'array' });
    const sheet = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets['岗位缺口清单']);
    expect(sheet.map((r) => r['岗位']).sort()).toEqual(['后端岗', '无依据岗']);
    expect(sheet.some((r) => r['岗位'] === '销售岗')).toBe(false); // 筛选范围外的岗位不得出现在导出里
    expect(loadProject()!.scenarios).toHaveLength(1); // 导出不改动项目
    save();
  });

  it('v2.3.1 T-01：导出失败必须给出可见错误提示，不得静默', async () => {
    seed(); render(<App />);
    tauriMock.saveFile.mockRejectedValue(new Error('disk full'));
    fireEvent.click(screen.getByRole('button', { name: '缺口清单' }));
    const modal = screen.getByRole('dialog', { name: '岗位缺口清单' });
    await act(async () => {
      fireEvent.click(within(modal).getByRole('button', { name: '导出 Excel' }));
    });
    await act(async () => { await Promise.resolve(); });
    const toasts = screen.getAllByRole('status').map((el) => el.textContent ?? '').join(' | ');
    expect(toasts).toContain('导出岗位缺口清单失败');
  });
});
