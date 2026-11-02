/** Pin `value` into [min, max]; when the range is inverted (viewport smaller than the panel) `min` wins. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}
