import { modelPickerFor, type TurnSelection } from "@mend/domain/workbench";
import { ComposerCard, PromptInput, PromptInputModel } from "@mend/ui/components/prompt-input";
import { Button } from "@mend/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import { cn } from "@mend/ui/lib/utils";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { ASK_LABEL } from "#/components/new-session/pickers";
import { askOf, isPending, waitingRequest } from "#/lib/agent-requests";
import { answeredHere } from "#/lib/answered-here";
import { launchFirstMessage, pasteSessionImage } from "#/lib/api";
import type { ConversationView } from "#/lib/conversation";
import { readDraft, subscribeDrafts, writeDrafts } from "#/lib/drafts";
import {
  FIRST_MESSAGE_UNCONFIRMED,
  type FirstMessageOutcome,
  sendFirstMessage,
} from "#/lib/first-message";
import {
  draftItems,
  type MessageScope,
  mintMessageKey,
  releaseLoginHold,
  sendMessage,
  useMessageOwner,
  useOutbox,
} from "#/lib/outbox";
import { usePhone } from "#/lib/phone";
import { failureWords, refusalTagOf } from "#/lib/refusal";
import {
  type ComposerMode,
  composerMode,
  currentSelection,
  othersOpenTurn,
  ownRunningTurn,
  sameSelection,
} from "#/lib/session-composer";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

import { executorCallsQuery } from "./executor-calls";
import {
  AnsweredElsewhere,
  ApprovalComposer,
  ExecutorApprovalComposer,
  type PromptBase,
  QuestionComposer,
  RequestPreview,
} from "./request-card";
import type { SessionFacts } from "./session-facts";
import { useLoginHold, useLoginWorks } from "./shared-control";

type Size = "default" | "touch";

/** The id of a session's message field, for a message's Edit to move focus into it. */
export const messageInputId = (sessionId: string) => `message-input-${sessionId}`;

/** A line under the composer: what is happening, or what went wrong and what to do. */
function ComposerLine({
  tone = "muted",
  children,
}: {
  readonly tone?: "muted" | "alert";
  readonly children: ReactNode;
}) {
  return (
    <p
      role={tone === "alert" ? "alert" : "status"}
      className={cn(
        "px-1 pt-1.5 text-meta",
        tone === "alert" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}

/** Why the viewer can't write to the agent here, said in the composer's place. */
const lockedWords = (mode: ComposerMode, facts: SessionFacts): string => {
  const { agent, session } = facts;
  switch (mode._tag) {
    case "no-control": {
      const owner = session.ownerUserId === null ? null : facts.nameOf(session.ownerUserId);
      // Doop "Someone else's session · reading": whose session it is, the band above says the rest.
      return owner === null
        ? `Only the session's owner can send messages in this session.`
        : `Only ${owner} can send messages in this session.`;
    }
    case "terminal":
      return `${agent} runs in a terminal in this session. Type to it there.`;
    case "starting":
      return `${agent} is starting. You can message it once it runs.`;
    case "not-running":
      return `${agent} isn't running. Resume the session to message it.`;
    case "first-message":
    case "conversation":
      return "";
  }
};

/**
 * What sits under a session's conversation, in its footer (Doop "Write while it works", "Stop
 * the turn"): the composer that messages the agent. A message sent while your own turn runs goes
 * into that turn, and Stop turn stops it; one sent while someone else's turn runs waits for it.
 * An imported conversation's first message starts the agent. Where the viewer can't write to the
 * agent, the composer says why instead.
 *
 * It is a Composer card: while the agent waits on a question or an approval, the card holds it
 * above the input (`request-card.tsx`), and the composer's one send button answers it. Someone who
 * may not answer sees what was asked, with no controls.
 */
export function SessionComposer({
  facts,
  conversation,
  onStartOwn,
}: {
  readonly facts: SessionFacts;
  /** The conversation as the tile holds it; undefined while it is read. */
  readonly conversation: ConversationView | undefined;
  /**
   * Opens a New session tab in this workspace. Where the viewer can't message another person's
   * session, the composer offers it instead: joining needs nobody's leave, and the joiner's session
   * is their own, on their own logins (ADR 0026, decision 7).
   */
  readonly onStartOwn?: (() => void) | undefined;
}) {
  const size: Size = usePhone() ? "touch" : "default";
  const { session, detail } = facts;
  const mode = composerMode({
    session,
    currentAgent: detail.currentAgent,
    steer: detail.control.steer,
    agentLive: facts.agentLive,
  });
  switch (mode._tag) {
    case "first-message":
      return <FirstMessageComposer key={session.id} facts={facts} size={size} />;
    case "conversation":
      return (
        <MessageComposer
          key={session.id}
          facts={facts}
          conversation={conversation}
          resumes={mode.resumes}
          size={size}
        />
      );
    case "no-control":
    case "terminal":
    case "starting":
    case "not-running": {
      const waiting =
        mode._tag === "no-control" && conversation !== undefined
          ? waitingRequest(conversation.requests)
          : undefined;
      return (
        <ComposerCard className="max-lg:max-w-none">
          {waiting === undefined ? null : (
            <RequestPreview
              request={waiting}
              facts={facts}
              conversation={conversation}
              size={size}
            />
          )}
          <PromptInput
            state="locked"
            size={size}
            notice={waiting === undefined ? lockedWords(mode, facts) : answerLockedWords(facts)}
            noticeAction={
              mode._tag === "no-control" && onStartOwn !== undefined ? (
                <Button
                  type="button"
                  variant="outline"
                  size={size === "touch" ? "touch" : "sm"}
                  className="bg-card"
                  onClick={onStartOwn}
                >
                  Start your own session in this workspace
                </Button>
              ) : undefined
            }
          />
        </ComposerCard>
      );
    }
  }
}

/** Why the viewer can't answer what the agent asks here. */
const answerLockedWords = (facts: SessionFacts): string => {
  const owner = facts.session.ownerUserId === null ? null : facts.nameOf(facts.session.ownerUserId);
  return `Only ${owner ?? "the session's owner"} can answer ${facts.agent} in this session, or someone they share control with.`;
};

/**
 * The Executor call waiting on the viewer's own approval, oldest first; undefined when none does.
 * A call whose approver is the turn's sender (`approverId` null) waits on whoever sent the turn,
 * which the server checks when it is answered.
 */
const useHeldExecutorCall = (facts: SessionFacts) => {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const calls = useInfiniteQuery(executorCallsQuery(trpc, client, facts.session.id));
  if (calls.isPending || calls.isError) return undefined;
  return calls.data.pages
    .flatMap((page) => page.calls)
    .filter((call) => call.outcome === "held" && call.approverId === facts.viewerId)
    .at(-1);
};

/** Images a paste or a drop carries; the rest of what it carries goes on as usual. */
const imagesOf = (files: FileList): ReadonlyArray<File> =>
  Array.from(files).filter((file) => file.type.startsWith("image/"));

const base64Of = async (file: File): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

type Attaching = "idle" | "uploading" | "resuming" | { readonly failed: string };

/** The words being written, kept per account and session (`lib/drafts`), and the key they go under. */
const useMessageDraft = (scope: MessageScope | null) => {
  const items = scope === null ? null : draftItems(scope);
  const text = useSyncExternalStore(
    subscribeDrafts,
    () => (items === null ? "" : readDraft(items.text)),
    () => "",
  );
  const key = useSyncExternalStore(
    subscribeDrafts,
    () => (items === null ? "" : readDraft(items.key)),
    () => "",
  );
  const write = (next: { readonly text: string; readonly key: string | null }) => {
    if (items !== null)
      writeDrafts([
        [items.text, next.text],
        [items.key, next.key ?? ""],
      ]);
  };
  return { text, key: key === "" ? null : key, write };
};

/** The agent-and-model menu for the session's next turn: model, thinking, fast and permission. */
function NextTurnMenu({
  harness,
  selection,
  onPick,
  size,
}: {
  readonly harness: TurnSelection["harness"];
  readonly selection: TurnSelection;
  readonly onPick: (next: TurnSelection) => void;
  readonly size: Size;
}) {
  const trpc = useTRPC();
  const catalogs = useQuery(
    trpc.harnesses.models.queryOptions(undefined, { staleTime: 60_000, retry: false }),
  );
  // Without the catalog the menu offers what the turn runs with now; the server checks the rest.
  const picker = modelPickerFor(
    catalogs.isPending || catalogs.isError ? undefined : catalogs.data,
    harness,
    { model: selection.model, effort: selection.effort },
  );
  const fast = selection.speed === "fast";
  const ask = selection.permissionMode === "ask";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <PromptInputModel
            size={size}
            aria-label={`Model for the next turn: ${picker.modelLabel}`}
          >
            <span className="truncate">{picker.modelLabel}</span>
          </PromptInputModel>
        }
      />
      <DropdownMenuContent width="lg" className="max-h-[min(var(--available-height),32rem)]">
        {picker.hasModels ? (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Model</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={picker.model ?? ""}
              onValueChange={(value: string) => {
                const next = modelPickerFor(
                  catalogs.isPending || catalogs.isError ? undefined : catalogs.data,
                  harness,
                  { model: value, effort: selection.effort },
                );
                onPick({ ...selection, model: next.model, effort: next.effort });
              }}
            >
              {picker.models.map((model) => (
                <DropdownMenuRadioItem key={model.id} value={model.id}>
                  {model.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        ) : null}
        {picker.efforts.length > 1 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Thinking</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={picker.effort ?? "default"}
                onValueChange={(value: string) =>
                  onPick({
                    ...selection,
                    effort:
                      picker.efforts.find((row) => (row.effort ?? "default") === value)?.effort ??
                      null,
                  })
                }
              >
                {picker.efforts.map((row) => (
                  <DropdownMenuRadioItem
                    key={row.effort ?? "default"}
                    value={row.effort ?? "default"}
                  >
                    {row.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Next turn</DropdownMenuLabel>
          {picker.fastCapable ? (
            <DropdownMenuCheckboxItem
              checked={fast}
              onCheckedChange={(on: boolean) =>
                onPick({ ...selection, speed: on ? "fast" : "standard" })
              }
            >
              <span className="flex-1">Fast</span>
              <span className="text-meta text-muted-foreground">Uses more of the plan</span>
            </DropdownMenuCheckboxItem>
          ) : null}
          <DropdownMenuCheckboxItem
            checked={ask}
            onCheckedChange={(on: boolean) =>
              onPick({ ...selection, permissionMode: on ? "ask" : "bypass" })
            }
          >
            {ASK_LABEL}
          </DropdownMenuCheckboxItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The composer of a conversation: Send starts the next turn, or goes into your own running turn
 * (Steer), and Stop turn stops that turn. The words leave the field the moment they are sent and
 * show at once as a message in the conversation (`lib/outbox`), so the next one can be written
 * while they are on their way. A pasted or dropped image is stored in the session's workspace and
 * its path goes into the words.
 */
function MessageComposer({
  facts,
  conversation,
  resumes,
  size,
}: {
  readonly facts: SessionFacts;
  readonly conversation: ConversationView | undefined;
  readonly resumes: boolean;
  readonly size: Size;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { session, detail, agent } = facts;
  const outbox = useOutbox(session.id);
  const { scope } = outbox;
  const draft = useMessageDraft(scope);
  const files = useRef<HTMLInputElement>(null);
  const [attaching, setAttaching] = useState<Attaching>("idle");
  const [keyless, setKeyless] = useState(false);
  const busyAttaching = attaching === "uploading" || attaching === "resuming";

  const turns = conversation?.turns ?? [];
  const own = ownRunningTurn(turns, facts.viewerId);
  const other = own === null ? othersOpenTurn(turns, facts.viewerId) : null;
  const base = currentSelection(turns, session, detail.currentAgent?.protocolOptions ?? null);
  const [picked, setPicked] = useState<TurnSelection | null>(null);
  const selection = picked ?? base;
  const changed =
    picked !== null && base !== null && !sameSelection(picked, base) ? picked : undefined;

  const interrupt = useMutation(
    trpc.sessions.interruptTurn.mutationOptions({
      onSettled: () => queryClient.invalidateQueries(trpc.sessions.pathFilter()),
    }),
  );

  const attachImages = async (images: ReadonlyArray<File>) => {
    if (scope === null || busyAttaching || images.length === 0) return;
    try {
      for (const image of images) {
        setAttaching("uploading");
        const contents = await base64Of(image);
        // A stopped conversation whose workspace is still up takes the image as it is; only one
        // whose workspace is gone (the server says so) is resumed for it.
        const stored = await pasteSessionImage(session.id, contents).catch((cause: unknown) => {
          if (!resumes || refusalTagOf(cause) !== "SessionNotLive") throw cause;
          setAttaching("resuming");
          return pasteSessionImage(session.id, contents, true);
        });
        const words = readDraft(draftItems(scope).text);
        const joiner = words === "" || words.endsWith(" ") ? "" : " ";
        draft.write({ text: `${words}${joiner}${stored.path} `, key: draft.key });
      }
      setAttaching("idle");
    } catch (cause) {
      setAttaching({ failed: failureWords(cause, "The image wasn't attached. Try again.") });
    }
  };

  const send = (words: string) => {
    if (scope === null || busyAttaching) return;
    const clientMessageId = draft.key ?? mintMessageKey();
    setKeyless(clientMessageId === null);
    if (clientMessageId === null) {
      // The field empties as it sends; with nothing sent, the words go back.
      queueMicrotask(() => draft.write({ text: words, key: null }));
      return;
    }
    interrupt.reset();
    // Sent again by hand: a refusal for the sender's login is answered anew.
    releaseLoginHold(scope);
    // The message first, then the empty field: the words are never in neither place.
    void sendMessage(outbox.courier, scope, words, clientMessageId, {
      resuming: resumes,
      selection: changed,
    });
    draft.write({ text: "", key: null });
  };

  // A message refused for the sender's own login waits in the box (`holdForLogin`). Once the
  // person's logins, read again after the refusal, say it works, Mend sends it (Doop "Shared
  // control · Ada connects again"). An effect, since the login lands from outside the page: a
  // `user` event when `mend connect` finishes on the person's computer.
  const hold = useLoginHold(scope);
  const loginWorks = useLoginWorks(hold);
  const sendHeld = useEffectEvent(() => {
    if (scope === null) return;
    if (draft.text.trim() === "") releaseLoginHold(scope);
    else send(draft.text);
  });
  useEffect(() => {
    if (loginWorks) sendHeld();
  }, [loginWorks]);

  // What the agent waits on the viewer for: its own question or approval first, then an Executor
  // call. The card shows the one that waited longest.
  const waiting = conversation === undefined ? undefined : waitingRequest(conversation.requests);
  const heldCall = useHeldExecutorCall(facts);
  // The request this tab showed last: once it settles without this tab answering, the card says
  // who answered it, until dismissed.
  const [watched, setWatched] = useState<string | null>(null);
  if (waiting !== undefined && waiting.id !== watched) setWatched(waiting.id);
  const watchedRequest =
    watched === null || waiting !== undefined
      ? undefined
      : conversation?.requests.find((request) => request.id === watched);
  const elsewhere =
    watchedRequest !== undefined && !isPending(watchedRequest) && !answeredHere(watchedRequest.id)
      ? watchedRequest
      : undefined;

  const stopped = turns.at(-1)?.status === "interrupted";
  const placeholder =
    own !== null
      ? `Message ${agent}. It reads this at its next step.`
      : other !== null
        ? `Message ${agent}. It waits for ${facts.nameOf(other.author ?? "") ?? "the other person"}'s turn to finish.`
        : stopped
          ? `Tell ${agent} what to do next`
          : `Message ${agent}`;
  const announcement = outbox.announcement;
  // What every card's input shares: the field, the draft it writes, attach and the model menu.
  const prompt: PromptBase = {
    id: messageInputId(session.id),
    size,
    label: `Message ${agent}`,
    value: draft.text,
    onValueChange: (text) => draft.write({ text, key: draft.key }),
    blocked: scope === null || busyAttaching,
    onAttach: () => files.current?.click(),
    harness: agent,
    ...(selection === null || (session.harness !== "claude" && session.harness !== "codex")
      ? {}
      : {
          model: (
            <NextTurnMenu
              harness={session.harness}
              selection={selection}
              onPick={setPicked}
              size={size}
            />
          ),
        }),
  };

  return (
    <div
      onPaste={(event) => {
        const images = imagesOf(event.clipboardData.files);
        if (images.length === 0) return;
        event.preventDefault();
        void attachImages(images);
      }}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.items).some((item) => item.type.startsWith("image/")))
          event.preventDefault();
      }}
      onDrop={(event) => {
        const images = imagesOf(event.dataTransfer.files);
        if (images.length === 0) return;
        event.preventDefault();
        void attachImages(images);
      }}
    >
      <ComposerCard className="max-lg:max-w-none">
        {waiting !== undefined && askOf(waiting).kind === "question" ? (
          <QuestionComposer
            key={waiting.id}
            request={waiting}
            facts={facts}
            base={prompt}
            size={size}
          />
        ) : waiting !== undefined ? (
          <ApprovalComposer
            key={waiting.id}
            request={waiting}
            facts={facts}
            conversation={conversation}
            base={prompt}
            size={size}
            sendWords={send}
          />
        ) : heldCall !== undefined ? (
          <ExecutorApprovalComposer
            key={heldCall.id}
            call={heldCall}
            facts={facts}
            base={prompt}
            size={size}
            sendWords={send}
          />
        ) : (
          <>
            {elsewhere === undefined ? null : (
              <AnsweredElsewhere
                request={elsewhere}
                facts={facts}
                hasWords={draft.text.trim() !== ""}
                size={size}
                onDismiss={() => setWatched(null)}
              />
            )}
            <PromptInput
              {...prompt}
              state={own === null ? "default" : "running"}
              placeholder={placeholder}
              onSubmit={send}
              onSteer={send}
              onStop={() => interrupt.mutate({ turnId: own?.id ?? "" })}
              stopping={interrupt.isPending}
            />
          </>
        )}
      </ComposerCard>
      <input
        ref={files}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const chosen = event.target.files === null ? [] : imagesOf(event.target.files);
          event.target.value = "";
          void attachImages(chosen);
        }}
      />
      {scope === null ? (
        <ComposerLine>Checking who is signed in…</ComposerLine>
      ) : keyless ? (
        <ComposerLine tone="alert">
          This browser couldn't make a key for the message, so it wasn't sent.
        </ComposerLine>
      ) : attaching === "uploading" ? (
        <ComposerLine>Attaching the image…</ComposerLine>
      ) : attaching === "resuming" ? (
        <ComposerLine>Resuming the session to attach the image…</ComposerLine>
      ) : typeof attaching === "object" ? (
        <ComposerLine tone="alert">{attaching.failed}</ComposerLine>
      ) : interrupt.isError ? (
        <ComposerLine tone="alert">
          The turn didn't stop. {failureWords(interrupt.error, "")} Press Stop turn to try again.
        </ComposerLine>
      ) : resumes ? (
        <ComposerLine>Sending resumes the session.</ComposerLine>
      ) : null}
      {outbox.inMemoryOnly ? (
        <ComposerLine tone="alert">
          This browser's storage is full. Messages on their way are kept in this tab only until they
          are sent.
        </ComposerLine>
      ) : null}
      {/* Every send's outcome is said as it settles. Always rendered, so screen readers hear what
          is put in them. */}
      <p role="status" className="sr-only">
        {announcement !== null && !announcement.urgent ? announcement.words : ""}
      </p>
      <p role="alert" className="sr-only">
        {announcement !== null && announcement.urgent ? announcement.words : ""}
      </p>
    </div>
  );
}

/**
 * The composer of a session whose imported conversation waits for its first message: Send starts
 * the agent in conversation mode on that conversation, the words its first turn
 * (`lib/first-message`). The words are kept as the session's message draft; one the server
 * refused goes back into the field with its words under it.
 */
function FirstMessageComposer({
  facts,
  size,
}: {
  readonly facts: SessionFacts;
  readonly size: Size;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { session, agent } = facts;
  const userId = useMessageOwner();
  const draft = useMessageDraft(userId === null ? null : { userId, sessionId: session.id });
  const start = useMutation({
    mutationFn: (words: string) =>
      sendFirstMessage(
        (request) => launchFirstMessage(session.id, request),
        words,
        session.settledAt,
      ),
    onSuccess: (outcome: FirstMessageOutcome, words) => {
      if (outcome._tag === "Started") return;
      // Not taken: the words go back, unless something new was written meanwhile.
      if (draft.text.trim() === "") draft.write({ text: words, key: null });
    },
    // Started, or maybe started: the page reads the session again. A refusal leaves it as it is.
    onSettled: (outcome) => {
      if (outcome?._tag !== "Refused")
        void queryClient.invalidateQueries(trpc.sessions.pathFilter());
    },
  });
  const outcome = start.data ?? null;
  return (
    <div>
      <ComposerCard className="max-lg:max-w-none">
        <PromptInput
          id={messageInputId(session.id)}
          size={size}
          label={`First message to ${agent}`}
          placeholder={`Message ${agent}`}
          value={draft.text}
          onValueChange={(text) => draft.write({ text, key: null })}
          onSubmit={(words) => start.mutate(words)}
          blocked={userId === null || start.isPending}
          harness={agent}
        />
      </ComposerCard>
      {userId === null ? (
        <ComposerLine>Checking who is signed in…</ComposerLine>
      ) : start.isPending ? (
        <ComposerLine>Starting {agent}…</ComposerLine>
      ) : start.isError ? (
        <ComposerLine tone="alert">
          {failureWords(start.error, FIRST_MESSAGE_UNCONFIRMED)}
        </ComposerLine>
      ) : outcome?._tag === "Refused" ? (
        <ComposerLine tone="alert">{outcome.words}</ComposerLine>
      ) : outcome?._tag === "Unconfirmed" ? (
        <ComposerLine tone="alert">{FIRST_MESSAGE_UNCONFIRMED}</ComposerLine>
      ) : (
        <ComposerLine>Sending starts {agent} on the imported conversation.</ComposerLine>
      )}
    </div>
  );
}
