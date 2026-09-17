// The native terminal: a libghostty surface (vendored from pingdotgg/t3code,
// MIT — see modules/t3-terminal/THIRD_PARTY_NOTICES.md) fed by the SAME
// /api/tty WebSocket every Mend surface uses — now through the supervised
// socket hook, so a dropped link reconnects itself instead of freezing the
// surface. Each reconnect replays the PTY record from 0; the buffer restarts
// on the new generation and the native side rebuilds from the fresh prefix.
// When the installed binary lacks the native module (Expo Go, stale build),
// the WebView terminal takes over — the app never loses its terminal.

import { useQuery } from "@tanstack/react-query";
import { requireNativeView } from "expo";
import type { ComponentType } from "react";
import { useCallback, useRef, useState } from "react";
import type { NativeSyntheticEvent, ViewProps } from "react-native";
import { Pressable, View } from "react-native";
import { WebView } from "react-native-webview";

import { MonoText, useTextScale } from "@/components/typography";
import { api, ApiError } from "@/data/live";
import { legacyBearerAfterMint404, useTtySocket } from "@/data/tty-socket";
import { useEvidenceTheme } from "@/theme/evidence";

interface TerminalInputEvent {
  readonly data: string;
}
interface TerminalResizeEvent {
  readonly cols: number;
  readonly rows: number;
}

interface NativeTerminalSurfaceProps extends ViewProps {
  readonly appearanceScheme?: "light" | "dark";
  readonly autoFocus?: boolean;
  readonly themeConfig?: string;
  readonly backgroundColor?: string;
  readonly foregroundColor?: string;
  readonly terminalKey: string;
  readonly initialBuffer: string;
  readonly fontSize: number;
  readonly onInput?: (event: NativeSyntheticEvent<TerminalInputEvent>) => void;
  readonly onResize?: (event: NativeSyntheticEvent<TerminalResizeEvent>) => void;
}

let cachedView: ComponentType<NativeTerminalSurfaceProps> | null | undefined;
const nativeTerminalView = (): ComponentType<NativeTerminalSurfaceProps> | null => {
  if (cachedView !== undefined) return cachedView;
  try {
    cachedView = requireNativeView<NativeTerminalSurfaceProps>("T3TerminalSurface");
  } catch {
    cachedView = null;
  }
  return cachedView;
};

// Scrollback the JS side retains. Trimming breaks the native prefix-diff and
// forces a surface reset + full replay, so trim with hysteresis: let the
// buffer run to TRIM_AT, then cut back to KEEP — resets stay rare instead of
// firing on every chunk once the cap is reached (t3code caps at 512 KiB).
const KEEP_CHARS = 512 * 1024;
const TRIM_AT_CHARS = 640 * 1024;

const trimBuffer = (buffer: string): string => {
  if (buffer.length <= TRIM_AT_CHARS) return buffer;
  let start = buffer.length - KEEP_CHARS;
  // Never split a surrogate pair.
  const lead = buffer.charCodeAt(start);
  if (lead >= 0xdc00 && lead <= 0xdfff) start += 1;
  return buffer.slice(start);
};

const decodeLatin1 = (bytes: Uint8Array): string => {
  // Chunked fromCharCode: a spread of a large PTY burst overflows the stack.
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return out;
};

const makeDecoder = (): TextDecoder | null =>
  typeof TextDecoder === "undefined" ? null : new TextDecoder();

export function GhosttyTerminal({
  serverUrl,
  token,
  sessionId,
  processId,
  registerSend,
  transformInput,
}: {
  readonly serverUrl: string;
  readonly token: string;
  readonly sessionId: string;
  /** A supporting shell process. Omitted only for legacy agent-terminal links. */
  readonly processId?: string;
  /** Hands the caller a raw-bytes sender (the accessory key bar uses it). */
  readonly registerSend?: (send: (data: string) => void) => void;
  /** Applied to keyboard input before it hits the wire (sticky modifiers). */
  readonly transformInput?: (data: string) => string;
}) {
  const Native = nativeTerminalView();
  const { scheme, colors } = useEvidenceTheme();
  const textScale = useTextScale();
  const [buffer, setBuffer] = useState("");

  // Coalesce PTY bursts to one React commit per frame: a busy harness emits
  // dozens of WebSocket frames per screen frame, and a setState per frame
  // of output is exactly the re-render storm that made the terminal crawl.
  // Chunks accumulate in a ref; one rAF flushes them into state, and the
  // native side feeds only the appended suffix.
  const pendingRef = useRef("");
  const flushHandle = useRef<number | null>(null);
  const decoderRef = useRef<TextDecoder | null>(makeDecoder());
  const generationRef = useRef(0);
  const restartRef = useRef(false);

  const flush = useCallback(() => {
    flushHandle.current = null;
    if (pendingRef.current === "" && !restartRef.current) return;
    const chunk = pendingRef.current;
    pendingRef.current = "";
    if (restartRef.current) {
      // A fresh connection replays from 0 — replace, never append.
      restartRef.current = false;
      setBuffer(trimBuffer(chunk));
      return;
    }
    setBuffer((current) => trimBuffer(current + chunk));
  }, []);

  const onBinary = useCallback(
    (data: ArrayBuffer, generation: number) => {
      if (generation !== generationRef.current) {
        generationRef.current = generation;
        pendingRef.current = "";
        restartRef.current = true;
        decoderRef.current = makeDecoder();
      }
      const bytes = new Uint8Array(data);
      pendingRef.current +=
        decoderRef.current !== null
          ? decoderRef.current.decode(bytes, { stream: true })
          : decodeLatin1(bytes);
      flushHandle.current ??= requestAnimationFrame(flush);
    },
    [flush],
  );

  const tty = useTtySocket({
    serverUrl,
    token,
    target:
      processId === undefined
        ? { kind: "session", id: sessionId }
        : { kind: "process", id: processId },
    enabled: Native !== null,
    onBinary,
  });
  registerSend?.((data) => void tty.send(data));

  if (Native === null) {
    // Binary without the native module — the WebView terminal still works.
    return (
      <EmbeddedTerminal
        serverUrl={serverUrl}
        token={token}
        sessionId={sessionId}
        processId={processId}
        background={colors.panel}
      />
    );
  }

  const themeConfig = [
    `background = ${colors.panel}`,
    `foreground = ${colors.ink}`,
    `cursor-color = ${colors.accent}`,
    `cursor-text = ${colors.panel}`,
  ].join("\n");

  return (
    <View style={{ flex: 1, backgroundColor: colors.panel }}>
      <Native
        style={{ flex: 1 }}
        terminalKey={processId ?? sessionId}
        initialBuffer={buffer}
        fontSize={12.5 * textScale}
        autoFocus
        appearanceScheme={scheme}
        themeConfig={`${themeConfig}\n`}
        backgroundColor={colors.panel}
        foregroundColor={colors.ink}
        onInput={(event) => {
          const data = transformInput?.(event.nativeEvent.data) ?? event.nativeEvent.data;
          tty.send(data);
        }}
        onResize={(event) => tty.resize(event.nativeEvent.cols, event.nativeEvent.rows)}
      />
      {(tty.phase === "reconnecting" || tty.phase === "ended") && (
        <Pressable
          onPress={tty.phase === "reconnecting" ? tty.retryNow : undefined}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            alignItems: "center",
            paddingVertical: 4,
            backgroundColor: colors.sunken,
          }}
        >
          <MonoText tone="faint" size={11}>
            {tty.phase === "ended" ? "session settled" : "reconnecting… (tap to retry now)"}
          </MonoText>
        </Pressable>
      )}
    </View>
  );
}

/**
 * The WebView fallback. A WebView cannot set a header on a page load, so its URL carries an
 * upgrade ticket (docs/adr/0004, "Upgrade tickets"): single use, thirty seconds, good for this
 * terminal's embed only. The page trades it for the socket's own ticket; the device bearer never
 * reaches the WebView's URL, history or referrer. A server older than tickets answers the mint
 * with 404, and only then does the bearer ride the URL, as it always did with that server.
 */
const EmbeddedTerminal = ({
  serverUrl,
  token,
  sessionId,
  processId,
  background,
}: {
  readonly serverUrl: string;
  readonly token: string;
  readonly sessionId: string;
  readonly processId: string | undefined;
  readonly background: string;
}) => {
  // The page is told both; the ticket is bound to the one it attaches by (the process when named).
  const address = `session=${encodeURIComponent(sessionId)}${
    processId === undefined ? "" : `&process=${encodeURIComponent(processId)}`
  }`;
  const credential = useQuery({
    queryKey: ["tty-embed-ticket", serverUrl, sessionId, processId ?? null],
    queryFn: async (): Promise<string> => {
      try {
        const minted = await api<{ readonly ticket: string }>("POST", "/upgrade-tickets", {
          target: "tty-embed",
          ...(processId === undefined ? { session: sessionId } : { process: processId }),
        });
        return `ticket=${encodeURIComponent(minted.ticket)}`;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          return `token=${encodeURIComponent(await legacyBearerAfterMint404(token))}`;
        }
        throw error;
      }
    },
    // A ticket is spent by the page that loads it: never reuse one from a cache.
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
    retry: false,
  });
  if (credential.data === undefined) return null;
  // A spent or expired ticket cannot be renewed by the page: it asks, and a fresh one is minted
  // here, with the device's bearer in a header. A new URL reloads the WebView. The same when the
  // OS kills the WebView's process, whose reload would present the spent ticket from its URL.
  const remint = () => void credential.refetch();
  return (
    <WebView
      source={{ uri: `${serverUrl}/tty-embed?${address}&${credential.data}` }}
      style={{ flex: 1, backgroundColor: background }}
      keyboardDisplayRequiresUserAction={false}
      onMessage={(event) => {
        if (event.nativeEvent.data === "mend:embed-expired") remint();
      }}
      onContentProcessDidTerminate={remint}
    />
  );
};
