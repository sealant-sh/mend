import { useMemo, useSyncExternalStore } from "react";

const everySecond = (onChange: () => void) => {
  const timer = setInterval(onChange, 1_000);
  return () => clearInterval(timer);
};
const nowSecond = () => Math.floor(Date.now() / 1_000);

/**
 * The current second, so a line that counts ("Checking the key with GitHub · 3s", "Checked 12s
 * ago") stays true while the page is open.
 */
export const useSecond = (): Date => {
  const second = useSyncExternalStore(everySecond, nowSecond, nowSecond);
  return useMemo(() => new Date(second * 1_000), [second]);
};
