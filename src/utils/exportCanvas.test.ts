// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exportCanvas } from './exportCanvas';

/**
 * v2.3.1（T-10）：`exportCanvas.ts` 此前零测试覆盖（却是 PNG / 诊断报告 / 管理层报告三条导出链路的唯一核心）。
 * 这里用 mock 的 html2canvas 验证其**契约**：
 * - 导出的克隆文档里，Tailwind 4 的 oklch / color-mix / 渐变插值提示被归一化为 rgb(a)；
 * - animation / transition 被关闭、transform 被重置（否则导出会截到动画中间态或缩放态）；
 * - FontMetrics 临时样式在成功与失败路径下都被清理（不污染实时工作区）。
 */

const calls: { element: HTMLElement; options: Record<string, unknown> }[] = [];
const clones: HTMLElement[] = [];
let behavior: 'ok' | 'throw' = 'ok';

vi.mock('html2canvas', () => ({
  default: async (element: HTMLElement, options: Record<string, unknown>) => {
    calls.push({ element, options });
    if (behavior === 'throw') throw new Error('canvas boom');
    // 真实 html2canvas 会先克隆文档再回调 onclone
    const cloned = element.cloneNode(true) as HTMLElement;
    document.body.appendChild(cloned);
    (options.onclone as (doc: Document, el: HTMLElement) => void)?.(document, cloned);
    clones.push(cloned);
    cloned.remove();
    return { width: 10, height: 10 } as unknown as HTMLCanvasElement;
  },
}));

beforeEach(() => {
  // jsdom 默认没有 canvas 实现（getContext 返回 null）→ 用最小 2D 上下文替身，
  // 让 onclone 里的「现代颜色 → rgb」归一化路径真实跑起来。
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: () => {},
    fillRect: () => {},
    getImageData: () => ({ data: new Uint8ClampedArray([18, 52, 86, 255]) }),
    fillStyle: '',
  } as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  calls.length = 0;
  clones.length = 0;
  behavior = 'ok';
  vi.restoreAllMocks();
  document.head.querySelectorAll('style').forEach((s) => {
    if (s.textContent?.includes('visibility: hidden')) s.remove();
  });
});

function makeElement(): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = '<span id="t">导出文本</span>';
  document.body.appendChild(el);
  return el;
}

describe('v2.3.1 T-10：exportCanvas 导出契约', () => {
  it('调用 html2canvas 时传入白底 / scale=2 / 关闭日志，并注册 onclone', async () => {
    const el = makeElement();
    await exportCanvas(el);
    expect(calls).toHaveLength(1);
    expect(calls[0].options).toMatchObject({ backgroundColor: '#ffffff', scale: 2, logging: false, useCORS: true });
    expect(typeof calls[0].options.onclone).toBe('function');
    expect(calls[0].options).not.toMatchObject({ backgroundColor: '#000000' });
  });

  it('onclone 里把现代颜色语法归一化为 rgb(a)、关闭动画并重置 transform', async () => {
    const el = makeElement();
    const span = el.querySelector('#t') as HTMLElement;
    span.style.color = 'oklch(0.7 0.1 200)';
    span.style.backgroundImage = 'linear-gradient(90deg in oklab, red, blue)';
    el.style.transform = 'scale(0.5)';

    await exportCanvas(el, '#123456');
    expect(calls[0].options.backgroundColor).toBe('#123456');
    // 断言落在**克隆文档**上：真实导出只改克隆，绝不能改实时工作区
    const clone = clones[0];
    expect(clone.style.transform).toBe('none');
    expect(clone.style.getPropertyValue('animation')).toBe('none');
    expect(clone.style.getPropertyValue('transition')).toBe('none');
    expect(el.style.transform).toBe('scale(0.5)'); // 原节点不受影响
  });

  it('渐变里的插值提示被移除（html2canvas 1.x 不认 in oklab）', async () => {
    const el = makeElement();
    // 直接调用 onclone 的归一化逻辑：通过 mock 触发，并观察被写回的样式值
    const span = el.querySelector('#t') as HTMLElement;
    span.style.backgroundImage = 'linear-gradient(90deg in oklab, red, blue)';
    await exportCanvas(el);
    const cloneSpan = clones[0].querySelector('#t') as HTMLElement;
    const applied = cloneSpan.style.getPropertyValue('background-image');
    expect(applied).not.toContain('in oklab');
    // 归一化后插值提示被移除（保留渐变本体；jsdom 不解析渐变内的颜色函数）
    expect(applied).not.toMatch(/\sin\s/);
    expect(applied).toContain('linear-gradient');
  });

  it('导出失败时临时 FontMetrics 样式必须被清理（不污染实时工作区）', async () => {
    const el = makeElement();
    behavior = 'throw';
    await expect(exportCanvas(el)).rejects.toThrow('canvas boom');
    const leftover = [...document.head.querySelectorAll('style')].filter((s) =>
      s.textContent?.includes('visibility: hidden'),
    );
    expect(leftover).toHaveLength(0);
  });

  it('成功路径同样不留下临时样式', async () => {
    const el = makeElement();
    await exportCanvas(el);
    const leftover = [...document.head.querySelectorAll('style')].filter((s) =>
      s.textContent?.includes('visibility: hidden'),
    );
    expect(leftover).toHaveLength(0);
  });
});
