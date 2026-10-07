import type RFB from "@novnc/novnc";
import { useEffect, useRef, useState } from "react";

/** Mend serves the viewer code; only VNC bytes come from the workspace. */
export function DesktopViewer({
  baseUrl,
  humanControl,
}: {
  readonly baseUrl: string;
  readonly humanControl: boolean;
}) {
  const target = useRef<HTMLDivElement>(null);
  const client = useRef<RFB | null>(null);
  const viewOnly = useRef(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // RFB is an external resource: synchronize input mode without reconnecting its socket.
  useEffect(() => {
    viewOnly.current = !humanControl;
    if (client.current) client.current.viewOnly = viewOnly.current;
  }, [humanControl]);

  useEffect(() => {
    let disposed = false;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    const url = new URL(`${baseUrl}/vnc`, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const connect = async () => {
      try {
        const { default: Viewer } = await import("@novnc/novnc");
        const screen = target.current;
        if (disposed || !screen) return;
        screen.replaceChildren();
        const rfb = new Viewer(screen, url.href);
        client.current = rfb;
        rfb.scaleViewport = true;
        rfb.resizeSession = false;
        rfb.viewOnly = viewOnly.current;
        rfb.addEventListener("connect", () => {
          setConnected(true);
          setError(null);
        });
        rfb.addEventListener("disconnect", () => {
          if (disposed) return;
          setConnected(false);
          reconnect = setTimeout(() => void connect(), 2000);
        });
      } catch (cause) {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : "Desktop could not connect.");
      }
    };
    void connect();
    return () => {
      disposed = true;
      clearTimeout(reconnect);
      client.current?.disconnect();
      client.current = null;
    };
  }, [baseUrl]);

  return (
    <div className="relative">
      <div
        ref={target}
        aria-label="Session desktop"
        className="aspect-[1440/900] w-full overflow-hidden bg-secondary"
      />
      {!connected ? (
        <p role="status" className="absolute inset-x-4 top-4 text-xs text-muted-foreground">
          {error ?? "Connecting to desktop…"}
        </p>
      ) : null}
    </div>
  );
}
