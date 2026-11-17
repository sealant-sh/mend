import {
  cloneElement,
  isValidElement,
  useState,
  useSyncExternalStore,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from "react";

import { whenIdle } from "#/lib/idle";

/**
 * Code a popup needs only once it opens (Base UI's menu, combobox, tooltip and popover, and the
 * floating layer they share), kept out of the page's first load. It loads on first use, when a
 * pointer, a finger or focus reaches one of its triggers, or else once the page has loaded and the
 * browser is idle, so it is usually there before the first press.
 */
export interface FirstUse<M> {
  /** Starts loading the code, once; a failed download is tried again on the next use. */
  readonly wake: () => Promise<void>;
  /** The code, or `null` until it has arrived: always `null` on the server and while hydrating. */
  readonly useLoaded: () => M | null;
}

export function firstUse<M>(load: () => Promise<M>): FirstUse<M> {
  let loaded: M | null = null;
  let loading: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const wake = () => {
    loading ??= load().then(
      (code) => {
        loaded = code;
        for (const listener of listeners) listener();
        return undefined;
      },
      () => {
        loading = null;
      },
    );
    return loading;
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  };
  if (typeof window !== "undefined") {
    const soon = () => void whenIdle(() => void wake());
    if (document.readyState === "complete") soon();
    else window.addEventListener("load", soon, { once: true });
  }
  return {
    wake,
    useLoaded: () =>
      useSyncExternalStore(
        subscribe,
        () => loaded,
        () => null,
      ),
  };
}

/** What happened to a trigger before its popup's code arrived. */
export interface Woken {
  /** It was pressed: the popup opens as it first renders. */
  readonly pressed: boolean;
  /** It had focus: the popup's trigger takes it back as it mounts. */
  readonly triggerRef: ((element: HTMLElement | null) => void) | undefined;
}

const focusOnMount = (element: HTMLElement | null) => element?.focus();

/**
 * `trigger` until `code` arrives, then `children(code, woken)`. Until then the trigger is the same
 * element, saying it opens a `popup` (as Base UI will), waking the code when a pointer, a finger
 * or focus reaches it, and holding a press: the popup opens once it renders, or `onPress` runs
 * for a popup whose open state its parent holds. `popup={null}` is a tip, which no press opens.
 */
export function Deferred<M>({
  code,
  trigger,
  popup,
  label,
  describedBy,
  onPress,
  children,
}: {
  readonly code: FirstUse<M>;
  readonly trigger: ReactElement;
  readonly popup: "menu" | "listbox" | "dialog" | null;
  /** The trigger's name, when the popup's code names it. */
  readonly label?: string;
  readonly describedBy?: string;
  readonly onPress?: () => void;
  readonly children: (code: M, woken: Woken) => ReactNode;
}) {
  const loaded = code.useLoaded();
  const [pressed, setPressed] = useState(false);
  const [focused, setFocused] = useState(false);
  if (loaded !== null)
    return children(loaded, { pressed, triggerRef: focused ? focusOnMount : undefined });
  if (!isValidElement<HTMLAttributes<HTMLElement>>(trigger)) return trigger;
  const own = trigger.props;
  const wake = () => void code.wake();
  return cloneElement(trigger, {
    ...(popup === null ? {} : { "aria-haspopup": popup, "aria-expanded": false }),
    ...(label === undefined ? {} : { "aria-label": label }),
    ...(describedBy === undefined ? {} : { "aria-describedby": describedBy }),
    onPointerEnter: (event) => {
      own.onPointerEnter?.(event);
      wake();
    },
    onTouchStart: (event) => {
      own.onTouchStart?.(event);
      wake();
    },
    onFocus: (event) => {
      own.onFocus?.(event);
      setFocused(true);
      wake();
    },
    onBlur: (event) => {
      own.onBlur?.(event);
      setFocused(false);
    },
    onClick: (event) => {
      own.onClick?.(event);
      wake();
      if (popup === null) return;
      if (onPress === undefined) setPressed(true);
      else onPress();
    },
  });
}
