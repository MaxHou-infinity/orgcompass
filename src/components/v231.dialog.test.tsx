// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SearchModal } from './SearchModal';
import { LevelManagerModal } from './LevelManagerModal';
import { TemplatePreviewModal } from './TemplatePreviewModal';
import { OnboardingOverlay } from './OnboardingOverlay';
import type { Department } from '../types';

/**
 * —— v2.3.1 F-14：弹窗必须带 dialog 语义 ——
 *
 * 这不只是 a11y 装饰：`App.tsx` 的全局键盘处理用
 *   `if (document.querySelector('[role="dialog"]')) return;`
 * 判断「当前是否在弹窗里」，从而决定是否放行 Ctrl+Z。
 * 缺 `role="dialog"` 的弹窗会让 Ctrl+Z 穿透到底层画布执行 undo()，
 * **静默撤销用户看不见的编辑**（历史栈被改写，且没有任何反馈）。
 *
 * 因此断言分两层：
 * 1) 每个弹窗打开后，`[role="dialog"]` 必须存在（App 依赖的契约）；
 * 2) Esc 能关闭（对话框语义的行为面）。
 */

afterEach(cleanup);

const DEPTS: Department[] = [
  { id: 'd1', name: '研发部', level: 1, expanded: true, children: [], employees: [] },
];

describe('v2.3.1 F-14：弹窗带 role="dialog"（Ctrl+Z 不得穿透）', () => {
  it('SearchModal', () => {
    const onClose = vi.fn();
    render(
      <SearchModal
        open
        onClose={onClose}
        departments={DEPTS}
        onHighlight={vi.fn()}
        onClearHighlight={vi.fn()}
        onJump={vi.fn()}
        onCloseKeepHighlight={vi.fn()}
      />,
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(screen.getByRole('dialog', { name: '搜索' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('LevelManagerModal', () => {
    const onClose = vi.fn();
    render(<LevelManagerModal open onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: '职级管理' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('TemplatePreviewModal', () => {
    const onClose = vi.fn();
    render(<TemplatePreviewModal open onClose={onClose} onLoadTemplate={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: '行业模板' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('OnboardingOverlay', () => {
    const onClose = vi.fn();
    render(
      <OnboardingOverlay open onClose={onClose} onDownloadTemplate={vi.fn()} onLoadTemplate={vi.fn()} />,
    );
    expect(screen.getByRole('dialog', { name: '首次使用引导' })).toBeTruthy();
  });

  it('关闭状态下不产生 dialog（不误挡画布快捷键）', () => {
    render(<LevelManagerModal open={false} onClose={vi.fn()} />);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
