import { useQueryClient } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";

import { Button } from "#/components/kit/button";
import { launchFirstMessage } from "#/lib/api";
import { readDraft, subscribeDrafts, writeDrafts } from "#/lib/drafts";
import {
  FIRST_MESSAGE_UNCONFIRMED,
  type FirstMessageOutcome,
  sendFirstMessage,
} from "#/lib/first-message";
import { draftItems, useMessageOwner } from "#/lib/outbox";
import { useTRPC } from "#/lib/trpc";
import { useSignedInQuery } from "#/lib/viewer";

import { messageInputId } from "../session-message-input";

/**
 * The composer of a session whose imported conversation waits for its first message: Send starts
 * the session's agent in conversation mode on that conversation, the words its first turn
 * (`lib/first-message`). The words stay in the input until the server takes them; a refusal is
 * said under them in the server's words. They are kept as the session's message draft, the one
 * the ordinary composer shows, so words a refusal left behind are still there once the session
 * reads as started by someone else, and after a reload.
 */
export function FirstMessageInput({
  sessionId,
  settledAt,
  agent,
}: {
  readonly sessionId: string;
  /** The attempt the page shows; a first message refused before (no login) left it settled. */
  readonly settledAt: Date | null;
  readonly agent: string;
}) {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  // Who is signed in names the draft; read here as the session's message input reads it, and
  // the words wait for the answer, so none are written that the draft does not hold.
  const signedIn = useSignedInQuery();
  const userId = useMessageOwner();
  const draft = userId === null ? null : draftItems({ userId, sessionId }).text;
  // Words this tab could not store (storage full) stay in memory.
  const [unstored, setUnstored] = useState<string | null>(null);
  const stored = useSyncExternalStore(
    subscribeDrafts,
    () => (draft === null ? "" : readDraft(draft)),
    () => "",
  );
  const text = unstored ?? stored;
  const setText = (next: string) => {
    setUnstored(draft !== null && writeDrafts([[draft, next]]) ? null : next);
  };
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<FirstMessageOutcome | null>(null);

  const send = async () => {
    if (sending || userId === null || text.trim() === "") return;
    setSending(true);
    const answered = await sendFirstMessage(
      (request) => launchFirstMessage(sessionId, request),
      text,
      settledAt,
    );
    setOutcome(answered);
    if (answered._tag === "Started") setText("");
    setSending(false);
    // Started, or maybe started: the page reads the session again. A refusal leaves the page as
    // it is, so its words stay beside the person's; the session's own events still bring the
    // page up to date when it moved on.
    if (answered._tag !== "Refused") void queryClient.invalidateQueries(trpc.sessions.pathFilter());
  };

  return (
    <form
      aria-label="First message"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      className="rounded-[18px] border border-input composer-glass shadow-md transition-[border-color,box-shadow] focus-within:border-[color-mix(in_oklab,var(--sw-accent)_45%,var(--sw-rule))]"
    >
      <textarea
        id={messageInputId(sessionId)}
        aria-label={`First message to ${agent}`}
        readOnly={sending || userId === null}
        value={text}
        rows={1}
        placeholder={`Message ${agent}.`}
        onChange={(event) => setText(event.target.value)}
        onInput={(event) => {
          const el = event.currentTarget;
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") event.currentTarget.blur();
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          void send();
        }}
        className="block max-h-[200px] min-h-[52px] w-full resize-none bg-transparent px-[18px] pt-4 pb-1.5 font-sans text-[15px] leading-relaxed text-foreground outline-none placeholder:text-faint"
      />
      <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-2.5">
        <div className="min-w-0 flex-1 px-1.5">
          {userId === null ? (
            <p className="font-sans text-[12.5px] text-muted-foreground">
              {signedIn.isError && !signedIn.isFetching
                ? "could not check who is signed in"
                : "checking who is signed in"}
            </p>
          ) : sending ? (
            <p role="status" className="font-sans text-[12.5px] text-muted-foreground">
              Starting {agent}…
            </p>
          ) : outcome?._tag === "Refused" ? (
            <p role="alert" className="font-sans text-[12.5px] text-danger">
              {outcome.words}
            </p>
          ) : outcome?._tag === "Unconfirmed" ? (
            <p role="alert" className="font-sans text-[12.5px] text-warning">
              {FIRST_MESSAGE_UNCONFIRMED}
            </p>
          ) : (
            <p className="font-sans text-[12.5px] text-muted-foreground">
              Sending starts {agent} on the imported conversation
            </p>
          )}
        </div>
        <Button
          type="submit"
          variant="primary"
          disabled={sending || userId === null}
          onPointerDown={(event) => event.preventDefault()}
        >
          Send
        </Button>
      </div>
    </form>
  );
}
