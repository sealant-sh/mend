import type { PageRef } from "@mend/domain/workbench";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { TranscriptEventDto } from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

import { PageDialog, PageFrame } from "./page-frame.tsx";

function PageEvent({ page }: { readonly page: PageRef }) {
  const [open, setOpen] = useState(false);
  return (
    <figure className="min-w-0 space-y-3">
      <figcaption className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 text-[13px] font-medium break-words text-foreground">
          {page.title}
        </span>
        <button
          type="button"
          aria-label={`Open ${page.title}`}
          onClick={() => setOpen(true)}
          className="shrink-0 text-xs font-medium text-info hover:underline"
        >
          Open
        </button>
      </figcaption>
      <PageFrame page={page} />
      {open && <PageDialog page={page} onClose={() => setOpen(false)} />}
    </figure>
  );
}

function TranscriptEvent({ event }: { readonly event: TranscriptEventDto }) {
  if (event.kind === "page" && event.page !== undefined) {
    return <PageEvent page={event.page} />;
  }
  if (event.kind === "user" && event.text !== null) {
    return (
      <div className="ml-auto max-w-[85%] rounded-xl bg-secondary px-3.5 py-2.5">
        <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-foreground">
          {event.text}
        </p>
      </div>
    );
  }
  if (event.kind === "assistant" && event.text !== null) {
    return (
      <p className="text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink-2">{event.text}</p>
    );
  }
  if (event.kind === "reasoning" && event.text !== null) {
    return <p className="line-clamp-2 font-mono text-[11px] text-faint">{event.text}</p>;
  }
  if (event.kind === "tool") {
    return (
      <div className="rounded-lg bg-secondary px-3 py-2">
        <p className="font-mono text-[11.5px] text-ink-2">
          {event.command !== null ? `$ ${event.command}` : `⚙ ${event.name ?? "tool"}`}
        </p>
        {event.output !== null && event.output !== "" && (
          <p className="mt-1 line-clamp-3 font-mono text-[10.5px] whitespace-pre-wrap text-faint">
            {event.output}
          </p>
        )}
      </div>
    );
  }
  return null;
}

/** The durable record, conversation-shaped — what the ephemeral SSE lines could never replay. */
export function TranscriptPane({ sessionId }: { readonly sessionId: string }) {
  const trpc = useTRPC();
  const transcript = useQuery(trpc.sessions.transcript.queryOptions({ id: sessionId }));
  if (transcript.isLoading) {
    return <p className="p-4 font-mono text-xs text-faint">reading the record…</p>;
  }
  const events = transcript.data?.events ?? [];
  if (events.length === 0) {
    return (
      <p className="p-4 font-mono text-xs text-faint">
        {transcript.isError
          ? "the record could not be read — it stays on the platform"
          : "no conversation recorded — open the change for the reviewed diff"}
      </p>
    );
  }
  return (
    <div className="flex max-h-[480px] flex-col gap-2.5 overflow-y-auto p-4">
      {events.map((event, index) => (
        <TranscriptEvent key={event.page?.id ?? index} event={event} />
      ))}
    </div>
  );
}
