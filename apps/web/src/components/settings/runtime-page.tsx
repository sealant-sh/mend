import type { RuntimeSwitchMoves } from "@mend/domain";
import { InlineAlert } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@mend/ui/components/ui/radio-group";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { toast } from "@mend/ui/components/ui/toast";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useId, useState } from "react";

import { ownersOf } from "#/lib/organization-general";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import {
  type ImpactRow,
  offerLine,
  RUNTIME_LABELS,
  runtimeChoices,
  runtimeIntro,
  type SessionRuntime,
  standingImpact,
  type SwitchAsk,
  switchedLine,
  switchStep,
} from "#/lib/runtime-switch";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC } from "#/lib/trpc";

import { Overlay } from "../projects/overlay.tsx";
import { SettingRow, SettingSection } from "./setting-row.tsx";
import { settingsLink } from "./settings-links.tsx";
import { SettingsPage } from "./settings-page.tsx";

/** A control's height: the frames' 36px on the desk, a 44px touch target on a phone. */
const CONTROL = "h-9 max-lg:h-11 max-lg:text-base";

/**
 * Settings → the organization → Runtime (Doop "Settings · Northwind · Runtime"): where the
 * organization's new sessions run, of what the server offers. Owners switch it; before a switch
 * that would change anything for new sessions, the page says what, from the server's answer, and
 * offers to move what the new runtime can't run in the same step. Everyone else reads it and who
 * can change it. The Boat key is the Boat page's: this page links to it.
 */
export function RuntimePage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const settings = useSuspenseQuery(trpc.organization.settings.queryOptions()).data;
  const roster = useSuspenseQuery(trpc.organization.members.queryOptions()).data;
  const organization = viewer.organization.name;
  const owner = settings.editable;
  const choices = runtimeChoices(settings.sessionRuntime);

  /** The runtime the owner picked, while Mend reads what it would change. */
  const [checking, setChecking] = useState<SessionRuntime | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  /** What the switch the owner picked would change, while they decide. */
  const [asked, setAsked] = useState<SwitchAsk | null>(null);

  const save = useMutation(
    trpc.organization.setSessionRuntime.mutationOptions({
      onSuccess: async (saved, sent) => {
        queryClient.setQueryData(trpc.organization.settings.queryKey(), saved);
        setAsked(null);
        const now = saved.sessionRuntime.effective;
        if (now !== null)
          toast.add({ description: switchedLine(organization, now, sent.moves !== undefined) });
        // What the runtime supports, what it wouldn't run, and the images a move changed.
        await Promise.all([
          queryClient.invalidateQueries(trpc.organization.runtime.queryFilter()),
          queryClient.invalidateQueries(trpc.organization.runtimeSwitch.pathFilter()),
          queryClient.invalidateQueries(trpc.projects.list.queryFilter()),
        ]);
      },
    }),
  );

  const choose = async (runtime: SessionRuntime) => {
    if (choices.kind !== "offered" || runtime === choices.selected) return;
    if (checking !== null || save.isPending) return;
    setCheckError(null);
    save.reset();
    setChecking(runtime);
    try {
      const view = await queryClient.fetchQuery({
        ...trpc.organization.runtimeSwitch.queryOptions({ sessionRuntime: runtime }),
        staleTime: 0,
      });
      const step = switchStep(view, runtime, organization);
      if (step.kind === "switch") save.mutate({ sessionRuntime: runtime });
      else setAsked(step.ask);
    } catch (cause) {
      setCheckError(
        `Not switched: Mend couldn't read what ${RUNTIME_LABELS[runtime]} would change. ${failureWords(cause, "Try again.")}`,
      );
    } finally {
      setChecking(null);
    }
  };

  const pendingRuntime =
    checking ?? (save.isPending ? (save.variables?.sessionRuntime ?? null) : null);
  const saveError =
    save.error === null
      ? null
      : `Not switched. ${failureWords(save.error, "Mend couldn't save it. Try again.")}`;
  const error = checkError ?? (asked === null ? saveError : null);

  return (
    <SettingsPage
      page="o-runtime"
      intro={runtimeIntro(
        organization,
        owner,
        ownersOf(roster, viewer.userId).map((person) => person.name),
      )}
    >
      <SettingSection title="Session runtime" description={offerLine(choices)}>
        {choices.kind === "sealant-picks" ? (
          <SettingRow
            label="Sealant picks"
            description={`New sessions in ${organization} run wherever Sealant on this server puts them.`}
          />
        ) : (
          <RuntimeList
            runtimes={choices.runtimes}
            selected={pendingRuntime ?? choices.selected}
            organization={organization}
            disabled={!owner || pendingRuntime !== null}
            onChoose={(runtime) => void choose(runtime)}
          />
        )}
        {pendingRuntime === null ? null : (
          <p
            role="status"
            className="flex items-center gap-2 py-3 text-row text-muted-foreground max-lg:px-4"
          >
            <Spinner aria-hidden />
            {checking === null
              ? `Switching to ${RUNTIME_LABELS[pendingRuntime]}…`
              : `Reading what ${RUNTIME_LABELS[pendingRuntime]} would change…`}
          </p>
        )}
        {error === null ? null : <Note tone="error">{error}</Note>}
        {owner && choices.kind === "offered" ? (
          <Standing
            runtime={choices.selected}
            organization={organization}
            pending={save.isPending}
            onMove={(moves) =>
              save.mutate({ sessionRuntime: settings.sessionRuntime.chosen, moves })
            }
          />
        ) : null}
      </SettingSection>
      <SwitchDialog
        ask={asked}
        pending={save.isPending}
        error={asked === null ? null : saveError}
        onCancel={() => {
          setAsked(null);
          save.reset();
        }}
        onSwitch={(runtime, moves) =>
          save.mutate(
            moves === null ? { sessionRuntime: runtime } : { sessionRuntime: runtime, moves },
          )
        }
      />
    </SettingsPage>
  );
}

const DESCRIPTIONS: Readonly<Record<SessionRuntime, (organization: string) => ReactNode>> = {
  docker: () => "Workspaces run as containers on this server. They stop when the server stops.",
  boat: (organization) => (
    <>
      Workspaces run as virtual machines on Boat, away from this server. {organization} pays for
      them with its{" "}
      <Link {...settingsLink("o-boat")} className="text-primary underline-offset-2 hover:underline">
        Boat key
      </Link>
      .
    </>
  ),
};

/** The runtimes the server offers, one radio each, as the frame draws them. */
function RuntimeList({
  runtimes,
  selected,
  organization,
  disabled,
  onChoose,
}: {
  readonly runtimes: ReadonlyArray<SessionRuntime>;
  readonly selected: SessionRuntime;
  readonly organization: string;
  readonly disabled: boolean;
  readonly onChoose: (runtime: SessionRuntime) => void;
}) {
  const id = useId();
  return (
    <RadioGroup
      aria-label={`Where ${organization}'s new sessions run`}
      value={selected}
      disabled={disabled}
      onValueChange={(value) => {
        const runtime = runtimes.find((candidate) => candidate === value);
        if (runtime !== undefined) onChoose(runtime);
      }}
      className="gap-0"
    >
      {runtimes.map((runtime) => (
        <div
          key={runtime}
          className="flex items-start gap-3 border-b border-border py-4 max-lg:min-h-11 max-lg:px-4"
        >
          <RadioGroupItem
            id={`${id}-${runtime}`}
            value={runtime}
            aria-describedby={`${id}-${runtime}-about`}
            className="mt-0.5 size-4.5"
          />
          <div className="grid min-w-0 gap-1">
            <label htmlFor={`${id}-${runtime}`} className="font-semibold text-foreground">
              {RUNTIME_LABELS[runtime]}
            </label>
            <p id={`${id}-${runtime}-about`} className="text-row text-pretty text-muted-foreground">
              {DESCRIPTIONS[runtime](organization)}
            </p>
          </div>
        </div>
      ))}
    </RadioGroup>
  );
}

/**
 * A note under the list: the tone colours only its icon. `inset` is for one inside a block that
 * already keeps the phone's side margin.
 */
function Note({
  tone,
  inset = false,
  children,
}: {
  readonly tone: "warning" | "error";
  readonly inset?: boolean;
  readonly children: ReactNode;
}) {
  const phone = usePhone();
  return (
    <InlineAlert
      tone={tone}
      size={phone ? "touch" : "default"}
      className={inset ? "mt-0" : "mt-3 max-lg:mx-4"}
    >
      {children}
    </InlineAlert>
  );
}

/** What the server's answer lists, one row per project or image. */
function ImpactList({
  heading,
  rows,
}: {
  readonly heading: string;
  readonly rows: ReadonlyArray<ImpactRow>;
}) {
  return (
    <div className="grid gap-2">
      <p className="font-semibold">{heading}</p>
      <ul aria-label={heading} className="divide-y divide-border rounded-md border border-border">
        {rows.map((row) => (
          <li key={row.key} className="grid gap-0.5 px-3 py-2.5">
            <span className="font-mono text-row text-foreground">{row.name}</span>
            {row.facts.map((fact) => (
              <span key={fact.text} className="text-row text-pretty text-foreground-2">
                {fact.text}
                {fact.why === undefined ? null : (
                  <span className="text-muted-foreground"> · {fact.why}</span>
                )}
              </span>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What the runtime new sessions run on now wouldn't run, for an owner: after a switch without
 * moving, or a project changed since. The same move the switch offered, without a switch. Nothing
 * shows while it reads, when it runs everything, or when it couldn't be read: a switch says that.
 */
function Standing({
  runtime,
  organization,
  pending,
  onMove,
}: {
  readonly runtime: SessionRuntime;
  readonly organization: string;
  readonly pending: boolean;
  readonly onMove: (moves: RuntimeSwitchMoves) => void;
}) {
  const trpc = useTRPC();
  const read = useQuery(trpc.organization.runtimeSwitch.queryOptions({ sessionRuntime: runtime }));
  if (read.isPending || read.isError) return null;
  const standing = standingImpact(read.data, organization);
  if (standing === null) return null;
  const { moves } = standing;
  return (
    <div className="mt-4 grid gap-3 max-lg:px-4">
      <Note tone="warning" inset>
        {standing.lead}
      </Note>
      <ImpactList heading={standing.heading} rows={standing.rows} />
      {moves === null ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            className={CONTROL}
            disabled={pending}
            onClick={() => onMove(moves)}
          >
            {pending ? <Spinner aria-hidden /> : null}
            {pending ? "Moving…" : standing.moveLabel}
          </Button>
          <span className="text-row text-muted-foreground">
            Packages a project added aren&apos;t kept. The next session in each builds the new
            image, which takes a few minutes the first time.
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Before a switch that would change something for new sessions, or that Mend couldn't check: what
 * the server answered, the moves it offers, and switching without them. Nothing is saved until the
 * owner presses one. A dialog on the desk, a sheet on a phone.
 */
function SwitchDialog({
  ask,
  pending,
  error,
  onCancel,
  onSwitch,
}: {
  readonly ask: SwitchAsk | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSwitch: (runtime: SessionRuntime, moves: RuntimeSwitchMoves | null) => void;
}) {
  // Kept while the dialog closes, so its words don't change as it goes.
  const [shown, setShown] = useState(ask);
  if (ask !== null && ask !== shown) setShown(ask);
  const moves = shown?.moves ?? null;
  return (
    <Overlay
      open={ask !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
      size="lg"
      title={shown?.title ?? ""}
      description={shown?.lead}
      footer={
        shown === null ? null : (
          // Three buttons don't fit side by side on a phone: there they stack, the move on top.
          <div className="flex w-full flex-col-reverse gap-2 lg:w-auto lg:flex-row lg:justify-end lg:gap-2.5">
            <Button
              type="button"
              variant="outline"
              className={CONTROL}
              disabled={pending}
              onClick={onCancel}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={moves === null ? "default" : "outline"}
              className={CONTROL}
              disabled={pending}
              onClick={() => onSwitch(shown.runtime, null)}
            >
              {pending && moves === null ? <Spinner aria-hidden /> : null}
              {shown.confirm}
            </Button>
            {moves === null ? null : (
              <Button
                type="button"
                className={CONTROL}
                disabled={pending}
                onClick={() => onSwitch(shown.runtime, moves)}
              >
                {pending ? <Spinner aria-hidden /> : null}
                {pending ? "Switching…" : "Move and switch"}
              </Button>
            )}
          </div>
        )
      }
    >
      {shown === null || (shown.heading === null && error === null) ? null : (
        <>
          {shown.heading === null ? null : <ImpactList heading={shown.heading} rows={shown.rows} />}
          {shown.moveNote === null ? null : (
            <p className="text-row text-pretty text-muted-foreground">{shown.moveNote}</p>
          )}
          {error === null ? null : (
            <p role="alert" className="text-row text-destructive">
              {error}
            </p>
          )}
        </>
      )}
    </Overlay>
  );
}
