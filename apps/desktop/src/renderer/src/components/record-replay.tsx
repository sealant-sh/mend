import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { TERMINAL_THEME } from "#/components/tty-terminal";
import { processLogPage, type TranscriptEventDto } from "#/lib/api";
import { sessionTranscriptQuery } from "#/lib/queries";
import { base64Bytes, recordPages } from "#/lib/record";
import { useTerminalFont, type TerminalFontSetting } from "#/lib/terminal-font";
import { GhosttyTerminalSurface } from "#/terminal/ghostty/surface";

/**
 * An ended PTY, replayed from its record (`GET /api/processes/:id/logs`), never from `/api/tty`:
 * the attach only reaches a live PTY, while the record outlives the process and its workspace.
 * The same terminal surface draws the bytes, read-only — keys go nowhere, selection and links
 * still work. `from` is a record sequence (the scrubber's checkpoint ticks); changing it replays
 * from there.
 */

type ReplayState =
  | { readonly kind: "reading" }
  | { readonly kind: "replayed"; readonly chunks: number; readonly truncated: boolean }
  | { readonly kind: "error"; readonly message: string };

const readFrom = (processId: string) => (from: string) =>
  processLogPage(processId, { from, limit: "1000" });

const replayNote = (state: ReplayState): string => {
  if (state.kind === "reading") return "reading the record…";
  if (state.kind === "error") return `the record could not be read — ${state.message}`;
  if (state.chunks === 0) return "no output recorded from here";
  return state.truncated ? "replayed · the record continues past what was read" : "";
};

export function RecordReplay({
  processId,
  from,
}: {
  /** The ended process whose PTY output the record holds. */
  readonly processId: string;
  /** Record sequence to replay from. */
  readonly from: string;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<GhosttyTerminalSurface | null>(null);
  const font = useTerminalFont();
  const fontRef = useRef<TerminalFontSetting>(font);
  fontRef.current = font;
  const [state, setState] = useState<ReplayState>({ kind: "reading" });

  useEffect(() => {
    void surfaceRef.current?.setFont(font);
  }, [font]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    let disposed = false;
    let surface: GhosttyTerminalSurface | null = null;
    setState({ kind: "reading" });

    const replay = async (created: GhosttyTerminalSurface) => {
      let chunks = 0;
      const pages = recordPages(readFrom(processId), from);
      for (;;) {
        const step = await pages.next();
        if (disposed) return;
        if (step.done === true) {
          setState({ kind: "replayed", chunks, truncated: step.value.truncated });
          return;
        }
        for (const chunk of step.value.chunks) created.write(base64Bytes(chunk.dataBase64));
        chunks += step.value.chunks.length;
      }
    };

    void GhosttyTerminalSurface.create(host, {
      theme: TERMINAL_THEME,
      font: fontRef.current,
      // Read-only: nothing typed here reaches anything.
      onData: () => {},
      onResize: () => {},
      onSelectionChange: () => {},
      beforeKey: (event) => !event.defaultPrevented,
      onLinkActivate: (text) => {
        void window.mend.shell.openExternal(text);
      },
    }).then(
      (created) => {
        if (disposed) {
          created.dispose();
          return null;
        }
        surface = created;
        surfaceRef.current = created;
        void created.setFont(fontRef.current);
        return replay(created).catch((error: unknown) => {
          if (disposed) return;
          setState({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        });
      },
      () => {
        if (!disposed) setState({ kind: "error", message: "the terminal surface did not load" });
        return null;
      },
    );

    return () => {
      disposed = true;
      surface?.dispose();
      if (surfaceRef.current === surface) surfaceRef.current = null;
      host.replaceChildren();
    };
  }, [processId, from]);

  const note = replayNote(state);
  return (
    <div className="relative h-full w-full bg-term">
      <div ref={hostRef} className="tty-host opacity-75" />
      {note !== "" && (
        <p
          className={`pointer-events-none absolute right-3 bottom-2 font-mono text-[11.5px] ${state.kind === "error" ? "text-term-red" : "text-term-faint"}`}
        >
          {note}
        </p>
      )}
    </div>
  );
}

/**
 * The session's conversation from its durable record — the web app's settled-session view, on
 * the terminal surface's ground.
 */
export function TranscriptView({ sessionId }: { readonly sessionId: string }) {
  const transcript = useQuery(sessionTranscriptQuery(sessionId));
  if (transcript.isPending) {
    return <p className="p-4 font-mono text-[11.5px] text-term-faint">reading the record…</p>;
  }
  const events = transcript.data?.events ?? [];
  if (events.length === 0) {
    return (
      <p className="p-4 font-mono text-[11.5px] text-term-faint">
        {transcript.isError
          ? "the record could not be read — it stays on the platform"
          : "no conversation recorded"}
      </p>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-4">
      {events.map((event, index) => (
        <TranscriptEvent key={index} event={event} />
      ))}
    </div>
  );
}

function TranscriptEvent({ event }: { readonly event: TranscriptEventDto }) {
  if (event.kind === "user" && event.text !== null) {
    return (
      <div className="ml-auto max-w-[85%] rounded-xl bg-term-rule/60 px-3.5 py-2.5">
        <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-term-fg">{event.text}</p>
      </div>
    );
  }
  if (event.kind === "assistant" && event.text !== null) {
    return (
      <p className="max-w-[760px] text-[13px] leading-relaxed whitespace-pre-wrap text-term-fg">
        {event.text}
      </p>
    );
  }
  if (event.kind === "reasoning" && event.text !== null) {
    return <p className="line-clamp-2 font-mono text-[11px] text-term-faint">{event.text}</p>;
  }
  if (event.kind === "tool") {
    return (
      <div className="rounded-lg border border-term-rule px-3 py-2">
        <p className="font-mono text-[11.5px] text-term-dim">
          {event.command !== null ? `$ ${event.command}` : `⚙ ${event.name ?? "tool"}`}
        </p>
        {event.output !== null && event.output !== "" && (
          <p className="mt-1 line-clamp-3 font-mono text-[10.5px] whitespace-pre-wrap text-term-faint">
            {event.output}
          </p>
        )}
      </div>
    );
  }
  return null;
}
