import { InlineAlert } from "@mend/ui/components/banner";
import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import { ContextMenuContent } from "@mend/ui/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import { Input } from "@mend/ui/components/ui/input";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Columns2Icon,
  EllipsisIcon,
  FolderIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  LinkIcon,
  Maximize2Icon,
  PencilIcon,
  Rows2Icon,
  SquareIcon,
  SquarePenIcon,
  Trash2Icon,
  UserXIcon,
  XIcon,
} from "lucide-react";
import { Fragment, useState } from "react";

import { agentIsLive, type SessionDetailDto } from "#/lib/api";
import { copyTextChecked } from "#/lib/clipboard";
import { activity, age, type InboxRow } from "#/lib/inbox";
import { acceptStop, beginStop, type StopKeys, undoStop } from "#/lib/pending-stops";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import { rowActions } from "#/lib/row-actions";
import { sessionDetailQuery } from "#/lib/session-queries";
import { STATUS_WORDS } from "#/lib/session-sheet";
import {
  actorOf,
  deletedToast,
  offersDelete,
  offersStop,
  type Sentence,
  stoppedToast,
  type StaysRow,
  type StopPreview,
  type StopTarget,
  stopWords,
  whatStays,
} from "#/lib/session-stop";
import { sessionTitleOf } from "#/lib/session-title";
import { type TrpcClient, type TrpcProxy, useTRPC, useTRPCClient } from "#/lib/trpc";
import { useRowActions } from "#/lib/use-row-actions";

import { Overlay } from "../projects/overlay.tsx";
import {
  CONTEXT,
  DROPDOWN,
  MarkItems,
  type MenuParts,
  META,
  PhoneRowActions,
} from "../row-actions.tsx";
import { SheetItem } from "../sheet-item.tsx";
import { useTurnOffItems } from "./shared-control.tsx";

/**
 * A session's own actions and its workspace's (docs/adr/0026, decision 4; Doop "T25 · Session tab
 * menu", "T26 · Conversation tile menu", "T21 · Workspace menu", "Phone · Session actions").
 *
 * A session's status, its age and its own actions (Rename…, Snooze, Mark done, Copy link, Stop
 * session…) are on its tab: the tab's right-click menu and the "…" of the tile that shows it,
 * with what the tile can do to the tab. The workspace's "…" holds the workspace's: New session in
 * this workspace, Copy branch name, Copy worktree path and Land…, which opens the Change view's Land
 * dialog. On a phone, one sheet holds both, the session's first.
 *
 * Rename, snooze, mark done and copy link write through the sidebar row's writers
 * (`useRowActions`), so a change shows in the tab and the sidebar at once.
 */

/** The session a Stop dialog is about (`lib/session-stop.ts`). */
export type { StopTarget };

/** The session a Delete dialog is about, with what stays once it goes. */
export interface DeleteTarget {
  readonly sessionId: string;
  readonly title: string;
  readonly projectName: string;
  readonly stays: ReadonlyArray<StaysRow>;
}

/** The Delete dialog's subject, from the session's detail and its inbox row. */
const deleteTargetOf = (detail: SessionDetailDto, row: InboxRow | null): DeleteTarget => {
  const pullRequest = detail.landings.find((landing) => landing.pullRequest !== null)?.pullRequest;
  return {
    sessionId: detail.session.id,
    title: sessionTitleOf(row, detail.session.label),
    projectName: row?.project.name ?? "",
    stays: whatStays({
      worktreeName: row?.worktreeName ?? detail.session.branch,
      branch: detail.session.branch,
      checkpoints: detail.checkpoints.filter((checkpoint) => checkpoint.ordinal > 0).length,
      pullRequest:
        pullRequest === undefined || pullRequest === null
          ? null
          : `#${pullRequest.number} ${pullRequest.state}`,
    }),
  };
};

/** What a tab's menu can do to the tiles: each left out where it can't. */
export interface TabLayout {
  readonly onMaximise?: () => void;
  readonly onSplit?: (side: "right" | "bottom") => void;
  readonly onClose?: () => void;
}

/** What the sheet gives every session menu: the inbox's row for a session, and the dialogs. */
export interface SessionMenuContext {
  readonly rowOf: (sessionId: string) => InboxRow | null;
  readonly viewerId: string;
  readonly onRename: (row: InboxRow) => void;
  readonly onStop: (target: StopTarget) => void;
  readonly onDelete: (target: DeleteTarget) => void;
}

/** The Stop dialog's subject, from the session's detail and its inbox row. */
export const stopTargetOf = (detail: SessionDetailDto, row: InboxRow | null): StopTarget => ({
  sessionId: detail.session.id,
  title: sessionTitleOf(row, detail.session.label),
  agent: actorOf(detail.session.harness),
  status: detail.session.status,
  turnRunning:
    detail.session.status === "running" && detail.currentAgent?.kind === "agent-protocol",
  branch: detail.session.branch,
  worktreeName: row?.worktreeName ?? detail.session.branch,
  fileCount: row?.annotation?.fileCount ?? null,
});

/** What a session's menu offers it, from its detail (read as the menu opens) and its row. */
const useMenuFacts = (sessionId: string, context: SessionMenuContext) => {
  const trpc = useTRPC();
  const read = useQuery(sessionDetailQuery(trpc, sessionId));
  const detail = read.isPending || read.isError ? null : read.data;
  const row = context.rowOf(sessionId);
  const status = detail?.session.status ?? row?.session.status ?? null;
  return {
    row,
    // The tab's own Stop session… reads the detail (`stop` below), not the row.
    actions: row === null ? null : { ...rowActions(row, context.viewerId), stop: false },
    /** "Waiting on you · 4m": the session's status and how long ago it last moved. */
    label:
      status === null
        ? null
        : row === null
          ? STATUS_WORDS[status]
          : `${STATUS_WORDS[status]} · ${age(new Date(activity(row)), new Date())}`,
    // Offered once the detail says the agent runs and the viewer may stop it.
    stop:
      detail !== null &&
      offersStop(
        agentIsLive(detail.session, detail.currentAgent),
        detail.session.status,
        detail.control.stop,
      )
        ? stopTargetOf(detail, row)
        : null,
    // Offered to the owner once the session is stopped or Done.
    remove:
      detail !== null &&
      offersDelete({
        own: detail.control.own,
        agentLive: agentIsLive(detail.session, detail.currentAgent),
        status: detail.session.status,
        group: row?.group ?? null,
      })
        ? deleteTargetOf(detail, row)
        : null,
    title: sessionTitleOf(row, detail?.session.label),
  };
};

/**
 * A session's items, in the frames' order: its status and age, Rename…, Snooze, Mark done, Copy
 * link; then the tile's (Split right and Split down on the tab, Maximise tile in the tile's "…",
 * Close tab); then Stop session… in red.
 */
function SessionMenuItems({
  parts,
  sessionId,
  where,
  layout,
  context,
}: {
  readonly parts: MenuParts;
  readonly sessionId: string;
  readonly where: "tab" | "tile";
  readonly layout: TabLayout;
  readonly context: SessionMenuContext;
}) {
  const { Group, Label, Item, Separator, Shortcut } = parts;
  const handlers = useRowActions();
  const facts = useMenuFacts(sessionId, context);
  const { row, actions, stop, remove } = facts;
  const turnOff = useTurnOffItems(sessionId);
  const tiles = [
    where === "tab" && layout.onSplit !== undefined
      ? [
          <Item key="right" onClick={() => layout.onSplit?.("right")}>
            <Columns2Icon aria-hidden />
            Split right
          </Item>,
          <Item key="down" onClick={() => layout.onSplit?.("bottom")}>
            <Rows2Icon aria-hidden />
            Split down
          </Item>,
        ]
      : [],
    where === "tile" && layout.onMaximise !== undefined
      ? [
          <Item key="max" onClick={layout.onMaximise}>
            <Maximize2Icon aria-hidden />
            Maximise tile
          </Item>,
        ]
      : [],
    layout.onClose === undefined
      ? []
      : [
          <Item key="close" onClick={layout.onClose}>
            <XIcon aria-hidden />
            Close tab
          </Item>,
        ],
  ].flat();
  return (
    <>
      <Group>
        {facts.label === null ? null : <Label className="truncate">{facts.label}</Label>}
        {row !== null && actions?.rename === true ? (
          <Item onClick={() => context.onRename(row)}>
            <PencilIcon aria-hidden />
            Rename…
            <Shortcut className={META}>F2</Shortcut>
          </Item>
        ) : null}
        {row === null || actions === null ? null : (
          <MarkItems parts={parts} row={row} actions={actions} handlers={handlers} />
        )}
        <Item onClick={() => handlers.copyLink({ session: { id: sessionId }, title: facts.title })}>
          <LinkIcon aria-hidden />
          Copy link
        </Item>
      </Group>
      {tiles.length === 0 ? null : (
        <>
          <Separator />
          <Group>{tiles}</Group>
        </>
      )}
      {turnOff.length === 0 ? null : (
        <>
          <Separator />
          <Group>
            {turnOff.map((item) => (
              <Item key={item.label} onClick={item.onSelect}>
                <UserXIcon aria-hidden />
                {item.label}
              </Item>
            ))}
          </Group>
        </>
      )}
      {stop === null ? null : (
        <>
          <Separator />
          <Item variant="destructive" onClick={() => context.onStop(stop)}>
            <SquareIcon aria-hidden />
            Stop session…
          </Item>
        </>
      )}
      {remove === null ? null : (
        <>
          <Separator />
          <Item variant="destructive" onClick={() => context.onDelete(remove)}>
            <Trash2Icon aria-hidden />
            Delete session…
          </Item>
        </>
      )}
    </>
  );
}

/** A session tab's right-click menu; the tab is its `ContextMenu`'s trigger. */
export function SessionTabMenu(props: {
  readonly sessionId: string;
  readonly layout: TabLayout;
  readonly context: SessionMenuContext;
}) {
  return (
    <ContextMenuContent width="md">
      <SessionMenuItems parts={CONTEXT} where="tab" {...props} />
    </ContextMenuContent>
  );
}

/** The "…" on a tile's strip: the active tab's actions, and what the tile does to it. */
export function TileMenuButton({
  sessionId,
  label,
  layout,
  context,
}: {
  /** The active tab's session; null for a view or a New session tab. */
  readonly sessionId: string | null;
  /** The active tab's name, for the button's: "Actions for Fix flaky checkout retry". */
  readonly label: string;
  readonly layout: TabLayout;
  readonly context: SessionMenuContext;
}) {
  if (sessionId === null && layout.onMaximise === undefined && layout.onClose === undefined)
    return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Actions for ${label}`}
        className={cn(
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          "text-muted-foreground",
        )}
      >
        <EllipsisIcon aria-hidden className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent width="md" align="end">
        {sessionId === null ? (
          <DropdownMenuGroup>
            {layout.onMaximise === undefined ? null : (
              <DropdownMenuItem onClick={layout.onMaximise}>
                <Maximize2Icon aria-hidden />
                Maximise tile
              </DropdownMenuItem>
            )}
            {layout.onClose === undefined ? null : (
              <DropdownMenuItem onClick={layout.onClose}>
                <XIcon aria-hidden />
                Close tab
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
        ) : (
          <SessionMenuItems
            parts={DROPDOWN}
            where="tile"
            sessionId={sessionId}
            layout={layout}
            context={context}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The workspace a menu speaks of: its worktree's name, its branch and its directory. */
export interface WorkspaceFacts {
  readonly worktreeName: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly onNewSession: () => void;
  /** Opens the Change view with the Land dialog (`/sessions/<id>/change#land`). */
  readonly onLand: () => void;
}

/** Copies `text`, and says in a toast that it did, or that this browser wouldn't. */
const copy = (text: string, what: string) => {
  void copyTextChecked(text).then((copied) =>
    toast.add(
      copied
        ? { description: `Copied the ${what}.`, priority: "low" }
        : {
            description: `Couldn't copy the ${what}. This browser doesn't allow it here.`,
            priority: "high",
          },
    ),
  );
};

/** The workspace's "…" in its header (Doop "T21 · Workspace menu"): the workspace's own actions. */
export function WorkspaceMenuButton({ workspace }: { readonly workspace: WorkspaceFacts }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Workspace actions"
        className={cn(
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          "text-muted-foreground",
        )}
      >
        <EllipsisIcon aria-hidden className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent width="lg" align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="truncate">{workspace.worktreeName}</DropdownMenuLabel>
          <DropdownMenuItem onClick={workspace.onNewSession}>
            <SquarePenIcon aria-hidden />
            New session in this workspace
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => copy(workspace.branch, "branch name")}>
            <GitBranchIcon aria-hidden />
            Copy branch name
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => copy(workspace.worktreePath, "worktree path")}>
            <FolderIcon aria-hidden />
            Copy worktree path
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={workspace.onLand}>
            <GitPullRequestIcon aria-hidden />
            Land…
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The phone header's "…" (Doop "Phone · Session actions"): one sheet with the focused session's
 * actions, Close tab, then its workspace's, then Stop session… in red.
 */
export function PhoneSessionActions({
  sessionId,
  layout,
  context,
  workspace,
}: {
  readonly sessionId: string;
  readonly layout: TabLayout;
  readonly context: SessionMenuContext;
  readonly workspace: WorkspaceFacts;
}) {
  const handlers = useRowActions();
  const facts = useMenuFacts(sessionId, context);
  const { stop, remove } = facts;
  const turnOff = useTurnOffItems(sessionId);
  // A session the inbox doesn't list has no row to act on; its workspace's actions are on the
  // desktop's header until it does.
  if (facts.row === null || facts.actions === null) return null;
  return (
    <PhoneRowActions
      row={facts.row}
      actions={facts.actions}
      handlers={handlers}
      triggerClassName=""
      first={turnOff.map((item) => (
        <SheetItem key={item.label} icon={<UserXIcon aria-hidden />} onClick={item.onSelect}>
          {item.label}
        </SheetItem>
      ))}
      more={
        <>
          {layout.onClose === undefined ? null : (
            <SheetItem icon={<XIcon aria-hidden />} onClick={layout.onClose}>
              Close tab
            </SheetItem>
          )}
          <p className="truncate px-5 pt-3 pb-1 text-sm text-muted-foreground">
            {workspace.worktreeName}
          </p>
          <SheetItem icon={<SquarePenIcon aria-hidden />} onClick={workspace.onNewSession}>
            New session in this workspace
          </SheetItem>
          <SheetItem
            icon={<GitBranchIcon aria-hidden />}
            onClick={() => copy(workspace.branch, "branch name")}
          >
            Copy branch name
          </SheetItem>
          <SheetItem icon={<GitPullRequestIcon aria-hidden />} onClick={workspace.onLand}>
            Land…
          </SheetItem>
          {stop === null ? null : (
            <>
              <hr className="my-1 border-border" />
              <SheetItem
                icon={<SquareIcon aria-hidden className="text-destructive!" />}
                className="text-destructive"
                onClick={() => context.onStop(stop)}
              >
                Stop session…
              </SheetItem>
            </>
          )}
          {remove === null ? null : (
            <>
              <hr className="my-1 border-border" />
              <SheetItem
                icon={<Trash2Icon aria-hidden className="text-destructive!" />}
                className="text-destructive"
                onClick={() => context.onDelete(remove)}
              >
                Delete session…
              </SheetItem>
            </>
          )}
        </>
      }
    />
  );
}

/** A sentence from `lib/session-stop`, with names in the foreground and machine names in mono. */
export function Said({ sentence }: { readonly sentence: Sentence }) {
  // Each part is keyed by where it starts in the sentence, which no other part shares.
  const starts = sentence.reduce<ReadonlyArray<number>>(
    (at, part, index) => [...at, (at[index] ?? 0) + part.text.length],
    [0],
  );
  return sentence.map((part, index) => (
    <Fragment key={starts[index]}>
      {part.kind === "text" ? (
        part.text
      ) : part.kind === "name" ? (
        <span className="text-foreground">{part.text}</span>
      ) : (
        <code className="font-mono text-meta text-foreground">{part.text}</code>
      )}
    </Fragment>
  ));
}

/** The two reads a stop is laid over (`lib/pending-stops.ts`). */
const stopKeys = (trpc: TrpcProxy): StopKeys => ({
  inbox: trpc.sessions.inbox.queryKey(),
  detail: (id) => trpc.sessions.detail.queryKey({ id }),
});

/**
 * Stops the session. It reads as stopped at once wherever it shows (`beginStop`); once Mend
 * answers, a toast says what happened. A stop that fails puts the session back as it was and says
 * so in a toast, with Try again. It runs outside any component: the session's tab, and the dialog
 * in it, leave the sheet the moment the session reads stopped.
 */
const sendStop = async (stop: {
  readonly queryClient: QueryClient;
  readonly trpc: TrpcProxy;
  readonly client: TrpcClient;
  readonly target: StopTarget;
  readonly preview: StopPreview | null;
}): Promise<void> => {
  const { queryClient, trpc, client, target, preview } = stop;
  beginStop(queryClient, stopKeys(trpc), target.sessionId);
  try {
    await client.sessions.stop.mutate({ id: target.sessionId });
    acceptStop(queryClient, target.sessionId);
    toast.add({
      description: stoppedToast(target.title, target.fileCount, preview),
      priority: "low",
    });
  } catch (cause) {
    // A lost answer says nothing of whether the server took the stop: read the session again,
    // and say the stop failed only if it still runs.
    const detail = await client.sessions.detail.query({ id: target.sessionId }).catch(() => null);
    if (
      detail !== null &&
      (detail.session.status === "stopping" || !agentIsLive(detail.session, detail.currentAgent))
    ) {
      acceptStop(queryClient, target.sessionId);
      return;
    }
    undoStop(queryClient, target.sessionId);
    toast.add({
      description: `"${target.title}" didn't stop. ${failureWords(cause, "Try again.")}`,
      // Low, so a screen reader can reach Try again (high toasts are read out and gone).
      priority: "low",
      actionProps: { children: "Try again", onClick: () => void sendStop(stop) },
    });
  } finally {
    void queryClient.invalidateQueries(trpc.sessions.pathFilter());
  }
};

/** The Stop dialog's open state, kept with its target so the dialog can close with its words. */
export interface StopDialogState {
  readonly open: boolean;
  readonly target: StopTarget | null;
}

/**
 * Stop session? (Doop "Session · Stop session dialog", "Stop session · workspace keeps running",
 * "Phone · Stop session · workspace stops too"). It reads what the stop would do now
 * (`sessions.stopPreview`): whether the workspace and its Services stop too, or which running
 * sessions keep it up. The stop decides again when it runs.
 */
export function StopSessionDialog({
  state,
  viewerId,
  onOpenChange,
}: {
  readonly state: StopDialogState;
  readonly viewerId: string;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const target = state.target;
  if (target === null) return null;
  return (
    <StopSessionOverlay
      key={target.sessionId}
      open={state.open}
      target={target}
      viewerId={viewerId}
      onOpenChange={onOpenChange}
    />
  );
}

function StopSessionOverlay({
  open,
  target,
  viewerId,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly target: StopTarget;
  readonly viewerId: string;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const read = useQuery({
    ...trpc.sessions.stopPreview.queryOptions({ id: target.sessionId }),
    // What runs in the workspace changes without an event for this read: ask each time it opens.
    staleTime: 0,
    enabled: open,
  });
  const preview = read.isPending || read.isError ? null : read.data;
  const words = stopWords(target, preview, viewerId);
  // The session reads as stopped the moment Stop is confirmed, everywhere it shows, so the dialog
  // closes at once; what Mend answers arrives in a toast (`sendStop`).
  const confirm = () => {
    onOpenChange(false);
    void sendStop({ queryClient, trpc, client, target, preview });
  };

  // The desktop's last-session dialog lays out what stops and what is kept; every other case,
  // and the phone, says it in sentences.
  const table = !phone && preview?.workspace === "stops";
  const checking = read.isPending ? (
    <p role="status" className="text-muted-foreground">
      Checking what else runs in this workspace…
    </p>
  ) : read.isError ? (
    <InlineAlert
      tone="warning"
      size={phone ? "touch" : "default"}
      actions={
        <Button type="button" size="sm" variant="outline" onClick={() => void read.refetch()}>
          Try again
        </Button>
      }
    >
      Mend couldn&apos;t check what else runs in this workspace. The stop checks again before it
      stops the workspace.
    </InlineAlert>
  ) : null;

  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      title="Stop session?"
      size="md"
      description={phone ? target.title : table ? <Said sentence={words.lead} /> : undefined}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            size={phone ? "touch" : "default"}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size={phone ? "touch" : "default"}
            onClick={confirm}
          >
            Stop session
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-muted-foreground">
        {table ? (
          <>
            {words.waiting === null ? null : <p>{words.waiting}</p>}
            <dl className="grid grid-cols-[5.5rem_1fr] gap-x-4 gap-y-1.5 border-y py-3 text-foreground">
              <StopRows term="Stops" items={words.stops} />
              <StopRows term="Kept" items={words.kept} />
            </dl>
            <p>{words.after}</p>
          </>
        ) : (
          <>
            {words.waiting === null ? null : <p>{words.waiting}</p>}
            <p>{words.after}</p>
            {words.workspace === null ? (
              read.isSuccess ? (
                <p>
                  <Said sentence={words.lead} />
                </p>
              ) : null
            ) : (
              <p>
                <Said sentence={words.workspace} />
                {preview?.workspace === "stops" ? (
                  <>
                    {" The files and the change stay in "}
                    <code className="font-mono text-meta text-foreground">
                      {target.worktreeName}
                    </code>
                    .
                  </>
                ) : null}
              </p>
            )}
          </>
        )}
        {checking}
      </div>
    </Overlay>
  );
}

/** One term of the Stop dialog's table and its lines. */
function StopRows({
  term,
  items,
}: {
  readonly term: string;
  readonly items: ReadonlyArray<Sentence>;
}) {
  if (items.length === 0) return null;
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="flex flex-col gap-1.5">
        {items.map((item) => (
          <span key={item.map((part) => part.text).join("")}>
            <Said sentence={item} />
          </span>
        ))}
      </dd>
    </>
  );
}

/** The Rename dialog's open state, kept with its row so the dialog can close with its words. */
export interface RenameDialogState {
  readonly open: boolean;
  readonly row: InboxRow | null;
}

/**
 * Rename… from a tab's menu or F2 on the tab: the name selected, Enter or Save keeps it, an empty
 * name goes back to the worktree's.
 */
export function RenameSessionDialog({
  state,
  onOpenChange,
}: {
  readonly state: RenameDialogState;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const row = state.row;
  if (row === null) return null;
  return (
    <RenameOverlay key={row.session.id} open={state.open} row={row} onOpenChange={onOpenChange} />
  );
}

function RenameOverlay({
  open,
  row,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly row: InboxRow;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const handlers = useRowActions();
  const phone = usePhone();
  const [name, setName] = useState(row.title);
  const formId = `rename-${row.session.id}`;
  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      title="Rename session"
      size="sm"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            size={phone ? "touch" : "default"}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" form={formId} size={phone ? "touch" : "default"}>
            Save
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onOpenChange(false);
          handlers.rename(row, name);
        }}
      >
        <Input
          aria-label="Session name"
          value={name}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setName(event.currentTarget.value)}
          className={phone ? "h-11 text-lead" : undefined}
        />
        <p className="text-meta text-muted-foreground">
          An empty name goes back to the worktree&apos;s name.
        </p>
      </form>
    </Overlay>
  );
}

/** The Delete dialog's open state, kept with its target so the dialog can close with its words. */
export interface DeleteDialogState {
  readonly open: boolean;
  readonly target: DeleteTarget | null;
}

/**
 * Delete this session? (Doop "Session · Delete session dialog", "Phone · Session · Delete session
 * sheet"): the session goes from every list with its conversation and record; its worktree,
 * branch, change and pull request stay. A removal the server can't finish yet (its workspace is
 * still saving) says what it waits on.
 */
export function DeleteSessionDialog({
  state,
  onOpenChange,
  onDeleted,
}: {
  readonly state: DeleteDialogState;
  readonly onOpenChange: (open: boolean) => void;
  /** After the session is gone: the sheet closes its tab, or leaves the page. */
  readonly onDeleted: (sessionId: string) => void;
}) {
  const target = state.target;
  if (target === null) return null;
  return (
    <DeleteOverlay
      key={target.sessionId}
      open={state.open}
      target={target}
      onOpenChange={onOpenChange}
      onDeleted={onDeleted}
    />
  );
}

function DeleteOverlay({
  open,
  target,
  onOpenChange,
  onDeleted,
}: {
  readonly open: boolean;
  readonly target: DeleteTarget;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDeleted: (sessionId: string) => void;
}) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const [failure, setFailure] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: () => client.sessions.remove.mutate({ id: target.sessionId }),
    onMutate: () => setFailure(null),
    onSuccess: (report) => {
      void queryClient.invalidateQueries(trpc.sessions.pathFilter());
      if (!report.removed) {
        // Removed after its workspace: a removal asked while it saves says what it waits on.
        setFailure(report.leftover ?? "Mend couldn't delete it yet. Try again in a moment.");
        return;
      }
      onOpenChange(false);
      toast.add({ description: deletedToast(target.title, target.projectName), priority: "low" });
      onDeleted(target.sessionId);
    },
    onError: (cause) =>
      setFailure(`The session wasn't deleted. ${failureWords(cause, "Try again.")}`),
  });
  const size = phone ? "touch" : "default";
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => {
        if (!remove.isPending) onOpenChange(next);
      }}
      title="Delete this session?"
      size="md"
      description={`${target.title} goes from every list, with its conversation and its record. This can't be undone.`}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            size={size}
            disabled={remove.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size={size}
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? "Deleting…" : "Delete session"}
          </Button>
        </>
      }
    >
      <section aria-label="What stays" className="flex flex-col">
        <h3 className="pb-2 font-semibold text-foreground">What stays</h3>
        <dl className="flex flex-col border-t">
          {target.stays.map((row) => (
            <div
              key={row.term}
              className="flex items-baseline justify-between gap-4 border-b py-2.5"
            >
              <dt className="text-foreground">{row.term}</dt>
              <dd
                className={cn(
                  "min-w-0 truncate text-right text-muted-foreground",
                  row.mono && "font-mono text-meta",
                )}
              >
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      </section>
      {failure === null ? null : (
        <p role="alert" className="text-destructive">
          {failure}
        </p>
      )}
    </Overlay>
  );
}
