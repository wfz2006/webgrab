function clampIndex(value, max) {
  return Math.min(Math.max(0, value), Math.max(0, max));
}

/**
 * 计算固定行高虚拟列表的可见窗口。纯函数，不接触 DOM，方便单测。
 * @param {{ scrollTop: number, viewportHeight: number, rowHeight: number, itemCount: number, overscan?: number }} input
 * @returns {{ startIndex: number, endIndex: number, offsetY: number, totalHeight: number }}
 *   endIndex 为独占上界（[startIndex, endIndex)）
 */
export function computeVisibleRange({ scrollTop, viewportHeight, rowHeight, itemCount, overscan = 6 }) {
  const total = Math.max(0, Number(itemCount) || 0);
  const height = Math.max(1, Number(rowHeight) || 1);
  const totalHeight = total * height;

  if (total === 0) {
    return { startIndex: 0, endIndex: 0, offsetY: 0, totalHeight: 0 };
  }

  const top = Math.max(0, Number(scrollTop) || 0);
  const viewport = Math.max(0, Number(viewportHeight) || 0);

  const firstVisible = Math.floor(top / height);
  const visibleCount = Math.ceil(viewport / height) + 1;

  const startIndex = clampIndex(firstVisible - overscan, total - 1);
  const endIndex = clampIndex(firstVisible + visibleCount + overscan, total);

  return {
    startIndex,
    endIndex: Math.max(startIndex, endIndex),
    offsetY: startIndex * height,
    totalHeight,
  };
}
