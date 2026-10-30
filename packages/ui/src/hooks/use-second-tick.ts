import { useSyncExternalStore } from "react";

const subscribeToSeconds = (onStoreChange: () => void) => {
  const timer = setInterval(onStoreChange, 1000);
  return () => clearInterval(timer);
};

const secondsNow = () => Math.floor(Date.now() / 1000);

export const useSecondTick = (): number =>
  useSyncExternalStore(subscribeToSeconds, secondsNow, secondsNow);
