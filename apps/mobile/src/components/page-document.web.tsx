import {
  fitPageHeight,
  openPageLink,
  PAGE_FRAME_SANDBOX,
  pageThemeMessage,
  readPageFrameRequest,
  usePageLoadDeadline,
} from "@mend/ui/page-frame";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { PageDocumentProps } from "./page-document";

export function PageDocument({
  title,
  src,
  theme,
  initialHeight,
  fill,
  onLoadError,
}: PageDocumentProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(initialHeight);
  const loaded = usePageLoadDeadline(onLoadError);

  useLayoutEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      const frameWindow = frame.current?.contentWindow;
      if (frameWindow == null || event.source !== frameWindow) return;
      const request = readPageFrameRequest(event.data);
      if (request?.kind === "size") {
        loaded();
        setHeight(fitPageHeight(request.height));
        return;
      }
      if (request?.kind === "link" && frame.current !== null) openPageLink(frame.current, request);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [loaded]);

  useEffect(() => {
    // A sandboxed document has an opaque origin, so postMessage requires "*".
    frame.current?.contentWindow?.postMessage(pageThemeMessage(theme), "*");
  }, [theme]);

  const iframe = (
    <iframe
      ref={frame}
      src={src}
      title={title}
      sandbox={PAGE_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      style={{
        display: "block",
        width: "100%",
        height,
        border: 0,
        background: theme.variables["--background"],
        colorScheme: theme.appearance,
      }}
      onLoad={() => frame.current?.contentWindow?.postMessage(pageThemeMessage(theme), "*")}
    />
  );
  return fill ? (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" }}>
      {iframe}
    </div>
  ) : (
    iframe
  );
}
