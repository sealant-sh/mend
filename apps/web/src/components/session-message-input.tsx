import {
  focusManager,
  type InfiniteData,
  type QueryClient,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo, useState, useSyncExternalStore } from "react";

import { Button } from "#/components/kit/button";
import { pasteSessionImage } from "#/lib/api";
import {
  type ConversationPage,
  conversationKey,
  type ConversationView,
  heldConversation,
} from "#/lib/conversation";
import { dropAllDrafts, readDraft, subscribeDrafts, writeDrafts } from "#/lib/drafts";
import {
  arrivedIn,
  draftItems,
  forgetTabOutboxes,
  mintMessageKey,
  type MessageScope,
  type OutboxMessage,
  sendMessage,
  turnOfMessage,
  UNCONFIRMED,
  useOutbox,
} from "#/lib/outbox";
import { forgetPendingLaunches } from "#/lib/pending-launches";
import { failureWords, refusalTagOf } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";
import { useSignedInQuery } from "#/lib/viewer";

/**
 * The words being written and the key their next send carries. A message's key is minted when it
 * is sent and goes with it into the outbox (`lib/outbox`), which shows it as a bubble at once; the
 * composer holds a key only for words taken back from a bubble to edit, so sending them unchanged
 * is still the same message to the server. Both live in sessionStorage per account and session,
 * so they outlive the input when it unmounts (the agent stopped, control revoked) and a reload.
 */
interface Draft {
  readonly text: string;
  readonly clientMessageId: string | null;
}

const SIGNED_OUT = "mend.signedOut";

const SIGNED_IN = "mend.signedIn";

const readMessageDraft = (scope: MessageScope): Draft => {
  const items = draftItems(scope);
  const key = readDraft(items.key);
  return { text: readDraft(items.text), clientMessageId: key === "" ? null : key };
};

const writeMessageDraft = (scope: MessageScope, next: Draft) => {
  const items = draftItems(scope);
  writeDrafts([
    [items.text, next.text],
    [items.key, next.clientMessageId ?? ""],
  ]);
};

/**
 * Run at sign-out, so the next person in this tab inherits neither these words nor the cached
 * identity a draft is stored under. Other tabs hear of it through `followOtherTabs`.
 */
export const forgetSignedInPerson = (queryClient: QueryClient) => {
  queryClient.clear();
  dropAllDrafts();
  forgetTabOutboxes();
  forgetPendingLaunches();
  localStorage.setItem(SIGNED_OUT, String(Date.now()));
};

/**
 * Run after a sign-in or sign-up, which can replace the account a tab's cookie names with no
 * sign-out. Every tab reads its answers again, so a draft shows only once the new identity is
 * read; each draft stays stored under the account that wrote it.
 */
export const noteSignedIn = (queryClient: QueryClient) => {
  forgetPendingLaunches();
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
    forgetPendingLaunches();
    if (event.key === SIGNED_OUT) {
      dropAllDrafts();
      forgetTabOutboxes();
    }
    void queryClient.resetQueries();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
};

/**
 * What the footer says of the person's latest message to the session: Mend's sentence once it
 * answered, why it was not sent, or that its answer was lost. Nothing while it is on its way, and
 * nothing for a lost answer once the conversation shows the message arrived. Said here, under the
 * words, so it is heard on every tab; the bubble in the conversation carries Retry and Edit.
 */
export const footerOf = (
  latest: OutboxMessage | undefined,
  conversation: ConversationView | undefined,
):
  | { readonly _tag: "Answered"; readonly explanation: string }
  | { readonly _tag: "Refused"; readonly words: string }
  | { readonly _tag: "Unconfirmed" }
  | null => {
  if (latest === undefined) return null;
  switch (latest.state._tag) {
    case "Sending":
      return null;
    case "Sent": {
      // Mend's sentence describes the turn as it stood when Mend answered ("turn running"): once
      // the conversation shows that turn ended, the sentence is history, and the line goes.
      const turn = conversation === undefined ? null : turnOfMessage(conversation, latest);
      return turn !== null && turn.status !== "queued" && turn.status !== "running"
        ? null
        : { _tag: "Answered", explanation: latest.state.explanation };
    }
    case "NotSent":
      return { _tag: "Refused", words: latest.state.words };
    case "Unconfirmed":
      return conversation !== undefined && arrivedIn(conversation, latest)
        ? null
        : { _tag: "Unconfirmed" };
  }
};

/** The id of a session's message input, for a bubble's Edit to move focus into it. */
export const messageInputId = (sessionId: string) => `message-input-${sessionId}`;

/**
 * The session page's one input for a live conversation. Send goes into the person's own running
 * turn or starts their next one, as their "Send steers the running turn" setting says; the server
 * decides and answers with a sentence, shown as it is. The words leave the input the moment Send
 * is pressed and show as a bubble in the conversation (`lib/outbox`), so the next message can be
 * written while they are on their way. A draft is shown and edited only under an answer to who is
 * signed in that is not being read again and did not fail (`useMessageOwner`).
 */
export function SessionMessageInput({
  sessionId,
  placeholder = "Message the agent",
  submitLabel = "Send",
  attach = false,
  resumes = false,
}: {
  readonly sessionId: string;
  readonly placeholder?: string;
  /** "Steer" while the agent works, "Send" otherwise. */
  readonly submitLabel?: string;
  /** Offer Attach: an image goes into the workspace and its path into the message. */
  readonly attach?: boolean;
  /**
   * The session is stopped and comes back as a conversation: Send (and Attach) resume it, and
   * the words go as its next turn. A line under the words says so.
   */
  readonly resumes?: boolean;
}) {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const signedIn = useSignedInQuery();
  const outbox = useOutbox(sessionId);
  const { scope } = outbox;
  const userId = scope?.userId ?? null;
  const items = scope === null ? null : draftItems(scope);
  const text = useSyncExternalStore(
    subscribeDrafts,
    () => (items === null ? "" : readDraft(items.text)),
    () => "",
  );
  const storedKey = useSyncExternalStore(
    subscribeDrafts,
    () => (items === null ? "" : readDraft(items.key)),
    () => "",
  );
  // Read from the cache as it changes, never fetched here: the conversation reads it. The pages
  // are the snapshot (the cache keeps their identity until they change); what they hold is
  // derived from them once per change.
  const pages = useSyncExternalStore(
    (listener) => queryClient.getQueryCache().subscribe(listener),
    () =>
      queryClient.getQueryData<InfiniteData<ConversationPage>>(conversationKey(trpc, sessionId)),
    () => undefined,
  );
  const conversation = useMemo(
    () => (pages === undefined ? undefined : heldConversation(pages.pages)),
    [pages],
  );
  const draft: Draft = { text, clientMessageId: storedKey === "" ? null : storedKey };
  const [keyless, setKeyless] = useState(false);
  const [attaching, setAttaching] = useState<
    "idle" | "uploading" | "resuming" | { readonly failed: string }
  >("idle");
  const busyAttaching = attaching === "uploading" || attaching === "resuming";
  const footer = footerOf(outbox.messages.at(-1), conversation);
  const announcement = outbox.announcement;

  /** Store the image beside the session and put its workspace path into the words. */
  const attachImage = async (file: File) => {
    if (scope === null) return;
    setAttaching("uploading");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const contents = btoa(binary);
      // A stopped conversation whose workspace is still up takes the image as it is; only one
      // whose workspace is gone (the server says so) is resumed for it, and says "Resuming…".
      const stored = await pasteSessionImage(sessionId, contents).catch((cause: unknown) => {
        if (!resumes || refusalTagOf(cause) !== "SessionNotLive") throw cause;
        setAttaching("resuming");
        return pasteSessionImage(sessionId, contents, true);
      });
      const current = readMessageDraft(scope);
      const joiner = current.text === "" || current.text.endsWith(" ") ? "" : " ";
      writeMessageDraft(scope, {
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

  const send = () => {
    // An image still uploading belongs in these words: wait for its path before they go.
    if (scope === null || busyAttaching || draft.text.trim() === "") return;
    const clientMessageId = draft.clientMessageId ?? mintMessageKey();
    setKeyless(clientMessageId === null);
    if (clientMessageId === null) return;
    // The bubble first, then the empty input: the words are never in neither place.
    void sendMessage(outbox.courier, scope, draft.text, clientMessageId, { resuming: resumes });
    writeMessageDraft(scope, { text: "", clientMessageId: null });
  };

  return (
    <form
      aria-label="Message"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
      className="rounded-[18px] border border-input composer-glass shadow-md transition-[border-color,box-shadow] focus-within:border-[color-mix(in_oklab,var(--sw-accent)_45%,var(--sw-rule))]"
    >
      <textarea
        id={messageInputId(sessionId)}
        aria-label="Message the agent"
        readOnly={userId === null}
        value={draft.text}
        rows={1}
        placeholder={placeholder}
        onChange={(event) => {
          if (scope !== null) writeMessageDraft(scope, { ...draft, text: event.target.value });
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
          send();
        }}
        className="block max-h-[200px] min-h-[52px] w-full resize-none bg-transparent px-[18px] pt-4 pb-1.5 font-sans text-[15px] leading-relaxed text-foreground outline-none placeholder:text-faint"
      />
      <div className="flex items-center gap-1.5 px-2.5 pt-2 pb-2.5">
        {attach ? (
          <label
            className={`inline-flex cursor-pointer items-center gap-1.5 rounded-[9px] border border-rule px-2.5 py-[5px] font-sans text-[12.5px] leading-[1.3] font-medium text-ink-2 transition-colors hover:bg-secondary hover:text-foreground has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-[var(--sw-accent)] ${userId === null || busyAttaching ? "pointer-events-none opacity-50" : ""}`}
          >
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="sr-only"
              disabled={userId === null || busyAttaching}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file !== undefined) void attachImage(file);
              }}
            />
            {attaching === "resuming"
              ? "Resuming…"
              : attaching === "uploading"
                ? "Attaching…"
                : "Attach"}
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
          {keyless ? (
            <p role="alert" className="font-sans text-[12.5px] text-danger">
              Not sent · this browser could not make a message key
            </p>
          ) : footer?._tag === "Answered" ? (
            <p className="truncate font-mono text-[12px] text-ink-2">{footer.explanation}</p>
          ) : footer?._tag === "Refused" ? (
            <p className="font-sans text-[12.5px] text-danger">{footer.words}</p>
          ) : footer?._tag === "Unconfirmed" ? (
            <p className="font-sans text-[12.5px] text-warning">{UNCONFIRMED}</p>
          ) : resumes && userId !== null ? (
            <p className="font-sans text-[12.5px] text-muted-foreground">
              Sending resumes the session
            </p>
          ) : null}
          {outbox.inMemoryOnly ? (
            <p className="font-sans text-[12.5px] text-warning">
              This browser&apos;s storage is full: messages on their way are kept in this tab only
              until they are sent.
            </p>
          ) : null}
          {/* Every send's outcome is said as it settles, whichever message is newest. Always
              rendered, so screen readers hear what is put in them. */}
          <p role="status" className="sr-only">
            {announcement !== null && !announcement.urgent ? announcement.words : ""}
          </p>
          <p role="alert" className="sr-only">
            {announcement !== null && announcement.urgent ? announcement.words : ""}
          </p>
        </div>
        <Button
          type="submit"
          variant="primary"
          disabled={userId === null || busyAttaching}
          onPointerDown={(event) => event.preventDefault()}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
