// @vitest-environment jsdom
import { lazy } from 'react';
import { expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { LazyView } from './LazyView';

it('模块未完成时有可访问的骨架，载入完成后显示页面', async () => {
  let finish!: (value: { default: () => React.JSX.Element }) => void;
  const Page = lazy(() => new Promise<{ default: () => React.JSX.Element }>((resolve) => { finish = resolve; }));
  render(<LazyView label="HealthPage"><Page /></LazyView>);
  expect(screen.getByRole('status', { name: '正在载入页面' })).toBeTruthy();
  expect(screen.getByText('正在载入组织健康度…')).toBeTruthy();
  await act(async () => finish({ default: () => <h1>完成页面</h1> }));
  expect(screen.getByRole('heading', { name: '完成页面' })).toBeTruthy();
  expect(screen.queryByRole('status', { name: '正在载入页面' })).toBeNull();
});
