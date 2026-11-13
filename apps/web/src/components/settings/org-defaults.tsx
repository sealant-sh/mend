import {
  movesAnything,
  offeredMoves,
  organizationDefaults,
  organizationDefaultSources,
  runtimeName,
  type RuntimeSwitchMoves,
  switchChangesNothing,
} from "@mend/domain";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "#/components/kit/button";
import {
  InheritChoice,
  InheritedValue,
  InheritSegment,
  type InheritSource,
  type InheritValue,
} from "#/components/kit/inherit-choice";
import { Panel, SettingsSection } from "#/components/kit/section";
import { ErrorNote, errorText } from "#/components/kit/status";
import type {
  OrganizationRuntimeSwitchDto,
  OrganizationSettingsDto,
  OrganizationSettingsViewDto,
} from "#/lib/api";
import { documentWriter } from "#/lib/optimistic";
import { SESSION_RUNTIME_WORDS } from "#/lib/organization";
import { DEFAULT_SWITCHES, onOff, type DefaultSwitch } from "#/lib/organization-defaults";
import { clockTime } from "#/lib/session-view";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

import { useOrganizationView } from "./org-parts";
import { RuntimeImpactList, RuntimeSwitchDialog } from "./runtime-switch";

const choiceOf = (value: boolean | null): InheritValue =>
  value === null ? "inherit" : value ? "on" : "off";

const valueOf = (choice: InheritValue): boolean | null =>
  choice === "inherit" ? null : choice === "on";

/** The organization's own values over the instance's: what a project on inherit then gets. */
export const withOwnDefaults = (
  view: OrganizationSettingsViewDto,
  organization: OrganizationSettingsDto,
): OrganizationSettingsViewDto => ({
  ...view,
  organization,
  effective: organizationDefaults(view.instance, organization),
});

/**
 * Every default writes the one organization document, so all of them share one writer: a change
 * shows at once over the server's view, with what projects then inherit recomputed.
 */
const organizationDefaultsWriter = documentWriter<
  OrganizationSettingsViewDto,
  Partial<OrganizationSettingsDto>,
  OrganizationSettingsViewDto
>({
  overlay: (view, patch) => withOwnDefaults(view, { ...view.organization, ...patch }),
  saved: (_server, saved) => saved,
});

type SessionRuntime = OrganizationSettingsViewDto["sessionRuntime"]["offered"][number];

/** Where new sessions run once `chosen` is saved: the choice while offered, else the default. */
const effectiveOf = (
  runtime: OrganizationSettingsViewDto["sessionRuntime"],
  chosen: SessionRuntime | null,
): SessionRuntime | null =>
  chosen !== null && runtime.offered.includes(chosen) ? chosen : runtime.serverDefault;

/** An owner's choice of where new sessions run, and the environments it moves in the same step. */
interface RuntimeChange {
  readonly sessionRuntime: SessionRuntime | null;
  readonly moves?: RuntimeSwitchMoves;
}

/** An owner's pending choice of where new sessions run, over the server's view. */
const withSessionRuntime = (
  view: OrganizationSettingsViewDto,
  change: RuntimeChange,
): OrganizationSettingsViewDto => ({
  ...view,
  sessionRuntime: {
    ...view.sessionRuntime,
    chosen: change.sessionRuntime,
    effective: effectiveOf(view.sessionRuntime, change.sessionRuntime),
  },
});

/** The runtime choice has its own route, so its own writer over the same document. */
const sessionRuntimeWriter = documentWriter<
  OrganizationSettingsViewDto,
  RuntimeChange,
  OrganizationSettingsViewDto
>({
  overlay: withSessionRuntime,
  saved: (_server, saved) => saved,
});

const RUNTIME_LABEL: Readonly<Record<SessionRuntime, string>> = { docker: "Docker", boat: "Boat" };
const RUNTIME_TIP: Readonly<Record<SessionRuntime, string>> = {
  docker: "On this server's Docker.",
  boat: "Each session in a Boat VM, paid by the organization's Boat key or the server's.",
};
const SESSION_RUNTIME_LABEL = "Where new sessions run";
const KEPT = "Existing worktrees keep where they run.";

/**
 * Where the organization's new sessions run. The operator declares what the server offers and its
 * default; with more than one offered, owners pick Inherit or one of them. Everyone else, and an
 * owner on a server that offers one, reads where they run and why.
 */
function SessionRuntimeRow({
  settings,
  name,
  onChoose,
}: {
  readonly settings: OrganizationSettingsViewDto;
  readonly name: string;
  readonly onChoose: (runtime: SessionRuntime | null) => void;
}) {
  const runtime = settings.sessionRuntime;
  const server: InheritSource = {
    title: "From this server",
    detail: `Set by this server's operator, who also chooses where sessions may run. ${KEPT}`,
  };
  if (runtime.serverDefault === null)
    return (
      <InheritedValue
        label={SESSION_RUNTIME_LABEL}
        resolved="Sealant picks"
        source={{
          title: "From this server",
          detail:
            "This server leaves it to Sealant. Its operator can offer runtimes with MEND_SESSION_RUNTIMES.",
        }}
      />
    );
  if (settings.editable && runtime.offered.length > 1)
    return (
      <InheritSegment
        label={SESSION_RUNTIME_LABEL}
        value={runtime.chosen ?? "inherit"}
        resolved={RUNTIME_LABEL[runtime.serverDefault]}
        source={{
          ...server,
          detail: `Set by this server's operator. Pick Docker or Boat to set it for ${name}. ${KEPT}`,
        }}
        choices={runtime.offered.map((value) => ({
          value,
          label: RUNTIME_LABEL[value],
          tip: RUNTIME_TIP[value],
        }))}
        onChange={(choice) => onChoose(choice === "inherit" ? null : choice)}
      />
    );
  const effective = runtime.effective ?? runtime.serverDefault;
  const source: InheritSource =
    runtime.offered.length === 1
      ? {
          title: "From this server",
          detail: `This server runs sessions only on ${SESSION_RUNTIME_WORDS[effective] ?? effective}. Its operator chooses where sessions may run.`,
        }
      : runtime.chosen !== null && runtime.chosen === effective
        ? {
            title: `From ${name}'s defaults`,
            detail: `The owners of ${name} chose it for every new session here. ${KEPT}`,
          }
        : server;
  return (
    <InheritedValue
      label={SESSION_RUNTIME_LABEL}
      resolved={RUNTIME_LABEL[effective]}
      source={source}
    />
  );
}

/**
 * What the runtime new sessions run on now would not run, for its owners: after a switch without
 * moving, or on a server whose default runtime cannot run what the organization inherits. The
 * same moves the switch offers, without a switch. Nothing shows while Sealant was not read: the
 * pickers already say so.
 */
function StandingImpact({
  view,
  organization,
  pending,
  onMove,
}: {
  readonly view: OrganizationRuntimeSwitchDto;
  readonly organization: string;
  readonly pending: boolean;
  readonly onMove: (moves: RuntimeSwitchMoves) => void;
}) {
  const { impact } = view;
  if (impact.state !== "observed" || switchChangesNothing(impact)) return null;
  const moves = offeredMoves(impact);
  const count = (moves.organizationDefault ? 1 : 0) + moves.projects.length;
  const runtime = runtimeName(impact.runtime);
  return (
    <div className="mt-3 grid max-w-[760px] gap-2.5">
      <p className="border-l-2 border-[var(--sw-amber)] pl-3 text-[13px] leading-relaxed text-ink-2">
        New sessions in {organization} run on {runtime}, which cannot run everything here as it is,
        as Sealant reported at {clockTime(impact.observedAt)}.
      </p>
      <RuntimeImpactList impact={impact} organization={organization} />
      {movesAnything(moves) ? (
        <div className="flex flex-wrap items-center gap-2.5">
          <Button disabled={pending} onClick={() => onMove(moves)}>
            {pending ? "Moving…" : `Move ${count} to what ${runtime} runs`}
          </Button>
          <span className="text-[12.5px] text-muted-foreground">
            Packages a project added are not kept. The next session in each builds the new
            environment, which takes a few minutes the first time.
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** Where Inherit's value comes from: the instance, which its operator sets. */
export const instanceSource = (organizationName: string, operator: boolean): InheritSource => ({
  title: "From the instance default",
  detail: `Set by this machine's operator for every organization on it. Pick On or Off to set it for ${organizationName}.`,
  link: operator ? (
    <Link to="/settings/instance/defaults">Change it in Instance · Defaults</Link>
  ) : (
    "Only operators can change instance defaults"
  ),
});

/**
 * O3 · Defaults: what every project in the organization inherits unless it sets its own. Owners
 * pick Inherit, On or Off for each, and Inherit says what it resolves to and where that comes
 * from; the change shows at once and goes back if the server refuses. Members read each value
 * and its source.
 */
export function DefaultsTab() {
  const trpc = useTRPC();
  const view = useOrganizationView();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const server = useSuspenseQuery(trpc.organization.settings.queryOptions()).data;
  const withDefaults = organizationDefaultsWriter.useVisible(server) ?? server;
  const settings = sessionRuntimeWriter.useVisible(withDefaults) ?? withDefaults;
  const name = view.organization.name;
  const save = useMutation(
    organizationDefaultsWriter.options({
      queryClient,
      documentKey: trpc.organization.settings.queryKey(),
      mutationKey: trpc.organization.setSettings.mutationKey(),
      send: (patch, latest) =>
        client.organization.setSettings.mutate({ ...latest.organization, ...patch }),
      // Each member's own switches fall back to these.
      related: [trpc.platform.automation.queryKey()],
    }),
  );
  const saveRuntime = useMutation(
    sessionRuntimeWriter.options({
      queryClient,
      documentKey: trpc.organization.settings.queryKey(),
      mutationKey: trpc.organization.setSessionRuntime.mutationKey(),
      send: (change) => client.organization.setSessionRuntime.mutate(change),
      // The pickers' facts, what the runtime would not run, and moved projects' environments.
      related: [
        trpc.organization.runtime.queryKey(),
        trpc.organization.runtimeSwitch.queryKey(),
        trpc.projects.list.queryKey(),
      ],
    }),
  );
  const effective = settings.sessionRuntime.effective;
  const standing = useQuery({
    ...trpc.organization.runtimeSwitch.queryOptions({ sessionRuntime: effective }),
    enabled: settings.editable && effective !== null,
  });
  /** What the switch the owner asked for would change, while they decide. */
  const [asked, setAsked] = useState<OrganizationRuntimeSwitchDto | null>(null);
  const [checking, setChecking] = useState<SessionRuntime | null>(null);
  const [checkError, setCheckError] = useState<unknown>(null);
  const chooseRuntime = async (runtime: SessionRuntime | null) => {
    if (settings.sessionRuntime.chosen === runtime || checking !== null) return;
    setCheckError(null);
    if (effectiveOf(settings.sessionRuntime, runtime) === effective) {
      saveRuntime.mutate({ sessionRuntime: runtime });
      return;
    }
    setChecking(runtime ?? settings.sessionRuntime.serverDefault);
    try {
      const impact = await queryClient.fetchQuery({
        ...trpc.organization.runtimeSwitch.queryOptions({ sessionRuntime: runtime }),
        staleTime: 0,
      });
      if (switchChangesNothing(impact.impact)) saveRuntime.mutate({ sessionRuntime: runtime });
      else setAsked(impact);
    } catch (cause) {
      setCheckError(cause);
    } finally {
      setChecking(null);
    }
  };
  const error =
    save.error ??
    saveRuntime.error ??
    (checkError === null ? null : new Error(`Not switched: ${errorText(checkError)}`));
  const sources = organizationDefaultSources(settings.organization);
  const instance = instanceSource(name, view.operator);
  const choose = (key: DefaultSwitch, choice: InheritValue) => {
    const value = valueOf(choice);
    if (settings.organization[key] !== value) save.mutate({ [key]: value });
  };

  return (
    <Panel>
      <SettingsSection
        title={`Defaults · ${name}`}
        why={
          settings.editable
            ? "Inherit follows the instance default, set by its operator. A project can still set its own."
            : `Set by the owners of ${name}. A project can still set its own.`
        }
      >
        {DEFAULT_SWITCHES.map((row) =>
          settings.editable ? (
            <InheritChoice
              key={row.key}
              label={row.label}
              value={choiceOf(settings.organization[row.key])}
              resolved={onOff(settings.instance[row.key])}
              source={instance}
              onChange={(choice) => choose(row.key, choice)}
            />
          ) : (
            <InheritedValue
              key={row.key}
              label={row.label}
              resolved={onOff(settings.effective[row.key])}
              source={
                sources[row.key] === "organization"
                  ? {
                      title: `From ${name}'s defaults`,
                      detail: `The owners of ${name} set it for every project here.`,
                    }
                  : instance
              }
            />
          ),
        )}
        <SessionRuntimeRow
          settings={settings}
          name={name}
          onChoose={(runtime) => void chooseRuntime(runtime)}
        />
        {checking === null ? null : (
          <p role="status" className="mt-2 font-mono text-[11.5px] text-muted-foreground">
            Reading what {runtimeName(checking)} runs…
          </p>
        )}
        {standing.data === undefined ? null : (
          <StandingImpact
            view={standing.data}
            organization={name}
            pending={saveRuntime.isPending}
            onMove={(moves) =>
              saveRuntime.mutate({ sessionRuntime: settings.sessionRuntime.chosen, moves })
            }
          />
        )}
        {error === null ? null : <ErrorNote className="mt-3">{errorText(error)}</ErrorNote>}
        <RuntimeSwitchDialog
          view={asked}
          organization={name}
          pending={saveRuntime.isPending}
          onCancel={() => setAsked(null)}
          onSwitch={(moves) => {
            if (asked === null) return;
            const sessionRuntime = asked.chosen;
            saveRuntime.mutate(
              moves === undefined ? { sessionRuntime } : { sessionRuntime, moves },
              { onSettled: () => setAsked(null) },
            );
          }}
        />
      </SettingsSection>
    </Panel>
  );
}
