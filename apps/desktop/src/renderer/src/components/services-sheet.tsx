import { isLoopbackHostname } from "@mend/domain/workbench";
import { Button } from "@mend/ui/components/ui/button";
import { Checkbox } from "@mend/ui/components/ui/checkbox";
import { Input } from "@mend/ui/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@mend/ui/components/ui/native-select";
import { cn } from "@mend/ui/lib/utils";
import { Modal, ModalHeader } from "@mend/ui/modal";
import { Sheet, SheetHeader } from "@mend/ui/sheet";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { LogsView } from "#/components/logs-view";
import { StatusDot } from "#/components/status-dot";
import {
  addService,
  restartService,
  runService,
  runServiceRecipe,
  type ServiceViewDto,
  type SessionDto,
  stopService,
} from "#/lib/api";
import { useConnection } from "#/lib/connection";
import { useEventsState } from "#/lib/events";
import { useNow } from "#/lib/now";
import { queryClient, sessionRecipesQuery } from "#/lib/queries";
import {
  readOnlyActions,
  type ServiceAction,
  type ServiceFact,
  type ServiceFacts,
  servicesForSession,
} from "#/lib/services";
import { sessionActions, useViewer } from "#/lib/viewer";
import { ago, clock } from "#/lib/words";

/** Whether the server URL names this machine (an empty or unparsable one: assume so). */
const serverIsThisMachine = (url: string): boolean => {
  if (url === "") return true;
  try {
    return isLoopbackHostname(new URL(url).hostname);
  } catch {
    return true;
  }
};

/**
 * The session Services sheet (plan §Services desktop journey): stable
 * Services as run-record-style evidence rows — one status dot per Service,
 * mono facts beneath it, quiet actions — plus the declared recipes and a
 * one-off run/adopt form. Facts stay independent observations (process,
 * forward, target); color is earned: amber and red only for observed
 * trouble, cobalt only on interaction. Logs open in a modal that can promote
 * itself to a durable tab.
 */

const actionLabel: Record<ServiceAction, string> = {
  open: "Open",
  copy: "Copy endpoint",
  "copy-command": "Copy command",
  logs: "Logs",
  restart: "Restart",
  stop: "Stop",
  "remove-forward": "Remove forward",
  "run-again": "Run again",
};

const refreshServices = () => queryClient.invalidateQueries({ queryKey: ["services"] });

/**
 * Sheet-scale quiet action, composed from the ui Button: `info` is the one
 * cobalt (interaction) action of a group; `danger` earns red on hover.
 */
function Action({
  tone = "quiet",
  className,
  ...props
}: React.ComponentProps<typeof Button> & { readonly tone?: "quiet" | "info" | "danger" }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className={cn(
        "h-6 rounded-md px-1.5 text-[11.5px]",
        tone === "info" && "text-info hover:text-info",
        tone === "danger" && "hover:text-danger",
        className,
      )}
      {...props}
    />
  );
}

/* Sheet-scale overrides on the ui Input/NativeSelect: mono, compact. */
const field = "bg-background font-mono text-[11.5px]";

/** The word stays ink unless the tone is earned (observed trouble/success). */
const factText = (tone: ServiceFact["tone"]): string =>
  tone === "red"
    ? "text-danger"
    : tone === "amber"
      ? "text-warning"
      : tone === "green"
        ? "text-success"
        : "text-ink-2";

const observed = (iso: string, now: number): string => {
  const when = ago(iso, now);
  if (when === "now") return "observed just now";
  return when === null ? `observed ${clock(iso)}` : `observed ${when} ago`;
};

function FactRow({ fact, meta }: { readonly fact: ServiceFact; readonly meta?: string }) {
  return (
    <div className="flex items-center gap-2 px-2.5 py-[5px]">
      <StatusDot tone={fact.tone} size={6} />
      <span className={`min-w-0 flex-1 truncate font-mono text-[11.5px] ${factText(fact.tone)}`}>
        {fact.word}
      </span>
      {meta !== undefined && (
        <span className="shrink-0 font-mono text-[10.5px] text-faint">{meta}</span>
      )}
    </div>
  );
}

/** The sheet's one dot per Service: observed trouble first, then liveness. */
const headTone = (facts: ServiceFacts): ServiceFact["tone"] => {
  if (facts.attention !== null) return facts.attention.tone;
  if (facts.process !== null && facts.process.tone !== "hollow") return facts.process.tone;
  return facts.forward.tone;
};

function ServiceRow({
  facts,
  now,
  pending,
  act,
  steer,
}: {
  readonly facts: ServiceFacts;
  readonly now: number;
  readonly pending: string | null;
  readonly act: (action: ServiceAction, facts: ServiceFacts) => void;
  /** Whether the viewer steers the session: without it, a row reads and never runs. */
  readonly steer: boolean;
}) {
  const service = facts.view.service;
  const running = facts.process?.tone === "accent";
  return (
    <article className="border-b border-rule-faint px-4 py-4 last:border-0">
      <div className="flex items-center gap-2">
        <StatusDot tone={headTone(facts)} size={7} pulse={running} />
        <p className="min-w-0 truncate font-sans text-[13px] font-medium text-foreground">
          {facts.name}
        </p>
        <span className="flex-1" />
        <span className="shrink-0 font-mono text-[10.5px] text-faint">
          {service.declarationSource} · :{service.workspacePort}
          {service.transport === "udp" ? "/udp" : ""}
        </span>
      </div>
      <div className="mt-2.5 divide-y divide-rule-faint rounded-lg bg-[var(--sw-sunken)]">
        {facts.process === null ? (
          <FactRow fact={{ word: "No Mend-owned process", tone: "hollow" }} />
        ) : (
          <FactRow fact={facts.process} />
        )}
        <FactRow fact={facts.forward} />
        {facts.target === null ? (
          <FactRow fact={{ word: "Target unobserved", tone: "hollow" }} />
        ) : (
          <FactRow fact={facts.target} meta={observed(facts.target.observedAt, now)} />
        )}
      </div>
      {facts.movedFrom !== null && (
        <p className="mt-2 border-l-2 border-[var(--sw-amber)] pl-2.5 font-mono text-[10.5px] leading-relaxed text-warning">
          Endpoint moved from {facts.movedFrom}
        </p>
      )}
      {facts.reach.kind === "tunnel" && facts.view.currentForward?.state === "bound" && (
        <div className="mt-2">
          <p className="truncate font-mono text-[11.5px] text-ink-2">{facts.connectCommand}</p>
          <p className="mt-1 font-sans text-[11.5px] leading-relaxed text-muted-foreground">
            Its port answers on the Mend host only. The Mend CLI tunnels it to this machine&apos;s
            loopback, signed in as you.
            {service.browserScheme === null ? null : (
              <>
                {" "}
                An open <span className="font-mono text-[10.5px]">mend attach</span> does this on
                its own.
              </>
            )}
          </p>
        </div>
      )}
      {facts.endpoint?.scope === "private" && (
        <p className="mt-2 border-l-2 border-[var(--sw-amber)] pl-2.5 font-sans text-[11.5px] leading-relaxed text-warning">
          No Mend sign-in protects this port. Anyone who can reach this private address can connect.
        </p>
      )}
      {facts.view.workspaceTtlRenewalError !== null && (
        <p className="mt-2 border-l-2 border-[var(--sw-amber)] pl-2.5 font-mono text-[10.5px] leading-relaxed text-warning">
          TTL renewal failed · known expiry {facts.view.workspaceExpiresAt ?? "unknown"}
        </p>
      )}
      <div className="-mx-1.5 mt-2 flex flex-wrap gap-x-1 gap-y-0.5">
        {(steer ? facts.actions : readOnlyActions(facts.actions)).map((action) => (
          <Action
            key={action}
            tone={
              action === "open"
                ? "info"
                : action === "stop" || action === "remove-forward"
                  ? "danger"
                  : "quiet"
            }
            disabled={pending !== null}
            onClick={() => act(action, facts)}
          >
            {pending === `${action}:${service.id}`
              ? `${actionLabel[action]}…`
              : actionLabel[action]}
          </Action>
        ))}
      </div>
      {!service.attemptHistoryComplete && (
        <p className="mt-1.5 font-mono text-[10px] text-faint">
          Earlier attempts were not recorded.
        </p>
      )}
    </article>
  );
}

export function ServicesSheet({
  session,
  views,
  onClose,
  onOpenLogsTab,
}: {
  readonly session: SessionDto;
  readonly views: ReadonlyArray<ServiceViewDto>;
  readonly onClose: () => void;
  /** Promote a logs modal into a durable tab for this session. */
  readonly onOpenLogsTab: (processId: string, name: string) => void;
}) {
  const recipes = useQuery(sessionRecipesQuery(session.id));
  // Running, restarting and stopping Services steer the session (docs/adr/0003). An unknown
  // viewer keeps the controls and the server decides.
  const viewer = useViewer();
  const steer = viewer === null || sessionActions(session, viewer).steer;
  const eventState = useEventsState();
  const now = useNow();
  const connection = useConnection();
  // A loopback endpoint answers on the Mend host only; a desktop pointed elsewhere cannot open it.
  const onMendHost = connection === null || serverIsThisMachine(connection.url);
  const facts = servicesForSession(views, session.id, onMendHost);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logsFor, setLogsFor] = useState<{
    readonly service: string;
    readonly processId: string;
  } | null>(null);
  const performAction = (key: string, promise: Promise<unknown>) => {
    setPending(key);
    setError(null);
    void promise
      .then(refreshServices)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPending(null));
  };
  const act = (action: ServiceAction, item: ServiceFacts) => {
    const id = item.view.service.id;
    if (action === "open" && item.browserUrl !== null) {
      void window.mend.shell.openExternal(item.browserUrl);
      return;
    }
    if (action === "copy" && item.endpoint !== null) {
      void navigator.clipboard.writeText(item.endpoint.authority);
      return;
    }
    if (action === "copy-command") {
      void navigator.clipboard.writeText(item.connectCommand);
      return;
    }
    if (action === "logs" && item.logAttempt !== null) {
      setLogsFor({ service: item.name, processId: item.logAttempt.id });
      return;
    }
    if (action === "restart") {
      performAction(`${action}:${id}`, restartService(id));
      return;
    }
    if (action === "stop" || action === "remove-forward") {
      performAction(`${action}:${id}`, stopService(id));
      return;
    }
    const attempt = item.logAttempt;
    if (action === "run-again" && attempt !== null) {
      performAction(
        `${action}:${id}`,
        runService(session.id, {
          argv: attempt.argv,
          port: item.view.service.workspacePort,
          name: item.name,
          protocol: item.view.service.transport,
          browserScheme: item.view.service.browserScheme,
        }),
      );
    }
  };
  const submit = (form: HTMLFormElement) => {
    const data = new FormData(form);
    const command = String(data.get("command") ?? "").trim();
    const name = String(data.get("name") ?? "").trim() || null;
    const port = Number(data.get("port"));
    const protocol = data.get("udp") === "on" ? "udp" : "tcp";
    const requested = String(data.get("scheme") ?? "");
    let browserScheme: "http" | "https" | null = null;
    if (protocol === "tcp" && requested === "http") browserScheme = "http";
    if (protocol === "tcp" && requested === "https") browserScheme = "https";
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      setError("Enter a port between 1 and 65535.");
      return;
    }
    performAction(
      "run:form",
      command === ""
        ? addService(session.id, { port, name, protocol, browserScheme })
        : runService(session.id, {
            argv: ["sh", "-c", command],
            port,
            name,
            protocol,
            browserScheme,
          }),
    );
    form.reset();
  };

  return (
    <Sheet
      label="Session Services"
      header={
        <SheetHeader title="Services" meta={session.label ?? session.branch}>
          {eventState !== "live" && (
            <span className="shrink-0 font-mono text-[10.5px] text-warning">
              event stream {eventState}
            </span>
          )}
          <Action onClick={onClose}>Close</Action>
        </SheetHeader>
      }
      footer={
        error === null ? undefined : (
          <p className="shrink-0 border-t border-rule px-4 py-2 font-sans text-[11.5px] text-danger">
            {error}
          </p>
        )
      }
    >
      {logsFor !== null && (
        <Modal
          label={`${logsFor.service} logs`}
          onClose={() => setLogsFor(null)}
          header={
            <ModalHeader title={`${logsFor.service} · logs`} meta="read-only · sequence-addressed">
              <Action
                tone="info"
                onClick={() => {
                  onOpenLogsTab(logsFor.processId, logsFor.service);
                  setLogsFor(null);
                }}
              >
                Open as tab
              </Action>
              <Action onClick={() => setLogsFor(null)}>Close</Action>
            </ModalHeader>
          }
        >
          <div className="flex h-[60vh] flex-col">
            <LogsView processId={logsFor.processId} />
          </div>
        </Modal>
      )}
      {facts.length === 0 ? (
        <div className="px-4 py-6">
          <p className="font-sans text-[12.5px] text-ink-2">No Services in this session.</p>
          <p className="mt-1 font-mono text-[10.5px] text-faint">
            Run a recipe or adopt a port below.
          </p>
        </div>
      ) : (
        facts.map((item) => (
          <ServiceRow
            key={item.view.service.id}
            facts={item}
            now={now}
            pending={pending}
            act={act}
            steer={steer}
          />
        ))
      )}
      <section className="border-t border-rule px-4 pt-4 pb-3">
        <p className="ev-eyebrow">Recipes</p>
        <div className="mt-1.5">
          {(recipes.data ?? []).map((recipe) => (
            <div
              key={`${recipe.source}:${recipe.name}`}
              className="flex items-center gap-3 border-b border-rule-faint py-2.5 last:border-0"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-sans text-[12.5px] text-foreground">{recipe.name}</p>
                <p className="truncate font-mono text-[10.5px] text-faint">
                  {recipe.command ?? "adopt"} · :{recipe.port}
                  {recipe.protocol === "udp" ? "/udp" : ""}
                  {recipe.shadowedBy !== null && (
                    <span className="text-warning"> · overridden by {recipe.shadowedBy}</span>
                  )}
                </p>
              </div>
              {steer && (
                <Action
                  tone="info"
                  disabled={pending !== null || recipe.shadowedBy !== null}
                  onClick={() =>
                    performAction(
                      `recipe:${recipe.name}`,
                      runServiceRecipe(session.id, recipe.name),
                    )
                  }
                >
                  {pending === `recipe:${recipe.name}` ? "Starting…" : "Run"}
                </Action>
              )}
            </div>
          ))}
          {recipes.data !== undefined && recipes.data.length === 0 && (
            <p className="py-1 font-mono text-[10.5px] text-faint">
              No recipes declared in mend.toml.
            </p>
          )}
        </div>
      </section>
      {!steer && (
        <p className="border-t border-rule px-4 py-3 font-sans text-[12.5px] text-ink-2">
          Only this session&apos;s owner runs Services in it, unless they share control.
        </p>
      )}
      {steer && (
        <form
          className="border-t border-rule px-4 pt-4 pb-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit(event.currentTarget);
          }}
        >
          <p className="ev-eyebrow">One-off</p>
          <Input
            name="command"
            placeholder="command · leave empty to adopt a listening port"
            className={`mt-2.5 w-full ${field}`}
          />
          <div className="mt-2 flex items-center gap-2">
            <Input
              required
              name="port"
              inputMode="numeric"
              placeholder="port"
              className={`w-[72px] ${field}`}
            />
            <Input name="name" placeholder="name" className={`min-w-0 flex-1 ${field}`} />
            <NativeSelect name="scheme" size="sm" className={`w-fit ${field}`}>
              <NativeSelectOption value="">raw</NativeSelectOption>
              <NativeSelectOption value="http">http</NativeSelectOption>
              <NativeSelectOption value="https">https</NativeSelectOption>
            </NativeSelect>
            <label className="flex items-center gap-1.5 font-mono text-[10.5px] text-label">
              <Checkbox name="udp" />
              udp
            </label>
          </div>
          <div className="mt-2.5 flex items-center">
            <span className="flex-1" />
            <Action tone="info" type="submit" disabled={pending !== null}>
              {pending === "run:form" ? "Starting…" : "Run or adopt"}
            </Action>
          </div>
        </form>
      )}
    </Sheet>
  );
}
