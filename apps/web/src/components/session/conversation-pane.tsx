import { useCallback, type ReactNode } from "react";

/** Reserve the measured overlay inside the scroll content, including attachments and safe area. */
export function ConversationPane({
  children,
  composer,
  narrow = false,
}: {
  readonly children: ReactNode;
  readonly composer: ReactNode;
  readonly narrow?: boolean;
}) {
  const measure = useCallback((node: HTMLDivElement | null) => {
    if (node === null) return;
    const pane = node.parentElement;
    if (pane === null) return;
    const read = () => {
      const viewport = pane.querySelector('[data-slot="message-scroller-viewport"]');
      const following =
        viewport instanceof HTMLElement &&
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 8;
      // Reserve and scroll in one layout, before a scroll event can mistake growth for reading up.
      pane.style.setProperty("--composer-height", `${node.getBoundingClientRect().height}px`);
      if (following) viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight;
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        className={
          narrow
            ? "flex min-h-0 flex-1 flex-col px-6 pt-4"
            : "flex min-h-0 flex-1 flex-col px-6 pt-5 max-md:px-3 max-md:pt-3"
        }
      >
        {children}
      </div>
      <div
        ref={measure}
        className="pointer-events-none absolute inset-x-0 bottom-0 px-6 pt-3 pb-[18px] max-md:px-3 max-md:pt-2 max-md:pb-[max(12px,env(safe-area-inset-bottom))]"
      >
        <div className="pointer-events-auto mx-auto w-full max-w-[768px]">{composer}</div>
      </div>
    </div>
  );
}
