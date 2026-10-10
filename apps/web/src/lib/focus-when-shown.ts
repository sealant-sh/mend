/**
 * Focus `element` as soon as it can take focus, trying again each frame for up to `maxFrames`.
 * `autoFocus` tries once, at React's commit: content handed to a library that places it later (the
 * diff's annotations are slotted into its shadow root after the commit) is not rendered yet then,
 * and a browser gives no focus to what it does not render. Returns the cancel.
 */
export const focusWhenShown = (element: HTMLElement, maxFrames = 60): (() => void) => {
  let frame: number | null = null;
  let framesLeft = maxFrames;
  const attempt = () => {
    frame = null;
    element.focus();
    const root = element.getRootNode();
    const active =
      root instanceof Document || root instanceof ShadowRoot ? root.activeElement : null;
    if (active === element || framesLeft <= 0) return;
    framesLeft -= 1;
    frame = requestAnimationFrame(attempt);
  };
  attempt();
  return () => {
    if (frame !== null) cancelAnimationFrame(frame);
  };
};
