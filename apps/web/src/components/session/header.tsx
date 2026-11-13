import { boatKeyLine, captureDiscardOffered, sessionModelLine } from "@mend/domain/workbench";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Button, focusRing, IconButton, touchTarget } from "#/components/kit/button";
import { Field, TextInput } from "#/components/kit/field";
import { Icon } from "#/components/kit/icons";
import { Menu, MenuItem, MenuSeparator } from "#/components/kit/menu";
import { ModalDialog } from "#/components/kit/modal";
import { IconSegment } from "#/components/kit/segment";
import { Dot, StatusWord } from "#/components/kit/status";
import {
  SegmentTabLine,
  SegmentTabLink,
  UnderlineTabLine,
  UnderlineTabLink,
} from "#/components/kit/tab-line";
import { Facts, InfoPopover } from "#/components/kit/tip";
import {
  agentIsLive,
  checkpointSession,
  discardUnsavedAndStop,
  removeSession,
  sessionCaptureLine,
  setSessionLabel,
  stopSession,
  stopSessionServices,
  type SessionDetailDto,
} from "#/lib/api";
import { failureWords } from "#/lib/refusal";
import { sessionDetailQuery } from "#/lib/session-queries";
import {
  FULL_SCREEN_TABS,
  SESSION_LAYOUTS,
  SESSION_TABS,
  type SessionLayout,
  sessionLayout,
  type SessionTab,
  WORK_TABS,
} from "#/lib/session-view";
import { useTRPC } from "#/lib/trpc";
import { ownerLine } from "#/lib/viewer";

import { ExecutorFact } from "./executor";
import type { SessionFacts } from "./facts";
import { SharedControl } from "./shared-control";

const errorWords = (cause: unknown) => failureWords(cause, "Mend could not do that.");

type HeaderFailure = { readonly action: "stop" | "other"; readonly words: string } | null;

const stopObserved = (detail: SessionDetailDto): boolean =>
  detail.session.status === "stopping" || !agentIsLive(detail.session, detail.currentAgent);

/**
 * The session's one header line (screen P1): its status dot, title and project. Hovering or
 * focusing the title opens the details: branch, agent, workspace, who started it and who steers.
 */
export function SessionTitle({
  facts,
  compact = false,
}: {
  readonly facts: SessionFacts;
  readonly compact?: boolean;
}) {
  const { session, control, names } = facts;
  const modelLine = sessionModelLine(null, session);
  const captureLine = sessionCaptureLine(session);
  const owner = ownerLine(session, control.own, names);
  const steers =
    session.ownerUserId === null
      ? "nobody · the session has no owner"
      : session.sharedControlEnabledAt !== null
        ? "everyone who can see the project · shared control on"
        : control.own
          ? "only you"
          : facts.ownerName === null
            ? "its owner"
            : `only ${facts.ownerName}`;
  return (
    <h1 className="flex min-w-0 items-center">
      <InfoPopover
        openOnHover
        label="Session details"
        trigger={
          <button
            type="button"
            className={cn(
              "flex min-w-0 items-center gap-2.5 rounded-lg text-left",
              touchTarget,
              focusRing,
            )}
          >
            <Dot tone={facts.status.tone} />
            <span className="sr-only">{facts.status.word}: </span>
            <span className="truncate font-display text-[18px] leading-tight font-semibold tracking-[-0.02em]">
              {facts.title}
            </span>
            {compact || facts.project === null ? null : (
              <span className="shrink-0 font-mono text-[11.5px] font-normal text-faint max-md:hidden">
                {facts.project.name}
              </span>
            )}
          </button>
        }
      >
        <Facts
          rows={[
            { term: "Status", value: facts.status.word },
            { term: "Branch", value: session.branch },
            {
              term: "Agent",
              value: modelLine === null ? facts.agent : `${facts.agent} · ${modelLine}`,
            },
            {
              term: "Workspace",
              value: `${session.worktree} · base ${
                session.baseRef === null
                  ? session.baseSha.slice(0, 12)
                  : `${session.baseRef} @ ${session.baseSha.slice(0, 7)}`
              }`,
            },
            {
              term: "Started by",
              value: [
                control.own ? "you" : (facts.ownerName ?? "nobody"),
                session.origin === "slack" ? "from Slack" : null,
                session.startedAt === null ? null : session.startedAt.toLocaleString(),
              ]
                .filter((part) => part !== null)
                .join(" · "),
            },
            { term: "Who steers", value: steers },
            // Which key the workspace was created on (SLNT-797): steering never moves it.
            ...(session.boatKey === null
              ? []
              : [
                  {
                    term: "Runs on",
                    value: boatKeyLine(
                      session.boatKey,
                      control.own
                        ? "your"
                        : facts.ownerName === null
                          ? "its owner's"
                          : `${facts.ownerName}'s`,
                    ),
                  },
                ]),
            { term: "Executor", value: <ExecutorFact sessionId={session.id} /> },
            ...(owner === null ? [] : [{ term: "Ownership", value: owner }]),
            ...(captureLine === null ? [] : [{ term: "Saving", value: captureLine }]),
          ]}
        />
      </InfoPopover>
    </h1>
  );
}

/** Share: shared control, the owner's switch (docs/adr/0003); everyone else reads who steers. */
function ShareButton({ facts }: { readonly facts: SessionFacts }) {
  const { session } = facts;
  if (!sharesFrom(facts)) return null;
  return (
    <InfoPopover
      label="Share this session"
      align="end"
      className="w-[380px]"
      trigger={
        // A phone has no room for it on the header line: More holds it there.
        <Button
          size="sm"
          aria-pressed={session.sharedControlEnabledAt !== null}
          className="max-md:hidden"
        >
          Share
        </Button>
      }
    >
      <SessionSharing facts={facts} />
    </InfoPopover>
  );
}

/** Whether this person may turn shared control on or off here. */
const sharesFrom = (facts: SessionFacts): boolean =>
  facts.control.own || facts.control.toggleSharedControl;

function SessionSharing({ facts }: { readonly facts: SessionFacts }) {
  const { session, control } = facts;
  return (
    <SharedControl
      sessionId={session.id}
      ownerSteers={control.own}
      shared={session.sharedControlEnabledAt !== null}
      canToggle={control.toggleSharedControl}
      turnsOnSendersLogin={control.turnsOnSendersLogin}
      steer={control.steer}
      ownerName={facts.names === undefined ? undefined : facts.ownerName}
    />
  );
}

/**
 * Stop while the agent is live. Resume sits in the middle of the stopped screen, on the Screen tab,
 * and sending a message resumes the session anywhere else.
 */
function StopButton({
  facts,
  onError,
}: {
  readonly facts: SessionFacts;
  readonly onError: (words: string | null) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const stop = useMutation({
    mutationFn: () => stopSession(facts.session.id),
    onMutate: () => onError(null),
    onError: async (cause) => {
      // A lost response says nothing about whether the server accepted Stop. Bypass the fresh
      // detail cached before the click, and let subsequent session events resolve uncertainty.
      const detail = await queryClient
        .fetchQuery({ ...sessionDetailQuery(trpc, facts.session.id), staleTime: 0, retry: false })
        .catch(() => null);
      onError(
        detail !== null && stopObserved(detail)
          ? null
          : `Mend could not confirm the stop. ${errorWords(cause)}`,
      );
    },
    onSettled: () => queryClient.invalidateQueries(trpc.sessions.pathFilter()),
  });
  if (!facts.agentLive || !facts.control.stop) return null;
  const stopping = stop.isPending || facts.session.status === "stopping";
  return (
    <Button size="sm" disabled={stopping} onClick={() => stop.mutate()}>
      {stopping ? "Stopping…" : "Stop"}
    </Button>
  );
}

type Confirm = "share" | "rename" | "discard" | "delete" | null;

/** The session's quieter actions, each with its own confirmation where it cannot be undone. */
function MoreActions({
  facts,
  onError,
}: {
  readonly facts: SessionFacts;
  readonly onError: (words: string | null) => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { session, control, detail } = facts;
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [label, setLabel] = useState("");
  const settle = () => queryClient.invalidateQueries(trpc.sessions.pathFilter());
  const fail = (what: string) => (cause: unknown) => onError(`${what} ${errorWords(cause)}`);
  const checkpoint = useMutation({
    mutationFn: () => checkpointSession(session.id, "user-mark"),
    onMutate: () => onError(null),
    onError: fail("The checkpoint was not taken."),
    onSettled: settle,
  });
  const stopServices = useMutation({
    mutationFn: () => stopSessionServices(session.id),
    onMutate: () => onError(null),
    onError: fail("The services did not stop."),
    onSettled: settle,
  });
  const rename = useMutation({
    mutationFn: (next: string | null) => setSessionLabel(session.id, next),
    onSuccess: () => setConfirm(null),
    onSettled: settle,
  });
  const discard = useMutation({
    mutationFn: () => discardUnsavedAndStop(session.id),
    onSuccess: () => setConfirm(null),
    onSettled: settle,
  });
  const remove = useMutation({
    mutationFn: () => removeSession(session.id),
    onSuccess: (report) => {
      void queryClient.invalidateQueries();
      if (report.removed) {
        void navigate({ to: "/" });
        return;
      }
      setConfirm(null);
      // The row goes after its workspace: a removal asked mid-drain says what it waits on.
      onError(report.leftover);
    },
  });
  const servicesLive = detail.liveServices > 0 && control.stop;
  const discardShows = captureDiscardOffered(session) && control.own;
  const deleteShows = !facts.agentLive && control.own;
  return (
    <>
      <Menu
        align="end"
        width={230}
        trigger={<IconButton icon="more" label="More session actions" bordered />}
      >
        {sharesFrom(facts) ? (
          <MenuItem className="md:hidden" onClick={() => setConfirm("share")}>
            Share…
          </MenuItem>
        ) : null}
        {control.own ? (
          <MenuItem
            onClick={() => {
              setLabel(session.label ?? "");
              rename.reset();
              setConfirm("rename");
            }}
          >
            Rename…
          </MenuItem>
        ) : null}
        <MenuItem disabled={checkpoint.isPending} onClick={() => checkpoint.mutate()}>
          {checkpoint.isPending ? "Marking a checkpoint…" : "Mark a checkpoint"}
        </MenuItem>
        {servicesLive ? (
          <MenuItem disabled={stopServices.isPending} onClick={() => stopServices.mutate()}>
            {stopServices.isPending ? "Stopping services…" : "Stop services"}
          </MenuItem>
        ) : null}
        {discardShows || deleteShows ? <MenuSeparator /> : null}
        {discardShows ? (
          <MenuItem onClick={() => setConfirm("discard")}>Discard unsaved and stop…</MenuItem>
        ) : null}
        {deleteShows ? (
          <MenuItem onClick={() => setConfirm("delete")} className="text-danger">
            Delete session…
          </MenuItem>
        ) : null}
      </Menu>
      <ModalDialog
        open={confirm === "share"}
        onOpenChange={(open) => setConfirm(open ? "share" : null)}
        title="Share this session"
        width={420}
        footer={
          <Button variant="ghost" onClick={() => setConfirm(null)}>
            Done
          </Button>
        }
      >
        <SessionSharing facts={facts} />
      </ModalDialog>
      <ModalDialog
        open={confirm === "rename"}
        onOpenChange={(open) => setConfirm(open ? "rename" : null)}
        title="Rename this session"
        width={460}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="session-rename"
              disabled={rename.isPending}
            >
              {rename.isPending ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        <form
          id="session-rename"
          onSubmit={(event) => {
            event.preventDefault();
            const next = label.trim();
            rename.mutate(next === "" ? null : next);
          }}
        >
          <Field label="Name">
            {(id) => (
              <TextInput
                id={id}
                autoFocus
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="What this session is about"
              />
            )}
          </Field>
          <p className="text-[12.5px] text-muted-foreground">
            Empty goes back to the worktree&apos;s name.
          </p>
          {rename.isError ? (
            <p role="alert" className="mt-2 text-[13px] text-danger">
              {errorWords(rename.error)}
            </p>
          ) : null}
        </form>
      </ModalDialog>
      <ModalDialog
        open={confirm === "discard"}
        onOpenChange={(open) => setConfirm(open ? "discard" : null)}
        title="Discard what is not saved?"
        description="The workspace stops now, with captures still pending. What it has not saved is gone once it stops."
        width={480}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Keep saving
            </Button>
            <Button disabled={discard.isPending} onClick={() => discard.mutate()}>
              {discard.isPending ? "Discarding…" : "Discard and stop"}
            </Button>
          </>
        }
      >
        {discard.isError ? (
          <p role="alert" className="text-[13px] text-danger">
            {errorWords(discard.error)}
          </p>
        ) : null}
      </ModalDialog>
      <ModalDialog
        open={confirm === "delete"}
        onOpenChange={(open) => setConfirm(open ? "delete" : null)}
        title="Delete this session?"
        description="The session goes from every list. Its worktree, its change and its checkpoints stay."
        width={480}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Keep it
            </Button>
            <Button disabled={remove.isPending} onClick={() => remove.mutate()}>
              {remove.isPending ? "Deleting…" : "Delete session"}
            </Button>
          </>
        }
      >
        {remove.isError ? (
          <p role="alert" className="text-[13px] text-danger">
            {errorWords(remove.error)}
          </p>
        ) : null}
      </ModalDialog>
    </>
  );
}

/** The three-state layout control and the full-screen button beside it. */
export function LayoutControls({
  sessionId,
  tab,
  layout,
}: {
  readonly sessionId: string;
  readonly tab: SessionTab;
  readonly layout: SessionLayout;
}) {
  const navigate = useNavigate();
  return (
    <>
      <IconSegment
        label="Layout"
        value={layout}
        options={SESSION_LAYOUTS}
        onChange={(next) => {
          sessionLayout.set(next);
          // The split view's conversation sits beside the work, so the work panel opens on Change.
          if (next === "split" && tab === "conversation")
            void navigate({ to: "/sessions/$sessionId/change", params: { sessionId } });
        }}
      />
      <FullScreenLink full={false} />
    </>
  );
}

/**
 * On a phone, the way from a session back to the inbox, which kept its place: a link, so it is
 * the router's own navigation and nothing reloads.
 */
export function BackToSessions() {
  return (
    <Link
      to="/"
      aria-label="Back to sessions"
      title="Back to sessions"
      className={cn(
        "-ml-1.5 grid size-11 shrink-0 place-items-center rounded-[10px] text-ink-2 transition-colors hover:bg-secondary hover:text-foreground md:hidden",
        focusRing,
      )}
    >
      <Icon name="chevronLeft" size={20} />
    </Link>
  );
}

/** Full screen and back, as a link: Back returns from it, and `f` or Esc do the same. */
export function FullScreenLink({ full }: { readonly full: boolean }) {
  return (
    <Link
      to="."
      from="/sessions/$sessionId"
      search={({ full: _open, ...rest }) => (full ? rest : { ...rest, full: true })}
      aria-label={full ? "Exit full screen (Esc)" : "Full screen (f)"}
      title={full ? "Exit full screen (Esc)" : "Full screen (f)"}
      className={cn(
        "grid size-[30px] shrink-0 place-items-center rounded-[9px] border border-rule bg-panel text-ink-2 shadow-xs transition-colors hover:text-foreground",
        touchTarget,
        focusRing,
      )}
    >
      <Icon name={full ? "exitFullScreen" : "fullScreen"} size={15} />
    </Link>
  );
}

/** What a tab carries after its name: the change's size, the screen's live dot. */
function TabExtra({ facts, tab }: { readonly facts: SessionFacts; readonly tab: SessionTab }) {
  const trpc = useTRPC();
  const changeId = facts.detail.change?.id ?? null;
  const stats = useQuery({
    ...trpc.changes.stats.queryOptions({ id: changeId ?? "" }, { staleTime: 30_000 }),
    enabled: tab === "change" && changeId !== null,
  });
  if (tab === "change" && stats.data !== undefined && stats.data.files > 0)
    return (
      <span className="font-mono text-[11px] font-normal">
        <span className="text-success">+{stats.data.additions}</span>{" "}
        <span className="text-danger">−{stats.data.deletions}</span>
        <span className="sr-only">
          {" "}
          ({stats.data.additions} lines added, {stats.data.deletions} removed)
        </span>
      </span>
    );
  return null;
}

/** The Screen tab's name, led by a live dot while the agent has a screen. */
function ScreenLabel({ facts }: { readonly facts: SessionFacts }) {
  const live = facts.screen?.life._tag === "Live";
  return (
    <>
      {live ? <Dot tone="run" /> : null}
      Screen
      {live ? <span className="sr-only"> (live)</span> : null}
    </>
  );
}

/** The underlined tab line under the header (screens P and C); on a phone it scrolls sideways. */
export function SessionTabs({ facts }: { readonly facts: SessionFacts }) {
  return (
    <UnderlineTabLine label="Session" className="mt-3 max-md:mt-1 max-md:gap-4">
      {SESSION_TABS.map((entry) => (
        <UnderlineTabLink
          key={entry.tab}
          to={entry.to}
          params={{ sessionId: facts.session.id }}
          search={true}
          activeOptions={{ exact: true, includeSearch: false }}
        >
          {entry.tab === "screen" ? <ScreenLabel facts={facts} /> : entry.label}
          <TabExtra facts={facts} tab={entry.tab} />
        </UnderlineTabLink>
      ))}
    </UnderlineTabLine>
  );
}

/** The work panel's tab line in the split view (screens X1 to X5): every tab but Conversation. */
export function WorkTabs({ facts }: { readonly facts: SessionFacts }) {
  return (
    <SegmentTabLine label="Session work">
      {WORK_TABS.map((entry) => (
        <SegmentTabLink
          key={entry.tab}
          to={entry.to}
          params={{ sessionId: facts.session.id }}
          search={true}
          activeOptions={{ exact: true, includeSearch: false }}
        >
          {entry.tab === "screen" ? <ScreenLabel facts={facts} /> : entry.label}
          <TabExtra facts={facts} tab={entry.tab} />
        </SegmentTabLink>
      ))}
    </SegmentTabLine>
  );
}

/** A header action that failed, said under the header until the next one. */
function HeaderError({
  failure,
  facts,
}: {
  readonly failure: HeaderFailure;
  readonly facts: SessionFacts;
}) {
  return failure === null || (failure.action === "stop" && stopObserved(facts.detail)) ? null : (
    <p role="alert" className="mt-2 font-mono text-[11.5px] text-danger">
      {failure.words}
    </p>
  );
}

/** The header of the windowed layouts (screens P and C): title, actions, layout, tab line. */
export function SessionHeader({
  facts,
  tab,
  layout,
}: {
  readonly facts: SessionFacts;
  readonly tab: SessionTab;
  readonly layout: SessionLayout;
}) {
  const [error, setError] = useState<HeaderFailure>(null);
  return (
    <header className="px-6 pt-3.5 max-md:px-3 max-md:pt-1.5">
      <div className="flex min-w-0 items-center gap-2.5 max-md:gap-2">
        <BackToSessions />
        <SessionTitle facts={facts} />
        <span className="flex-1" />
        <ShareButton facts={facts} />
        <StopButton
          facts={facts}
          onError={(words) => setError(words === null ? null : { action: "stop", words })}
        />
        <MoreActions
          facts={facts}
          onError={(words) => setError(words === null ? null : { action: "other", words })}
        />
        {/* A phone shows one pane, full width: no layouts to pick from. */}
        <span className="flex items-center gap-2.5 max-md:hidden">
          <LayoutControls sessionId={facts.session.id} tab={tab} layout={layout} />
        </span>
      </div>
      <HeaderError failure={error} facts={facts} />
      <SessionTabs facts={facts} />
    </header>
  );
}

/** The split view's conversation header (screens X1 to X5): title, Stop, layout. */
export function SplitHeader({
  facts,
  tab,
}: {
  readonly facts: SessionFacts;
  readonly tab: SessionTab;
}) {
  const [error, setError] = useState<HeaderFailure>(null);
  return (
    <header className="border-b border-rule px-6 pt-3.5 pb-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <SessionTitle facts={facts} compact />
        <span className="flex-1" />
        <StopButton
          facts={facts}
          onError={(words) => setError(words === null ? null : { action: "stop", words })}
        />
        <MoreActions
          facts={facts}
          onError={(words) => setError(words === null ? null : { action: "other", words })}
        />
        <LayoutControls sessionId={facts.session.id} tab={tab} layout="split" />
      </div>
      <HeaderError failure={error} facts={facts} />
    </header>
  );
}

/**
 * The full-screen top bar (screens X6 and X7): where, what, the tab line, Share and the way out.
 * On a phone the tab line takes a row of its own and scrolls sideways.
 */
export function FullScreenBar({ facts }: { readonly facts: SessionFacts }) {
  return (
    <header className="flex items-center gap-[22px] border-b border-rule px-6 py-3.5 max-md:flex-wrap max-md:gap-x-3 max-md:gap-y-2 max-md:px-3 max-md:py-2">
      <Link to="/" aria-label="Mend · sessions" className={cn("rounded-[9px]", focusRing)}>
        <span
          aria-hidden="true"
          className="grid size-[30px] place-items-center rounded-[9px] bg-foreground font-display text-[16px] font-bold text-background"
        >
          m
        </span>
      </Link>
      <span className="flex min-w-0 items-center gap-2 font-sans text-[13px] font-medium text-muted-foreground max-md:flex-1">
        <span className="shrink-0 max-md:hidden">{facts.project?.name ?? "project"}</span>
        <span aria-hidden="true" className="text-faint max-md:hidden">
          /
        </span>
        <SessionTitleText facts={facts} />
      </span>
      <StatusWord tone={facts.status.tone}>{facts.status.word}</StatusWord>
      <span className="flex-1 max-md:hidden" />
      <SegmentTabLine
        label="Session"
        className="max-md:order-last max-md:w-full max-md:overflow-x-auto"
      >
        {FULL_SCREEN_TABS.map((entry) => (
          <SegmentTabLink
            key={entry.tab}
            to={entry.to}
            params={{ sessionId: facts.session.id }}
            search={true}
            activeOptions={{ exact: true, includeSearch: false }}
          >
            {entry.tab === "screen" ? <ScreenLabel facts={facts} /> : entry.label}
            <TabExtra facts={facts} tab={entry.tab} />
          </SegmentTabLink>
        ))}
      </SegmentTabLine>
      <ShareButton facts={facts} />
      <FullScreenLink full />
    </header>
  );
}

function SessionTitleText({ facts }: { readonly facts: SessionFacts }) {
  return <h1 className="truncate font-medium text-foreground">{facts.title}</h1>;
}
