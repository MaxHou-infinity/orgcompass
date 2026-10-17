// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ScenarioCompareButton } from './ScenarioCompareButton';
afterEach(cleanup);

it('单方案保留鼠标和键盘说明，点击可复制；成功后关闭提示', () => {
  const duplicate = vi.fn(); const compare = vi.fn();
  render(<ScenarioCompareButton canCompare={false} onCompare={compare} onDuplicateCurrent={duplicate} />);
  const button = screen.getByRole('button', { name: '场景对比' });
  expect(button.hasAttribute('disabled')).toBe(false);
  expect(button.getAttribute('aria-disabled')).toBe('true');
  fireEvent.mouseEnter(button);
  expect(screen.getByRole('tooltip').textContent).toBe('需要至少 2 个方案才能对比');
  fireEvent.mouseLeave(button); expect(screen.queryByRole('tooltip')).toBeNull();
  fireEvent.focus(button); expect(button.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id);
  fireEvent.click(button);
  expect(screen.getByRole('dialog').textContent).toContain('当前只有 1 个方案');
  fireEvent.click(screen.getByRole('button', { name: '复制当前方案' }));
  expect(duplicate).toHaveBeenCalledOnce(); expect(compare).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
});
it('复制落盘失败保留提示，两个方案直接打开对比', () => {
  const { rerender } = render(<ScenarioCompareButton canCompare={false} onCompare={vi.fn()} onDuplicateCurrent={() => false} />);
  fireEvent.click(screen.getByRole('button', { name: '场景对比' }));
  fireEvent.click(screen.getByRole('button', { name: '复制当前方案' }));
  expect(screen.getByRole('alert').textContent).toContain('复制未保存');
  fireEvent.click(screen.getByRole('button', { name: '取消' }));
  const compare = vi.fn(); rerender(<ScenarioCompareButton canCompare onCompare={compare} />);
  fireEvent.click(screen.getByRole('button', { name: '场景对比' }));
  expect(compare).toHaveBeenCalledOnce(); expect(screen.queryByRole('dialog')).toBeNull();
});
