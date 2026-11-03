/** After the page settles: Safari has no `requestIdleCallback`, so there a timer stands in. */
export const whenIdle = (run: () => void): (() => void) => {
  if ("requestIdleCallback" in window) {
    const handle = window.requestIdleCallback(run, { timeout: 3_000 });
    return () => window.cancelIdleCallback(handle);
  }
  const timer = setTimeout(run, 1_500);
  return () => clearTimeout(timer);
};
