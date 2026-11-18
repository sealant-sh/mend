import { resumesOwnHarness, serviceConnectCommand } from "@mend/domain/workbench";
import { InlineAlert } from "@mend/ui/components/banner";
import { CopyField } from "@mend/ui/components/copy-field";
import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import { Checkbox } from "@mend/ui/components/ui/checkbox";
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
import { Field, FieldDescription, FieldError, FieldLabel } from "@mend/ui/components/ui/field";
import { Input } from "@mend/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@mend/ui/components/ui/native-select";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AppWindowIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LockIcon,
  PlayIcon,
  RotateCwIcon,
  ServerIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useId, useState } from "react";

import { Overlay } from "#/components/projects/overlay";
import { QueryError } from "#/components/route-screens";
import { useSessionFacts } from "#/components/session/session-facts";
import type { ServiceRecipeDto } from "#/lib/api";
import { usePhone } from "#/lib/phone";
import { joinPath, previewShowing, type PreviewShowing, usePageAt } from "#/lib/previews";
import { failureWords } from "#/lib/refusal";
import { sessionDetailQuery } from "#/lib/session-queries";
import { useTRPC, useTRPCClient } from "#/lib/trpc";
import { useSecond } from "#/lib/use-second";
import {
  lastLogLine,
  latestSupervisedAttempt,
  logLines,
  portText,
  previewFact,
  previewLines,
  serviceOpen,
  type ServiceOpen,
  type WorkspaceService,
} from "#/lib/workspace-services";
import { shellAccess } from "#/lib/workspace-shells";

import type { ViewFacts, ViewPlace, WorkspaceView } from "../views.tsx";
import {
  useOnMendHost,
  usePickedService,
  useServiceLog,
  useShownService,
  useWorkspaceServices,
} from "./use-workspace-services.ts";

/**
 * How the view lays itself out in its tile (Doop "Preview · this workspace's services", its phone
 * copy, T13): the services beside the page in a large tile, a picker over it in a narrow one or on
 * a phone, and the page alone under its address bar in a short one.
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
interface CommandStart {
  readonly command: string;
  readonly port: number;
  readonly name: string | null;
  readonly browserScheme: "http" | "https" | null;
  readonly udp: boolean;
}

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

  const recipeFailure = (recipe: ServiceRecipeDto) =>
    startRecipe.isError && startRecipe.variables.name === recipe.name
      ? failureWords(startRecipe.error, `Mend couldn't start ${recipe.name}. Try again.`)
      : null;
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
    <Button variant="outline" size={touch} onClick={() => setRunning(true)}>
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
              failure={recipeFailure}
            />
          ) : null}
          <div className="flex flex-col items-start gap-2 px-4 pt-3">
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
            onRunCommand={starts ? () => setRunning(true) : null}
            onShowLog={current?.logProcessId === null ? null : () => setLogOpen(true)}
            onRestart={steers && current !== null ? () => setRestarting(current) : null}
            onStop={steers && current !== null ? () => stop.mutate(current) : null}
          />
          {startRecipe.isError ? (
            <p role="alert" className="text-meta text-destructive">
              {failureWords(startRecipe.error, "Mend couldn't start the service. Try again.")}
            </p>
          ) : null}
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
  failure,
}: {
  readonly recipes: ReadonlyArray<ServiceRecipeDto>;
  readonly starts: boolean;
  readonly starting: string | null;
  readonly onStart: (recipe: ServiceRecipeDto) => void;
  readonly failure: (recipe: ServiceRecipeDto) => string | null;
}) {
  return (
    <section aria-label="Declared in .mend/mend.toml" className="flex flex-col pt-3">
      <h3 className="px-4 pb-1 text-meta text-muted-foreground">
        Declared in <span className="font-mono">.mend/mend.toml</span>
      </h3>
      <ul className="flex flex-col gap-0.5 px-2">
        {recipes.map((recipe) => {
          const failed = failure(recipe);
          return (
            <li key={recipe.name} className="flex flex-col gap-1 px-2 py-2">
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
              {failed === null ? null : (
                <p role="alert" className="pl-6.5 text-meta text-destructive">
                  {failed}
                </p>
              )}
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
      service={current}
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

const LINK_WHY: Record<Extract<PreviewShowing, { _tag: "Link" }>["why"], (name: string) => string> =
  {
    "another-site": () =>
      "Previews are on a different site from this page, and a browser doesn't keep a preview signed in inside another site's page. Open it in a new tab: Mend signs you in to it there.",
    "own-address": (name) =>
      `${name} opens at its own address, which Mend doesn't show inside the view. Open it in a new tab.`,
  };

/**
 * The page, under its address bar: reload, the path, open in a new tab. The address is the
 * Service's and the path typed here: a page on another site can't be read from this one, so a
 * link followed inside the frame doesn't change it.
 *
 * The frame's `sandbox`, flag by flag. `allow-scripts`, `allow-forms` and `allow-modals`: the app
 * runs, submits its forms and shows its dialogs. `allow-same-origin`: the app keeps its own
 * origin, so its sign-in cookie and storage work. That origin is a preview host, never Mend's, so
 * together with `allow-scripts` it reaches nothing of Mend's: not its cookies, its storage or
 * this page. `allow-popups`: links that open a tab of their own still open, sandboxed alike. No
 * `allow-top-navigation`, so the app cannot take this tab away from Mend.
 */
function Page({
  base,
  service,
  showing,
  layout,
  line,
}: {
  readonly base: string;
  readonly service: WorkspaceService;
  readonly showing: PreviewShowing;
  readonly layout: Layout;
  /** The preview's newest status line ("preview · web · answered HTTP 200 · observed 4 s ago"). */
  readonly line: string | null;
}) {
  const [path, setPath] = useState("/");
  const [shown, setShown] = useState("/");
  const [reload, setReload] = useState(0);
  const src = joinPath(base, shown);
  const id = useId();
  const signedIn = base.startsWith("/");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          "flex shrink-0 items-center gap-1.5 border-b",
          layout === "picker" ? "px-4 py-2" : "px-3 py-2",
        )}
      >
        {showing._tag === "Frame" ? (
          <Button
            variant="ghost"
            size={layout === "picker" ? "icon-touch" : "icon-sm"}
            aria-label="Reload"
            title="Reload"
            onClick={() => setReload((count) => count + 1)}
          >
            <RotateCwIcon />
          </Button>
        ) : null}
        <form
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg bg-muted px-2.5 max-lg:h-11"
          onSubmit={(event) => {
            event.preventDefault();
            setShown(path);
            setReload((count) => count + 1);
          }}
        >
          {signedIn ? (
            <LockIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <AppWindowIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <label htmlFor={id} className="shrink-0 font-mono text-meta text-muted-foreground">
            {service.name}
            {portText(service.port, service.udp)}
          </label>
          <input
            id={id}
            value={path}
            spellCheck={false}
            autoComplete="off"
            aria-label={`Path on ${service.name}`}
            onChange={(event) => setPath(event.target.value)}
            className="min-w-0 flex-1 bg-transparent font-mono text-meta text-foreground outline-none"
          />
        </form>
        <a
          href={src}
          target="_blank"
          rel="noreferrer"
          aria-label="Open in a new tab"
          title="Open in a new tab"
          className={cn(
            buttonVariants({
              variant: layout === "list" ? "outline" : "ghost",
              size: layout === "list" ? "sm" : layout === "picker" ? "icon-touch" : "icon-sm",
            }),
          )}
        >
          {layout === "list" ? "Open in new tab" : <ExternalLinkIcon />}
        </a>
      </div>
      {showing._tag === "Frame" ? (
        <div
          className={cn(
            "flex min-h-0 flex-1 bg-muted/40",
            layout === "alone" ? "" : "p-4 max-lg:p-3",
          )}
        >
          <iframe
            key={`${src}:${reload}`}
            title={`Preview of ${service.name}`}
            src={src}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            referrerPolicy="no-referrer"
            className={cn(
              "min-h-0 w-full flex-1 border-0 bg-white",
              layout !== "alone" && "rounded-xl border",
            )}
          />
        </div>
      ) : (
        <div className="flex flex-col items-start gap-3 px-6 py-6 max-lg:px-4">
          {line === null ? null : (
            <p className="font-mono text-meta break-words text-muted-foreground">{line}</p>
          )}
          <p className="max-w-prose text-row">{LINK_WHY[showing.why](service.name)}</p>
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ size: layout === "picker" ? "touch" : "sm" }))}
          >
            <ExternalLinkIcon aria-hidden />
            Open in a new tab
          </a>
        </div>
      )}
    </div>
  );
}

/**
 * A Service's log: one bar at the foot of the view with its newest line (the frame's "Logs · web
 * GET /checkout 200"), opening upward into the whole log; on a phone or a narrow tile, a sheet.
 */
function LogBar({
  service,
  open,
  onOpenChange,
  asSheet,
  actions,
}: {
  readonly service: WorkspaceService;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly asSheet: boolean;
  readonly actions: ReactNode;
}) {
  const log = useServiceLog(service.logProcessId, service.live);
  const lines =
    log.isPending || log.isError ? [] : logLines(log.data.pages.flatMap((page) => page.chunks));
  const last = lastLogLine(lines);
  const body = log.isPending ? (
    <p className="px-4 py-3 text-meta text-muted-foreground">Reading the log…</p>
  ) : log.isError ? (
    <div className="px-4 py-3">
      <QueryError error={log.error} retry={() => void log.refetch()} retrying={log.isFetching} />
    </div>
  ) : (
    <LogText lines={lines} name={service.name} live={service.live} />
  );
  const bar = (
    <div className="flex h-10 shrink-0 items-center gap-2 border-t px-3">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={asSheet ? undefined : open}
        onClick={() => onOpenChange(!open)}
        className="min-w-0 flex-1 justify-start gap-2 font-normal"
      >
        {open && !asSheet ? <ChevronDownIcon aria-hidden /> : <ChevronUpIcon aria-hidden />}
        <span className="shrink-0">Logs</span>
        <span className="min-w-0 truncate font-mono text-meta text-muted-foreground">
          {service.name}
          {last === null ? "" : ` ${last}`}
        </span>
      </Button>
      {actions}
    </div>
  );
  if (asSheet)
    return (
      <>
        {bar}
        <Overlay
          open={open}
          onOpenChange={onOpenChange}
          title={`${service.name}'s log`}
          description={`What ${service.name} printed, as Mend recorded it.`}
          size="md"
          footer={
            <Button variant="outline" size="touch" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          }
        >
          {body}
        </Overlay>
      </>
    );
  return (
    <>
      {open ? (
        <section
          aria-label={`${service.name}'s log`}
          className="flex max-h-[45%] min-h-40 shrink-0 flex-col border-t"
        >
          {body}
        </section>
      ) : null}
      {bar}
    </>
  );
}

function LogText({
  lines,
  name,
  live,
}: {
  readonly lines: ReadonlyArray<string>;
  readonly name: string;
  readonly live: boolean;
}) {
  // Kept at the newest line while it follows, as a terminal would.
  const follow = useCallback((element: HTMLPreElement | null) => {
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, []);
  if (lines.length === 0)
    return (
      <p className="px-4 py-3 text-meta text-muted-foreground">
        {live ? `${name} hasn't printed anything yet.` : `${name} printed nothing.`}
      </p>
    );
  return (
    <pre
      ref={follow}
      key={lines.length}
      className="min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-meta leading-relaxed whitespace-pre-wrap text-foreground"
    >
      {lines.join("\n")}
    </pre>
  );
}

/**
 * Run a command as a Service in this workspace, or adopt a port something already listens on:
 * one-off, nothing saved. What every session starts with comes from `.mend/mend.toml` (decision
 * D8), so the dialog says where to declare it for good.
 */
function RunCommandDialog({
  open,
  onOpenChange,
  pending,
  failure,
  onRun,
  sessions,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly pending: boolean;
  readonly failure: string | null;
  readonly onRun: (start: CommandStart) => void;
  readonly sessions: number;
}) {
  const ids = useId();
  const phone = usePhone();
  const touch = phone ? "touch" : "default";
  const [command, setCommand] = useState("");
  const [port, setPort] = useState("");
  const [name, setName] = useState("");
  const [scheme, setScheme] = useState<"" | "http" | "https">("http");
  const [udp, setUdp] = useState(false);
  const [tried, setTried] = useState(false);
  const portNumber = Number(port.trim());
  const portProblem =
    !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535
      ? "Enter the port it listens on, between 1 and 65535."
      : null;
  const submit = () => {
    setTried(true);
    if (portProblem !== null || pending) return;
    onRun({
      command: command.trim(),
      port: portNumber,
      name: name.trim() === "" ? null : name.trim(),
      browserScheme: scheme === "" ? null : scheme,
      udp,
    });
  };
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setTried(false);
      }}
      title="Run a command"
      description={
        <>
          It runs in this workspace until it stops
          {sessions > 1 ? ", and every session here can use it" : ""}. To start it with every
          session, declare it in <span className="font-mono">.mend/mend.toml</span>.
        </>
      }
      size="md"
      footer={
        <>
          <Button variant="outline" size={touch} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form={`${ids}-form`} size={touch} disabled={pending}>
            {pending ? "Starting…" : command.trim() === "" ? "Adopt port" : "Run"}
          </Button>
        </>
      }
    >
      <form
        id={`${ids}-form`}
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${ids}-command`}>Command</FieldLabel>
          <Input
            id={`${ids}-command`}
            value={command}
            autoComplete="off"
            spellCheck={false}
            placeholder="pnpm dev"
            className={cn("font-mono", phone && "h-11")}
            onChange={(event) => setCommand(event.target.value)}
          />
          <FieldDescription>
            Leave it empty to adopt a port something in the workspace already listens on.
          </FieldDescription>
        </Field>
        <div className="flex gap-3 max-sm:flex-col">
          <Field data-invalid={tried && portProblem !== null ? true : undefined}>
            <FieldLabel htmlFor={`${ids}-port`}>Port</FieldLabel>
            <Input
              id={`${ids}-port`}
              value={port}
              inputMode="numeric"
              autoComplete="off"
              placeholder="3000"
              aria-invalid={tried && portProblem !== null ? true : undefined}
              className={cn("font-mono", phone && "h-11")}
              onChange={(event) => setPort(event.target.value)}
            />
            {tried && portProblem !== null ? <FieldError>{portProblem}</FieldError> : null}
          </Field>
          <Field>
            <FieldLabel htmlFor={`${ids}-name`}>Name</FieldLabel>
            <Input
              id={`${ids}-name`}
              value={name}
              autoComplete="off"
              spellCheck={false}
              placeholder="web"
              className={cn("font-mono", phone && "h-11")}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor={`${ids}-scheme`}>Opens in a browser</FieldLabel>
          <NativeSelect
            id={`${ids}-scheme`}
            value={udp ? "" : scheme}
            disabled={udp}
            className={phone ? "h-11" : undefined}
            onChange={(event) => {
              const value = event.target.value;
              setScheme(value === "http" || value === "https" ? value : "");
            }}
          >
            <NativeSelectOption value="http">Yes, over http</NativeSelectOption>
            <NativeSelectOption value="https">Yes, over https</NativeSelectOption>
            <NativeSelectOption value="">No, it isn't a web page</NativeSelectOption>
          </NativeSelect>
        </Field>
        <Field orientation="horizontal">
          <Checkbox
            id={`${ids}-udp`}
            checked={udp}
            onCheckedChange={(checked) => setUdp(checked)}
          />
          <FieldLabel htmlFor={`${ids}-udp`} className="font-normal">
            It speaks UDP
          </FieldLabel>
        </Field>
        {failure === null ? null : (
          <InlineAlert size={touch} title="It didn't start.">
            {failure}
          </InlineAlert>
        )}
      </form>
    </Overlay>
  );
}

/** The Preview view (ADR 0026): this workspace's services, and the page one of them serves. */
export const PREVIEW_VIEW: WorkspaceView = {
  id: "preview",
  name: "Preview",
  icon: <AppWindowIcon />,
  useFacts: usePreviewFacts,
  Body: PreviewBody,
};
