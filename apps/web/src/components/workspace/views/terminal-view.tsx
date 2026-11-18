import { agentStartingFacts, resumesOwnHarness } from "@mend/domain/workbench";
import { Button } from "@mend/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, SquareTerminalIcon } from "lucide-react";
import { type ReactNode, useCallback, useRef, useState } from "react";

import { Overlay } from "#/components/projects/overlay";
import { QueryError } from "#/components/route-screens";
import { useSessionFacts } from "#/components/session/session-facts";
import { SessionTerminal, type TerminalControls } from "#/components/terminal/session-terminal";
import { copyTextChecked } from "#/lib/clipboard";
import { age } from "#/lib/inbox";
import { failureWords } from "#/lib/refusal";
import { sessionDetailQuery } from "#/lib/session-queries";
import { useTRPC, useTRPCClient } from "#/lib/trpc";
import { useMinute } from "#/lib/use-inbox";
import {
  runningShellsFact,
  shellAccess,
  shellLine,
  type WorkspaceShell,
  workspaceRuns,
} from "#/lib/workspace-shells";

import type { ViewFacts, ViewPlace, WorkspaceView } from "../views.tsx";
import { useShellOnOwn, wantsShellOnOwn } from "./shell-on-own.ts";
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
  const [box, setBox] = useState<{ readonly width: number; readonly height: number } | null>(null);
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

/** The Terminal tab's and its "+" item's fact: how many shells run ("1 shell"). */
const useTerminalFacts = (place: ViewPlace): ViewFacts => {
  const { shells } = useWorkspaceShells(place);
  const fact = runningShellsFact(shells);
  return fact === undefined ? {} : { fact };
};

/** "both sessions", "all 3 sessions", "its session": who sees what a shell changes. */
const sharedWith = (count: number): string =>
  count <= 1 ? "its session sees" : count === 2 ? "both sessions see" : `all ${count} sessions see`;

function TerminalBody({ place }: { readonly place: ViewPlace }) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const facts = useSessionFacts(place.sessionId);
  const { sessions, shells, ready, failed, retrying, retry } = useWorkspaceShells(place);
  const access = shellAccess(sessions, place.sessionId, facts.viewerId);
  const runs = workspaceRuns(sessions);
  const now = useMinute();
  const { box, ref } = useBoxSize();
  const layout = layoutOf(box);
  const terminal = useRef<TerminalControls | null>(null);

  const visible = shells.filter((shell) => access.watches(shell.sessionId));
  const [picked, setPicked] = useState<string | null>(null);
  const current =
    visible.find((shell) => shell.key === picked) ??
    visible.find((shell) => shell.live) ??
    visible[0] ??
    null;
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
      liveTerminals: ready ? visible.filter((shell) => shell.live).length : null,
    }),
    openShell,
  );

  const [closing, setClosing] = useState<WorkspaceShell | null>(null);
  const stop = useMutation({
    mutationFn: (processId: string) => client.sessions.stopShell.mutate({ processId }),
    onSuccess: () => setClosing(null),
    onSettled: () => queryClient.invalidateQueries(trpc.sessions.pathFilter()),
  });

  const copy = async () => {
    const copied = await copyTextChecked(terminal.current?.text() ?? "");
    toast.add({
      description: copied
        ? "Copied the terminal's text."
        : "Couldn't copy. Select the text and press Ctrl C.",
    });
  };

  if (failed !== null)
    return (
      <div className="mx-auto w-full max-w-conversation px-4 py-6">
        <QueryError error={failed} retry={retry} retrying={retrying} />
      </div>
    );

  const typesHere = current !== null && current.live && access.types(current.sessionId);
  const opening = open.isPending
    ? step === "resuming"
      ? "Starting the workspace…"
      : "Opening…"
    : null;
  const newShell =
    opensOn === null ? null : (
      <Button
        variant="outline"
        size={layout === "picker" ? "touch" : "sm"}
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

  return (
    <div
      ref={ref}
      className={cn("flex min-h-0 flex-1", layout === "list" ? "flex-row" : "flex-col")}
    >
      {layout === "list" ? (
        <ShellList
          shells={visible}
          current={current}
          onPick={setPicked}
          line={(shell) => shellLine(shell, facts.nameOf, (date) => age(date, now))}
          sessions={sessions.length}
          runs={runs}
          newShell={newShell}
          failure={openFailed}
        />
      ) : null}
      {layout === "picker" ? (
        <ShellPicker
          shells={visible}
          current={current}
          onPick={setPicked}
          line={(shell) => shellLine(shell, facts.nameOf, (date) => age(date, now))}
          sessions={sessions.length}
          onNewShell={opensOn === null || open.isPending ? null : () => open.mutate(opensOn)}
          opening={opening}
          onClose={
            current !== null && current.processId !== null && typesHere
              ? () => setClosing(current)
              : null
          }
          onCopy={current === null ? null : () => void copy()}
          onClear={current === null ? null : () => terminal.current?.clear()}
          failure={openFailed}
        />
      ) : null}
      {/* The terminal stays in this place whatever the layout, so a resize never reopens it. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
            {current.processId !== null && typesHere ? (
              <Button variant="outline" size="sm" onClick={() => setClosing(current)}>
                Close shell…
              </Button>
            ) : null}
          </div>
        ) : null}
        {current !== null && current.live && !access.types(current.sessionId) ? (
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
            newShell={layout === "list" ? null : newShell}
            failure={layout === "list" ? null : openFailed}
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
        description="Whatever runs in it stops. What it printed stays in the session's record."
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
    </div>
  );
}

/** The shells column beside the terminal (the frame's left column). */
function ShellList({
  shells,
  current,
  onPick,
  line,
  sessions,
  runs,
  newShell,
  failure,
}: {
  readonly shells: ReadonlyArray<WorkspaceShell>;
  readonly current: WorkspaceShell | null;
  readonly onPick: (key: string) => void;
  readonly line: (shell: WorkspaceShell) => string;
  readonly sessions: number;
  readonly runs: boolean;
  readonly newShell: ReactNode;
  readonly failure: ReactNode;
}) {
  return (
    <nav aria-label="This workspace's shells" className="flex w-60 shrink-0 flex-col border-r">
      <div className="flex items-baseline justify-between px-4 pt-4 pb-2">
        <h2 className="text-row font-semibold">This workspace's shells</h2>
        <span className="text-meta text-muted-foreground tabular-nums">{shells.length}</span>
      </div>
      <ul className="flex min-h-0 flex-col gap-0.5 overflow-y-auto px-2">
        {shells.map((shell) => (
          <li key={shell.key}>
            <button
              type="button"
              aria-current={shell.key === current?.key ? "true" : undefined}
              onClick={() => onPick(shell.key)}
              className={cn(
                "flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-hover",
                shell.key === current?.key && "bg-selection hover:bg-selection",
              )}
            >
              <SquareTerminalIcon
                aria-hidden
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-row">{shell.name}</span>
                <span className="truncate text-meta text-muted-foreground">{line(shell)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-col items-start gap-2 px-4 pt-3">
        {runs ? null : (
          <p className="text-meta text-muted-foreground">
            This workspace isn't running. Its shells stopped when its last session stopped.
          </p>
        )}
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

/** A narrow tile's or a phone's shells: one picker over the terminal (the phone frame). */
function ShellPicker({
  shells,
  current,
  onPick,
  line,
  sessions,
  onNewShell,
  opening,
  onClose,
  onCopy,
  onClear,
  failure,
}: {
  readonly shells: ReadonlyArray<WorkspaceShell>;
  readonly current: WorkspaceShell | null;
  readonly onPick: (key: string) => void;
  readonly line: (shell: WorkspaceShell) => string;
  readonly sessions: number;
  readonly onNewShell: (() => void) | null;
  readonly opening: string | null;
  readonly onClose: (() => void) | null;
  readonly onCopy: (() => void) | null;
  readonly onClear: (() => void) | null;
  readonly failure: ReactNode;
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
              {opening ?? (shells.length === 1 ? "1 shell" : `${shells.length} shells`)}
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
            {onClose === null ? null : (
              <DropdownMenuItem className="min-h-11" variant="destructive" onClick={onClose}>
                Close {current.name}…
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {failure}
      <p className="text-meta text-muted-foreground">
        Shells run in the workspace, so {sharedWith(sessions)} what you change here. They don't send
        anything to an agent.
      </p>
    </div>
  );
}

/** No terminal to show: still reading, none open, the workspace stopped, or none to see. */
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

/** The Terminal view (ADR 0026): this workspace's shells, each a live terminal. */
export const TERMINAL_VIEW: WorkspaceView = {
  id: "terminal",
  name: "Terminal",
  icon: <SquareTerminalIcon />,
  useFacts: useTerminalFacts,
  Body: TerminalBody,
};
