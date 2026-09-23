// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from '../App';
import { INDUSTRY_TEMPLATES } from '../utils/industryTemplates';
import { createProject, PROJECT_STORAGE_KEY } from '../utils/project';

/**
 * V2.4.0 批次一：菜单入口归位。
 *
 * 1. 「行业模板」（顶部下拉）并入「载入示例数据」（左侧底部）——两个入口原本高度重复：
 *    前者列 5 个行业模板，后者载入一份同样性质的硬编码 10 人示例。
 * 2. 「工具模板」（顶部下拉）挪进左侧「文件上传」，与上传行配对：上传什么 → 就下载什么模板。
 * 3. 左侧「组织健康度」移除——与顶部「健康度」是同一个抽屉，按
 *    「顶部放高频操作、左侧管导入导出备份」的分工只保留顶部入口。
 * 4. 硬编码的 10 人示例数据删除。
 *
 * 其中第 2 项有一个**结构性约束**：下载按钮不能嵌在 `<label>` 里 ——
 * 否则点「下载模板」会连带触发那个 label 的文件选择器（本文件把它锁住）。
 */

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  storage.set('org-designer.onboarded', '1');
  storage.set('org-designer.display-hint', '1');
  const seeded = createProject('入口归位测试');
  Object.assign(seeded.scenarios[0], {
    departments: [{ id: 'd1', name: '技术部', level: 1, expanded: true, employees: [], children: [], positions: [] }],
  });
  storage.set(PROJECT_STORAGE_KEY, JSON.stringify(seeded));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.useFakeTimers();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('V2.4.0 顶部菜单不再有「工具模板」「行业模板」', () => {
  it('两个顶部下拉入口都已移除', () => {
    render(<App />);
    expect(screen.queryByRole('button', { name: /工具模板/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^行业模板$/ })).toBeNull();
  });

  it('顶部仍保留高频操作（岗位与编制 / 胜任度 / 健康度）', () => {
    render(<App />);
    for (const name of ['岗位与编制', '胜任度', '健康度']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });

  it('「岗位操作」与「缺口清单」两个旧入口已合并，不再各自出现', () => {
    render(<App />);
    expect(screen.queryByRole('button', { name: '缺口清单' })).toBeNull();
    expect(screen.queryByRole('button', { name: '岗位' })).toBeNull();
  });
});

describe('V2.4.0 模板下载挪进左侧「文件上传」并与其配对', () => {
  it('两个上传行各自带一个「模板」下载按钮', () => {
    render(<App />);
    expect(screen.getByTitle(/下载「员工信息」Excel 模板/)).toBeTruthy();
    expect(screen.getByTitle(/下载「组织架构」Excel 模板/)).toBeTruthy();
  });

  it('模板行有「模板」前缀，两个按钮写明是哪份模板（不是笼统的「模板」）', () => {
    render(<App />);
    const row = screen.getByTitle(/下载「员工信息」Excel 模板/).parentElement as HTMLElement;
    expect(row.textContent).toContain('模板');
    expect(within(row).getByRole('button', { name: '员工信息' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: '组织架构' })).toBeTruthy();
  });

  it('下载按钮不得嵌在 <label> 内（否则点击会连带弹出文件选择器）', () => {
    render(<App />);
    for (const re of [/下载「员工信息」Excel 模板/, /下载「组织架构」Excel 模板/]) {
      const btn = screen.getByTitle(re);
      expect(btn.tagName).toBe('BUTTON');
      expect(btn.closest('label')).toBeNull();
    }
  });

  it('上传行本身仍是 label（点击行内任意处仍能选文件）', () => {
    const { container } = render(<App />);
    const fileInputs = container.querySelectorAll('input[type="file"]');
    expect(fileInputs.length).toBeGreaterThanOrEqual(2);
    // 每个文件输入都必须在某个 label 内（保证「点整行即可上传」的手感没被破坏）
    for (const input of Array.from(fileInputs)) {
      expect((input as HTMLElement).closest('label')).not.toBeNull();
    }
  });
});

describe('V2.4.0 顶部栏合并为一行', () => {
  it('不再显示写死的项目名「组织架构项目」（createProject 的默认值，用户从未设置过）', () => {
    render(<App />);
    expect(screen.queryByText('组织架构项目')).toBeNull();
  });

  it('不再显示版本号徽标（移到品牌 title 里，不占位置）', () => {
    const { container } = render(<App />);
    const header = container.querySelector('header')!;
    expect(header.textContent).not.toMatch(/v\d+\.\d+\.\d+/);
  });

  it('只保留一个 header（第二行工具条已并入，不存在独立的 toolbar 容器）', () => {
    const { container } = render(<App />);
    expect(container.querySelectorAll('header')).toHaveLength(1);
    expect(container.querySelector('.workspace-toolbar')).toBeNull();
    expect(container.querySelector('.workspace-context')).toBeNull();
  });

  it('合并后所有入口仍在这一个 header 里（一个都不能丢）', () => {
    const { container } = render(<App />);
    const header = container.querySelector('header')!;
    for (const name of ['岗位与编制', '胜任度', '搜索', '健康度', '场景对比', '职级管理', '缩小', '放大', '撤销', '重做']) {
      expect(within(header as HTMLElement).getByRole('button', { name })).toBeTruthy();
    }
  });

  it('保存状态与场景切换器也在同一行里', () => {
    const { container } = render(<App />);
    const header = container.querySelector('header')!;
    expect(header.textContent).toContain('已保存');
    expect(header.textContent).toContain('场景');
  });

  it('品牌块带版本号 title（版本仍可查，只是不占版面）', () => {
    const { container } = render(<App />);
    const brand = container.querySelector('.workspace-brand')!;
    expect(brand.getAttribute('title')).toMatch(/v\d+\.\d+\.\d+/);
  });
});

describe('V2.4.0 左侧不再有「组织健康度」', () => {
  it('该入口已移除，顶部「健康度」保留', () => {
    render(<App />);
    expect(screen.queryByRole('button', { name: '组织健康度' })).toBeNull();
    expect(screen.getByRole('button', { name: '健康度' })).toBeTruthy();
  });

  it('侧栏「分析 & 备份」其余入口不受影响', () => {
    render(<App />);
    for (const name of ['诊断报告', '数据备份 (.orgproj)', '从 .orgproj 恢复']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
  });
});

describe('V2.4.0「载入示例数据」= 模板选择器（原「行业模板」并入此处）', () => {
  const openPicker = () => {
    fireEvent.click(screen.getByRole('button', { name: '载入示例数据' }));
    return screen.getByRole('dialog', { name: '行业模板' });
  };

  it('点击后打开模板选择器，5 个行业模板全部可选（不再是"直接导入一份示例"）', () => {
    render(<App />);
    const picker = openPicker();
    const useButtons = within(picker).getAllByRole('button', { name: '使用此模板' });
    expect(useButtons).toHaveLength(INDUSTRY_TEMPLATES.length);
    for (const tpl of INDUSTRY_TEMPLATES) {
      expect(within(picker).getByText(tpl.name)).toBeTruthy();
    }
  });

  it('选中模板才真正进入导入流程（先弹「确认导入到新场景」）', () => {
    render(<App />);
    const picker = openPicker();
    fireEvent.click(within(picker).getAllByRole('button', { name: '使用此模板' })[0]);
    expect(screen.getByRole('dialog', { name: '确认导入到新场景' })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '行业模板' })).toBeNull();
  });

  it('取消选择不产生任何导入（选择器可安全打开）', () => {
    render(<App />);
    const picker = openPicker();
    fireEvent.click(within(picker).getByRole('button', { name: '关闭' }));
    act(() => { vi.advanceTimersByTime(900); });
    expect(screen.queryByRole('dialog', { name: '行业模板' })).toBeNull();
    expect(screen.queryByRole('dialog', { name: '确认导入到新场景' })).toBeNull();
  });

  it('空状态引导里同样只剩「载入示例数据」（原「载入示例模板」已并入，且它也开同一个选择器）', () => {
    storage.set(PROJECT_STORAGE_KEY, JSON.stringify(createProject('空'))); // 空工作区 → 画布显示引导 Hero
    render(<App />);
    expect(screen.queryByRole('button', { name: '载入示例模板' })).toBeNull();
    const entries = screen.getAllByRole('button', { name: '载入示例数据' });
    expect(entries).toHaveLength(2); // 侧栏底部 + 空状态引导
    fireEvent.click(entries[1]);
    expect(screen.getByRole('dialog', { name: '行业模板' })).toBeTruthy();
  });
});
