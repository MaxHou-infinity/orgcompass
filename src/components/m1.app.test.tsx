// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from '../App';
import * as excel from '../utils/excel';
import { createProject, loadProject, PROJECT_STORAGE_KEY } from '../utils/project';
import type { Employee, Department } from '../types';

/** V2.4.0：「岗位与编制」是页面级子界面（不是弹窗），用 data-page 锚点取容器 */
const boardPage = () => document.querySelector('[data-page="position-board"]') as HTMLElement;

const storage = new Map<string, string>();
const t = '2026-09-01T00:00:00.000Z';
function seed() {
  const e: Employee = { id: 'e', name: 'M1员工', employeeId: 'E01', level: 'L1', positionId: 'pa' };
  const tree: Department[] = ['a', 'b'].map((id) => ({ id, name: `部门${id}`, level: 1, employees: id === 'a' ? [e] : [], children: [], expanded: true,
    positions: [{ id: `p${id}`, departmentId: id, name: `岗位${id}`, headcount: 1, status: 'active', createdAt: t, updatedAt: t }] }));
  const p = createProject('M1测试');
  Object.assign(p.scenarios[0], { departments: tree, allEmployeesFlat: [e],
    positionAssignments: [{ id: 'rel', employeeId: 'e', positionId: 'pa', type: 'primary', status: 'active', source: 'legacy', createdAt: t, updatedAt: t }],
    assessments: [{ id: 'score', employeeId: 'e', dimension: 'business', score: 2, scale: { min: 1, max: 5 }, requirement: 3,
      assessorRole: 'supervisor', assessedAt: t, source: 'manual', createdAt: t, updatedAt: t }] });
  storage.set(PROJECT_STORAGE_KEY, JSON.stringify(p));
  return p;
}
beforeEach(() => {
  storage.clear();
  storage.set('org-designer.onboarded', '1'); storage.set('org-designer.display-hint', '1');
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.useFakeTimers();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const save = () => act(() => vi.advanceTimersByTime(850));

describe('M1 真实 App 入口', () => {
  /**
   * V2.4.0：「行业模板」已并入「载入示例数据」——点它先打开模板选择器，再选一个模板载入。
   * 所以这里多一步「使用此模板」。
   */
  const loadSampleTemplate = () => {
    fireEvent.click(screen.getByRole('button', { name: '载入示例数据' }));
    const picker = screen.getByRole('dialog', { name: '行业模板' });
    fireEvent.click(within(picker).getAllByRole('button', { name: '使用此模板' })[0]);
  };

  it('A22 导入预览取消无变化，确认后保留原场景及评分关系', () => {
    const original = seed();
    render(<App />);
    const before = storage.get(PROJECT_STORAGE_KEY);
    loadSampleTemplate();
    let dialog = screen.getByRole('dialog', { name: '确认导入到新场景' });
    expect(dialog.textContent).toContain('1 条评分');
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(storage.get(PROJECT_STORAGE_KEY)).toBe(before);
    loadSampleTemplate();
    dialog = screen.getByRole('dialog', { name: '确认导入到新场景' });
    fireEvent.click(within(dialog).getByRole('button', { name: '保留原场景并导入' }));
    save();
    const p = loadProject()!;
    expect(p.scenarios).toHaveLength(2);
    const prior = p.scenarios.find((s) => s.id === original.currentScenarioId)!;
    expect(prior.assessments).toHaveLength(1);
    expect(prior.positionAssignments![0].id).toBe('rel');
    expect(p.scenarios.find((s) => s.id === p.currentScenarioId)!.assessments).toEqual([]);
  });

  it('岗位操作跨部门套岗同步名册、画布与历史；撤销一步恢复', () => {
    seed(); render(<App />);
    // V2.4.0：原「岗位操作」弹窗已并入页面级「岗位与编制」；套岗改为**行内**展开候选人
    fireEvent.click(screen.getByRole('button', { name: '岗位与编制' }));
    const page = boardPage();
    const bRow = page.querySelector('[data-position-row="pb"]') as HTMLElement;
    expect(bRow).toBeTruthy();
    fireEvent.click(within(bRow).getByRole('button', { name: '套岗' }));
    const assign = page.querySelector('[data-assign-row="pb"]') as HTMLElement;
    fireEvent.click(within(assign).getByRole('button', { name: /M1员工/ }));
    save();
    const sc = loadProject()!.scenarios[0];
    expect(sc.allEmployeesFlat[0].positionId).toBe('pb');
    expect(sc.departments[0].employees).toEqual([]);
    expect(sc.departments[1].employees[0].positionId).toBe('pb');
    expect(sc.positionAssignments!.find((r) => r.id === 'rel')!.status).toBe('ended');
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true }); save();
    expect(loadProject()!.scenarios[0].allEmployeesFlat[0].positionId).toBe('pa');
    expect(loadProject()!.scenarios[0].positionAssignments).toHaveLength(1);
  });

  it('岗位删除（归档）先展示影响，取消不改；确认后关系结束、评分保留', () => {
    seed(); render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '岗位与编制' }));
    const page = boardPage();
    const row = () => page.querySelector('[data-position-row="pa"]') as HTMLElement;
    fireEvent.click(within(row()).getByRole('button', { name: '删除' }));
    let dialog = screen.getByRole('dialog', { name: '确认归档岗位' });
    expect(dialog.textContent).toContain('M1员工');
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(loadProject()!.scenarios[0].allEmployeesFlat[0].positionId).toBe('pa');
    fireEvent.click(within(row()).getByRole('button', { name: '删除' }));
    dialog = screen.getByRole('dialog', { name: '确认归档岗位' });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认执行' })); save();
    const sc = loadProject()!.scenarios[0];
    expect(sc.departments[0].positions![0].status).toBe('archived');
    expect(sc.allEmployeesFlat[0].positionId).toBeUndefined();
    expect(sc.assessments).toHaveLength(1);
    expect(sc.positionAssignments![0].status).toBe('ended');
    // V2.4.0：删除后必须**持续可见**地提示「无明确岗位」员工（用户明确要求）
    const banner = document.querySelector('[data-positionless-banner]') as HTMLElement;
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('无明确岗位');
    expect(banner.textContent).toContain('M1员工');
  });
});


describe('M1 评分导入应用路径（仅替代文件读取）', () => {
  async function upload() {
    fireEvent.click(screen.getByRole('button', { name: '胜任度' }));
    fireEvent.click(screen.getByRole('button', { name: '发起批量评估' }));
    await act(async () => { fireEvent.change(screen.getByLabelText('导入评分表'), { target: { files: [new File([''], 'scores.xlsx')] } }); });
  }
  it('身份歧义提示，整批无评分写入', async () => {
    const p = seed();
    p.scenarios[0].allEmployeesFlat.push({ ...p.scenarios[0].allEmployeesFlat[0], id: 'duplicate' });
    storage.set(PROJECT_STORAGE_KEY, JSON.stringify(p));
    vi.spyOn(excel, 'parseAssessmentExcel').mockResolvedValue([{ employeeKey: 'E01', employeeKeyType: 'employeeId', scores: { business: 4 } }]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<App />); await upload();
    expect(screen.getByText(/评分表第 2 行.*存在身份歧义/)).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: '确认评分导入' })).toBeNull();
    save(); expect(loadProject()!.scenarios[0].assessments).toHaveLength(1);
  });
  it('匹配后预览取消不写入，确认一次追加全部评分', async () => {
    seed();
    vi.spyOn(excel, 'parseAssessmentExcel').mockResolvedValue([{ employeeKey: 'E01', employeeKeyType: 'employeeId', assessedAt: '2026-09-10', scores: { business: 4, individual: 3 } }]);
    render(<App />); await upload();
    let preview = screen.getByRole('dialog', { name: '确认评分导入' });
    expect(preview.textContent).toContain('共 2 条评分');
    fireEvent.click(within(preview).getByRole('button', { name: '取消' }));
    save(); expect(loadProject()!.scenarios[0].assessments).toHaveLength(1);
    await act(async () => { fireEvent.change(screen.getByLabelText('导入评分表'), { target: { files: [new File([''], 'scores.xlsx')] } }); });
    preview = screen.getByRole('dialog', { name: '确认评分导入' });
    fireEvent.click(within(preview).getByRole('button', { name: '确认执行' }));
    save(); expect(loadProject()!.scenarios[0].assessments).toHaveLength(3);
  });
});
