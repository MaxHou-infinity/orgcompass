// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from '../App';
import { createProject, loadProject, PROJECT_STORAGE_KEY } from '../utils/project';
import type { Employee, Department } from '../types';

/**
 * V2.3 M2 应用入口验收（契约 A16、A19、A20、A21）：
 * 走真实 App + 工作区 + 组件，验证 HRBP 校准录入、同日修订写入与复核留痕的落库结果。
 */

const storage = new Map<string, string>();
const t = '2026-09-01T00:00:00.000Z';

function seed(): void {
  const e: Employee = { id: 'e', name: 'M2员工', employeeId: 'E01', level: 'L1', positionId: 'pa' };
  const tree: Department[] = [{
    id: 'a', name: '研发部', level: 1, employees: [e], leaderId: 'nobody', children: [], expanded: true,
    positions: [{ id: 'pa', departmentId: 'a', name: '岗位A', headcount: 2, status: 'active', createdAt: t, updatedAt: t }],
  }];
  const p = createProject('M2测试');
  Object.assign(p.scenarios[0], {
    departments: tree,
    allEmployeesFlat: [e],
    positionAssignments: [{ id: 'rel', employeeId: 'e', positionId: 'pa', type: 'primary', status: 'active', source: 'legacy', createdAt: t, updatedAt: t }],
    assessments: [],
  });
  storage.set(PROJECT_STORAGE_KEY, JSON.stringify(p));
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
  vi.useFakeTimers();
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const save = () => act(() => vi.advanceTimersByTime(850));

/** 打开批量评估弹窗并切到员工模型 + 通用评价范围 */
function openBatch() {
  fireEvent.click(screen.getByRole('button', { name: '胜任度' }));
  fireEvent.click(screen.getByRole('button', { name: '发起批量评估' }));
  const dialog = screen.getByRole('dialog', { name: /批量评估/ });
  fireEvent.click(within(dialog).getByRole('button', { name: '员工胜任度' }));
  fireEvent.click(within(dialog).getByRole('button', { name: '通用评价' }));
  fireEvent.change(within(dialog).getByRole('textbox', { name: '牵头 HRBP' }), { target: { value: '牵头HRBP' } });
  return dialog;
}

describe('M2 应用入口：校准 / 修订 / 复核留痕', () => {
  it('A19/D03：HRBP 校准分录入 → assessorRole=hrbp，评分人与批次经办人分开留痕', () => {
    seed();
    render(<App />);
    const dialog = openBatch();
    fireEvent.click(within(dialog).getByRole('button', { name: 'HRBP 校准分' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: '校准 HRBP' }), { target: { value: '校准人B' } });
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'M2员工 · 业务能力' }), { target: { value: '4' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存批次' }));
    save();
    const list = loadProject()!.scenarios[0].assessments!;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      employeeId: 'e',
      dimension: 'business',
      score: 4,
      assessorRole: 'hrbp',
      assessorId: '校准人B',
      enteredBy: '牵头HRBP',
      scope: 'general',
      source: 'manual',
    });
  });

  it('A19/D03：上级原始分录入 → assessorRole=supervisor，不把 HRBP 经办人冒充评分人', () => {
    seed();
    render(<App />);
    const dialog = openBatch();
    fireEvent.change(within(dialog).getByRole('textbox', { name: '上级评分人' }), { target: { value: '上级A' } });
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'M2员工 · 业务能力' }), { target: { value: '2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存批次' }));
    save();
    const list = loadProject()!.scenarios[0].assessments!;
    expect(list[0]).toMatchObject({ assessorRole: 'supervisor', assessorId: '上级A', enteredBy: '牵头HRBP' });
    expect(list[0].assessorId).not.toBe('牵头HRBP');
  });

  it('A16/F03：同日再次录入同一维度 → 保留旧分并写入修订链（旧记录不被改写）', () => {
    seed();
    render(<App />);
    // 第一次录入
    let dialog = openBatch();
    fireEvent.change(within(dialog).getByRole('textbox', { name: '上级评分人' }), { target: { value: '上级A' } });
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'M2员工 · 业务能力' }), { target: { value: '2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存批次' }));
    save();
    const first = loadProject()!.scenarios[0].assessments![0];
    expect(first.score).toBe(2);
    expect(first.revisionOf).toBeUndefined();

    // 同日改分
    dialog = openBatch();
    fireEvent.change(within(dialog).getByRole('textbox', { name: '上级评分人' }), { target: { value: '上级A' } });
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'M2员工 · 业务能力' }), { target: { value: '5' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存批次' }));
    save();

    const list = loadProject()!.scenarios[0].assessments!;
    expect(list).toHaveLength(2); // 旧分保留
    const revision = list.find((a) => a.revisionOf)!;
    expect(revision.score).toBe(5);
    expect(revision.revisionOf).toBe(first.id);
    expect(list.find((a) => a.id === first.id)!.score).toBe(2); // 旧分未被覆盖
  });

  it('A20/D04：确认与撤销分别留痕，原确认在撤销后仍保留', () => {
    seed();
    render(<App />);
    // 打开胜任度看板 → 展开员工 → 进入详情
    fireEvent.click(screen.getByRole('button', { name: '胜任度' }));
    const drawer = screen.getByRole('dialog', { name: '胜任度看板' });
    fireEvent.click(within(drawer).getByRole('button', { name: /研发部\s*1 人/ }));
    fireEvent.click(within(drawer).getByTitle('展开员工'));
    fireEvent.click(within(drawer).getByRole('button', { name: '查看 M2员工 的胜任度详情' }));
    const detail = screen.getByRole('dialog', { name: /胜任度详情/ });

    // 确认不胜任：复核人必填 + 依据
    fireEvent.change(within(detail).getByRole('textbox', { name: '复核人' }), { target: { value: '复核人A' } });
    fireEvent.change(within(detail).getByRole('textbox', { name: '确认依据说明' }), { target: { value: '连续两期未达要求' } });
    fireEvent.click(within(detail).getByRole('button', { name: '确认不胜任' }));
    save();
    let records = loadProject()!.scenarios[0].positionAssignments!;
    const confirm = records.find((a) => a.status === 'not_competent')!;
    expect(confirm).toMatchObject({ relationId: 'rel', confirmedBy: '复核人A', reviewNote: '连续两期未达要求' });
    expect(confirm.confirmedAt).toBeTruthy();
    expect(confirm.revokedAt).toBeUndefined();
    // 任职状态未被确认覆盖
    expect(records.find((a) => a.id === 'rel')!.status).toBe('active');

    // 撤销确认：撤销人必填 + 原因；原确认仍在
    fireEvent.change(within(detail).getByRole('textbox', { name: '复核人' }), { target: { value: '复核人B' } });
    fireEvent.change(within(detail).getByRole('textbox', { name: '撤销原因' }), { target: { value: '补充证据后推翻' } });
    fireEvent.click(within(detail).getByRole('button', { name: '撤销确认' }));
    save();
    records = loadProject()!.scenarios[0].positionAssignments!;
    const after = records.find((a) => a.id === confirm.id)!;
    expect(after.revokedBy).toBe('复核人B');
    expect(after.revokeReason).toBe('补充证据后推翻');
    expect(after.revokedAt).toBeTruthy();
    expect(after.confirmedBy).toBe('复核人A'); // 原确认事实保留
    expect(after.confirmedAt).toBe(confirm.confirmedAt);
  });
});
