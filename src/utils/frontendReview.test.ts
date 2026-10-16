import { expect, it } from 'vitest';
import { fitViewZoom } from './zoom';

it('适配同时考虑宽高，向下取整避免溢出，不放大小画布', () => {
  expect(fitViewZoom(1000, 1000, 800, 700)).toBe(70);
  expect(fitViewZoom(100, 100, 800, 700)).toBe(100);
  expect(fitViewZoom(3000, 1000, 800, 700)).toBe(50);
});

it('零尺寸和无效尺寸不写入 NaN 或 Infinity', () => {
  expect(fitViewZoom(0, 100, 800, 700)).toBe(100);
  expect(fitViewZoom(Infinity, 100, 800, 700)).toBe(100);
});
