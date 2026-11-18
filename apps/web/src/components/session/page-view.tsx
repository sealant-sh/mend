import type { PageRef } from "@mend/domain/workbench";
import { PAGE_FRAME_MIN_URL_LIFE_MS, PAGE_FRAME_TTL_MS } from "@mend/domain/workbench";
import { htmlRenderShortcutsMessage, readHtmlRenderKeyDown } from "@mend/t3-contracts/html-render";
import { Button } from "@mend/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mend/ui/components/ui/dialog";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type RefObject,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import {
  fitPageHeight,
  openPageLink,
  PAGE_FRAME_SANDBOX,
  pageFrameSrc,
  pageThemeMessage,
  readPageFrameRequest,
  usePageLoadDeadline,
} from "#/lib/page-frame";
import { type PageTheme, pageThemeOf } from "#/lib/page-theme";
import { messageTime } from "#/lib/session-sheet";
import { useResolvedDark } from "#/lib/theme";
import { type TrpcClient, type TrpcProxy, useTRPC, useTRPCClient } from "#/lib/trpc";

/**
 * A page's frame address, for the appearance its first paint uses. The address expires: a held one
 * is used only while it has long enough left to load.
 */
const pageFrameQuery = (
  trpc: TrpcProxy,
  client: TrpcClient,
  id: string,
  appearance: "light" | "dark",
) =>
  queryOptions({
    queryKey: [...trpc.pages.frame.queryKey({ id }), appearance],
    queryFn: () => client.pages.frame.query({ id, appearance }),
    staleTime: PAGE_FRAME_TTL_MS - PAGE_FRAME_MIN_URL_LIFE_MS,
    retry: false,
    refetchOnWindowFocus: false,
  });

/** How far ahead of the screen a page starts loading, so it is there when the reader reaches it. */
const NEAR_VIEWPORT = "600px 0px";

const ESCAPE_SHORTCUT = htmlRenderShortcutsMessage(
  [{ key: "escape", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }],
  [],
);

/** The page theme of the app as it is painted now: Sheet's tokens, light or dark. */
const usePageTheme = (): PageTheme => {
  const dark = useResolvedDark();
  return pageThemeOf((token) => {
    if (typeof document === "undefined") return "";
    return getComputedStyle(document.documentElement).getPropertyValue(token);
  }, dark);
};

/** Whether `box` has come near the screen; once it has, it stays so. */
const useNearViewport = (box: RefObject<HTMLElement | null>) => {
  const [near, setNear] = useState(false);
  // Watching the screen needs the mounted element and the browser: an effect.
  useEffect(() => {
    const element = box.current;
    if (near || element === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: NEAR_VIEWPORT },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [box, near]);
  return near;
};

function PageFailure({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 text-row text-destructive">
      This page didn't load.
      <Button type="button" size="sm" variant="outline" className="max-lg:h-11" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

/**
 * A page the agent made, in a sandboxed frame: it loads as the reader nears it, takes the app's
 * colours, light or dark, and grows to the page's own height. A page that doesn't load says so,
 * with Try again.
 */
export function PageFrame({
  page,
  onEscape,
}: {
  readonly page: PageRef;
  readonly onEscape?: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const box = useRef<HTMLDivElement>(null);
  const near = useNearViewport(box);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const retry = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.pages.frame.queryKey({ id: page.id }) });
    setFailed(false);
    setAttempt((current) => current + 1);
  };
  return (
    <div ref={box}>
      {failed ? (
        <PageFailure onRetry={retry} />
      ) : near ? (
        <PageLoader
          key={attempt}
          page={page}
          onEscape={onEscape}
          onRetry={retry}
          onLoadError={() => (attempt === 0 ? retry() : setFailed(true))}
        />
      ) : (
        <div style={{ height: fitPageHeight(page.height) }} />
      )}
    </div>
  );
}

function PageLoader({
  page,
  onEscape,
  onRetry,
  onLoadError,
}: {
  readonly page: PageRef;
  readonly onEscape: (() => void) | undefined;
  readonly onRetry: () => void;
  readonly onLoadError: () => void;
}) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const theme = usePageTheme();
  const [appearance] = useState(theme.appearance);
  const frame = useQuery(pageFrameQuery(trpc, client, page.id, appearance));
  const [src, setSrc] = useState<string | null>(null);
  if (src === null && frame.isSuccess && !frame.isStale)
    setSrc(pageFrameSrc(frame.data.url, theme));
  if (src === null)
    return frame.isError ? (
      <PageFailure onRetry={onRetry} />
    ) : frame.isPending ? (
      <p role="status" className="py-6 text-row text-muted-foreground">
        Loading the page…
      </p>
    ) : null;
  return (
    <PageDocument
      page={page}
      src={src}
      theme={theme}
      onEscape={onEscape}
      onLoadError={onLoadError}
    />
  );
}

function PageDocument({
  page,
  src,
  theme,
  onEscape,
  onLoadError,
}: {
  readonly page: PageRef;
  readonly src: string;
  readonly theme: PageTheme;
  readonly onEscape: (() => void) | undefined;
  readonly onLoadError: () => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(() => fitPageHeight(page.height));
  const loaded = usePageLoadDeadline(onLoadError);
  const escape = useEffectEvent(() => onEscape?.());

  // The page speaks through window messages: its size, a link to open, and Escape.
  useLayoutEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      const frameWindow = frameRef.current?.contentWindow;
      if (frameWindow == null || event.source !== frameWindow) return;
      if (readHtmlRenderKeyDown(event.data)?.key === "Escape") {
        escape();
        return;
      }
      const request = readPageFrameRequest(event.data);
      if (request?.kind === "size") {
        loaded();
        setHeight(fitPageHeight(request.height));
        return;
      }
      if (request?.kind === "link" && frameRef.current !== null)
        openPageLink(frameRef.current, request);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [loaded]);

  // A theme change reaches the page as a message: the frame keeps its document.
  useEffect(() => {
    // A sandboxed document has an opaque origin, so postMessage requires "*".
    frameRef.current?.contentWindow?.postMessage(pageThemeMessage(theme), "*");
  }, [theme]);

  return (
    <iframe
      ref={frameRef}
      src={src}
      title={page.title}
      sandbox={PAGE_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      className="block w-full rounded-lg border bg-background"
      style={{ height, colorScheme: theme.appearance }}
      onLoad={() => {
        const frameWindow = frameRef.current?.contentWindow;
        frameWindow?.postMessage(pageThemeMessage(theme), "*");
        // A focused frame keeps its keys, so the page passes Escape on only once it is told to.
        if (onEscape !== undefined) frameWindow?.postMessage(ESCAPE_SHORTCUT, "*");
      }}
    />
  );
}

/** A page the agent made, where it made it: its title, Open to see it large, and the page. */
export function PageEvent({ page }: { readonly page: PageRef }) {
  const [open, setOpen] = useState(false);
  const published = messageTime(page.publishedAt, new Date());
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 text-row font-medium wrap-anywhere text-foreground">
          {page.title}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="max-lg:h-11"
          onClick={() => setOpen(true)}
        >
          Open<span className="sr-only"> {page.title}</span>
        </Button>
      </figcaption>
      <PageFrame page={page} />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>{page.title}</DialogTitle>
            <DialogDescription>Published at {published}</DialogDescription>
          </DialogHeader>
          {open ? <PageFrame page={page} onEscape={() => setOpen(false)} /> : null}
        </DialogContent>
      </Dialog>
    </figure>
  );
}
