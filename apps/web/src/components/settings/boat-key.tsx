import {
  type BoatKeyHolder,
  boatKeyFacts,
  boatKeyWarnings,
  dayOf,
  FULL_CHECK_COST,
  FULL_CHECK_WHY,
  INTERRUPTED_WORDS,
  proofLeftoverWords,
  proofOutcomeWords,
  proofStepWords,
  proofTone,
} from "@mend/domain/workbench";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Redacted } from "effect";
import { useState } from "react";

import { Button } from "#/components/kit/button";
import { CodeBox } from "#/components/kit/code-box";
import { Field, TextInput } from "#/components/kit/field";
import { ModalDialog } from "#/components/kit/modal";
import { Panel, SettingsSection } from "#/components/kit/section";
import { Dot, ErrorNote, errorText, StatusWord, type Tone } from "#/components/kit/status";
import { DataTable } from "#/components/kit/table";
import type {
  BoatKeyCheckDto,
  BoatKeyDetailsDto,
  BoatKeyFullCheckDto,
  BoatKeyProofDto,
  BoatKeyStatusDto,
  PersonBoatKeyStatusDto,
} from "#/lib/api";
import { BOAT_KEY_COMMANDS, observedAt, REPLACE_ON_PAGE } from "#/lib/boat-key";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

import { Caption, Notice, useOrganizationView } from "./org-parts";

/**
 * Whose Boat key a card shows, in words: the organization's (SLNT-791), or a person's own
 * (SLNT-797), the same card with its own words and binding.
 */
export interface BoatKeySubject {
  /** "the organization's", "your". */
  readonly whose: string;
  /** Whose key it is in the Boat failure table, which decides who is told to fix it. */
  readonly holder: BoatKeyHolder;
  /** The section's why: what connecting does. */
  readonly why: string;
  /** What a person who cannot change the key reads, connected or not. */
  readonly viewerLine: (connected: boolean) => string;
  /** What a person reads beside the key, connected or not, before anything else. */
  readonly notes: ReadonlyArray<string>;
  readonly removalFacts: ReadonlyArray<string>;
}

/** What the card reads of a key's status, the organization's or a person's. */
export type BoatKeyCardStatus = Pick<BoatKeyStatusDto, "connected" | "sessionRuntime" | "details">;

/**
 * A Boat key's reads and changes, bound to whoever owns it. `connect` takes the key as `Redacted`
 * and wipes it once the call settles, so neither the mutation cache nor a refusal holds it.
 */
export interface BoatKeyBinding {
  readonly status: BoatKeyCardStatus;
  readonly connect: BoatKeyCall<Redacted.Redacted<string>, BoatKeyCardStatus>;
  readonly check: BoatKeyCall<void, BoatKeyCheckDto>;
  /**
   * Starts a full check, answered within a few seconds: finished, or running since. While one
   * runs, `status` is read again until its result replaces it.
   */
  readonly fullCheck: BoatKeyCall<void, BoatKeyFullCheckDto>;
  readonly disconnect: BoatKeyCall<void, BoatKeyCardStatus>;
}

/** The part of a mutation the card uses. */
export interface BoatKeyCall<V, R> {
  readonly mutate: (variables: V, options?: { readonly onSuccess?: () => void }) => void;
  readonly reset: () => void;
  readonly isPending: boolean;
  readonly error: unknown;
  readonly data: R | undefined;
}

export const ORGANIZATION_BOAT_KEY: BoatKeySubject = {
  whose: "the organization's",
  holder: "organization",
  why: "This organization's Boat sessions run in, and are billed to, the Boat account of its own key. Without one they use the server's own key, if the server has one, and are refused if it has none.",
  viewerLine: (connected) =>
    connected
      ? "This organization has its own Boat key: its new Boat sessions run in its own Boat account. Only an owner sees the key's details or changes it."
      : "This organization has no Boat key, so its Boat sessions use the server's own key, if the server has one. An owner can connect one here.",
  notes: [],
  removalFacts: [
    "New Boat sessions in the organization use the server's own Boat key, if it has one, apart from those of people who connected their own; otherwise they are refused.",
    "Sealant deletes the saved images it made in this Boat account, which frees their snapshot slots.",
    "Mend first stops the standby workspaces it keeps in this Boat account, without saving anything, since they hold no session's work. It refuses while a session's VM or an image build still holds the account: stop the organization's Boat sessions first.",
  ],
};

/** How often the page reads the key's status while a full check runs. */
const FULL_CHECK_POLL_MS = 3_000;

/** The organization's Boat key, with the reads and changes the page makes. */
export const useOrganizationBoatKey = (): BoatKeyBinding & {
  readonly status: BoatKeyStatusDto;
} => {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  // Read again every few seconds while a full check runs, until sealant's result replaces it.
  const status = useSuspenseQuery(
    trpc.boatKey.status.queryOptions(undefined, {
      refetchInterval: (query) =>
        query.state.data?.details?.fullCheck.runningSince ? FULL_CHECK_POLL_MS : false,
    }),
  ).data;
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries(trpc.boatKey.status.pathFilter()),
      queryClient.invalidateQueries(trpc.organization.audit.pathFilter()),
    ]);
  const connect = useMutation({
    mutationKey: trpc.boatKey.connect.mutationKey(),
    mutationFn: (key: Redacted.Redacted<string>) =>
      client.boatKey.connect.mutate({ key: Redacted.value(key) }),
    gcTime: 0,
    // A check of the key it replaced no longer says anything about this one.
    onSuccess: () => check.reset(),
    onSettled: (_status, _error, key) => {
      Redacted.wipeUnsafe(key);
      return refresh();
    },
  });
  const check = useMutation(trpc.boatKey.check.mutationOptions({ onSettled: refresh }));
  const fullCheck = useMutation(trpc.boatKey.fullCheck.mutationOptions({ onSettled: refresh }));
  const disconnect = useMutation(
    trpc.boatKey.disconnect.mutationOptions({ onSuccess: () => check.reset(), onSettled: refresh }),
  );
  return { status, connect, check, fullCheck, disconnect };
};

/** Settings, Organization, Boat (SLNT-791). */
export function BoatKeyTab() {
  const view = useOrganizationView();
  const binding = useOrganizationBoatKey();
  const people = binding.status.peopleWithOwnKeys;
  return (
    <Panel>
      <BoatKeyCard
        subject={ORGANIZATION_BOAT_KEY}
        binding={binding}
        canManage={view.role === "owner"}
      />
      {people === null ? null : <PeopleWithOwnKeys people={people} />}
    </Panel>
  );
}

const nameList = (names: ReadonlyArray<string>): string =>
  names.length <= 1
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/**
 * Who in the organization runs their Boat sessions on their own key (SLNT-797), for owners: the
 * organization's repositories are checked out in VMs in those people's Boat accounts. Names only;
 * a person's key is theirs to see.
 */
export function PeopleWithOwnKeys({
  people,
}: {
  readonly people: NonNullable<BoatKeyStatusDto["peopleWithOwnKeys"]>;
}) {
  const names = people.map((person) => person.name ?? "a removed account");
  return (
    <SettingsSection
      title="People with their own Boat key"
      why="A member can connect their own Boat key under Settings, Account. The Boat sessions they start here then run in, and are billed to, their own Boat account instead of this one."
    >
      <p className="text-[13px] leading-relaxed text-ink-2">
        {names.length === 0
          ? "Nobody in this organization has connected their own Boat key."
          : `${nameList(names)} ${names.length === 1 ? "has" : "have"} connected their own Boat key, so the organization's repositories are checked out in VMs in ${names.length === 1 ? "that Boat account" : "their Boat accounts"}. Only they see their key's details or change it.`}
      </p>
    </SettingsSection>
  );
}

/** Where a person's sessions go without their own key, in words. */
const fallbackOf = (status: PersonBoatKeyStatusDto): string =>
  status.organizationKey ? "the organization's Boat key" : "the server's Boat key";

/** A person's own Boat key, in words that name the organization it applies to (SLNT-797). */
export const personBoatKeySubject = (status: PersonBoatKeyStatusDto): BoatKeySubject => ({
  whose: "your",
  holder: "person",
  why: `The Boat sessions you start in ${status.organizationName} run in, and are billed to, your own Boat account. Without your own key they use ${fallbackOf(status)}.`,
  viewerLine: (connected) =>
    connected
      ? `Your Boat sessions in ${status.organizationName} run in your own Boat account.`
      : `Your Boat sessions in ${status.organizationName} use ${fallbackOf(status)}.`,
  notes: [
    `This key applies in ${status.organizationName} only: the organization's repositories are checked out in VMs in your Boat account, and its owners see that you have connected one, never its details.`,
    "Mend keeps no standby workspace on your key, so your Boat sessions here start without one: a standby would be a VM in your Boat account that you did not start.",
    "Your key builds its own image in your Boat account, even when the organization's key is in the same Boat organization, and that image keeps one of the account's saved snapshot slots.",
  ],
  removalFacts: [
    `Your new Boat sessions in ${status.organizationName} use ${fallbackOf(status)}.`,
    "Sealant deletes the saved images it made in your Boat account, which frees their snapshot slots.",
    "Mend refuses while your Boat account still holds VMs: stop your Boat sessions first.",
  ],
});

/**
 * The caller's own Boat key in their active organization, or null with no organization to apply
 * it in. The status is prefetched by the account page's loader; a sign-in without an organization
 * answers 404, and the section is left out.
 */
export const usePersonBoatKey = ():
  | (BoatKeyBinding & { readonly status: PersonBoatKeyStatusDto })
  | null => {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  // Read again every few seconds while a full check runs, as the organization's card does.
  const status = useQuery(
    trpc.personBoatKey.status.queryOptions(undefined, {
      retry: false,
      refetchInterval: (query) =>
        query.state.data?.details?.fullCheck.runningSince ? FULL_CHECK_POLL_MS : false,
    }),
  ).data;
  const refresh = () => queryClient.invalidateQueries(trpc.personBoatKey.status.pathFilter());
  const connect = useMutation({
    mutationKey: trpc.personBoatKey.connect.mutationKey(),
    mutationFn: (key: Redacted.Redacted<string>) =>
      client.personBoatKey.connect.mutate({ key: Redacted.value(key) }),
    gcTime: 0,
    onSuccess: () => check.reset(),
    onSettled: (_status, _error, key) => {
      Redacted.wipeUnsafe(key);
      return refresh();
    },
  });
  const check = useMutation(trpc.personBoatKey.check.mutationOptions({ onSettled: refresh }));
  const fullCheck = useMutation(
    trpc.personBoatKey.fullCheck.mutationOptions({ onSettled: refresh }),
  );
  const disconnect = useMutation(
    trpc.personBoatKey.disconnect.mutationOptions({
      onSuccess: () => check.reset(),
      onSettled: refresh,
    }),
  );
  return status === undefined ? null : { status, connect, check, fullCheck, disconnect };
};

/** Settings, Account, Boat key: the caller's own (SLNT-797). */
export function PersonBoatKeySection() {
  const binding = usePersonBoatKey();
  if (binding === null) return null;
  return <BoatKeyCard subject={personBoatKeySubject(binding.status)} binding={binding} canManage />;
}

const runtimeLine = (status: BoatKeyCardStatus): string | null =>
  status.sessionRuntime === "boat"
    ? null
    : `This server runs new sessions on ${status.sessionRuntime === "docker" ? "Docker" : "the runtime Sealant picks"}, so no session uses a Boat key until it runs them on Boat.`;

export function BoatKeyCard({
  subject,
  binding,
  canManage,
}: {
  readonly subject: BoatKeySubject;
  readonly binding: BoatKeyBinding;
  /** Whether this viewer connects, checks, replaces and removes the key. */
  readonly canManage: boolean;
}) {
  const { status } = binding;
  const runtime = runtimeLine(status);
  if (!canManage || (status.connected && status.details === null)) {
    return (
      <SettingsSection title="Boat key" why={subject.why}>
        <StatusWord tone={status.connected ? "ok" : "off"}>
          {status.connected ? "connected" : "not connected"}
        </StatusWord>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
          {subject.viewerLine(status.connected)}
        </p>
        {runtime === null ? null : <Notice>{runtime}</Notice>}
      </SettingsSection>
    );
  }
  if (status.details === null) {
    return (
      <SettingsSection title="Boat key" why={subject.why}>
        <StatusWord tone="off">not connected</StatusWord>
        <SubjectNotes subject={subject} />
        {runtime === null ? null : (
          <Notice>{`${runtime} You can connect one now for when it does.`}</Notice>
        )}
        <ConnectForm binding={binding} replacing={false} onDone={() => undefined} />
      </SettingsSection>
    );
  }
  return (
    <ConnectedKey subject={subject} binding={binding} details={status.details} runtime={runtime} />
  );
}

/** What a person reads beside their own key before anything else; nothing for the organization's. */
function SubjectNotes({ subject }: { readonly subject: BoatKeySubject }) {
  if (subject.notes.length === 0) return null;
  return (
    <ul className="mt-2 grid list-disc gap-1 pl-5 text-[13px] leading-relaxed text-muted-foreground">
      {subject.notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}

/** The command that creates a suitable key, in both forms, ready to copy. */
function CreateKeyCommands() {
  return (
    <div className="mb-4 grid gap-3">
      <p className="text-[13px] leading-relaxed text-ink-2">
        Create a key in Boat with the permissions Mend needs, then paste it here. It lasts a year,
        the longest Boat allows.
      </p>
      {BOAT_KEY_COMMANDS.map((form) => (
        <div key={form.key} className="grid gap-1.5">
          <Caption>{form.caption}</Caption>
          <CodeBox copy={form.command} label={`the command ${form.caption.toLowerCase()}`}>
            {form.command}
          </CodeBox>
        </div>
      ))}
    </div>
  );
}

/** The create-key command and one password field, checked by Boat before anything is kept. */
function ConnectForm({
  binding,
  replacing,
  onDone,
}: {
  readonly binding: BoatKeyBinding;
  readonly replacing: boolean;
  readonly onDone: () => void;
}) {
  const [key, setKey] = useState("");
  const { connect } = binding;
  return (
    <form
      className="mt-3"
      onSubmit={(event) => {
        event.preventDefault();
        const typed = key.trim();
        if (typed === "") return;
        // Gone from the page the moment it is sent; a refusal asks for it again.
        setKey("");
        connect.mutate(Redacted.make(typed), { onSuccess: onDone });
      }}
    >
      <CreateKeyCommands />
      <Field label="Boat key">
        {(id) => (
          <TextInput
            id={id}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="boat_…"
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
        )}
      </Field>
      <p className="mb-3 text-[12.5px] leading-relaxed text-muted-foreground">
        Sealant keeps the key sealed; Mend never shows it again.{" "}
        {replacing
          ? "Running sessions keep running on the new key."
          : "The first session after connecting waits a few minutes while Sealant builds its image in this Boat account, and that image keeps one of the account's saved snapshot slots until the key is removed."}
      </p>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={connect.isPending || key.trim() === ""}>
          {connect.isPending ? "Checking with Boat…" : "Check and connect"}
        </Button>
        {replacing ? (
          <Button variant="ghost" disabled={connect.isPending} onClick={onDone}>
            Cancel
          </Button>
        ) : null}
      </div>
      {connect.error === null ? null : (
        <ErrorNote className="mt-3">{errorText(connect.error)}</ErrorNote>
      )}
    </form>
  );
}

/** A fact's words in its tone, wrapping: a not-observed reason can carry Boat's own message. */
const FACT_TEXT: Record<Tone, string> = {
  run: "text-ink-2",
  ok: "text-ink-2",
  wait: "text-warning",
  bad: "text-danger",
  off: "text-muted-foreground",
};

const CHECK_STATE: Record<
  Exclude<BoatKeyCheckDto["state"], "active">,
  { readonly tone: Tone; readonly word: string; readonly line: string }
> = {
  removing: {
    tone: "wait",
    word: "removing",
    line: "Sealant is removing this Boat account, so no new session runs in it. Connect a key again once the removal is done.",
  },
  missing: {
    tone: "bad",
    word: "not in Sealant",
    line: "Sealant no longer lists the Boat account Mend recorded. Remove the key, then connect it again.",
  },
  none: {
    tone: "off",
    word: "not connected",
    line: "Another owner removed the key meanwhile.",
  },
};

function ConnectedKey({
  subject,
  binding,
  details,
  runtime,
}: {
  readonly subject: BoatKeySubject;
  readonly binding: BoatKeyBinding;
  readonly details: BoatKeyDetailsDto;
  readonly runtime: string | null;
}) {
  const { check, fullCheck, disconnect } = binding;
  const [dialog, setDialog] = useState<"replace" | "remove" | "full-check" | null>(null);
  const fullCheckRunning = details.fullCheck.runningSince !== null || fullCheck.isPending;
  const now = new Date();
  const checked = check.data ?? null;
  const report = checked?.report ?? details.report;
  const warnings = report === null ? [] : boatKeyWarnings(report, now, REPLACE_ON_PAGE);
  const checkState =
    checked === null || checked.state === "active" ? null : CHECK_STATE[checked.state];
  const observed = report?.observedAt ?? checked?.observedAt ?? null;
  const tone: Tone =
    checkState?.tone ??
    (warnings.some((warning) => warning.tone === "bad")
      ? "bad"
      : warnings.some((warning) => warning.tone === "wait")
        ? "wait"
        : "ok");
  return (
    <SettingsSection title="Boat key" why={subject.why}>
      <StatusWord tone={tone}>
        {`${checkState?.word ?? "connected"}${observed === null ? "" : ` · observed ${observedAt(observed, now)}`}`}
      </StatusWord>
      <p className="mt-1.5 font-mono text-[11.5px] leading-relaxed text-muted-foreground">
        connected by {details.connectedByName ?? "a removed account"} {dayOf(details.connectedAt)}
        {details.keyReplacedAt === null ? "" : ` · replaced ${dayOf(details.keyReplacedAt)}`}
      </p>
      <SubjectNotes subject={subject} />
      {checkState === null ? null : <Notice>{checkState.line}</Notice>}
      {checked === null || checked.unanswered === null ? null : (
        <Notice>{checked.unanswered}</Notice>
      )}
      {runtime === null ? null : <Notice>{runtime}</Notice>}
      {warnings.map((warning) =>
        warning.tone === "bad" ? (
          <ErrorNote key={warning.text} className="mt-3">
            {warning.text}
          </ErrorNote>
        ) : (
          <Notice key={warning.text}>{warning.text}</Notice>
        ),
      )}
      {report === null ? (
        <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">
          Not observed yet: who the key is, the wallet it bills, whether it can start a VM, its
          saved snapshot slots, its permissions and when it expires. Sealant has not checked this
          key with Boat since it was connected. Check now asks Boat.
        </p>
      ) : (
        <div className="mt-3">
          <DataTable
            label="What Mend observed about the key"
            columns={[
              { head: "Fact", width: "0.6fr" },
              { head: "Observed", width: "2fr" },
            ]}
            rows={boatKeyFacts(report, now).map((fact) => ({
              key: fact.label,
              cells: [
                <span key="label" className="text-[13px] text-ink-2">
                  {fact.label}
                </span>,
                <span
                  key="value"
                  className={cn(
                    "inline-flex min-w-0 items-baseline gap-1.5 font-mono text-[12px] break-words",
                    fact.tone === null ? "text-ink-2" : FACT_TEXT[fact.tone],
                  )}
                >
                  {fact.tone === null ? null : (
                    <Dot tone={fact.tone} className="translate-y-[-1px]" />
                  )}
                  <span className="min-w-0">{fact.value}</span>
                </span>,
              ],
            }))}
          />
        </div>
      )}
      <FullCheckResult fullCheck={details.fullCheck} holder={subject.holder} now={now} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={check.isPending} onClick={() => check.mutate()}>
          {check.isPending ? "Checking…" : "Check now"}
        </Button>
        <Button
          size="sm"
          disabled={fullCheckRunning}
          onClick={() => {
            fullCheck.reset();
            setDialog("full-check");
          }}
        >
          {fullCheckRunning ? "Full check running…" : "Run a full check…"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            binding.connect.reset();
            setDialog("replace");
          }}
        >
          Replace key…
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            disconnect.reset();
            setDialog("remove");
          }}
        >
          Remove…
        </Button>
      </div>
      {check.error === null ? null : (
        <ErrorNote className="mt-3">{errorText(check.error)}</ErrorNote>
      )}
      <ModalDialog
        open={dialog === "full-check"}
        onOpenChange={(open) => {
          if (!open && !fullCheck.isPending) setDialog(null);
        }}
        title="Run a full check of the Boat key?"
        width={520}
        footer={
          <>
            <Button variant="ghost" disabled={fullCheck.isPending} onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={fullCheck.isPending}
              onClick={() => fullCheck.mutate(undefined, { onSuccess: () => setDialog(null) })}
            >
              {fullCheck.isPending ? "Starting…" : "Run the full check"}
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-ink-2">{FULL_CHECK_WHY}</p>
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{FULL_CHECK_COST}</p>
        {fullCheck.error === null ? null : <ErrorNote>{errorText(fullCheck.error)}</ErrorNote>}
      </ModalDialog>
      <ModalDialog
        open={dialog === "replace"}
        onOpenChange={(open) => {
          if (!open && !binding.connect.isPending) setDialog(null);
        }}
        title={`Replace ${subject.whose} Boat key`}
        description="The new key must be for the same Boat account: it has to reach the VMs and saved images the account holds now. To move to another Boat account, remove this key, then connect the new one."
        width={600}
      >
        <ConnectForm binding={binding} replacing onDone={() => setDialog(null)} />
      </ModalDialog>
      <ModalDialog
        open={dialog === "remove"}
        onOpenChange={(open) => {
          if (!open && !disconnect.isPending) setDialog(null);
        }}
        title={`Remove ${subject.whose} Boat key?`}
        width={520}
        footer={
          <>
            <Button variant="ghost" disabled={disconnect.isPending} onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              className="border-danger text-danger"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate(undefined, { onSuccess: () => setDialog(null) })}
            >
              {disconnect.isPending ? "Removing…" : "Remove the Boat key"}
            </Button>
          </>
        }
      >
        <ul className="grid list-disc gap-1 pl-5 text-[13px] leading-relaxed text-muted-foreground">
          {subject.removalFacts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
        {disconnect.error === null ? null : <ErrorNote>{errorText(disconnect.error)}</ErrorNote>}
      </ModalDialog>
    </SettingsSection>
  );
}

/**
 * The key's full check (SLNT-784): the one running now, or the last one Sealant finished, step by
 * step, with whether everything it made was confirmed removed. Nothing until one has run.
 */
function FullCheckResult({
  fullCheck,
  holder,
  now,
}: {
  readonly fullCheck: BoatKeyDetailsDto["fullCheck"];
  readonly holder: BoatKeyHolder;
  readonly now: Date;
}) {
  if (fullCheck.runningSince !== null)
    return (
      <div className="mt-4">
        <StatusWord tone="run">{`full check running · started ${observedAt(fullCheck.runningSince, now)}`}</StatusWord>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
          It takes about a minute. You can leave this page: Sealant keeps the result, and this page
          shows it when it is done.
        </p>
      </div>
    );
  return fullCheck.last === null ? null : (
    <FullCheckProof proof={fullCheck.last} holder={holder} now={now} />
  );
}

function FullCheckProof({
  proof,
  holder,
  now,
}: {
  readonly proof: BoatKeyProofDto;
  readonly holder: BoatKeyHolder;
  readonly now: Date;
}) {
  const tone = proofTone(proof);
  return (
    <div className="mt-4">
      <StatusWord tone={tone ?? "ok"}>
        {`full check ${proofOutcomeWords(proof)} · observed ${observedAt(proof.finishedAt, now)}`}
      </StatusWord>
      <div className="mt-3">
        <DataTable
          label="What the full check did"
          columns={[
            { head: "Step", width: "0.6fr" },
            { head: "Observed", width: "2fr" },
          ]}
          rows={proof.steps.map((step) => {
            const words = proofStepWords(step, holder);
            return {
              key: step.step,
              cells: [
                <span key="label" className="text-[13px] text-ink-2">
                  {words.label}
                </span>,
                <span key="value" className="grid min-w-0 gap-1">
                  <span
                    className={cn(
                      "inline-flex items-baseline gap-1.5 font-mono text-[12px]",
                      words.tone === null ? "text-ink-2" : FACT_TEXT[words.tone],
                    )}
                  >
                    {words.tone === null ? null : (
                      <Dot tone={words.tone} className="translate-y-[-1px]" />
                    )}
                    {words.word}
                  </span>
                  {words.reason === null ? null : (
                    <span className="text-[12.5px] leading-relaxed break-words text-ink-2">
                      {words.reason}
                    </span>
                  )}
                </span>,
              ],
            };
          })}
        />
      </div>
      {proof.outcome === "interrupted" ? <Notice>{INTERRUPTED_WORDS}</Notice> : null}
      {proof.leftBehind.removalConfirmed ? (
        <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
          {proofLeftoverWords(proof)}
        </p>
      ) : (
        <Notice>{proofLeftoverWords(proof)}</Notice>
      )}
    </div>
  );
}
