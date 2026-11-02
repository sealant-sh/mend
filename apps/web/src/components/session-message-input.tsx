import { focusManager, type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";

import { Button } from "#/components/kit/button";
import { pasteSessionImage, type SessionMessageReceiptDto } from "#/lib/api";
import { failureWords, refusalTagOf } from "#/lib/refusal";
import { orLogin, useTRPC, useTRPCClient } from "#/lib/trpc";
import { uuidV4 } from "#/lib/uuid";
import { useSignedInQuery } from "#/lib/viewer";

/**
 * The words being written and the key their send carries. The key is minted at the first send and
 * kept, through edits, until Mend answers that it was sent or not sent, so a re-send after a lost or
 * uncertain answer is the same message to the server, never a second one; changed words under a
 * used key are refused with `MessageKeyConflict`, never delivered. Both live in sessionStorage per
 * account and session, so they outlive the input when it unmounts (the agent stopped, control
 * revoked) and a reload.
 */
interface Draft {
  readonly text: string;
  readonly clientMessageId: string | null;
}

type Outcome =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Sending" }
  | { readonly _tag: "Answered"; readonly explanation: string }
  | { readonly _tag: "Refused"; readonly words: string }
  | { readonly _tag: "Unconfirmed" };

const EMPTY: Draft = { text: "", clientMessageId: null };

const UNCONFIRMED = "Message outcome not confirmed · check the session before sending again";

const ENDED: ReadonlySet<string> = new Set(["cancelled", "failed", "interrupted"]);

const PREFIX = "mend.message.";

const SIGNED_OUT = "mend.signedOut";

const SIGNED_IN = "mend.signedIn";

const draftItems = (userId: string, sessionId: string) => ({
  text: `${PREFIX}${userId}.${sessionId}.text`,
  key: `${PREFIX}${userId}.${sessionId}.key`,
});

const readDraft = (userId: string, sessionId: string): Draft => {
  const items = draftItems(userId, sessionId);
  return {
    text: sessionStorage.getItem(items.text) ?? "",
    clientMessageId: sessionStorage.getItem(items.key),
  };
};

const store = (item: string, value: string | null) => {
  if (value === null || value === "") sessionStorage.removeItem(item);
  else sessionStorage.setItem(item, value);
};

const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const writeDraft = (userId: string, sessionId: string, next: Draft) => {
  const items = draftItems(userId, sessionId);
  store(items.text, next.text);
  store(items.key, next.clientMessageId);
  for (const listener of listeners) listener();
};

const dropDrafts = () => {
  const items = Array.from({ length: sessionStorage.length }, (_, index) =>
    sessionStorage.key(index),
  );
  for (const item of items) if (item?.startsWith(PREFIX)) sessionStorage.removeItem(item);
  for (const listener of listeners) listener();
};

/**
 * Run at sign-out, so the next person in this tab inherits neither these words nor the cached
 * identity a draft is stored under. Other tabs hear of it through `followOtherTabs`.
 */
export const forgetSignedInPerson = (queryClient: QueryClient) => {
  queryClient.clear();
  dropDrafts();
  localStorage.setItem(SIGNED_OUT, String(Date.now()));
};

/**
 * Run after a sign-in or sign-up, which can replace the account a tab's cookie names with no
 * sign-out. Every tab reads its answers again, so a draft shows only once the new identity is
 * read; each draft stays stored under the account that wrote it.
 */
export const noteSignedIn = (queryClient: QueryClient) => {
  void queryClient.resetQueries();
  localStorage.setItem(SIGNED_IN, String(Date.now()));
};

/**
 * Run once per tab. A sign-out in another tab drops this tab's drafts and cached answers too, a
 * sign-in there makes this tab read its answers again, and
 * focusing or showing the tab again re-reads stale answers. Reset, not cleared, so what is on
 * screen reads its answers again.
 */
export const followOtherTabs = (queryClient: QueryClient) => {
  focusManager.setEventListener((refocus) => {
    const onUse = () => refocus();
    window.addEventListener("focus", onUse);
    window.addEventListener("visibilitychange", onUse);
    return () => {
      window.removeEventListener("focus", onUse);
      window.removeEventListener("visibilitychange", onUse);
    };
  });
  const onStorage = (event: StorageEvent) => {
    if (event.key !== SIGNED_OUT && event.key !== SIGNED_IN) return;
    if (event.key === SIGNED_OUT) dropDrafts();
    void queryClient.resetQueries();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
};

const mintKey = (): string | null => {
  try {
    return uuidV4();
  } catch {
    return null;
  }
};

/**
 * What stays after a receipt. Words Mend recorded and never delivered (the server's `not sent ·
 * …`) stay under a new key, since the spent one would replay this receipt. Words whose delivery is
 * not confirmed stay under their key, so sending them again replays the receipt.
 */
const draftAfter = (receipt: SessionMessageReceiptDto, attempt: Draft): Draft => {
  const unsent = { text: attempt.text, clientMessageId: null };
  if (receipt._tag === "Turn")
    return receipt.turn.startedAt === null && ENDED.has(receipt.turn.status) ? unsent : EMPTY;
  switch (receipt.steer.delivery._tag) {
    case "Accepted":
    case "Queued":
      return EMPTY;
    case "Sending":
    case "Unknown":
      return attempt;
    case "NotSent":
      return unsent;
  }
};

/**
 * An answer settles the draft only while it still holds the key that was sent, and never replaces
 * words edited since (in a later mount of the input). The key goes as the answer says: an
 * uncertain one keeps it under the edited words too, so undoing the edit re-sends the same message.
 */
const settleDraft = (userId: string, sessionId: string, attempt: Draft, next: Draft) => {
  const current = readDraft(userId, sessionId);
  if (current.clientMessageId !== attempt.clientMessageId) return;
  writeDraft(userId, sessionId, {
    text: current.text === attempt.text ? next.text : current.text,
    clientMessageId: next.clientMessageId,
  });
};

/**
 * The session page's one input for a live conversation. Send goes into the person's own running
 * turn or starts their next one, as their "Send steers the running turn" setting says; the server
 * decides and answers with a sentence, shown as it is. A draft is shown and edited only under an
 * answer to who is signed in that is not being read again and did not fail. That answer is read
 * from the query cache as it changes, not from the rendered query, which hears of a re-read
 * started on focus only a task later.
 */
export function SessionMessageInput({
  sessionId,
  placeholder = "Message the agent",
  submitLabel = "Send",
  attach = false,
}: {
  readonly sessionId: string;
  readonly placeholder?: string;
  /** "Steer" while the agent works, "Send" otherwise. */
  readonly submitLabel?: string;
  /** Offer Attach: an image goes into the workspace and its path into the message. */
  readonly attach?: boolean;
}) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const signedIn = useSignedInQuery();
  const identityKey = trpc.organization.current.queryKey();
  const userId = useSyncExternalStore(
    (listener) => queryClient.getQueryCache().subscribe(listener),
    () => {
      const state = queryClient.getQueryState(identityKey);
      return state?.status === "success" && state.fetchStatus === "idle"
        ? (state.data?.userId ?? null)
        : null;
    },
  );
  const items = userId === null ? null : draftItems(userId, sessionId);
  const draft: Draft = {
    text: useSyncExternalStore(subscribe, () =>
      items === null ? "" : (sessionStorage.getItem(items.text) ?? ""),
    ),
    clientMessageId: useSyncExternalStore(subscribe, () =>
      items === null ? null : sessionStorage.getItem(items.key),
    ),
  };
  const [outcome, setOutcome] = useState<Outcome>({ _tag: "Idle" });
  const [attaching, setAttaching] = useState<"idle" | "uploading" | { readonly failed: string }>(
    "idle",
  );
  const sending = outcome._tag === "Sending";

  /** Store the image beside the session and put its workspace path into the words. */
  const attachImage = async (file: File) => {
    if (userId === null) return;
    setAttaching("uploading");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const stored = await pasteSessionImage(sessionId, btoa(binary));
      const current = readDraft(userId, sessionId);
      const joiner = current.text === "" || current.text.endsWith(" ") ? "" : " ";
      writeDraft(userId, sessionId, {
        ...current,
        text: `${current.text}${joiner}${stored.path} `,
      });
      setAttaching("idle");
    } catch (cause) {
      setAttaching({
        failed: failureWords(cause, "The image was not attached. Try again."),
      });
    }
  };

  const send = async () => {
    // An image still uploading belongs in these words: wait for its path before they go.
    if (userId === null || sending || attaching === "uploading" || draft.text.trim() === "") return;
    const clientMessageId = draft.clientMessageId ?? mintKey();
    if (clientMessageId === null) {
      setOutcome({
        _tag: "Refused",
        words: "Not sent · this browser could not make a message key",
      });
      return;
    }
    const attempt = { text: draft.text, clientMessageId };
    writeDraft(userId, sessionId, attempt);
    setOutcome({ _tag: "Sending" });
    try {
      const receipt = await orLogin(
        client.sessions.sendMessage.mutate({
          id: sessionId,
          input: attempt.text,
          clientMessageId: attempt.clientMessageId,
          expectedUserId: userId,
        }),
      );
      settleDraft(userId, sessionId, attempt, draftAfter(receipt, attempt));
      setOutcome({ _tag: "Answered", explanation: receipt.explanation });
      void queryClient.invalidateQueries(trpc.sessions.pathFilter());
    } catch (cause) {
      const tag = refusalTagOf(cause);
      if (tag === null) {
        setOutcome({ _tag: "Unconfirmed" });
        return;
      }
      if (tag === "MessageKeyConflict")
        settleDraft(userId, sessionId, attempt, { text: attempt.text, clientMessageId: null });
      if (tag === "MessageAuthorChanged")
        void queryClient.invalidateQueries(trpc.organization.current.queryFilter());
      setOutcome({
        _tag: "Refused",
        words: failureWords(cause, "Not sent. Your message is still here; send it again."),
      });
    }
  };

  return (
    <form
      aria-label="Message"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      className="rounded-[18px] border border-input bg-panel shadow-md transition-[border-color,box-shadow] focus-within:border-[color-mix(in_oklab,var(--sw-accent)_45%,var(--sw-rule))]"
    >
      <textarea
        aria-label="Message the agent"
        readOnly={sending || userId === null}
        value={draft.text}
        rows={1}
        placeholder={placeholder}
        onChange={(event) => {
          if (userId !== null)
            writeDraft(userId, sessionId, { ...draft, text: event.target.value });
        }}
        onInput={(event) => {
          const el = event.currentTarget;
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") event.currentTarget.blur();
          if (event.key !== "Enter") return;
          if (event.nativeEvent.isComposing) return;
          if (event.shiftKey) return;
          event.preventDefault();
          void send();
        }}
        className="block max-h-[200px] min-h-[52px] w-full resize-none bg-transparent px-[18px] pt-4 pb-1.5 font-sans text-[15px] leading-relaxed text-foreground outline-none placeholder:text-faint"
      />
      <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-2.5">
        {attach ? (
          <label
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-[9px] border border-rule px-2.5 py-[5px] font-sans text-[12.5px] leading-[1.3] font-medium text-ink-2 transition-colors hover:bg-secondary hover:text-foreground has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-[var(--sw-accent)] ${userId === null || attaching === "uploading" ? "pointer-events-none opacity-50" : ""}`}
          >
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="sr-only"
              disabled={userId === null || attaching === "uploading"}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file !== undefined) void attachImage(file);
              }}
            />
            {attaching === "uploading" ? "Attaching…" : "Attach"}
          </label>
        ) : null}
        <div className="min-w-0 flex-1 px-1.5">
          {typeof attaching === "object" ? (
            <p role="alert" className="font-sans text-[12.5px] text-danger">
              {attaching.failed}
            </p>
          ) : null}
          {userId === null && (
            <p className="font-sans text-[12.5px] text-muted-foreground">
              {signedIn.isError && !signedIn.isFetching
                ? "could not check who is signed in"
                : "checking who is signed in"}
            </p>
          )}
          {outcome._tag === "Answered" && (
            <p role="status" className="truncate font-mono text-[12px] text-ink-2">
              {outcome.explanation}
            </p>
          )}
          {outcome._tag === "Refused" && (
            <p role="alert" className="font-sans text-[12.5px] text-danger">
              {outcome.words}
            </p>
          )}
          {outcome._tag === "Unconfirmed" && (
            <p role="alert" className="font-sans text-[12.5px] text-warning">
              {UNCONFIRMED}
            </p>
          )}
        </div>
        <Button
          type="submit"
          variant="primary"
          disabled={sending || userId === null || attaching === "uploading"}
          onPointerDown={(event) => event.preventDefault()}
        >
          {sending ? "Sending…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
