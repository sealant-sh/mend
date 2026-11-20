import { agentStartingFacts, resumesOwnHarness } from "@mend/domain/workbench";
import { Button } from "@mend/ui/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@mend/ui/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import { Input } from "@mend/ui/components/ui/input";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  CopyIcon,
  EllipsisIcon,
  PencilIcon,
  SquareTerminalIcon,
  XIcon,
} from "lucide-react";
import { type ComponentType, type ReactNode, useCallback, useRef, useState } from "react";

import { Overlay } from "#/components/projects/overlay";
import { QueryError } from "#/components/route-screens";
import { useSessionFacts } from "#/components/session/session-facts";
import { SessionTerminal, type TerminalControls } from "#/components/terminal/session-terminal";
import { copyTextChecked } from "#/lib/clipboard";
import { failureWords } from "#/lib/refusal";
import { sessionDetailQuery } from "#/lib/session-queries";
import { useTRPC, useTRPCClient } from "#/lib/trpc";
import { logLines } from "#/lib/workspace-services";
import {
  exitWords,
  nextShell,
  openShells,
  openShellsFact,
  SHELL_DIRECTORY,
  type ShellExit,
  shellAccess,
  shellLine,
  shellsThatExited,
  type WorkspaceShell,
  workspaceRuns,
} from "#/lib/workspace-shells";

import type { ViewPlace } from "../views.tsx";
import { LogText } from "./service-log.tsx";
import { useShellOnOwn, wantsShellOnOwn } from "./shell-on-own.ts";
import { useServiceLog } from "./use-workspace-services.ts";
import { useWorkspaceShells } from "./use-workspace-shells.ts";

/**
 * How the view lays itself out in its tile (Doop "Terminal · this workspace's shells", T07, T10,
 * T16): the list of shells beside the terminal in a large tile, the phone's picker over it in a
 * narrow one, and the terminal alone in a short one.
 */
type Layout = "list" | "picker" | "alone";

const LIST_MIN_WIDTH = 720;
const LIST_MIN_HEIGHT = 420;
const PICKER_MIN_HEIGHT = 360;

const layoutOf = (box: { readonly width: number; readonly height: number } | null): Layout => {
  if (box === null) return "alone";
  if (box.width >= LIST_MIN_WIDTH && box.height >= LIST_MIN_HEIGHT) return "list";
  if (box.width < LIST_MIN_WIDTH && box.height >= PICKER_MIN_HEIGHT) return "picker";
  return "alone";
};

/**
 * The size of the element `ref` is given, as it changes: a tile resized, its tab moved to another
 * tile. Null until it is first measured, and while the element is out of the page.
 */
const useBoxSize = () => {
  const [box, setBox] = useState<{
    readonly width: number;
    readonly height: number;
  } | null>(null);
  const ref = useCallback((element: HTMLDivElement | null) => {
    if (element === null) return;
    const observer = new ResizeObserver(([entry]) => {
      const rect = entry?.contentRect;
      if (rect === undefined || rect.width === 0 || rect.height === 0) return;
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setBox((current) =>
        current?.width === width && current.height === height ? current : { width, height },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { box, ref };
};

/** "both sessions", "all 3 sessions", "its session": who sees what a shell changes. */
const sharedWith = (count: number): string =>
  count <= 1 ? "its session sees" : count === 2 ? "both sessions see" : `all ${count} sessions see`;

/** How many exit lines show at once; the oldest goes first. */
const EXITS_SHOWN = 3;

/** What a shell's menu offers; null where the person can't do it. */
interface ShellActions {
  readonly rename: (() => void) | null;
  readonly close: (() => void) | null;
  readonly copyDirectory: () => void;
}

/** Copies the directory shells open in, and says so. */
const copyDirectory = async () => {
  const copied = await copyTextChecked(SHELL_DIRECTORY);
  toast.add({
    description: copied
      ? `Copied ${SHELL_DIRECTORY}.`
      : `Couldn't copy. The working directory is ${SHELL_DIRECTORY}.`,
  });
};

export function TerminalBody({ place }: { readonly place: ViewPlace }) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const facts = useSessionFacts(place.sessionId);
  const { sessions, shells, ready, failed, retrying, retry } = useWorkspaceShells(place);
  const access = shellAccess(sessions, place.sessionId, facts.viewerId);
  const runs = workspaceRuns(sessions);
  const { box, ref } = useBoxSize();
  const layout = layoutOf(box);
  const terminal = useRef<TerminalControls | null>(null);

  // The list holds the shells the person can see that are open; one that exits or is closed
  // leaves it, and the tab counts the same shells.
  const listed = openShells(shells, access.watches);
  const listedKeys = listed.map((shell) => shell.key);
  const [picked, setPicked] = useState<string | null>(null);
  // The list as it was, to tell which shells left it, and the lines that say which exited.
  const [seen, setSeen] = useState<ReadonlyArray<string>>([]);
  const [exits, setExits] = useState<ReadonlyArray<ShellExit>>([]);
  if (ready && seen.join("\n") !== listedKeys.join("\n")) {
    setSeen(listedKeys);
    const exited = shellsThatExited(
      seen.filter((key) => !listedKeys.includes(key)),
      shells,
    );
    if (exited.length > 0)
      setExits((shown) =>
        [...shown.filter((each) => !exited.some((exit) => exit.key === each.key)), ...exited].slice(
          -EXITS_SHOWN,
        ),
      );
    // The shell shown left: show the one after it.
    if (picked !== null && seen.includes(picked) && !listedKeys.includes(picked))
      setPicked(nextShell(seen, picked, listedKeys));
  }
  const current = listed.find((shell) => shell.key === picked) ?? listed[0] ?? null;
  const ownerName = (sessionId: string) => {
    const owner = sessions.find((session) => session.id === sessionId)?.ownerUserId ?? null;
    return owner === null ? "its owner" : (facts.nameOf(owner) ?? "its owner");
  };

  const opensOn = access.opensOn;

  // A stopped workspace comes back with the session first: a conversation resumes as itself and
  // then opens a shell beside its agent; any other session comes back as a shell in its own
  // terminal, which is the shell.
  const [step, setStep] = useState<"resuming" | "opening" | null>(null);
  const open = useMutation({
    mutationFn: async (sessionId: string): Promise<string> => {
      if (!runs) {
        setStep("resuming");
        // The session's detail says how it comes back: its harness and its last agent's kind.
        const { session, currentAgent } = await queryClient.fetchQuery(
          sessionDetailQuery(trpc, sessionId),
        );
        const asItself =
          resumesOwnHarness(session.harness) &&
          session.harness !== "shell" &&
          currentAgent?.kind === "agent-protocol";
        await client.sessions.resume.mutate({
          id: sessionId,
          request: { harness: asItself ? null : "shell" },
        });
        if (!asItself) return `session:${sessionId}`;
      }
      setStep("opening");
      const shell = await client.sessions.openShell.mutate({ id: sessionId });
      return shell.id;
    },
    onSuccess: (key) => setPicked(key),
    onSettled: () => {
      setStep(null);
      return queryClient.invalidateQueries(trpc.sessions.pathFilter());
    },
  });
  const { mutate: openOn } = open;
  const openShell = useCallback((sessionId: string) => openOn(sessionId), [openOn]);
  useShellOnOwn(
    opensOn,
    wantsShellOnOwn({
      opensOn,
      workspaceRuns: runs,
      liveTerminals: ready ? listed.length : null,
    }),
    openShell,
  );

  const [closing, setClosing] = useState<WorkspaceShell | null>(null);
  const stop = useMutation({
    mutationFn: (processId: string) => client.sessions.stopShell.mutate({ processId }),
    onSuccess: () => setClosing(null),
    onSettled: () => queryClient.invalidateQueries(trpc.sessions.pathFilter()),
  });

  const [renaming, setRenaming] = useState<WorkspaceShell | null>(null);
  const [name, setName] = useState("");
  const rename = useMutation({
    mutationFn: ({ processId, label }: { readonly processId: string; readonly label: string }) =>
      client.sessions.renameShell.mutate({ processId, label }),
    onSuccess: () => setRenaming(null),
    onSettled: () => queryClient.invalidateQueries(trpc.sessions.pathFilter()),
  });

  const [log, setLog] = useState<ShellExit | null>(null);

  const copy = async () => {
    const copied = await copyTextChecked(terminal.current?.text() ?? "");
    toast.add({
      description: copied
        ? "Copied the terminal's text."
        : "Couldn't copy. Select the text and press Ctrl C.",
    });
  };
  // A shell of the person's own, not a session's terminal: they rename and close it.
  const ownShell = (shell: WorkspaceShell) =>
    shell.processId !== null && access.types(shell.sessionId);
  const actionsFor = (shell: WorkspaceShell): ShellActions => ({
    rename: ownShell(shell)
      ? () => {
          rename.reset();
          setName(shell.name);
          setRenaming(shell);
        }
      : null,
    close: ownShell(shell)
      ? () => {
          stop.reset();
          setClosing(shell);
        }
      : null,
    copyDirectory: () => void copyDirectory(),
  });

  if (failed !== null)
    return (
      <div className="mx-auto w-full max-w-conversation px-4 py-6">
        <QueryError error={failed} retry={retry} retrying={retrying} />
      </div>
    );

  const typesHere = current !== null && access.types(current.sessionId);
  const opening = open.isPending
    ? step === "resuming"
      ? "Starting the workspace…"
      : "Opening…"
    : null;
  const newShell =
    opensOn === null ? null : (
      <Button
        variant="outline"
        size={layout === "list" ? "sm" : "touch"}
        disabled={open.isPending}
        onClick={() => open.mutate(opensOn)}
      >
        {opening ?? (runs ? "New shell" : "Resume and open a shell")}
      </Button>
    );
  const openFailed = open.isError ? (
    <p role="alert" className="text-meta text-destructive">
      {failureWords(open.error, "Mend couldn't open a shell. Try again.")}
    </p>
  ) : null;
  const exitLines = (
    <ExitLines
      exits={exits}
      onShow={setLog}
      onDismiss={(key) => setExits((shown) => shown.filter((exit) => exit.key !== key))}
      touch={layout !== "list"}
    />
  );
  const savedName = name.trim();

  return (
    <div
      ref={ref}
      className={cn("flex min-h-0 flex-1", layout === "list" ? "flex-row" : "flex-col")}
    >
      {layout === "list" ? (
        <ShellList
          shells={listed}
          current={current}
          onPick={setPicked}
          line={(shell) => shellLine(shell, facts.nameOf)}
          actionsFor={actionsFor}
          sessions={sessions.length}
          newShell={listed.length === 0 ? null : newShell}
          failure={listed.length === 0 ? null : openFailed}
          exits={exitLines}
        />
      ) : null}
      {layout === "picker" ? (
        <ShellPicker
          shells={listed}
          current={current}
          onPick={setPicked}
          line={(shell) => shellLine(shell, facts.nameOf)}
          actions={current === null ? null : actionsFor(current)}
          sessions={sessions.length}
          onNewShell={opensOn === null || open.isPending ? null : () => open.mutate(opensOn)}
          opening={opening}
          onCopy={current === null ? null : () => void copy()}
          onClear={current === null ? null : () => terminal.current?.clear()}
          failure={listed.length === 0 ? null : openFailed}
          exits={exitLines}
        />
      ) : null}
      {/* The terminal stays in this place whatever the layout, so a resize never reopens it. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {layout === "alone" ? <div className="px-3 pt-1.5 empty:hidden">{exitLines}</div> : null}
        {layout === "list" && current !== null ? (
          <div className="flex h-tab-strip shrink-0 items-center gap-2 px-6 pt-4 pb-2">
            <p className="flex min-w-0 flex-1 items-baseline gap-2 truncate">
              <span className="text-row font-semibold">{current.name}</span>
              <span className="truncate font-mono text-meta text-muted-foreground">
                {facts.worktreeName} · {facts.session.branch}
              </span>
            </p>
            <Button variant="ghost" size="sm" onClick={() => void copy()}>
              Copy
            </Button>
            <Button variant="ghost" size="sm" onClick={() => terminal.current?.clear()}>
              Clear
            </Button>
            {ownShell(current) ? (
              <Button variant="outline" size="sm" onClick={actionsFor(current).close ?? undefined}>
                Close shell…
              </Button>
            ) : null}
          </div>
        ) : null}
        {current !== null && !typesHere ? (
          <p
            className={cn(
              "text-meta text-muted-foreground",
              layout === "alone" ? "px-3 py-1.5" : "px-6 pb-2 max-lg:px-4",
            )}
          >
            Only {ownerName(current.sessionId)} types here. You're watching.
          </p>
        ) : null}
        {current === null ? (
          <Nothing
            ready={ready}
            runs={runs}
            watches={sessions.some((session) => access.watches(session.id))}
            owner={ownerName(place.sessionId)}
            newShell={newShell}
            failure={openFailed}
            opening={open.isPending}
          />
        ) : (
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col",
              layout !== "alone" &&
                "mx-6 mb-6 overflow-hidden rounded-xl border max-lg:mx-4 max-lg:mb-4",
            )}
          >
            <SessionTerminal
              // A new terminal for another shell; its socket replays the record from the start.
              key={current.key}
              sessionId={current.sessionId}
              {...(current.processId === null ? {} : { processId: current.processId })}
              startingLabel={current.program}
              // Only an agent says it is starting; a command of the person's own may print nothing.
              announceStart={current.processId === null && current.agent}
              starting={agentStartingFacts(
                facts.detail.currentAgent,
                facts.detail.processes,
                Date.now(),
              )}
              readOnly={!typesHere}
              pasteImage={async (contentsBase64) =>
                (
                  await client.sessions.pasteImage.mutate({
                    id: current.sessionId,
                    upload: { contentsBase64 },
                  })
                ).path
              }
              controls={terminal}
              className="px-3 py-2"
            />
          </div>
        )}
      </div>
      <Overlay
        open={closing !== null}
        onOpenChange={(next) => {
          if (!next) {
            setClosing(null);
            stop.reset();
          }
        }}
        title={`Close ${closing?.name ?? "this shell"}?`}
        description="Whatever runs in it stops, and it leaves the list."
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setClosing(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={stop.isPending}
              onClick={() => {
                if (closing?.processId !== null && closing?.processId !== undefined)
                  stop.mutate(closing.processId);
              }}
            >
              {stop.isPending ? "Closing…" : "Close shell"}
            </Button>
          </>
        }
      >
        {stop.isError ? (
          <p role="alert" className="text-meta text-destructive">
            {failureWords(stop.error, "Mend couldn't close the shell. Try again.")}
          </p>
        ) : null}
      </Overlay>
      <Overlay
        open={renaming !== null}
        onOpenChange={(next) => {
          if (!next) setRenaming(null);
        }}
        title={`Rename ${renaming?.name ?? "shell"}`}
        size="sm"
        footer={
          <>
            <Button variant="outline" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="rename-shell"
              disabled={rename.isPending || savedName === ""}
            >
              {rename.isPending ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        <form
          id="rename-shell"
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (renaming?.processId === null || renaming?.processId === undefined) return;
            if (savedName === "") return;
            rename.mutate({ processId: renaming.processId, label: savedName });
          }}
        >
          <Input
            aria-label="Shell name"
            value={name}
            maxLength={64}
            ref={focusOnMount}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setName(event.currentTarget.value)}
            className="max-lg:h-11 max-lg:text-lead"
          />
          {rename.isError ? (
            <p role="alert" className="text-meta text-destructive">
              {failureWords(rename.error, "Mend couldn't rename the shell. Try again.")}
            </p>
          ) : null}
        </form>
      </Overlay>
      <Overlay
        open={log !== null}
        onOpenChange={(next) => {
          if (!next) setLog(null);
        }}
        title={`What ${log?.name ?? "the shell"} printed`}
        description={log === null ? undefined : `${exitWords(log)} These are its last lines.`}
        size="lg"
        footer={
          <Button variant="outline" onClick={() => setLog(null)}>
            Close
          </Button>
        }
      >
        {log === null ? null : <ShellLog exit={log} />}
      </Overlay>
    </div>
  );
}

/** A dialog's text box takes the focus as it opens. */
const focusOnMount = (input: HTMLInputElement | null) => {
  input?.focus();
};

/** An ended shell's output as Mend kept it, from the start, its newest lines in view. */
function ShellLog({ exit }: { readonly exit: ShellExit }) {
  const log = useServiceLog(exit.processId, false);
  if (log.isPending)
    return <p className="text-meta text-muted-foreground">Reading what it printed…</p>;
  if (log.isError)
    return (
      <QueryError error={log.error} retry={() => void log.refetch()} retrying={log.isFetching} />
    );
  return (
    <div className="-mx-4 flex max-h-[60dvh] min-h-0 flex-col rounded-lg border">
      <LogText
        lines={logLines(log.data.pages.flatMap((page) => page.chunks))}
        name={exit.name}
        live={false}
      />
    </div>
  );
}

/** The lines that say a shell exited, where it was listed, until the person dismisses them. */
function ExitLines({
  exits,
  onShow,
  onDismiss,
  touch,
}: {
  readonly exits: ReadonlyArray<ShellExit>;
  readonly onShow: (exit: ShellExit) => void;
  readonly onDismiss: (key: string) => void;
  readonly touch: boolean;
}) {
  return (
    <ul
      aria-live="polite"
      aria-label="Shells that exited"
      className="flex flex-col gap-0.5 empty:hidden"
    >
      {exits.map((exit) => (
        <li key={exit.key} className="flex items-center gap-1 text-meta text-muted-foreground">
          <span className="min-w-0 flex-1">{exitWords(exit)}</span>
          <Button variant="ghost" size={touch ? "touch" : "xs"} onClick={() => onShow(exit)}>
            What it printed
          </Button>
          <Button
            variant="ghost"
            size={touch ? "icon-touch" : "icon-xs"}
            aria-label={`Dismiss the line about ${exit.name}`}
            onClick={() => onDismiss(exit.key)}
          >
            <XIcon aria-hidden />
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** The parts of a menu, so a row's "…" menu and its right-click menu draw the same items. */
interface MenuParts {
  readonly Group: ComponentType<{ readonly children: ReactNode }>;
  readonly Label: ComponentType<{
    readonly children: ReactNode;
    readonly className?: string;
  }>;
  readonly Item: ComponentType<{
    readonly onClick?: () => void;
    readonly variant?: "default" | "destructive";
    readonly className?: string;
    readonly children: ReactNode;
  }>;
  readonly Separator: ComponentType;
  readonly Shortcut: ComponentType<{
    readonly children: ReactNode;
    readonly className?: string;
  }>;
}

const DROPDOWN: MenuParts = {
  Group: DropdownMenuGroup,
  Label: DropdownMenuLabel,
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Shortcut: DropdownMenuShortcut,
};

const CONTEXT: MenuParts = {
  Group: ContextMenuGroup,
  Label: ContextMenuLabel,
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Shortcut: ContextMenuShortcut,
};

/** A value on a menu item's right, in plain muted text on one line. */
const META = "pl-4 font-mono tracking-normal whitespace-nowrap";

/** A shell's actions, the same in its "…" menu, its right-click menu and the phone's picker. */
function ShellMenuItems({
  parts: { Group, Label, Item, Separator, Shortcut },
  shell,
  actions,
  touch = false,
}: {
  readonly parts: MenuParts;
  readonly shell: WorkspaceShell;
  readonly actions: ShellActions;
  readonly touch?: boolean;
}) {
  const size = touch ? "min-h-11" : "";
  return (
    <>
      <Group>
        <Label className="truncate">{shell.name}</Label>
        {actions.rename === null ? null : (
          <Item className={size} onClick={actions.rename}>
            <PencilIcon aria-hidden />
            Rename…
            {touch ? null : <Shortcut className={META}>F2</Shortcut>}
          </Item>
        )}
        <Item className={size} onClick={actions.copyDirectory}>
          <CopyIcon aria-hidden />
          {touch ? (
            // A phone's menu has no room beside the label: the path goes under it.
            <span className="flex min-w-0 flex-col">
              Copy working directory
              <span className="font-mono text-meta text-muted-foreground">{SHELL_DIRECTORY}</span>
            </span>
          ) : (
            <>
              Copy working directory
              <Shortcut className={META}>{SHELL_DIRECTORY}</Shortcut>
            </>
          )}
        </Item>
      </Group>
      {actions.close === null ? null : (
        <>
          <Separator />
          <Group>
            <Item className={size} variant="destructive" onClick={actions.close}>
              <XIcon aria-hidden />
              Close shell…
            </Item>
          </Group>
        </>
      )}
    </>
  );
}

/** The shells column beside the terminal (the frame's left column). */
function ShellList({
  shells,
  current,
  onPick,
  line,
  actionsFor,
  sessions,
  newShell,
  failure,
  exits,
}: {
  readonly shells: ReadonlyArray<WorkspaceShell>;
  readonly current: WorkspaceShell | null;
  readonly onPick: (key: string) => void;
  readonly line: (shell: WorkspaceShell) => string;
  readonly actionsFor: (shell: WorkspaceShell) => ShellActions;
  readonly sessions: number;
  readonly newShell: ReactNode;
  readonly failure: ReactNode;
  readonly exits: ReactNode;
}) {
  return (
    <nav aria-label="This workspace's shells" className="flex w-60 shrink-0 flex-col border-r">
      <div className="flex items-baseline justify-between px-4 pt-4 pb-2">
        <h2 className="text-row font-semibold">This workspace's shells</h2>
        <span className="text-meta text-muted-foreground tabular-nums">
          {shells.length}
          <span className="sr-only"> open</span>
        </span>
      </div>
      <ul aria-label="Open shells" className="flex min-h-0 flex-col gap-0.5 overflow-y-auto px-2">
        {shells.map((shell) => (
          <ShellRow
            key={shell.key}
            shell={shell}
            current={shell.key === current?.key}
            onPick={() => onPick(shell.key)}
            line={line(shell)}
            actions={actionsFor(shell)}
          />
        ))}
      </ul>
      <div className="flex flex-col items-start gap-2 px-4 pt-3 empty:hidden">
        {exits}
        {newShell}
        {failure}
      </div>
      <p className="mt-auto px-4 pt-4 pb-4 text-meta text-muted-foreground">
        Shells run in the workspace, so {sharedWith(sessions)} what you change here. They don't send
        anything to an agent.
      </p>
    </nav>
  );
}

/**
 * One shell in the list: pick it to show its terminal. Its actions are its right-click menu (a
 * long press on touch), its "…" button on hover and focus, and F2 to rename.
 */
function ShellRow({
  shell,
  current,
  onPick,
  line,
  actions,
}: {
  readonly shell: WorkspaceShell;
  readonly current: boolean;
  readonly onPick: () => void;
  readonly line: string;
  readonly actions: ShellActions;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<li className="group/row relative select-auto" />}>
        <button
          type="button"
          aria-current={current ? "true" : undefined}
          onClick={onPick}
          onKeyDown={(event) => {
            if (event.key === "F2" && actions.rename !== null) {
              event.preventDefault();
              actions.rename();
            }
          }}
          className={cn(
            "flex w-full items-start gap-2.5 rounded-lg py-2 pr-9 pl-2 text-left outline-none hover:bg-hover focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset pointer-coarse:min-h-11 pointer-coarse:pr-12",
            current && "bg-selection hover:bg-selection",
          )}
        >
          <SquareTerminalIcon
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-row">{shell.name}</span>
            <span className="truncate text-meta text-muted-foreground">{line}</span>
          </span>
        </button>
        <span className="absolute top-1/2 right-1.5 hidden -translate-y-1/2 group-focus-within/row:flex group-hover/row:flex group-has-data-popup-open/row:flex pointer-coarse:flex">
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`Actions for ${shell.name}`}
              className="grid size-6.5 place-items-center rounded-md text-foreground outline-none hover:bg-background focus-visible:ring-3 focus-visible:ring-ring/50 data-popup-open:bg-background pointer-coarse:size-11"
            >
              <EllipsisIcon aria-hidden className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent width="lg" align="start">
              <ShellMenuItems parts={DROPDOWN} shell={shell} actions={actions} />
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent width="lg">
        <ShellMenuItems parts={CONTEXT} shell={shell} actions={actions} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** A narrow tile's or a phone's shells: one picker over the terminal (the phone frame). */
function ShellPicker({
  shells,
  current,
  onPick,
  line,
  actions,
  sessions,
  onNewShell,
  opening,
  onCopy,
  onClear,
  failure,
  exits,
}: {
  readonly shells: ReadonlyArray<WorkspaceShell>;
  readonly current: WorkspaceShell | null;
  readonly onPick: (key: string) => void;
  readonly line: (shell: WorkspaceShell) => string;
  /** The shown shell's own actions. */
  readonly actions: ShellActions | null;
  readonly sessions: number;
  readonly onNewShell: (() => void) | null;
  readonly opening: string | null;
  readonly onCopy: (() => void) | null;
  readonly onClear: (() => void) | null;
  readonly failure: ReactNode;
  readonly exits: ReactNode;
}) {
  return (
    <div className="flex shrink-0 flex-col gap-2 border-b px-4 pt-3 pb-3">
      <h2 className="text-row font-semibold">This workspace's shells</h2>
      {current === null ? null : (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="outline"
                size="touch"
                className="w-full justify-start gap-2 px-3 text-left font-normal"
              />
            }
          >
            <SquareTerminalIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              <span className="text-row">{current.name}</span>
              <span className="text-meta text-muted-foreground"> · {line(current)}</span>
            </span>
            <span className="shrink-0 text-meta text-muted-foreground">
              {opening ?? openShellsFact(shells)}
            </span>
            <ChevronDownIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-(--anchor-width)">
            <DropdownMenuGroup>
              <DropdownMenuRadioGroup
                value={current.key}
                onValueChange={(key: string) => onPick(key)}
              >
                {shells.map((shell) => (
                  <DropdownMenuRadioItem key={shell.key} value={shell.key} className="min-h-11">
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{shell.name}</span>
                      <span className="truncate text-meta text-muted-foreground">
                        {line(shell)}
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {onCopy === null ? null : (
                <DropdownMenuItem className="min-h-11" onClick={onCopy}>
                  Copy text
                </DropdownMenuItem>
              )}
              {onClear === null ? null : (
                <DropdownMenuItem className="min-h-11" onClick={onClear}>
                  Clear
                </DropdownMenuItem>
              )}
              {onNewShell === null ? null : (
                <DropdownMenuItem className="min-h-11" onClick={onNewShell}>
                  New shell
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
            {actions === null ? null : (
              <>
                <DropdownMenuSeparator />
                <ShellMenuItems parts={DROPDOWN} shell={current} actions={actions} touch />
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {exits}
      {failure}
      <p className="text-meta text-muted-foreground">
        Shells run in the workspace, so {sharedWith(sessions)} what you change here. They don't send
        anything to an agent.
      </p>
    </div>
  );
}

/**
 * No terminal to show: still reading, none open, the workspace stopped, or none this person may
 * see.
 */
function Nothing({
  ready,
  runs,
  watches,
  owner,
  newShell,
  failure,
  opening,
}: {
  readonly ready: boolean;
  readonly runs: boolean;
  readonly watches: boolean;
  readonly owner: string;
  readonly newShell: ReactNode;
  readonly failure: ReactNode;
  readonly opening: boolean;
}) {
  const words = !ready
    ? "Reading this workspace's shells…"
    : !watches
      ? `Only ${owner} and the people they share control with see this workspace's shells.`
      : opening
        ? "Opening a shell…"
        : runs
          ? "No shells are open in this workspace."
          : "This workspace isn't running. Its shells stopped when its last session stopped.";
  return (
    <div role="status" className="flex flex-col items-start gap-3 px-6 py-6 max-lg:px-4">
      <p className="text-row text-muted-foreground">{words}</p>
      {ready && watches ? newShell : null}
      {failure}
    </div>
  );
}
