import { resumesOwnHarness, serviceConnectCommand } from "@mend/domain/workbench";
import { InlineAlert } from "@mend/ui/components/banner";
import { CopyField } from "@mend/ui/components/copy-field";
import { Button } from "@mend/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mend/ui/components/ui/dropdown-menu";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AppWindowIcon, ChevronDownIcon, GlobeIcon, PlayIcon, ServerIcon } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";

import { Overlay } from "#/components/projects/overlay";
import { QueryError } from "#/components/route-screens";
import { useSessionFacts } from "#/components/session/session-facts";
import type { ServiceRecipeDto } from "#/lib/api";
import { usePhone } from "#/lib/phone";
import { previewShowing, type PreviewShowing, usePageAt } from "#/lib/previews";
import { failureWords } from "#/lib/refusal";
import { sessionDetailQuery } from "#/lib/session-queries";
import { useTRPC, useTRPCClient } from "#/lib/trpc";
import { useSecond } from "#/lib/use-second";
import {
  latestSupervisedAttempt,
  portText,
  previewFact,
  previewLines,
  serviceOpen,
  type ServiceOpen,
  type WorkspaceService,
} from "#/lib/workspace-services";
import { shellAccess } from "#/lib/workspace-shells";

import type { ViewFacts, ViewPlace, WorkspaceView } from "../views.tsx";
import { type Layout, Page } from "./preview-page.tsx";
import { type CommandStart, RunCommandDialog } from "./run-command-dialog.tsx";
import { LogBar } from "./service-log.tsx";
import {
  useOnMendHost,
  usePickedService,
  useShownService,
  useWorkspaceServices,
} from "./use-workspace-services.ts";

const LIST_MIN_WIDTH = 720;
const LIST_MIN_HEIGHT = 420;
const PICKER_MIN_HEIGHT = 360;

const layoutOf = (box: { readonly width: number; readonly height: number } | null): Layout => {
  if (box === null) return "alone";
  if (box.width >= LIST_MIN_WIDTH && box.height >= LIST_MIN_HEIGHT) return "list";
  if (box.width < LIST_MIN_WIDTH && box.height >= PICKER_MIN_HEIGHT) return "picker";
  return "alone";
};

/** The size of the element `ref` is given, as it changes; null until first measured. */
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

/** The Preview tab's and its "+" item's fact: the port of the Service it shows, while it runs. */
const usePreviewFacts = (place: ViewPlace): ViewFacts => {
  const { services } = useWorkspaceServices(place);
  const fact = previewFact(useShownService(place, services));
  return fact === undefined ? {} : { fact };
};

/** "Both sessions in fix-retry use these services. If you restart one, it restarts for both." */
const sharedNote = (sessions: number, worktree: ReactNode): ReactNode =>
  sessions <= 1 ? (
    <>
      Services run in the workspace, beside its sessions. What each one runs comes from{" "}
      <span className="font-mono">.mend/mend.toml</span> or a command you start here.
    </>
  ) : (
    <>
      {sessions === 2 ? "Both sessions" : `All ${sessions} sessions`} in {worktree} use these
      services. If you restart one, it restarts for {sessions === 2 ? "both" : "all of them"}.
    </>
  );

/** What a person typed into Run a command, as the server takes it. */
function PreviewBody({ place }: { readonly place: ViewPlace }) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const facts = useSessionFacts(place.sessionId);
  const workspace = useWorkspaceServices(place);
  const { sessions, services, offered, recipes, previews, runs } = workspace;
  const access = shellAccess(sessions, place.sessionId, facts.viewerId);
  const [, pick] = usePickedService(place.worktreeId);
  const current = useShownService(place, services);
  const onMendHost = useOnMendHost();
  const page = usePageAt();
  const phone = usePhone();
  const { box, ref } = useBoxSize();
  const layout = phone ? "picker" : layoutOf(box);
  const touch = layout === "picker" ? "touch" : "sm";

  const opensOn = access.opensOn;
  const ownerName = (sessionId: string) => {
    const owner = sessions.find((session) => session.id === sessionId)?.ownerUserId ?? null;
    return owner === null ? "its owner" : (facts.nameOf(owner) ?? "its owner");
  };

  const settle = () =>
    Promise.all([
      queryClient.invalidateQueries(trpc.services.list.pathFilter()),
      queryClient.invalidateQueries(trpc.worktrees.previews.pathFilter()),
      queryClient.invalidateQueries(trpc.sessions.pathFilter()),
    ]);

  const startRecipe = useMutation({
    mutationFn: (recipe: ServiceRecipeDto) => {
      if (opensOn === null) throw new Error("Only the owner of a session here starts services.");
      return client.sessions.runServiceRecipe.mutate({ id: opensOn, name: recipe.name });
    },
    onMutate: (recipe) => pick(recipe.name),
    onSettled: settle,
  });
  const [running, setRunning] = useState(false);
  // Each opening of Run a command starts with empty fields.
  const [opened, setRuns] = useState(0);
  const openRunCommand = () => {
    setRuns((count) => count + 1);
    setRunning(true);
  };
  const runCommand = useMutation({
    mutationFn: (start: CommandStart) => {
      if (opensOn === null) throw new Error("Only the owner of a session here starts services.");
      const declared = {
        port: start.port,
        name: start.name,
        protocol: start.udp ? ("udp" as const) : ("tcp" as const),
        browserScheme: start.udp ? null : start.browserScheme,
      };
      return start.command === ""
        ? client.sessions.addService.mutate({ id: opensOn, ...declared })
        : client.sessions.runService.mutate({
            id: opensOn,
            argv: ["sh", "-c", start.command],
            ...declared,
          });
    },
    onSuccess: (view) => {
      pick(view.service.name);
      setRunning(false);
    },
    onSettled: settle,
  });
  const runAgain = useMutation({
    mutationFn: (service: WorkspaceService) => {
      const attempt = latestSupervisedAttempt(service.view);
      if (attempt === null) throw new Error(`${service.name} has no command to run again.`);
      return client.sessions.runService.mutate({
        id: service.view.service.sessionId,
        argv: attempt.argv,
        port: service.port,
        name: service.name,
        protocol: service.view.service.transport,
        browserScheme: service.view.service.browserScheme,
      });
    },
    onSettled: settle,
  });
  const [restarting, setRestarting] = useState<WorkspaceService | null>(null);
  const restart = useMutation({
    mutationFn: (service: WorkspaceService) =>
      client.services.restart.mutate({ id: service.view.service.id }),
    onSuccess: () => setRestarting(null),
    onSettled: settle,
  });
  const stop = useMutation({
    mutationFn: (service: WorkspaceService) =>
      client.services.stop.mutate({ id: service.view.service.id }),
    onError: (cause, service) =>
      toast.add({
        description: failureWords(cause, `Mend couldn't stop ${service.name}. Try again.`),
        priority: "low",
      }),
    onSettled: settle,
  });

  // A stopped workspace comes back with a session, as the Terminal view brings it back: a
  // conversation resumes as itself, any other session as a shell.
  const resume = useMutation({
    mutationFn: async (sessionId: string) => {
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
    },
    onSettled: settle,
  });

  const [logOpen, setLogOpen] = useState(false);
  const now = useSecond();

  if (workspace.failed !== null || workspace.list.isError)
    return (
      <div className="mx-auto w-full max-w-conversation px-4 py-6">
        <QueryError
          error={workspace.failed ?? workspace.list.error}
          retry={() => {
            workspace.retry();
            void workspace.list.refetch();
          }}
          retrying={workspace.retrying || workspace.list.isFetching}
        />
      </div>
    );

  const ready = workspace.ready && !workspace.list.isPending;
  const starts = runs && opensOn !== null;
  const open = current === null ? null : serviceOpen(current, previews, onMendHost);
  const base = open?._tag === "Open" ? open.href : null;
  const showing =
    base === null
      ? null
      : previewShowing(base, workspace.previewsRead.data?.frameSite ?? null, page);
  const startingRecipe = startRecipe.isPending ? startRecipe.variables.name : null;

  // Said under the list rather than on the recipe's row: a start that failed lists the Service
  // that ended, and its recipe row goes.
  const startFailure = startRecipe.isError ? (
    <p role="alert" className="text-meta text-destructive">
      {startRecipe.variables.name} didn't start.{" "}
      {failureWords(startRecipe.error, "Mend didn't say why. Try again.")}
    </p>
  ) : null;
  const fileTrouble = recipes.isError ? (
    <InlineAlert
      size={touch === "touch" ? "touch" : "default"}
      title=".mend/mend.toml couldn't be read."
      actions={
        <Button
          variant="outline"
          size={touch}
          disabled={recipes.isFetching}
          onClick={() => void recipes.refetch()}
        >
          {recipes.isFetching ? "Reading…" : "Read it again"}
        </Button>
      }
    >
      {failureWords(recipes.error, "Mend didn't say why.")} Fix the file in the worktree.
    </InlineAlert>
  ) : null;
  const whoStarts =
    runs && opensOn === null && sessions.length > 0 ? (
      <p className="text-meta text-muted-foreground">
        Only {ownerName(place.sessionId)} starts services in this workspace.
      </p>
    ) : null;
  const runCommandButton = starts ? (
    <Button variant="outline" size={touch} onClick={openRunCommand}>
      Run a command…
    </Button>
  ) : null;

  const pane = (
    <Pane
      ready={ready}
      runs={runs}
      current={current}
      open={open}
      showing={showing}
      base={base}
      layout={layout}
      lines={current === null ? [] : previewLines(previews, current, now)}
      startingRecipe={startingRecipe}
      hasRecipes={offered.length > 0}
      starts={starts}
      onResume={
        !runs && opensOn !== null
          ? {
              pending: resume.isPending,
              failure: resume.isError
                ? failureWords(resume.error, "Mend couldn't start the workspace. Try again.")
                : null,
              go: () => resume.mutate(opensOn),
            }
          : null
      }
      onRunAgain={
        current !== null &&
        !current.live &&
        runs &&
        current.command !== null &&
        access.types(current.sessionId)
          ? {
              pending: runAgain.isPending,
              failure: runAgain.isError
                ? failureWords(runAgain.error, `Mend couldn't start ${current.name}. Try again.`)
                : null,
              go: () => runAgain.mutate(current),
            }
          : null
      }
      onShowLog={current?.logProcessId === null ? null : () => setLogOpen(true)}
      owner={ownerName(place.sessionId)}
    />
  );

  const steers = current !== null && current.live && access.watches(current.sessionId);
  const logBar =
    current === null || current.logProcessId === null ? null : (
      <LogBar
        key={current.logProcessId}
        service={current}
        open={logOpen}
        onOpenChange={setLogOpen}
        asSheet={layout !== "list"}
        actions={
          steers ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={restart.isPending}
                onClick={() => setRestarting(current)}
              >
                Restart service…
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={stop.isPending}
                onClick={() => stop.mutate(current)}
              >
                {stop.isPending ? "Stopping…" : "Stop"}
              </Button>
            </>
          ) : null
        }
      />
    );

  return (
    <div
      ref={ref}
      className={cn("flex min-h-0 flex-1", layout === "list" ? "flex-row" : "flex-col")}
    >
      {layout === "list" ? (
        <nav
          aria-label="This workspace's services"
          className="flex w-72 shrink-0 flex-col border-r"
        >
          <h2 className="px-4 pt-4 pb-2 text-row font-semibold">This workspace's services</h2>
          <ServiceRows
            services={services}
            current={current}
            onPick={pick}
            starting={startingRecipe}
          />
          {offered.length > 0 ? (
            <RecipeRows
              recipes={offered}
              starts={starts}
              starting={startingRecipe}
              onStart={(recipe) => startRecipe.mutate(recipe)}
            />
          ) : null}
          <div className="flex flex-col items-start gap-2 px-4 pt-3">
            {startFailure}
            {fileTrouble}
            {whoStarts}
            {runCommandButton}
          </div>
          <p className="mt-auto px-4 pt-4 pb-4 text-meta text-muted-foreground">
            {sharedNote(sessions.length, <span className="font-mono">{facts.worktreeName}</span>)}
          </p>
        </nav>
      ) : null}
      {layout === "picker" ? (
        <div className="flex shrink-0 flex-col gap-2 border-b px-4 pt-3 pb-3">
          <h2 className="text-row font-semibold">This workspace's services</h2>
          <ServicePicker
            services={services}
            current={current}
            onPick={pick}
            recipes={starts ? offered : []}
            starting={startingRecipe}
            onStart={(recipe) => startRecipe.mutate(recipe)}
            onRunCommand={starts ? openRunCommand : null}
            onShowLog={current?.logProcessId === null ? null : () => setLogOpen(true)}
            onRestart={steers && current !== null ? () => setRestarting(current) : null}
            onStop={steers && current !== null ? () => stop.mutate(current) : null}
          />
          {startFailure}
          {fileTrouble}
          {whoStarts}
          <p className="text-meta text-muted-foreground">
            {sharedNote(sessions.length, "this workspace")}
          </p>
        </div>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {pane}
        {logBar}
      </div>
      <RunCommandDialog
        key={opened}
        open={running}
        onOpenChange={(next) => {
          setRunning(next);
          if (!next) runCommand.reset();
        }}
        pending={runCommand.isPending}
        failure={
          runCommand.isError
            ? failureWords(runCommand.error, "Mend couldn't start it. Try again.")
            : null
        }
        onRun={(start) => runCommand.mutate(start)}
        sessions={sessions.length}
      />
      <Overlay
        open={restarting !== null}
        onOpenChange={(next) => {
          if (!next) {
            setRestarting(null);
            restart.reset();
          }
        }}
        title={`Restart ${restarting?.name ?? "this service"}?`}
        description={
          sessions.length > 1
            ? `It stops and runs again on ${portText(restarting?.port ?? 0)}. Every session in this workspace uses it, so it restarts for them too.`
            : `It stops and runs again on ${portText(restarting?.port ?? 0)}.`
        }
        size="sm"
        footer={
          <>
            <Button variant="outline" size={touch} onClick={() => setRestarting(null)}>
              Cancel
            </Button>
            <Button
              size={touch}
              disabled={restart.isPending}
              onClick={() => {
                if (restarting !== null) restart.mutate(restarting);
              }}
            >
              {restart.isPending ? "Restarting…" : "Restart"}
            </Button>
          </>
        }
      >
        {restart.isError ? (
          <p role="alert" className="text-meta text-destructive">
            {failureWords(restart.error, "Mend couldn't restart it. Try again.")}
          </p>
        ) : null}
      </Overlay>
    </div>
  );
}

const serviceIcon = (service: { readonly web: boolean }) =>
  service.web ? (
    <GlobeIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
  ) : (
    <ServerIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
  );

/** A Service's line under its name: "Running · pnpm dev". */
const serviceLine = (service: WorkspaceService): ReactNode => (
  <>
    <span className={cn(service.state.tone === "bad" && "text-destructive")}>
      {service.state.word}
    </span>
    {" · "}
    {service.command ?? "an adopted port"}
  </>
);

/** The Services, live first, then the latest that ended (the frame's left column). */
function ServiceRows({
  services,
  current,
  onPick,
  starting,
}: {
  readonly services: ReadonlyArray<WorkspaceService>;
  readonly current: WorkspaceService | null;
  readonly onPick: (name: string) => void;
  readonly starting: string | null;
}) {
  if (services.length === 0 && starting === null) return null;
  return (
    <ul className="flex flex-col gap-0.5 px-2">
      {services.map((service) => (
        <li key={service.id}>
          <button
            type="button"
            aria-current={service.id === current?.id ? "true" : undefined}
            onClick={() => onPick(service.name)}
            className={cn(
              "flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-hover",
              service.id === current?.id && "bg-selection hover:bg-selection",
            )}
          >
            {serviceIcon(service)}
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-mono text-row">
                {service.name}{" "}
                <span className="text-muted-foreground">{portText(service.port, service.udp)}</span>
              </span>
              <span className="truncate text-meta text-muted-foreground">
                {serviceLine(service)}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The recipes `.mend/mend.toml` declares that nothing here runs, each with Start. */
function RecipeRows({
  recipes,
  starts,
  starting,
  onStart,
}: {
  readonly recipes: ReadonlyArray<ServiceRecipeDto>;
  readonly starts: boolean;
  readonly starting: string | null;
  readonly onStart: (recipe: ServiceRecipeDto) => void;
}) {
  return (
    <section aria-label="Declared in .mend/mend.toml" className="flex flex-col pt-3">
      <h3 className="px-4 pb-1 text-meta text-muted-foreground">
        Declared in <span className="font-mono">.mend/mend.toml</span>
      </h3>
      <ul className="flex flex-col gap-0.5 px-2">
        {recipes.map((recipe) => {
          return (
            <li key={recipe.name} className="px-2 py-2">
              <div className="flex items-start gap-2.5">
                {serviceIcon({ web: recipe.browserScheme !== null })}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate font-mono text-row">
                    {recipe.name}{" "}
                    <span className="text-muted-foreground">
                      {portText(recipe.port, recipe.protocol === "udp")}
                    </span>
                  </span>
                  <span className="truncate text-meta text-muted-foreground">
                    {starting === recipe.name ? "Starting" : "Not running"} ·{" "}
                    {recipe.command ?? "adopts a port"}
                  </span>
                </span>
                {starts ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={starting !== null}
                    aria-label={`Start ${recipe.name}`}
                    onClick={() => onStart(recipe)}
                  >
                    {starting === recipe.name ? "Starting…" : "Start"}
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** A narrow tile's or a phone's services: one picker holding them and what to do with them. */
function ServicePicker({
  services,
  current,
  onPick,
  recipes,
  starting,
  onStart,
  onRunCommand,
  onShowLog,
  onRestart,
  onStop,
}: {
  readonly services: ReadonlyArray<WorkspaceService>;
  readonly current: WorkspaceService | null;
  readonly onPick: (name: string) => void;
  readonly recipes: ReadonlyArray<ServiceRecipeDto>;
  readonly starting: string | null;
  readonly onStart: (recipe: ServiceRecipeDto) => void;
  readonly onRunCommand: (() => void) | null;
  readonly onShowLog: (() => void) | null;
  readonly onRestart: (() => void) | null;
  readonly onStop: (() => void) | null;
}) {
  const count = services.length === 1 ? "1 service" : `${services.length} services`;
  return (
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
        {current === null ? (
          <span className="min-w-0 flex-1 truncate text-row text-muted-foreground">
            {starting === null ? "No services running" : `Starting ${starting}…`}
          </span>
        ) : (
          <>
            {serviceIcon(current)}
            <span className="min-w-0 flex-1 truncate">
              <span className="font-mono text-row">
                {current.name} {portText(current.port, current.udp)}
              </span>
              <span className="text-meta text-muted-foreground"> · {current.state.word}</span>
            </span>
          </>
        )}
        <span className="shrink-0 text-meta text-muted-foreground">{count}</span>
        <ChevronDownIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-(--anchor-width)">
        {services.length === 0 ? null : (
          <DropdownMenuGroup>
            <DropdownMenuRadioGroup
              value={current?.name ?? ""}
              onValueChange={(name: string) => onPick(name)}
            >
              {services.map((service) => (
                <DropdownMenuRadioItem key={service.id} value={service.name} className="min-h-11">
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-mono">
                      {service.name} {portText(service.port, service.udp)}
                    </span>
                    <span className="truncate text-meta text-muted-foreground">
                      {serviceLine(service)}
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        )}
        {recipes.length === 0 ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Declared in .mend/mend.toml</DropdownMenuLabel>
              {recipes.map((recipe) => (
                <DropdownMenuItem
                  key={recipe.name}
                  className="min-h-11"
                  disabled={starting !== null}
                  onClick={() => onStart(recipe)}
                >
                  <PlayIcon aria-hidden />
                  {starting === recipe.name ? `Starting ${recipe.name}…` : `Start ${recipe.name}`}
                  <span className="ml-auto font-mono text-meta text-muted-foreground">
                    {portText(recipe.port, recipe.protocol === "udp")}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </>
        )}
        {onRunCommand === null &&
        onShowLog === null &&
        onRestart === null &&
        onStop === null ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              {onShowLog === null || current === null ? null : (
                <DropdownMenuItem className="min-h-11" onClick={onShowLog}>
                  Show {current.name}'s log
                </DropdownMenuItem>
              )}
              {onRestart === null || current === null ? null : (
                <DropdownMenuItem className="min-h-11" onClick={onRestart}>
                  Restart {current.name}…
                </DropdownMenuItem>
              )}
              {onStop === null || current === null ? null : (
                <DropdownMenuItem className="min-h-11" variant="destructive" onClick={onStop}>
                  Stop {current.name}
                </DropdownMenuItem>
              )}
              {onRunCommand === null ? null : (
                <DropdownMenuItem className="min-h-11" onClick={onRunCommand}>
                  Run a command…
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A way forward a state offers: its control's pending word and failure sit beside it. */
interface Action {
  readonly pending: boolean;
  readonly failure: string | null;
  readonly go: () => void;
}

/**
 * What sits where the page shows: the page in a frame under its address bar, or, when it can't
 * show, the one reason and the way forward.
 */
function Pane({
  ready,
  runs,
  current,
  open,
  showing,
  base,
  layout,
  lines,
  startingRecipe,
  hasRecipes,
  starts,
  onResume,
  onRunAgain,
  onShowLog,
  owner,
}: {
  readonly ready: boolean;
  readonly runs: boolean;
  readonly current: WorkspaceService | null;
  readonly open: ServiceOpen | null;
  readonly showing: PreviewShowing | null;
  readonly base: string | null;
  readonly layout: Layout;
  readonly lines: ReadonlyArray<string>;
  readonly startingRecipe: string | null;
  readonly hasRecipes: boolean;
  readonly starts: boolean;
  readonly onResume: Action | null;
  readonly onRunAgain: Action | null;
  readonly onShowLog: (() => void) | null;
  readonly owner: string;
}) {
  if (!ready) return <Note>Reading this workspace's services…</Note>;
  if (!runs)
    return (
      <Note
        action={
          onResume === null ? null : (
            <ActionButton action={onResume} label="Resume" pendingLabel="Starting the workspace…" />
          )
        }
      >
        This workspace isn't running. Its services stopped when its last session stopped.
        {onResume === null ? ` Only ${owner} can resume it.` : ""}
      </Note>
    );
  const startingShown =
    startingRecipe !== null &&
    (current === null || (current.name === startingRecipe && !current.live));
  if (startingShown)
    return (
      <Note busy>
        Starting {startingRecipe}. Mend waits for its port to answer; its log shows what it prints.
      </Note>
    );
  if (current === null)
    return (
      <Note>
        Nothing runs in this workspace yet.{" "}
        {starts
          ? hasRecipes
            ? "Start a service .mend/mend.toml declares, or run a command."
            : "Declare services in .mend/mend.toml, or run a command."
          : `Services ${owner} starts here show up in this list.`}
      </Note>
    );
  if (!current.live)
    return (
      <Note
        action={
          <>
            {onRunAgain === null ? null : (
              <ActionButton action={onRunAgain} label="Run again" pendingLabel="Starting…" />
            )}
            {onShowLog === null ? null : (
              <Button
                variant="outline"
                size={layout === "picker" ? "touch" : "sm"}
                onClick={onShowLog}
              >
                Show the log
              </Button>
            )}
          </>
        }
      >
        {current.state.tone === "bad"
          ? `${current.name} ${current.state.word.toLowerCase()}. Its log says what happened.`
          : `${current.name} stopped.`}
      </Note>
    );
  if (current.state.word === "Starting")
    return (
      <Note busy>
        Starting {current.name}. Mend waits for {portText(current.port, current.udp)} to answer.
      </Note>
    );
  if (open === null || open._tag === "Waiting")
    return <Note busy>Reading this worktree's previews…</Note>;
  if (open._tag === "Tunnel")
    return (
      <Note
        action={
          <CopyField
            className="w-full max-w-md"
            value={serviceConnectCommand(current.name)}
            label="Copy command"
            size={layout === "picker" ? "touch" : "default"}
          />
        }
      >
        {current.name} answers only on Mend's own machine. This command brings it to this computer,
        signed in as you.
      </Note>
    );
  if (open._tag === "None" || base === null || showing === null)
    return (
      <Note>
        {open._tag === "None" && open.why !== null
          ? open.why
          : `${current.name} doesn't open in a browser.`}
      </Note>
    );
  return (
    <Page
      key={base}
      base={base}
      name={current.name}
      port={portText(current.port, current.udp)}
      showing={showing}
      layout={layout}
      line={lines[0] ?? null}
    />
  );
}

function Note({
  children,
  action,
  busy = false,
}: {
  readonly children: ReactNode;
  readonly action?: ReactNode;
  readonly busy?: boolean;
}) {
  return (
    <div role="status" className="flex flex-col items-start gap-3 px-6 py-6 max-lg:px-4">
      <p className="flex items-start gap-2 text-row text-muted-foreground">
        {busy ? <Spinner aria-hidden className="mt-0.5 size-4 shrink-0" /> : null}
        <span>{children}</span>
      </p>
      {action === undefined || action === null ? null : (
        <div className="flex flex-wrap items-center gap-2">{action}</div>
      )}
    </div>
  );
}

function ActionButton({
  action,
  label,
  pendingLabel,
}: {
  readonly action: Action;
  readonly label: string;
  readonly pendingLabel: string;
}) {
  const phone = usePhone();
  return (
    <span className="flex flex-col items-start gap-1.5">
      <Button
        variant="outline"
        size={phone ? "touch" : "sm"}
        disabled={action.pending}
        onClick={action.go}
      >
        {action.pending ? pendingLabel : label}
      </Button>
      {action.failure === null ? null : (
        <span role="alert" className="text-meta text-destructive">
          {action.failure}
        </span>
      )}
    </span>
  );
}

export const PREVIEW_VIEW: WorkspaceView = {
  id: "preview",
  name: "Preview",
  icon: <AppWindowIcon />,
  useFacts: usePreviewFacts,
  Body: PreviewBody,
};
