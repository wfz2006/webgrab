function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function bounds(viewport, size, margin) {
  const viewportWidth = Math.max(0, finite(viewport?.width));
  const viewportHeight = Math.max(0, finite(viewport?.height));
  const width = Math.max(0, finite(size?.width));
  const height = Math.max(0, finite(size?.height));
  const safeMargin = Math.max(0, finite(margin, 8));
  if (viewportWidth <= width + safeMargin * 2 || viewportHeight <= height + safeMargin * 2) {
    return {
      minX: viewportWidth <= width + safeMargin * 2 ? 0 : safeMargin,
      maxX: viewportWidth <= width + safeMargin * 2 ? 0 : viewportWidth - width - safeMargin,
      minY: viewportHeight <= height + safeMargin * 2 ? 0 : safeMargin,
      maxY: viewportHeight <= height + safeMargin * 2 ? 0 : viewportHeight - height - safeMargin,
    };
  }
  return { minX: safeMargin, maxX: viewportWidth - width - safeMargin, minY: safeMargin, maxY: viewportHeight - height - safeMargin };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function clampCompanionPosition(position, viewport, size, margin = 8) {
  const range = bounds(viewport, size, margin);
  return {
    x: Math.round(clamp(finite(position?.x), range.minX, range.maxX)),
    y: Math.round(clamp(finite(position?.y), range.minY, range.maxY)),
  };
}

export function snapCompanionPosition(position, viewport, size, options = {}) {
  const margin = options.margin ?? 8;
  const threshold = Math.max(0, finite(options.threshold, 28));
  const range = bounds(viewport, size, margin);
  const clamped = clampCompanionPosition(position, viewport, size, margin);
  if (Math.abs(clamped.x - range.minX) <= threshold) clamped.x = Math.round(range.minX);
  else if (Math.abs(clamped.x - range.maxX) <= threshold) clamped.x = Math.round(range.maxX);
  if (Math.abs(clamped.y - range.minY) <= threshold) clamped.y = Math.round(range.minY);
  else if (Math.abs(clamped.y - range.maxY) <= threshold) clamped.y = Math.round(range.maxY);
  return clamped;
}

export function repairCompanionPosition(position, oldViewport, newViewport, size, margin = 8) {
  const oldRange = bounds(oldViewport, size, margin);
  const newRange = bounds(newViewport, size, margin);
  const edgeTolerance = 2;
  const repaired = { x: finite(position?.x), y: finite(position?.y) };
  if (Math.abs(repaired.x - oldRange.maxX) <= edgeTolerance) repaired.x = newRange.maxX;
  else if (Math.abs(repaired.x - oldRange.minX) <= edgeTolerance) repaired.x = newRange.minX;
  if (Math.abs(repaired.y - oldRange.maxY) <= edgeTolerance) repaired.y = newRange.maxY;
  else if (Math.abs(repaired.y - oldRange.minY) <= edgeTolerance) repaired.y = newRange.minY;
  return clampCompanionPosition(repaired, newViewport, size, margin);
}
