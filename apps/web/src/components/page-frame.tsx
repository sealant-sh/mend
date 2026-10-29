import { PAGE_FRAME_MIN_URL_LIFE_MS, PAGE_FRAME_TTL_MS } from "@mend/api-contracts";
import type { PageRef } from "@mend/domain/workbench";
import {
  HTML_RENDER_MAX_FIT_HEIGHT,
  HTML_RENDER_MIN_HEIGHT,
  htmlRenderResult,
  htmlRenderShortcutsMessage,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  readHtmlRenderKeyDown,
  readHtmlRenderLinkRequest,
} from "@mend/t3-contracts/html-render";
import { Modal, ModalHeader } from "@mend/ui/modal";
import { pageThemes, type PageTheme } from "@mend/ui/page-theme";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type RefObject,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useResolvedDark } from "#/lib/theme";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

const LOAD_TIMEOUT_MS = 15_000;
const NEAR_VIEWPORT = "600px 0px";
const ESCAPE_SHORTCUT = htmlRenderShortcutsMessage(
  [{ key: "escape", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }],
  [],
);

const fitHeight = (height: number) =>
  Math.min(HTML_RENDER_MAX_FIT_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.ceil(height)));

// t3code's reader drops a height of 0, which its bootstrap reports for a page whose content is all
// fixed-position; that page still loaded.
const reportedHeight = (data: unknown): number | undefined => {
  if (typeof data !== "object" || data === null) return undefined;
  if (!("jsonrpc" in data) || data.jsonrpc !== "2.0") return undefined;
  if (!("method" in data) || data.method !== "ui/notifications/size-changed") return undefined;
  if (!("params" in data) || typeof data.params !== "object" || data.params === null) {
    return undefined;
  }
  if (!("height" in data.params)) return undefined;
  const { height } = data.params;
  return typeof height === "number" && Number.isFinite(height) && height >= 0 ? height : undefined;
};

const useNearViewport = (box: RefObject<HTMLElement | null>) => {
  const [near, setNear] = useState(false);
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
        <div style={{ height: fitHeight(page.height) }} />
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
  const dark = useResolvedDark();
  const theme = pageThemes[dark ? "dark" : "light"];
  const [appearance] = useState(theme.appearance);
  const frame = useQuery({
    queryKey: trpc.pages.frame.queryKey({ id: page.id }),
    queryFn: () => client.pages.frame.query({ id: page.id, appearance }),
    staleTime: PAGE_FRAME_TTL_MS - PAGE_FRAME_MIN_URL_LIFE_MS,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [src, setSrc] = useState<string | null>(null);
  if (src === null && frame.data !== undefined && !frame.isStale) {
    setSrc(`${frame.data.url.split("#", 1)[0]}${htmlRenderThemeFragment(theme)}`);
  }
  if (src === null) {
    return frame.isError ? (
      <PageFailure onRetry={onRetry} />
    ) : (
      <p role="status" className="py-6 text-[13px] text-muted-foreground">
        Loading page…
      </p>
    );
  }
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

function PageFailure({ onRetry }: { readonly onRetry: () => void }) {
  return (
    <div role="status" className="border-l-2 border-[var(--sw-red)] py-2 pl-3 text-[13px]">
      <p className="text-ink-2">This page could not be loaded.</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-2 font-medium text-info hover:underline"
      >
        Try again
      </button>
    </div>
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
  const [height, setHeight] = useState(() => fitHeight(page.height));
  const answered = useRef(false);
  const loadTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const escape = useEffectEvent(() => onEscape?.());

  useLayoutEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      const frameWindow = frameRef.current?.contentWindow;
      if (frameWindow == null || event.source !== frameWindow) return;
      const contentHeight = reportedHeight(event.data);
      if (contentHeight !== undefined) {
        answered.current = true;
        clearTimeout(loadTimer.current);
        setHeight(fitHeight(contentHeight));
        return;
      }
      if (readHtmlRenderKeyDown(event.data)?.key === "Escape") {
        escape();
        return;
      }
      const link = readHtmlRenderLinkRequest(event.data);
      const url = link === undefined ? null : URL.parse(link.url);
      if (link === undefined || url === null) return;
      if (
        document.activeElement !== frameRef.current ||
        navigator.userActivation?.isActive === false
      )
        return;
      window.open(url.href, "_blank", "noopener,noreferrer");
      frameWindow.postMessage(htmlRenderResult(link.id), "*");
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      clearTimeout(loadTimer.current);
    };
  }, []);

  useEffect(() => {
    // A sandboxed document has an opaque origin, so postMessage requires "*".
    frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), "*");
  }, [theme]);

  return (
    <iframe
      ref={frameRef}
      src={src}
      title={page.title}
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      className="block w-full border-0 bg-background"
      style={{ height, colorScheme: theme.appearance }}
      onLoad={() => {
        const frameWindow = frameRef.current?.contentWindow;
        frameWindow?.postMessage(htmlRenderThemeMessage(theme), "*");
        // A focused frame keeps its keys, so the page passes Escape on only once it is told to.
        if (onEscape !== undefined) frameWindow?.postMessage(ESCAPE_SHORTCUT, "*");
        // Browsers fire iframe load even for HTTP failures. The injected bootstrap reports size.
        clearTimeout(loadTimer.current);
        if (!answered.current) loadTimer.current = setTimeout(onLoadError, LOAD_TIMEOUT_MS);
      }}
    />
  );
}

export function PageDialog({
  page,
  onClose,
}: {
  readonly page: PageRef;
  readonly onClose: () => void;
}) {
  return (
    <Modal
      label={page.title}
      onClose={onClose}
      maxWidth={1120}
      header={
        <ModalHeader
          title={page.title}
          meta={`page · published ${page.publishedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
        >
          <button
            type="button"
            onClick={onClose}
            className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Close
          </button>
        </ModalHeader>
      }
    >
      <div className="p-4">
        <PageFrame page={page} onEscape={onClose} />
      </div>
    </Modal>
  );
}
