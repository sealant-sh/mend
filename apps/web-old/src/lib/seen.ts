import { type RefObject, useEffect, useState } from "react";

import { whenIdle } from "./idle.ts";

/**
 * True once `box` has come near the screen and the page has settled after that (`whenIdle`), and
 * true from then on. For a read a row needs only once someone can see it, such as a change's
 * `+84 −31`: a list of eighty rows then reads the dozen on screen, after the page's first paint
 * and first click have had the server to themselves. Where the browser can't watch, it reads.
 */
export const useSeenAfterIdle = (box: RefObject<HTMLElement | null>): boolean => {
  const [seen, setSeen] = useState(false);
  // Watching the screen needs the mounted element and the browser: an effect.
  useEffect(() => {
    const element = box.current;
    if (seen || element === null) return;
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    let cancel: (() => void) | null = null;
    const observer = new IntersectionObserver(
      (entries) => {
        if (cancel !== null || !entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        cancel = whenIdle(() => setSeen(true));
      },
      { rootMargin: "200px 0px" },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancel?.();
    };
  }, [box, seen]);
  return seen;
};
