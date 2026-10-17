// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { fmtMetric, isMetricUnconfigured } from '../utils/statusUI';
import { rootCenterScrollLeft } from '../utils/zoom';
import { calculateTreeLayout, CARD_WIDTH } from './OrgChart';
import { SuccessionPanel } from './SuccessionPanel';
import { computeSuccession } from '../utils/succession';
import type { Department } from '../types';

it('管理者梯队（人/岗）保留两位小数，不会把 0.75 显示成与健康线相同的 0.8', () => {
  expect(fmtMetric(0.75, '人/岗')).toBe('0.75人/岗');
  expect(fmtMetric(0.8, '人/岗')).toBe('0.8人/岗');
  expect(fmtMetric(1, '人/岗')).toBe('1人/岗');
  expect(fmtMetric(12.34, '%')).toBe('12.3%');
  expect(fmtMetric(null, '人/岗')).toBe('—');
  expect(fmtMetric(null, '%', true)).toBe('未配置');
});

it('只有继任类指标在未录入继任人时显示「未配置」', () => {
  const s = { configured: false, pipeline: { configured: true } };
  expect(isMetricUnconfigured('succession', s)).toBe(true);
  expect(isMetricUnconfigured('managerPipeline', s)).toBe(false);
  expect(isMetricUnconfigured('span', s)).toBe(false);
  expect(isMetricUnconfigured('succession')).toBe(false);
});

it('rootCenterScrollLeft 让首个根部门水平居中，找不到卡片返回 0', () => {
  const canvas = document.createElement('div');
  expect(rootCenterScrollLeft(canvas, 1000)).toBe(0);
  const card = document.createElement('div');
  card.dataset.deptId = 'root';
  canvas.appendChild(card);
  canvas.getBoundingClientRect = () => ({ left: 100, width: 6000 } as DOMRect);
  card.getBoundingClientRect = () => ({ left: 3000, width: 320 } as DOMRect);
  expect(rootCenterScrollLeft(canvas, 1000)).toBe(3000 - 100 + 160 - 500);
  card.getBoundingClientRect = () => ({ left: 120, width: 320 } as DOMRect);
  expect(rootCenterScrollLeft(canvas, 1000)).toBe(0);
});

const dept = (id: string, children: Department[] = []): Department => ({ id, name: id, level: 1, employees: [], children, expanded: true } as unknown as Department);

it('树布局最右卡片右缘 = 卡片 x + 卡宽（不是 x + 子树带宽）', () => {
  const tree = [dept('root', [dept('a'), dept('b'), dept('c', [dept('c1'), dept('c2')])])];
  const nodes = calculateTreeLayout(tree, 0, 0, 100);
  const xs: number[] = [];
  const walk = (list: typeof nodes) => list.forEach((n) => { xs.push(n.x + CARD_WIDTH); walk(n.children); });
  walk(nodes);
  // 4 个叶子：4*320 + 3*80 = 1520，最右卡片右缘应恰好等于子树带右缘
  expect(Math.max(...xs)).toBe(1520);
  // 旧算法 root.x + root.width 会多出半个带宽
  expect(nodes[0].x + nodes[0].width).toBeGreaterThan(1520);
});

it('继任一个都没录入时，面板显示「未配置」而非 0.0%，清单不按单点风险呈现', () => {
  const root = { ...dept('d1'), name: '总部', positions: [{ id: 'p1', name: '总经理', status: 'active', isCritical: true, successors: [] }] } as unknown as Department;
  const data = computeSuccession([root]);
  expect(data.configured).toBe(false);
  render(<SuccessionPanel data={data} departments={[root]} />);
  const panel = screen.getByRole('region', { name: '关键岗位与继任' });
  expect(panel.textContent).toContain('继任覆盖率 未配置');
  expect(panel.textContent).not.toContain('0.0%');
  expect(panel.textContent).toContain('待配置继任的关键岗位');
  expect(panel.textContent).not.toContain('单点风险（无有效继任人');
});
