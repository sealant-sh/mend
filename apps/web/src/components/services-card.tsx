import { Button } from "@mend/ui/components/ui/button";
import { Checkbox } from "@mend/ui/components/ui/checkbox";
import { Input } from "@mend/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@mend/ui/components/ui/native-select";
import { cn } from "@mend/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { StatusDot } from "#/components/status";

/** Row-scale quiet action, composed from the ui Button. */
function RowAction({ className, ...props }: React.ComponentProps<typeof Button>) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className={cn(
        "h-6 px-1.5 text-xs font-normal text-muted-foreground hover:text-ink",
        className,
      )}
      {...props}
    />
  );
}
import {
  addService,
  restartService,
  runService,
  runServiceRecipe,
  serviceEndpoint,
  serviceUrl,
  stopService,
  type ServiceRecipeDto,
  type ServiceViewDto,
  type SessionProcessDto,
} from "#/lib/api";
import { useTRPC } from "#/lib/trpc";

/**
 * The session's Services (docs/SESSION-SERVICES.md §presentation): what runs
 * and where it is reachable, plus the declared recipes as one-tap launchers.
 * Status words are observations — reachable means the forwarded port accepted
 * a connection, never a judgment about the application.
 */

const currentAttempt = (view: ServiceViewDto): SessionProcessDto | null =>
  view.service.currentAttemptId === null
    ? null
    : (view.attempts.find((attempt) => attempt.id === view.service.currentAttemptId) ?? null);

const latestSupervisedAttempt = (view: ServiceViewDto): SessionProcessDto | null =>
  view.attempts.findLast((attempt) => attempt.argv.length > 0) ?? null;

const currentObservation = (view: ServiceViewDto) =>
  view.currentForward !== null && view.latestObservation?.forwardId === view.currentForward.id
    ? view.latestObservation
    : null;

const serviceIsLive = (view: ServiceViewDto): boolean => {
  const attempt = currentAttempt(view);
  return (
    (attempt !== null && attempt.exitedAt === null) ||
    view.currentForward?.state === "binding" ||
    view.currentForward?.state === "bound"
  );
};

/** Machine-fact timestamp: superjson carries real Dates; render them tersely. */
const observedAt = (value: string | Date | null): string =>
  value === null ? "unknown" : value instanceof Date ? value.toLocaleString() : value;

const serviceStatus = (view: ServiceViewDto): string =>
  currentObservation(view)?.state ??
  view.currentForward?.state ??
  currentAttempt(view)?.status ??
  "stopped";

function ServiceStatusDot({ status }: { readonly status: string }) {
  const tone =
    status === "reachable"
      ? ("green" as const)
      : status === "unreachable"
        ? ("amber" as const)
        : status === "starting" || status === "running"
          ? ("accent" as const)
          : ("hollow" as const);
  return <StatusDot tone={tone} word={status} pulse={status === "starting"} />;
}

type ServiceVerb = "restart" | "stop" | "rerun";

function ServiceRow({
  service,
  actionable,
  pending,
  onAction,
  first,
}: {
  readonly service: ServiceViewDto;
  readonly actionable: boolean;
  readonly pending: string | null;
  readonly onAction: (verb: ServiceVerb, service: ServiceViewDto) => void;
  readonly first: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const stable = service.service;
  const attempt = currentAttempt(service);
  const rerunAttempt = latestSupervisedAttempt(service);
  const displayAttempt = attempt ?? rerunAttempt;
  const status = serviceStatus(service);
  const url = serviceUrl(service);
  const live = serviceIsLive(service);
  // What a client would connect to — the copyable fact. Dead forwards are
  // not offered: an ended Service has no host port worth pasting anywhere.
  const endpoint = live ? serviceEndpoint(service) : null;
  const exposedEndpoint =
    service.endpoints.find((candidate) => candidate.scope === "private") ??
    service.endpoints[0] ??
    null;
  const meta = [
    `:${stable.workspacePort}${stable.transport === "udp" ? "/udp" : ""}`,
    endpoint === null ? null : `→ ${endpoint}`,
    endpoint === null || exposedEndpoint === null
      ? null
      : `${exposedEndpoint.scope === "private" ? "private network" : "this machine"} · Mend auth: ${exposedEndpoint.mendAuthentication}`,
    !live && displayAttempt?.exitCode !== null && displayAttempt?.exitCode !== undefined
      ? `code ${displayAttempt.exitCode}`
      : null,
  ]
    .filter((part) => part !== null)
    .join(" ");

  const copy = () => {
    if (endpoint === null) return;
    void navigator.clipboard.writeText(endpoint).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      return null;
    });
  };

  return (
    <div className={`group px-4 py-3 ${first ? "" : "border-t border-rule-faint"}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 truncate font-sans text-[13px] font-medium text-ink">{stable.name}</p>
        <ServiceStatusDot status={status} />
      </div>
      <div className="mt-1 flex items-center justify-between gap-3">
        {endpoint === null ? (
          <p className="min-w-0 truncate font-mono text-[11px] text-faint">{meta}</p>
        ) : (
          <button
            type="button"
            onClick={copy}
            title={`Copy ${endpoint}`}
            className="min-w-0 cursor-pointer truncate text-left font-mono text-[11px] text-faint transition-colors hover:text-ink"
          >
            {meta}
          </button>
        )}
        <span className="flex shrink-0 items-center gap-2">
          {endpoint !== null && (
            <RowAction
              onClick={copy}
              className={
                copied
                  ? "text-success opacity-100 hover:text-success"
                  : "opacity-0 group-hover:opacity-100"
              }
            >
              {copied ? "Copied" : "Copy"}
            </RowAction>
          )}
          {live && url !== null && currentObservation(service)?.state === "reachable" && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="font-sans text-xs font-medium text-info hover:underline"
            >
              Open
            </a>
          )}
          {live && attempt !== null && attempt.argv.length > 0 && (
            <RowAction
              onClick={() => onAction("restart", service)}
              disabled={pending !== null}
              className="opacity-0 group-hover:opacity-100"
            >
              {pending === `restart:${stable.id}` ? "Restarting…" : "Restart"}
            </RowAction>
          )}
          {live && (
            <RowAction
              onClick={() => onAction("stop", service)}
              disabled={pending !== null}
              className="opacity-0 group-hover:opacity-100"
            >
              {pending === `stop:${stable.id}` ? "Stopping…" : "Stop"}
            </RowAction>
          )}
          {!live && actionable && rerunAttempt !== null && (
            <RowAction
              onClick={() => onAction("rerun", service)}
              disabled={pending !== null}
              className="font-medium text-info hover:text-info hover:underline"
            >
              {pending === `rerun:${stable.id}` ? "Starting…" : "Run"}
            </RowAction>
          )}
        </span>
      </div>
      {live && exposedEndpoint?.scope === "private" && (
        <p className="mt-2 border-l-2 border-warning pl-2 font-sans text-xs leading-relaxed text-warning">
          No Mend sign-in protects this port. Anyone who can reach this private address can connect.
        </p>
      )}
    </div>
  );
}

export function ServicesCard({
  sessionId,
  sessionLive,
  steer,
}: {
  readonly sessionId: string;
  readonly sessionLive: boolean;
  /** Whether the viewer may steer the session (docs/adr/0003); otherwise the card only reads. */
  readonly steer: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const serviceViews = useQuery(
    trpc.services.list.queryOptions(
      { all: true },
      { select: (views) => views.filter((view) => view.service.sessionId === sessionId) },
    ),
  );
  const recipes = useQuery(trpc.sessions.recipes.queryOptions({ id: sessionId }));
  const [pending, setPending] = useState<string | null>(null);

  const services = serviceViews.data ?? [];
  const liveServices = services.filter(serviceIsLive);
  const canStart = steer && (sessionLive || liveServices.length > 0);
  const liveNames = new Set(liveServices.map((view) => view.service.name));
  const endedByName = new Map<string, ServiceViewDto>();
  for (const view of services.filter((item) => !serviceIsLive(item))) {
    if (liveNames.has(view.service.name)) continue;
    endedByName.set(view.service.name, view);
  }
  const endedServices = [...endedByName.values()].slice(-3);
  const shownNames = new Set([...liveServices, ...endedServices].map((view) => view.service.name));
  const startable = (recipes.data ?? []).filter(
    (recipe) => recipe.shadowedBy === null && !shownNames.has(recipe.name),
  );
  const shadowed = (recipes.data ?? []).filter((recipe) => recipe.shadowedBy !== null);
  const renewalFailure = services.find((view) => view.workspaceTtlRenewalError !== null) ?? null;

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries(trpc.sessions.pathFilter()),
      queryClient.invalidateQueries(trpc.services.list.pathFilter()),
    ]);

  const act = (verb: ServiceVerb, view: ServiceViewDto) => {
    const stable = view.service;
    const rerunAttempt = latestSupervisedAttempt(view);
    setPending(`${verb}:${stable.id}`);
    const action =
      verb === "restart"
        ? restartService(stable.id)
        : verb === "stop"
          ? stopService(stable.id)
          : rerunAttempt === null
            ? Promise.reject(new Error("This Service has no supervised attempt to run again."))
            : runService(sessionId, {
                argv: rerunAttempt.argv,
                port: stable.workspacePort,
                name: stable.name,
                protocol: stable.transport,
                browserScheme: stable.browserScheme,
              });
    void action.then(invalidate).finally(() => setPending(null));
  };

  const start = (recipe: ServiceRecipeDto) => {
    setPending(`run:${recipe.name}`);
    const action = runServiceRecipe(sessionId, recipe.name);
    void action.then(invalidate).finally(() => setPending(null));
  };

  const empty = services.length === 0 && startable.length === 0 && shadowed.length === 0;

  return (
    <section className="mt-6">
      <p className="text-xs font-medium text-label">Services</p>
      <div className="mt-3 overflow-hidden rounded-2xl bg-card shadow-sm">
        {renewalFailure === null ? null : (
          <div className="border-b border-rule-faint bg-warning/10 px-4 py-3 font-mono text-[11px] text-warning">
            <p>Workspace TTL renewal failed · {renewalFailure.workspaceTtlRenewalError}</p>
            <p className="mt-1 text-faint">
              last renewed {observedAt(renewalFailure.workspaceTtlRenewedAt)} · known expiry{" "}
              {observedAt(renewalFailure.workspaceExpiresAt)} · failed{" "}
              {observedAt(renewalFailure.workspaceTtlRenewalFailedAt)}
            </p>
          </div>
        )}
        {empty ? (
          <p className="p-4 font-mono text-xs text-faint">
            {recipes.isError
              ? "mend.toml did not parse — fix it in the worktree"
              : "none running · mend service run exposes one"}
          </p>
        ) : (
          <>
            {[...liveServices, ...endedServices].map((service, index) => (
              <ServiceRow
                key={service.service.id}
                service={service}
                actionable={canStart}
                pending={pending}
                onAction={act}
                first={index === 0}
              />
            ))}
            {canStart &&
              startable.map((recipe, index) => (
                <div
                  key={`${recipe.source}:${recipe.name}`}
                  className={`px-4 py-3 ${index === 0 && services.length === 0 ? "" : "border-t border-rule-faint"}`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="min-w-0 truncate font-sans text-[13px] font-medium text-ink-2">
                      {recipe.name}
                    </p>
                    <button
                      type="button"
                      onClick={() => start(recipe)}
                      disabled={pending !== null}
                      className="shrink-0 font-sans text-xs font-medium text-info hover:underline"
                    >
                      {pending === `run:${recipe.name}` ? "Starting…" : "Run"}
                    </button>
                  </div>
                  <p className="mt-1 truncate font-mono text-[11px] text-faint">
                    {recipe.command ?? "adopt"} · :{recipe.port}
                    {recipe.protocol === "udp" ? "/udp" : ""} ·{" "}
                    {recipe.source === "file" ? "mend.toml" : "project"}
                  </p>
                </div>
              ))}
            {shadowed.map((recipe) => (
              <div
                key={`${recipe.source}:${recipe.name}:shadowed`}
                className="border-t border-rule-faint px-4 py-3 opacity-60"
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="min-w-0 truncate font-sans text-[13px] font-medium text-ink-2">
                    {recipe.name}
                  </p>
                  <span className="font-sans text-xs text-muted-foreground">Shadowed</span>
                </div>
                <p className="mt-1 truncate font-mono text-[11px] text-faint">
                  project declaration · overridden by {recipe.shadowedBy}
                </p>
              </div>
            ))}
          </>
        )}
        {canStart && (
          <RunServiceForm
            sessionId={sessionId}
            pending={pending}
            setPending={setPending}
            onDone={invalidate}
          />
        )}
      </div>
    </section>
  );
}

/**
 * Declare and run a Service right here — one-off, session-scoped. Empty
 * command adopts an already-listening port; the project page holds the
 * declarations that persist across sessions.
 */
function RunServiceForm({
  sessionId,
  pending,
  setPending,
  onDone,
}: {
  readonly sessionId: string;
  readonly pending: string | null;
  readonly setPending: (value: string | null) => void;
  readonly onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (form: HTMLFormElement) => {
    const data = new FormData(form);
    const command = String(data.get("command") ?? "").trim();
    const name = String(data.get("name") ?? "").trim();
    const port = Number(String(data.get("port") ?? "").trim());
    const protocol = data.get("udp") === "on" ? ("udp" as const) : ("tcp" as const);
    const requestedScheme = String(data.get("browserScheme") ?? "");
    const browserScheme =
      protocol === "udp" || requestedScheme === ""
        ? null
        : requestedScheme === "https"
          ? ("https" as const)
          : ("http" as const);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError("A port between 1 and 65535 is the one required field.");
      return;
    }
    setPending("run:form");
    setError(null);
    const label = name === "" ? null : name;
    const action =
      command === ""
        ? addService(sessionId, { port, name: label, protocol, browserScheme })
        : runService(sessionId, {
            argv: ["sh", "-c", command],
            port,
            name: label,
            protocol,
            browserScheme,
          });
    void action
      .then(() => {
        onDone();
        form.reset();
        setOpen(false);
        return null;
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setPending(null));
  };

  if (!open) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => setOpen(true)}
        className="h-auto w-full justify-start rounded-none border-t border-rule-faint px-4 py-2.5 text-xs font-normal text-muted-foreground hover:bg-transparent hover:text-ink"
      >
        + run service…
      </Button>
    );
  }

  return (
    <form
      className="flex flex-col gap-2 border-t border-rule-faint px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit(event.currentTarget);
      }}
    >
      <Input
        name="command"
        autoFocus
        placeholder="pnpm dev (empty = adopt a listening port)"
        className="w-full bg-background font-mono text-xs"
      />
      <div className="flex items-center gap-2">
        <Input
          name="port"
          inputMode="numeric"
          placeholder="port"
          className="w-20 bg-background font-mono text-xs"
        />
        <Input
          name="name"
          placeholder="name (optional)"
          className="min-w-0 flex-1 bg-background font-mono text-xs"
        />
        <NativeSelect
          name="browserScheme"
          aria-label="Browser behavior"
          defaultValue=""
          size="sm"
          className="w-fit bg-background font-mono text-[11px]"
        >
          <NativeSelectOption value="">raw</NativeSelectOption>
          <NativeSelectOption value="http">http</NativeSelectOption>
          <NativeSelectOption value="https">https</NativeSelectOption>
        </NativeSelect>
        <label className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <Checkbox name="udp" />
          udp
        </label>
      </div>
      <div className="flex items-center justify-end gap-2.5">
        <RowAction
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          cancel
        </RowAction>
        <RowAction
          type="submit"
          disabled={pending !== null}
          className="font-medium text-info hover:text-info hover:underline"
        >
          {pending === "run:form" ? "Starting…" : "Run"}
        </RowAction>
      </div>
      {error === null ? null : (
        <p className="border-l-2 border-[var(--sw-red)] pl-2 font-sans text-xs text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
