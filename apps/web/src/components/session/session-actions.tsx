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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Columns2Icon,
  EllipsisIcon,
  FolderIcon,
  GitBranchIcon,
  LinkIcon,
  Maximize2Icon,
  PencilIcon,
  Rows2Icon,
  SquareIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import { Fragment, useState } from "react";

import { agentIsLive, type SessionDetailDto } from "#/lib/api";
import { copyTextChecked } from "#/lib/clipboard";
import { activity, age, type InboxRow } from "#/lib/inbox";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import { rowActions } from "#/lib/row-actions";
import { sessionDetailQuery } from "#/lib/session-queries";
import { STATUS_WORDS } from "#/lib/session-sheet";
import {
  actorOf,
  offersStop,
  type Sentence,
  stoppedToast,
  type StopSubject,
  stopWords,
} from "#/lib/session-stop";
import { useTRPC, useTRPCClient } from "#/lib/trpc";
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

/**
 * A session's own actions and its workspace's (docs/adr/0026, decision 4; Doop "T25 · Session tab
 * menu", "T26 · Conversation tile menu", "T21 · Workspace menu", "Phone · Session actions").
 *
 * A session's status, its age and its own actions (Rename…, Snooze, Mark done, Copy link, Stop
 * session…) are on its tab: the tab's right-click menu and the "…" of the tile that shows it,
 * with what the tile can do to the tab. The workspace's "…" holds the workspace's: New session in
 * this workspace, Copy branch name, Copy worktree path. Land… joins it with route PR 26. On a
 * phone, one sheet holds both, the session's first.
 *
 * Rename, snooze, mark done and copy link write through the sidebar row's writers
 * (`useRowActions`), so a change shows in the tab and the sidebar at once.
 */

/** The session a Stop dialog is about. */
export type StopTarget = StopSubject & {
  readonly sessionId: string;
  readonly title: string;
  /** The worktree's name, where the files and the change stay. */
  readonly worktreeName: string;
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
}

/** The Stop dialog's subject, from the session's detail and its inbox row. */
export const stopTargetOf = (detail: SessionDetailDto, row: InboxRow | null): StopTarget => ({
  sessionId: detail.session.id,
  title: row?.title ?? detail.session.label ?? detail.session.branch,
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
    actions: row === null ? null : rowActions(row, context.viewerId),
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
    title: row?.title ?? detail?.session.label ?? "Session",
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
  const { row, actions, stop } = facts;
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
      {stop === null ? null : (
        <>
          <Separator />
          <Item variant="destructive" onClick={() => context.onStop(stop)}>
            <SquareIcon aria-hidden />
            Stop session…
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
  const stop = facts.stop;
  // A session the inbox doesn't list has no row to act on; its workspace's actions are on the
  // desktop's header until it does.
  if (facts.row === null || facts.actions === null) return null;
  return (
    <PhoneRowActions
      row={facts.row}
      actions={facts.actions}
      handlers={handlers}
      triggerClassName=""
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
  const [failure, setFailure] = useState<string | null>(null);
  const stop = useMutation({
    mutationFn: () => client.sessions.stop.mutate({ id: target.sessionId }),
    onMutate: () => setFailure(null),
    onSuccess: () => {
      onOpenChange(false);
      toast.add({
        description: stoppedToast(target.title, target.fileCount, preview),
        priority: "low",
      });
    },
    onError: async (cause) => {
      // A lost answer says nothing of whether the server took the stop: read the session again,
      // and say the stop failed only if it still runs.
      const detail = await queryClient
        .fetchQuery({ ...sessionDetailQuery(trpc, target.sessionId), staleTime: 0, retry: false })
        .catch(() => null);
      if (
        detail !== null &&
        (detail.session.status === "stopping" || !agentIsLive(detail.session, detail.currentAgent))
      ) {
        onOpenChange(false);
        return;
      }
      setFailure(`The session didn't stop. ${failureWords(cause, "Try again.")}`);
    },
    onSettled: () => queryClient.invalidateQueries(trpc.sessions.pathFilter()),
  });

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
      onOpenChange={(next) => {
        if (!stop.isPending) onOpenChange(next);
      }}
      title="Stop session?"
      size="md"
      description={phone ? target.title : table ? <Said sentence={words.lead} /> : undefined}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            size={phone ? "touch" : "default"}
            disabled={stop.isPending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size={phone ? "touch" : "default"}
            disabled={stop.isPending}
            onClick={() => stop.mutate()}
          >
            {stop.isPending ? "Stopping…" : "Stop session"}
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
        {failure === null ? null : (
          <p role="alert" className="text-destructive">
            {failure}
          </p>
        )}
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
