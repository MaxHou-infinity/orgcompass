/**
 * 滚轮缩放的增量累积 + 阈值衰减计算（纯函数，便于单测）。
 *
 * 触控板/鼠标会产生高频小幅 delta（每个事件 deltaY 很小但频率高），
 * 若每个事件都直接乘以缩放因子，会让用户轻微一滚就跳几十个百分点。
 * 这里把 delta 累积起来，超过阈值才折算成"步数"触发缩放，让手感平稳。
 */

export interface ZoomWheelResult {
  /** 累积后的剩余 delta（未达阈值、留给下一次事件的部分） */
  accumulated: number;
  /** 本次应执行的缩放步数（0 = 不缩放；正数 = 放大；负数 = 缩小） */
  steps: number;
}

/** 保留现有 50–200% 缩放契约，适配不超过 100%，非法几何不污染持久化。 */
export function fitViewZoom(width: number, height: number, availableWidth: number, availableHeight: number): number {
  if (![width, height, availableWidth, availableHeight].every((n) => Number.isFinite(n) && n > 0)) return 100;
  return Math.max(50, Math.min(100, Math.floor(Math.min(availableWidth / width, availableHeight / height) * 100)));
}

/**
 * 处理一次 wheel 事件，返回应执行的缩放步数与剩余累积量。
 * @param prevAccum 上一次的累积 delta
 * @param deltaY    本次 wheel 事件的 deltaY（正值=向下滚=缩小，负值=向上滚=放大）
 * @param threshold 触发一次缩放所需的累积阈值（像素）。默认 120 ≈ 一次标准滚轮。
 */
export function accumZoomWheel(
  prevAccum: number,
  deltaY: number,
  threshold = 120,
): ZoomWheelResult {
  const accumulated = prevAccum + deltaY;
  if (Math.abs(accumulated) < threshold) {
    return { accumulated, steps: 0 };
  }
  const steps = Math.trunc(accumulated / threshold);
  const remaining = accumulated - steps * threshold;
  return { accumulated: remaining, steps };
}

/**
 * 由缩放步数换算新的缩放值。
 * @param currentZoom 当前缩放值（50-200 之间的数）
 * @param steps       步数（正数放大 / 负数缩小）
 * @param factor      每步的缩放比例（>1）。默认 1.08（约 +8%/步）
 * @param min,max     缩放范围
 */
export function applyZoomSteps(
  currentZoom: number,
  steps: number,
  factor = 1.08,
  min = 50,
  max = 200,
): number {
  if (steps === 0) return currentZoom;
  const next = currentZoom * Math.pow(steps > 0 ? 1 / factor : factor, Math.abs(steps));
  return Math.min(Math.max(next, min), max);
}
