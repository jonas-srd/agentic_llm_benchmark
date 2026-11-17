// Monotonic cumulative measurements make heartbeat retries safe.
export function timingClock(start: number, initiallyVisible: boolean) {
  let last = start,
    active = 0,
    visible = initiallyVisible;
  return (current: number, nextVisible: boolean) => {
    const next = Math.max(last, current);
    if (visible) active += next - last;
    last = next;
    visible = nextVisible;
    return {
      elapsed_ms: Math.min(259200000, Math.round(next - start)),
      active_ms: Math.min(259200000, Math.round(active)),
    };
  };
}
