import { sharedControlLine } from "@mend/domain/workbench";
import { Banner } from "@mend/ui/components/banner";
import { ConversationItem } from "@mend/ui/components/conversation";
import { ConversationMarker } from "@mend/ui/components/conversation-marker";
import { CopyField } from "@mend/ui/components/copy-field";
import { Button } from "@mend/ui/components/ui/button";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ClockIcon,
  EyeIcon,
  HandIcon,
  LockIcon,
  MessageSquareIcon,
  ToggleLeftIcon,
  SquareTerminalIcon,
  UserXIcon,
  UsersIcon,
} from "lucide-react";
import { type ReactNode, useState, useSyncExternalStore } from "react";

import { AGENT_FACTS, type Agent, agentLoginState, connectCommand } from "#/lib/agent-login";
import { type ConversationWaitWorkDto, endBackgroundWork } from "#/lib/api";
import { readDraft, subscribeDrafts } from "#/lib/drafts";
import { draftItems, type MessageScope, useMessageOwner } from "#/lib/outbox";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import { controlRow, sharedControlWords } from "#/lib/session-details";
import { messageTime } from "#/lib/session-sheet";
import { harnessName } from "#/lib/session-view";
import {
  type Band,
  type BandAct,
  type BandIcon,
  canEndWaitingWork,
  type ControlMarker,
  grantDialog,
  type LoginHold,
  loginBand,
  parseLoginHold,
  type SharedControlView,
  sharedControlBands,
  stepRefusalWords,
  type TurnOffStep,
  turnOffItems,
  turnOffSteps,
  waitingLineQuery,
} from "#/lib/shared-control";
import { type TrpcClient, useTRPC, useTRPCClient } from "#/lib/trpc";
import { useSecond } from "#/lib/use-second";

import { Overlay } from "../projects/overlay.tsx";
import type { SessionFacts } from "./session-facts.ts";

/**
 * Shared control on a session's sheet (docs/adr/0026, decision 7; Doop page 6 "Working with
 * others"). Bands over the conversation say whose session it is and where shared control stands,
 * with what the viewer may do about it: ask for it, cancel the request, turn it on for the person
 * who asked or dismiss the request, turn it off. A message the server refused for the sender's own
 * agent login says so in a band of its own, with how to connect it again.
 */

/** The session's shared control, as the server reads it for the viewer. */
export const useSharedControl = (sessionId: string) => {
  const trpc = useTRPC();
  return useQuery(trpc.sessions.sharedControl.queryOptions({ id: sessionId }));
};

const BAND_ICONS: Readonly<Record<BandIcon, ReactNode>> = {
  watching: <EyeIcon className="text-info!" />,
  asked: <ClockIcon className="text-info!" />,
  hand: <HandIcon className="text-info!" />,
  shared: <UsersIcon className="text-success!" />,
};

const MARKER_ICONS: Readonly<Record<ControlMarker["icon"], ReactNode>> = {
  hand: <HandIcon aria-hidden className="size-3.5 shrink-0" />,
  shared: <UsersIcon aria-hidden className="size-3.5 shrink-0" />,
  off: <UserXIcon aria-hidden className="size-3.5 shrink-0" />,
  terminal: <SquareTerminalIcon aria-hidden className="size-3.5 shrink-0" />,
};

/** A shared control marker's line in the conversation: its icon, what happened and when. */
export function ControlMarkerLabel({ marker }: { readonly marker: ControlMarker }) {
  return (
    <span className="flex items-start gap-2">
      <span className="flex h-lh items-center">{MARKER_ICONS[marker.icon]}</span>
      <span>
        {marker.label} · {messageTime(new Date(marker.at), new Date())}
      </span>
    </span>
  );
}

/** Read again what a step moved: the read itself, the session (who steers), the inbox. */
const afterStep = (queryClient: QueryClient, trpc: ReturnType<typeof useTRPC>) =>
  queryClient.invalidateQueries(trpc.sessions.pathFilter());

/** Run the steps that turn shared control off, one after another. */
export const runTurnOff = async (
  client: TrpcClient,
  sessionId: string,
  steps: ReadonlyArray<TurnOffStep>,
): Promise<void> => {
  for (const step of steps) {
    if (step.kind === "everyone-off")
      await client.sessions.setSharedControl.mutate({ id: sessionId, enabled: false });
    else await client.sessions.takeBackSharedControl.mutate({ id: sessionId, userId: step.userId });
  }
};

/**
 * Turn shared control off from a menu: the menu is gone by the time it answers, so a refusal is
 * said in a toast.
 */
export const useTurnOffFromMenu = () => {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  return (
    sessionId: string,
    steps: ReadonlyArray<TurnOffStep>,
    nameOf: (userId: string) => string | null,
  ) =>
    void runTurnOff(client, sessionId, steps)
      .then(() => toast.add({ description: "Shared control is off.", priority: "low" }))
      .catch((cause: unknown) =>
        toast.add({
          title: "Shared control is still on.",
          description: stepRefusalWords(
            cause,
            nameOf,
            steps[0]?.kind === "take-back" ? steps[0].userId : null,
          ),
          type: "error",
          priority: "high",
        }),
      )
      .finally(() => void afterStep(queryClient, trpc));
};

/** One band, inline on a desktop and stacked under 1024px. */
function SharedBand({
  band,
  pending,
  onAct,
  failure,
}: {
  readonly band: Band;
  readonly pending: BandAct["kind"] | null;
  readonly onAct: (act: BandAct) => void;
  readonly failure: string | null;
}) {
  const buttons = (phone: boolean) =>
    band.buttons.length === 0 ? undefined : (
      <>
        {band.buttons.map((button) => (
          <Button
            key={button.act.kind}
            type="button"
            size={phone ? "touch" : "sm"}
            variant={
              button.primary
                ? "default"
                : phone
                  ? "outline"
                  : button.act.kind === "decline"
                    ? "ghost"
                    : "outline"
            }
            className={phone ? "flex-1" : undefined}
            disabled={pending !== null}
            onClick={() => onAct(button.act)}
          >
            {pending === button.act.kind
              ? button.pendingLabel
              : phone
                ? button.phoneLabel
                : button.label}
          </Button>
        ))}
      </>
    );
  const said =
    failure === null ? null : (
      <span role="alert" className="mt-1 block text-destructive">
        {failure}
      </span>
    );
  return (
    <>
      <Banner
        icon={BAND_ICONS[band.icon]}
        title={band.title}
        className="max-lg:hidden"
        actions={buttons(false)}
        data-band={band.key}
      >
        {band.body}
        {said}
      </Banner>
      <Banner
        icon={BAND_ICONS[band.icon]}
        title={band.title}
        layout="stacked"
        className="lg:hidden [&_[data-slot=alert-action]]:flex [&_[data-slot=alert-action]]:gap-2"
        actions={buttons(true)}
        data-band={band.key}
      >
        {band.phoneBody}
        {said}
      </Banner>
    </>
  );
}

/**
 * Shared control's steps for one session, as the bands and the Details view's row offer them: the
 * read, the bands it draws for the viewer, one step at a time, the refusal said where its step was
 * offered, and the Turn on dialog for the person who asked. `bands` is null until the read
 * answers, or if it fails: the composer still says who may write.
 */
const useSharedControlSteps = (facts: SessionFacts) => {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const read = useSharedControl(facts.session.id);
  const [failure, setFailure] = useState<{ readonly band: string; readonly words: string } | null>(
    null,
  );
  const [granting, setGranting] = useState<string | null>(null);
  const step = useMutation({
    mutationFn: async ({ act }: { readonly act: BandAct; readonly band: string }) => {
      const id = facts.session.id;
      switch (act.kind) {
        case "ask":
          return client.sessions.askSharedControl.mutate({ id });
        case "withdraw":
          return client.sessions.withdrawSharedControl.mutate({ id });
        case "grant":
          return client.sessions.grantSharedControl.mutate({ id, userId: act.userId });
        case "decline":
          return client.sessions.declineSharedControl.mutate({ id, userId: act.userId });
        case "turn-off": {
          const view = read.data;
          if (view !== undefined) await runTurnOff(client, id, turnOffSteps(view));
          return null;
        }
      }
    },
    onMutate: () => setFailure(null),
    onSuccess: (answer) => {
      setGranting(null);
      if (answer !== null)
        queryClient.setQueryData(
          trpc.sessions.sharedControl.queryKey({ id: facts.session.id }),
          answer,
        );
    },
    onError: (cause, { act, band }) =>
      setFailure({
        band,
        words: stepRefusalWords(
          cause,
          facts.nameOf,
          act.kind === "grant" || act.kind === "decline" ? act.userId : null,
        ),
      }),
    onSettled: () => afterStep(queryClient, trpc),
  });
  const view = read.isPending || read.isError ? null : read.data;
  const bands =
    view === null
      ? null
      : sharedControlBands(view, {
          viewerId: facts.viewerId,
          nameOf: facts.nameOf,
          agent: facts.agent,
          projectName: facts.projectName,
          ownerUserId: facts.session.ownerUserId,
          timeOf: (at) => messageTime(at, new Date()),
        });
  return {
    bands,
    /** The step a band's button is running, if any. */
    pending: (band: string): BandAct["kind"] | null =>
      step.isPending && step.variables.band === band ? step.variables.act.kind : null,
    failure: (band: string): string | null => (failure?.band === band ? failure.words : null),
    /** Turn on opens its dialog first; every other step runs at once. */
    act: (act: BandAct, band: string) => {
      if (act.kind === "grant") setGranting(act.userId);
      else step.mutate({ act, band });
    },
    overlay:
      view === null ? null : (
        <GrantOverlay
          facts={facts}
          view={view}
          askerId={granting}
          pending={step.isPending && step.variables.act.kind === "grant"}
          failure={
            granting === null ? null : failure?.band === `ask:${granting}` ? failure.words : null
          }
          onCancel={() => {
            if (!step.isPending) setGranting(null);
          }}
          onGrant={(userId) =>
            step.mutate({ act: { kind: "grant", userId }, band: `ask:${userId}` })
          }
        />
      ),
  };
};

/**
 * The bands over a session's conversation about its shared control, each only when there is
 * something to say.
 */
export function SharedControlBands({ facts }: { readonly facts: SessionFacts }) {
  const steps = useSharedControlSteps(facts);
  if (steps.bands === null) return null;
  return (
    <>
      {steps.bands.map((band) => (
        <SharedBand
          key={band.key}
          band={band}
          pending={steps.pending(band.key)}
          failure={steps.failure(band.key)}
          onAct={(act) => steps.act(act, band.key)}
        />
      ))}
      {steps.overlay}
    </>
  );
}

/**
 * Shared control in the Details view's line for the session (docs/adr/0026, decision 5): who
 * holds it, and the same steps the bands over the conversation offer. Shared control goes to the
 * person who asked, so the switch for everyone is only ever turned off here.
 */
export function SharedControlRow({ facts }: { readonly facts: SessionFacts }) {
  const steps = useSharedControlSteps(facts);
  const phone = usePhone();
  const { session, detail } = facts;
  const owner = session.ownerUserId === facts.viewerId;
  const line = controlRow(session, detail.control, { id: facts.viewerId, nameOf: facts.nameOf });
  return (
    <>
      <p className="text-meta text-muted-foreground">
        {line.kind === "owner"
          ? sharedControlWords(session, facts.viewerId, facts.nameOf)
          : line.line}
      </p>
      {(steps.bands ?? [])
        .filter((band) => band.buttons.length > 0)
        .map((band) => (
          <div key={band.key} className="flex flex-col gap-0.5" data-row-band={band.key}>
            <p className="flex flex-wrap items-baseline gap-x-3 text-meta text-muted-foreground">
              {band.key.startsWith("ask:") || band.key === "asked" ? (
                <span>{band.title}</span>
              ) : null}
              {band.buttons.map((button) => (
                <Button
                  key={button.act.kind}
                  type="button"
                  variant="link"
                  size={phone ? "touch" : "sm"}
                  className="font-medium"
                  disabled={steps.pending(band.key) !== null}
                  onClick={() => steps.act(button.act, band.key)}
                >
                  {steps.pending(band.key) === button.act.kind ? button.pendingLabel : button.label}
                </Button>
              ))}
            </p>
            {steps.failure(band.key) === null ? null : (
              <p role="alert" className="text-meta text-destructive">
                {steps.failure(band.key)}
              </p>
            )}
          </div>
        ))}
      {/* Whose login a steered turn spends (`who-pays`). */}
      {owner ? (
        <p className="text-meta text-muted-foreground">
          {sharedControlLine(detail.control.turnsOnSendersLogin)}
        </p>
      ) : null}
      {steps.overlay}
    </>
  );
}

const ROW_ICONS = {
  people: <UsersIcon aria-hidden className="size-4 text-muted-foreground" />,
  message: <MessageSquareIcon aria-hidden className="size-4 text-muted-foreground" />,
  lock: <LockIcon aria-hidden className="size-4 text-muted-foreground" />,
  toggle: <ToggleLeftIcon aria-hidden className="size-4 text-muted-foreground" />,
} as const;

/** Turn on shared control for the person who asked (Doop "Shared control · turn on dialog"). */
function GrantOverlay({
  facts,
  view,
  askerId,
  pending,
  failure,
  onCancel,
  onGrant,
}: {
  readonly facts: SessionFacts;
  readonly view: SharedControlView;
  readonly askerId: string | null;
  readonly pending: boolean;
  readonly failure: string | null;
  readonly onCancel: () => void;
  readonly onGrant: (userId: string) => void;
}) {
  const phone = usePhone();
  const dialog = grantDialog(view, {
    askerId: askerId ?? "",
    nameOf: facts.nameOf,
    agent: facts.agent,
    projectName: facts.projectName,
    sessionTitle: facts.title,
  });
  return (
    <Overlay
      open={askerId !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={dialog.title}
      description={dialog.description}
      size="md"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            size={phone ? "touch" : "default"}
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size={phone ? "touch" : "default"}
            disabled={pending}
            onClick={() => {
              if (askerId !== null) onGrant(askerId);
            }}
          >
            {pending ? "Turning on…" : "Turn on shared control"}
          </Button>
        </>
      }
    >
      <ul className="flex flex-col">
        {dialog.rows.map((row, at) => (
          <li
            key={row.title}
            className={cn("grid grid-cols-[1rem_1fr] gap-x-4 py-3", at > 0 && "border-t")}
          >
            <span className="flex h-lh items-center">{ROW_ICONS[row.icon]}</span>
            <span className="flex flex-col gap-1">
              <span className="font-semibold text-foreground">{row.title}</span>
              <span className="text-muted-foreground">{row.body}</span>
            </span>
          </li>
        ))}
      </ul>
      {failure === null ? null : (
        <p role="alert" className="text-destructive">
          {failure}
        </p>
      )}
    </Overlay>
  );
}

// ─── The sender's own login ─────────────────────────────────────────────────

/** The refusal kept beside the viewer's draft for this session, if a message waits on a login. */
export const useLoginHold = (scope: MessageScope | null): LoginHold | null => {
  const raw = useSyncExternalStore(
    subscribeDrafts,
    () => (scope === null ? "" : readDraft(draftItems(scope).login)),
    () => "",
  );
  return parseLoginHold(raw);
};

const isAgent = (provider: string): provider is Agent =>
  provider === "claude" || provider === "codex";

/** The provider's agent as people call it: "Claude Code", "Codex". */
export const providerName = (provider: string): string =>
  isAgent(provider) ? AGENT_FACTS[provider].name : harnessName(provider);

/**
 * Whether the login a held message waits on works now, read after it was refused: the `user`
 * event a connected login sends reads the person's logins again (lib/workbench-events.ts).
 */
export const useLoginWorks = (hold: LoginHold | null): boolean => {
  const trpc = useTRPC();
  const identity = useQuery({
    ...trpc.platform.sealantIdentity.queryOptions(),
    enabled: hold !== null,
  });
  if (hold === null || hold.state === "unchosen" || !isAgent(hold.provider)) return false;
  if (identity.isPending || identity.isError || identity.dataUpdatedAt <= hold.at) return false;
  return agentLoginState(identity.data.accounts, hold.provider).kind === "connected";
};

/**
 * The band over a session whose message was refused for the sender's own login (Doop "Shared
 * control · Ada's login expired"), with Connect again… and its dialog ("Ada connects again").
 */
export function LoginBand({ facts }: { readonly facts: SessionFacts }) {
  const userId = useMessageOwner();
  const scope = userId === null ? null : { userId, sessionId: facts.session.id };
  const hold = useLoginHold(scope);
  const [connecting, setConnecting] = useState(false);
  if (hold === null) return null;
  const agentName = providerName(hold.provider);
  const ownerId = facts.session.ownerUserId;
  const words = loginBand(hold, {
    agentName,
    ownerName: ownerId === null ? null : facts.nameOf(ownerId),
    own: ownerId === facts.viewerId,
  });
  const action = (phone: boolean) =>
    words.connect && isAgent(hold.provider) ? (
      <Button
        type="button"
        variant="outline"
        size={phone ? "touch" : "sm"}
        className={phone ? "w-full" : undefined}
        onClick={() => setConnecting(true)}
      >
        {hold.state === "invalid" ? "Connect again…" : `Connect ${agentName}…`}
      </Button>
    ) : undefined;
  return (
    <>
      <Banner tone="error" title={words.title} className="max-lg:hidden" actions={action(false)}>
        {words.body}
      </Banner>
      <Banner
        tone="error"
        layout="stacked"
        title={words.title}
        className="lg:hidden"
        actions={action(true)}
      >
        {words.body}
      </Banner>
      {isAgent(hold.provider) ? (
        <ConnectOverlay
          open={connecting}
          onOpenChange={setConnecting}
          agent={hold.provider}
          again={hold.state === "invalid"}
          ownerName={ownerId === null || ownerId === facts.viewerId ? null : facts.nameOf(ownerId)}
        />
      ) : null}
    </>
  );
}

/** How long the dialog has waited: "6s", "1m 4s". */
const waited = (since: Date, now: Date): string => {
  const seconds = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

/** Connect Claude Code again (Doop "Shared control · Ada connects again"). */
function ConnectOverlay({
  open,
  onOpenChange,
  agent,
  again,
  ownerName,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly agent: Agent;
  readonly again: boolean;
  readonly ownerName: string | null;
}) {
  const phone = usePhone();
  const facts = AGENT_FACTS[agent];
  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      title={again ? `Connect ${facts.name} again` : `Connect ${facts.name}`}
      description={
        again ? `Your ${facts.name} login has expired.` : `You haven't connected ${facts.name} yet.`
      }
      size="sm"
      footer={
        <Button
          type="button"
          variant="outline"
          size={phone ? "touch" : "default"}
          onClick={() => onOpenChange(false)}
        >
          Cancel
        </Button>
      }
    >
      {open ? <ConnectBody agent={agent} ownerName={ownerName} phone={phone} /> : null}
    </Overlay>
  );
}

function ConnectBody({
  agent,
  ownerName,
  phone,
}: {
  readonly agent: Agent;
  readonly ownerName: string | null;
  readonly phone: boolean;
}) {
  const facts = AGENT_FACTS[agent];
  const now = useSecond();
  const [since] = useState(() => new Date());
  return (
    <div className="flex flex-col gap-4">
      <p className="text-foreground">
        On your computer, run this command. It opens {facts.service}'s sign-in in your browser and
        passes the login to Mend when you finish.
      </p>
      <CopyField
        value={connectCommand(agent)}
        label="Copy command"
        size={phone ? "touch" : "default"}
      />
      <p role="status" className="text-row text-muted-foreground">
        Waiting for {facts.name} to connect · {waited(since, now)}
      </p>
      <p className="border-t pt-4 text-row text-muted-foreground">
        Mend sends your message to {ownerName === null ? "the session" : `${ownerName}'s session`}{" "}
        as soon as you're connected. This renews your {facts.name} login everywhere in Mend, not
        only in this session.
      </p>
    </div>
  );
}

/**
 * The "…" menu's Turn off shared control (Doop "Shared control · turn off from the menu"): one
 * item, or one per person when several hold it; none unless the viewer may take it back.
 */
export const useTurnOffItems = (
  sessionId: string,
): ReadonlyArray<{ readonly label: string; readonly onSelect: () => void }> => {
  const trpc = useTRPC();
  const read = useSharedControl(sessionId);
  const members = useQuery(trpc.organization.members.queryOptions(undefined, { retry: false }));
  const turnOff = useTurnOffFromMenu();
  if (read.isPending || read.isError) return [];
  const names =
    members.isPending || members.isError
      ? new Map<string, string>()
      : new Map(members.data.map((member) => [member.userId, member.name]));
  const nameOf = (userId: string) => names.get(userId) ?? null;
  return turnOffItems(read.data, nameOf).map((item) => ({
    label: item.label,
    onSelect: () => turnOff(sessionId, item.steps, nameOf),
  }));
};

/**
 * The waiting line (docs/adr/0016, decision 6; per-person-homes.md `waiting-line`): under shared
 * control, whose work a new sender's turn waits for, with End for each piece the viewer may end
 * (the session's owner, or the person the work runs as). Nothing while no turn waits, and not read
 * at all unless people run as themselves in the workspace and someone besides the owner steers.
 */
export function WaitingLine({ facts }: { readonly facts: SessionFacts }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { session } = facts;
  const reading = waitingLineQuery(session, facts.agentLive);
  const wait = useQuery(
    trpc.sessions.conversationWait.queryOptions({ id: session.id }, { ...reading, retry: false }),
  );
  const end = useMutation({
    mutationFn: (work: ConversationWaitWorkDto) => endBackgroundWork(session.id, work),
    onSettled: () =>
      queryClient.invalidateQueries(trpc.sessions.conversationWait.queryFilter({ id: session.id })),
  });
  // Nothing to say until it is read, or if it can't be: the turns still show.
  if (!reading.enabled || wait.isPending || wait.isError || wait.data === null) return null;
  const waiting = wait.data;
  const endable = canEndWaitingWork({
    viewerId: facts.viewerId,
    ownerUserId: session.ownerUserId,
    runsAs: waiting.runsAs,
    steer: facts.detail.control.steer,
  })
    ? waiting.work.filter((work) => work.endable)
    : [];
  return (
    <ConversationItem messageId="waiting-line">
      <div className="flex flex-col gap-1.5">
        <div role="status">
          <ConversationMarker kind="status" label={waiting.line} />
        </div>
        {endable.length === 0 ? null : (
          <ul aria-label="Work the turn waits for" className="flex flex-col gap-1 pl-4">
            {endable.map((work) => (
              <li key={`${work.kind}:${work.id}`} className="flex items-center gap-3">
                <span className="min-w-0 truncate font-mono text-meta text-muted-foreground">
                  {work.kind} · {work.description ?? work.id}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="max-lg:h-11"
                  aria-label={`End ${work.kind} ${work.description ?? work.id}`}
                  disabled={end.isPending}
                  onClick={() => end.mutate(work)}
                >
                  {end.isPending && end.variables.id === work.id ? "Ending…" : "End"}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {end.isError ? (
          <p role="alert" className="pl-4 text-meta text-destructive">
            {`It didn't end. ${failureWords(end.error, "Try again.")}`}
          </p>
        ) : null}
      </div>
    </ConversationItem>
  );
}
