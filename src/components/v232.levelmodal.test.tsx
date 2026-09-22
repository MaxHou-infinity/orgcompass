// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LevelManagerModal } from './LevelManagerModal';
import { getLevelConfigs, resetLevelConfigs } from '../utils/levels';
import type { Employee } from '../types';

/**
 * v2.3.2 P4：职级管理里的「被引用」提示与二次确认。
 *
 * 缺陷：`handleSave` 只校验格式与重复，`removeDraft` 直接删 ——
 * 改 `code`/`number`（主键）或删一行后，引用该职级的员工会**静默掉色 + 成本归零**，
 * 而界面上没有任何提示。用户自己就能造出「职级不在配置中」（P1）。
 */

const emps: Employee[] = [
  { id: 'e1', name: '张三', employeeId: 'E001', level: 'L1.1' },
  { id: 'e2', name: '李四', employeeId: 'E002', level: 'L1.1' },
  { id: 'e3', name: '王五', employeeId: 'E003', level: 'L2.1' },
];

beforeEach(() => resetLevelConfigs());
afterEach(() => { cleanup(); resetLevelConfigs(); vi.restoreAllMocks(); });

const renderModal = (employees: Employee[] = emps) =>
  render(<LevelManagerModal open onClose={vi.fn()} allEmployees={employees} />);

describe('v2.3.2 P4 职级被引用提示', () => {
  it('每一行显示被多少人使用（没人在用的行不显示徽标）', () => {
    renderModal();
    expect(screen.getByText('2 人使用')).toBeTruthy(); // L1.1 × 2
    expect(screen.getByText('1 人使用')).toBeTruthy(); // L2.1 × 1
    // L0 / L1.2 等无人使用 → 没有徽标（避免满屏噪音）
    expect(screen.queryAllByText(/人使用/)).toHaveLength(2);
  });

  it('改动被引用的职级码 → 保存前给出后果清单并要求二次确认', () => {
    renderModal();
    // 把 L1.1 的编号改成 1.5 → 原 L1.1 会消失，而它仍被 2 人使用
    fireEvent.change(screen.getByLabelText('第 2 行 职级编号'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('仍被员工使用');
    expect(alert.textContent).toContain('L1.1');
    expect(alert.textContent).toContain('2 人');
    expect(alert.textContent).toContain('张三');
    // 关键：此时**还没有**写入配置
    expect(getLevelConfigs().some((c) => c.code === 'L' && c.number === '1.1')).toBe(true);
  });

  it('「仍然保存」才真正写入；「返回修改」不写入', () => {
    renderModal();
    fireEvent.change(screen.getByLabelText('第 2 行 职级编号'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    fireEvent.click(screen.getByRole('button', { name: '返回修改' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(getLevelConfigs().some((c) => c.code === 'L' && c.number === '1.1')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    fireEvent.click(screen.getByRole('button', { name: '仍然保存' }));
    const codes = getLevelConfigs().map((c) => `${c.code}${c.number}`);
    expect(codes).toContain('L1.5');
    expect(codes).not.toContain('L1.1');
  });

  it('改动**没有**人使用的职级 → 不打扰，直接保存', () => {
    renderModal();
    // L1.2 默认无人使用
    fireEvent.change(screen.getByLabelText('第 3 行 职级编号'), { target: { value: '1.9' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(getLevelConfigs().map((c) => `${c.code}${c.number}`)).toContain('L1.9');
  });

  it('名册为空时不出现任何使用徽标（纯配置场景保持干净）', () => {
    renderModal([]);
    expect(screen.queryAllByText(/人使用/)).toHaveLength(0);
  });
});

/**
 * v2.3.2：职级行的**溢出**回归（用户实测：颜色块与删除按钮跑到行背景外面）。
 *
 * 根因：这一行有 6 组控件、各控件近似固定宽，`sm:flex-nowrap` 又禁止换行；
 * 加入「N 人使用」徽标（53px + 12px 间距）后内容实需 644px，而 `max-w-2xl` 只给 596px
 * → 溢出 40~49px，视觉上就是颜色块与删除按钮出框、各行宽度不一致。
 *
 * jsdom 量不到像素，所以守的是**导致溢出的两个结构选择**（同 v232.card 的防换行守卫思路）。
 */
describe('v2.3.2 职级行溢出防线', () => {
  it('行内容允许换行（不得 sm:flex-nowrap：禁止换行 + 近似固定宽 = 必然出框）', () => {
    const { container } = renderModal();
    const items = container.querySelector('[data-level-row-items]') as HTMLElement;
    expect(items).not.toBeNull();
    expect(items.className).toContain('flex-wrap');
    expect(items.className).not.toContain('flex-nowrap');
  });

  it('弹窗宽度足够容纳一行 6 组控件（max-w-3xl；Chromium 实测实需 644px）', () => {
    const { container } = renderModal();
    const panel = container.querySelector('[role="dialog"] .rounded-3xl') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel.className).toContain('max-w-3xl');
    expect(panel.className).not.toContain('max-w-2xl');
  });

  it('每一行都有稳定的行容器锚点（改动行结构时测试不会静默失效）', () => {
    const { container } = renderModal();
    expect(container.querySelectorAll('[data-level-row]')).toHaveLength(13); // DEFAULT_LEVELS 条数
  });
});
