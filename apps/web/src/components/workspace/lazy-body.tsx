import { type ComponentType, use } from "react";

/**
 * A view's code didn't arrive: the network dropped, or Mend was updated under an open page. It
 * stays the body's answer until `retry`, which the tile's Try again (`TabFailed`) calls, so the
 * error reaches the tile instead of every render starting the fetch again.
 */
export class ViewLoadError extends Error {
  readonly retry: () => void;
  constructor(name: string, cause: unknown, retry: () => void) {
    super(
      `Mend couldn't fetch the ${name} view's code. If Mend was updated since this page opened, reload the page.`,
      { cause },
    );
    this.name = "ViewLoadError";
    this.retry = retry;
  }
}

export interface LazyBody<Props> {
  /** Renders the body once its code is here, and suspends until then. */
  readonly Body: ComponentType<Props>;
  /** Starts fetching the body's code, as a pointer rests on its tab or menu item. */
  readonly preload: () => void;
}

/**
 * A view's body, fetched the first time it renders (or is preloaded) rather than with the page.
 * Unlike `React.lazy`, a body already fetched renders at once, never through its Suspense
 * fallback, and a fetch that failed can start again (`ViewLoadError.retry`). Each body's code is
 * fetched once per page.
 */
export const lazyBody = <Props extends object>(
  name: string,
  load: () => Promise<ComponentType<Props>>,
): LazyBody<Props> => {
  let loaded: ComponentType<Props> | undefined;
  let loading: Promise<ComponentType<Props>> | undefined;
  let shown = false;
  const fetchBody = (): Promise<ComponentType<Props>> => {
    if (loading !== undefined) return loading;
    const attempt = load().then(
      (component) => {
        loaded = component;
        return component;
      },
      (cause: unknown) => {
        throw new ViewLoadError(name, cause, () => {
          if (loading === attempt) loading = undefined;
        });
      },
    );
    loading = attempt;
    return attempt;
  };
  function Body(props: Props) {
    shown = true;
    const Loaded = loaded ?? use(fetchBody());
    return <Loaded {...props} />;
  }
  Body.displayName = `${name}Body`;
  return {
    Body,
    preload: () => {
      // A preload that failed before the body ever showed is forgotten: showing it fetches again.
      fetchBody().catch((error: unknown) => {
        if (!shown && error instanceof ViewLoadError) error.retry();
      });
    },
  };
};
