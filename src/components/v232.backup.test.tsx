// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from '../App';
import { Sidebar } from './Sidebar';
import { ProjectModal } from './ProjectModal';
import { createProject, orgprojFileName, serializeProject, summarizeProjectJson, PROJECT_STORAGE_KEY } from '../utils/project';
import type { Department, Employee } from '../types';

/**
 * v2.3.2：`.orgproj` 备份的「回程」回归。
 *
 * 用户反馈原话：「这个数据备份 .orgproj 备份了之后似乎没有办法恢复……现在系统仍然提示需要重新导入员工信息」。
 * 实测确认导出/恢复链路本身是通的，坏的是**可发现性**：
 * 侧栏「数据备份 (.orgproj)」只有导出，恢复藏在「场景下拉 → 管理场景 → 项目文件」四步深处，
 * 用户点完备份根本找不到回程入口。本文件锁住三件事：
 * ① 备份旁边必须有恢复入口；② 空工作区不允许导出空备份；③ 恢复后有可见的内容摘要。
 */

const storage = new Map<string, string>();

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
  vi.useFakeTimers();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const save = () => act(() => vi.advanceTimersByTime(850));

/** 带数据的项目：技术部 > 研发部，1 名员工 + 1 个岗位 */
function withData() {
  const t = '2026-09-01T00:00:00.000Z';
  const e: Employee = { id: 'e1', name: '张三', employeeId: 'E001', level: 'L2.1', dept1: '技术部', dept2: '研发部', positionId: 'p1' };
  const tree: Department[] = [{
    id: 'd1', name: '技术部', level: 1, expanded: true, employees: [], positions: [], children: [{
      id: 'd2', name: '研发部', level: 2, expanded: true, employees: [e], children: [],
      positions: [{ id: 'p1', departmentId: 'd2', name: '前端工程师', headcount: 3, status: 'active', createdAt: t, updatedAt: t }],
    }],
  }];
  const p = createProject('测试项目');
  Object.assign(p.scenarios[0], { departments: tree, allEmployeesFlat: [e], positionAssignments: [], assessments: [] });
  return p;
}

describe('v2.3.2 orgproj 备份文件名', () => {
  it('带本地时间戳（多次备份不再互相覆盖、可从名字分辨先后）', () => {
    expect(orgprojFileName(new Date(2026, 8, 21, 15, 43))).toBe('组织架构项目-20260921-1543.orgproj');
    expect(orgprojFileName(new Date(2026, 0, 5, 9, 7))).toBe('组织架构项目-20260105-0907.orgproj');
  });

  it('两次备份文件名不同（旧实现固定叫 组织架构项目.orgproj）', () => {
    const a = orgprojFileName(new Date(2026, 8, 21, 15, 43));
    const b = orgprojFileName(new Date(2026, 8, 21, 15, 44));
    expect(a).not.toBe(b);
  });
});

describe('v2.3.2 orgproj 内容摘要（恢复后的可见反馈）', () => {
  it('统计场景 / 部门 / 员工 / 岗位', () => {
    const s = summarizeProjectJson(serializeProject(withData()));
    expect(s).toEqual({ name: '测试项目', scenarioCount: 1, departmentCount: 2, employeeCount: 1, positionCount: 1 });
  });

  it('岗位数从部门树内嵌 positions 统计（不依赖可能过期的 Scenario.positions 镜像）', () => {
    const p = withData();
    p.scenarios[0].positions = []; // 镜像为空：旧文件常见
    expect(summarizeProjectJson(serializeProject(p))?.positionCount).toBe(1);
  });

  it('非项目 JSON → null（调用方提示「不是有效的 .orgproj」，而不是静默换成空工作区）', () => {
    expect(summarizeProjectJson('{"foo":1}')).toBeNull();
    // 关键：不是「解析成一个空项目」，而是明确拒绝
    expect(summarizeProjectJson('{"version":4}')).toBeNull();
    expect(summarizeProjectJson('[1,2,3]')).toBeNull();
  });
});

describe('v2.3.2 备份与恢复入口必须挨着（用户反馈的核心缺陷）', () => {
  function sidebarProps() {
    return {
      onEmployeeFileUpload: vi.fn(), onOrgTemplateUpload: vi.fn(), onExportPng: vi.fn(),
      onExportExcel: vi.fn(), onReset: vi.fn(), onLoadTestData: vi.fn(), onCreateDepartment: vi.fn(),
      onOpenReport: vi.fn(), onExportProject: vi.fn(), onRestoreProject: vi.fn(),
      onDownloadEmployeeTemplate: vi.fn(), onDownloadOrgTemplate: vi.fn(), onOpenSamplePicker: vi.fn(),
      onRefreshCanvas: vi.fn(), departments: [], hasData: true, hasEmployees: false, hasOrgTemplate: false,
    };
  }

  it('侧栏同时存在「数据备份」与「从 .orgproj 恢复」，且后者可点', () => {
    const props = sidebarProps();
    render(<Sidebar {...props} />);
    const backup = screen.getByRole('button', { name: /数据备份 \(\.orgproj\)/ });
    const restore = screen.getByRole('button', { name: /从 \.orgproj 恢复/ });
    expect(backup).toBeDefined();
    fireEvent.click(restore);
    expect(props.onRestoreProject).toHaveBeenCalledTimes(1);
  });

  it('备份按钮的 tooltip 说明「只写文件、不产生历史快照」（这是最容易被误解的一点）', () => {
    render(<Sidebar {...sidebarProps()} />);
    expect(screen.getByRole('button', { name: /数据备份 \(\.orgproj\)/ }).getAttribute('title')).toContain('不写入下方「历史快照」');
  });

  it('空工作区：备份禁用，但恢复仍可点（恢复恰恰是空工作区的出路）', () => {
    const props = { ...sidebarProps(), hasData: false };
    render(<Sidebar {...props} />);
    expect((screen.getByRole('button', { name: /数据备份 \(\.orgproj\)/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /从 \.orgproj 恢复/ }));
    expect(props.onRestoreProject).toHaveBeenCalledTimes(1);
  });
});

describe('v2.3.2 项目管理弹窗', () => {
  const baseProps = () => ({
    open: true, onClose: vi.fn(), currentScenarioId: '', onRenameProject: vi.fn(),
    onCreateScenario: vi.fn(), onRenameScenario: vi.fn(), onDeleteScenario: vi.fn(),
    onDuplicateScenario: vi.fn(), onSwitchScenario: vi.fn(), onImport: vi.fn(), onExport: vi.fn(),
    onListBackups: () => [], onRestoreBackup: vi.fn(),
  });

  function renderModal(p: ReturnType<typeof withData>, focusImport: boolean) {
    const props = { ...baseProps(), project: p, currentScenarioId: p.currentScenarioId, focusImport };
    return render(<ProjectModal {...props} />);
  }

  it('focusImport=true → 进入即展开导入确认（从侧栏恢复只需 2 步）', () => {
    const p = withData();
    renderModal(p, true);
    expect(screen.getByText('导入会整体替换当前工作区')).toBeDefined();
    expect(screen.getByRole('button', { name: '继续导入' })).toBeDefined();
  });

  it('focusImport 缺省 → 不自动展开（不打扰从场景入口进来的用户）', () => {
    renderModal(withData(), false);
    expect(screen.queryByText('导入会整体替换当前工作区')).toBeNull();
  });

  it('空工作区禁止「另存为 .orgproj」（否则导出空项目，恢复后仍是空 → 误以为恢复坏了）', () => {
    const empty = createProject('空项目');
    renderModal(empty, false);
    expect((screen.getByRole('button', { name: /另存为 \.orgproj/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('有数据时「另存为 .orgproj」可用', () => {
    renderModal(withData(), false);
    expect((screen.getByRole('button', { name: /另存为 \.orgproj/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('v2.3.2 App 端到端：从侧栏恢复 .orgproj', () => {
  it('侧栏「从 .orgproj 恢复」→ 导入文件 → 画布恢复 + 摘要 toast', async () => {
    // 先做一个"备份文件"（就是序列化后的项目 JSON）
    const backupJson = serializeProject(withData());

    // 当前工作区是空的（模拟换机 / 重装后）
    storage.set(PROJECT_STORAGE_KEY, JSON.stringify(createProject('空工作区')));
    const { container } = render(<App />);
    expect(container.querySelectorAll('[data-dept-id]').length).toBe(0);

    // ① 侧栏入口（不再是四步深处）
    fireEvent.click(screen.getByRole('button', { name: /从 \.orgproj 恢复/ }));
    // ② 弹窗已展开导入确认
    expect(screen.getByText('导入会整体替换当前工作区')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '继续导入' }));

    // ③ 选中文件
    const input = container.querySelector('input[type="file"][accept*="orgproj"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    const file = new File([backupJson], '组织架构项目-20260921-1543.orgproj', { type: 'application/json' });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
      await vi.advanceTimersByTimeAsync(0);
    });
    save();

    // ④ 画布恢复
    expect(container.querySelectorAll('[data-dept-id]').length).toBe(2);
    // ⑤ 摘要可见（不再只弹一句"已导入项目文件"）
    const toast = screen.getByText(/已恢复/);
    expect(toast.textContent).toContain('1 个场景');
    expect(toast.textContent).toContain('2 个部门');
    expect(toast.textContent).toContain('1 名员工');
    expect(toast.textContent).toContain('1 个岗位');
    void within;
  });
});
