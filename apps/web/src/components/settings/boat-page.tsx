import {
  boatKeyFacts,
  type BoatKeyTone,
  boatWalletChoices,
  type BoatWalletChoices,
  FULL_CHECK_COST,
  FULL_CHECK_WHY,
  hasUnreachable,
  INTERRUPTED_WORDS,
  proofLeftoverWords,
  proofOutcomeWords,
  proofStepWords,
  proofTone,
  unreachableWords,
} from "@mend/domain/workbench";
import { Banner, InlineAlert } from "@mend/ui/components/banner";
import { CopyField } from "@mend/ui/components/copy-field";
import { Button } from "@mend/ui/components/ui/button";
import { Input } from "@mend/ui/components/ui/input";
import { Label } from "@mend/ui/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@mend/ui/components/ui/native-select";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Redacted } from "effect";
import { type ReactNode, useState } from "react";

import type {
  BoatKeyCheckDto,
  BoatKeyDetailsDto,
  BoatKeyProofDto,
  BoatKeyStatusDto,
} from "#/lib/api";
import {
  ago,
  BOAT_KEY_COMMANDS,
  boatIntro,
  CHECK_STATE_LINES,
  expiryBanner,
  keyLine,
  keyWarnings,
  lastCheckLine,
  memberKeyLine,
  noKeyLine,
  REMOVAL_FACTS,
  runtimeLine,
} from "#/lib/boat-key";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import { signedInOptions } from "#/lib/sign-in";
import { useTRPC, useTRPCClient } from "#/lib/trpc";
import { useViewer } from "#/lib/use-viewer";

import { Overlay } from "../projects/overlay.tsx";
import { SettingRow, SettingSection } from "./setting-row.tsx";
import { settingsLink } from "./settings-links.tsx";
import { SettingsPage } from "./settings-page.tsx";

/** How often the page reads the key again while a full check runs. */
const FULL_CHECK_POLL_MS = 3_000;

/** A control's size: 32px beside a row on the desk, a 44px touch target on a phone. */
const touch = (phone: boolean) => (phone ? "touch" : "default");

/** The status query, read again every few seconds while a full check runs. */
export const boatKeyStatusOptions = (trpc: ReturnType<typeof useTRPC>) =>
  trpc.boatKey.status.queryOptions(undefined, {
    refetchInterval: (query) =>
      query.state.data?.details?.fullCheck.runningSince ? FULL_CHECK_POLL_MS : false,
  });

/**
 * The key's reads and changes. `connect` takes the key as `Redacted` and wipes it once the call
 * settles, so neither the mutation cache nor a refusal holds it.
 */
function useBoatKey() {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const status = useSuspenseQuery(boatKeyStatusOptions(trpc)).data;
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries(trpc.boatKey.status.pathFilter()),
      queryClient.invalidateQueries(trpc.organization.audit.pathFilter()),
    ]);
  const check = useMutation(trpc.boatKey.check.mutationOptions({ onSettled: refresh }));
  const connect = useMutation({
    mutationKey: trpc.boatKey.connect.mutationKey(),
    mutationFn: (key: Redacted.Redacted) =>
      client.boatKey.connect.mutate({ key: Redacted.value(key) }),
    gcTime: 0,
    // A check of the key it replaced no longer says anything about this one.
    onSuccess: () => check.reset(),
    onSettled: (_status, _error, key) => {
      Redacted.wipeUnsafe(key);
      return refresh();
    },
  });
  const fullCheck = useMutation(trpc.boatKey.fullCheck.mutationOptions({ onSettled: refresh }));
  const chooseWallet = useMutation(
    trpc.boatKey.chooseWallet.mutationOptions({
      // A check from before the change reports the wallet the key billed then.
      onSuccess: () => check.reset(),
      onSettled: refresh,
    }),
  );
  const disconnect = useMutation(
    trpc.boatKey.disconnect.mutationOptions({ onSuccess: () => check.reset(), onSettled: refresh }),
  );
  return { status, check, connect, fullCheck, chooseWallet, disconnect };
}

type BoatKey = ReturnType<typeof useBoatKey>;

/**
 * Settings → the organization → Boat (Doop "Settings · Northwind · Boat"): the organization's Boat
 * key (docs/adr/0025; the personal Boat key is gone). Everyone sees whether there is one; its
 * owners see its details, connect, check, run a full check, choose its wallet, replace and remove
 * it. No part of the key is ever shown after it is entered.
 */
export function BoatPage() {
  const trpc = useTRPC();
  const { organizationName } = useViewer();
  const { role } = useSuspenseQuery(signedInOptions(trpc)).data;
  const boat = useBoatKey();
  const { status } = boat;
  const details = status.details;
  const owner = role === "owner";
  const [dialog, setDialog] = useState<"connect" | "replace" | "remove" | "full-check" | null>(
    null,
  );
  const now = new Date();
  const report = boat.check.data?.report ?? details?.report ?? null;
  const banner = owner && details !== null ? expiryBanner(report, now, organizationName) : null;
  const openReplace = () => {
    boat.connect.reset();
    setDialog("replace");
  };
  return (
    <SettingsPage
      page="o-boat"
      intro={boatIntro(organizationName)}
      banner={
        banner === null ? undefined : <ExpiryBanner banner={banner} onReplace={openReplace} />
      }
    >
      <SettingSection title="Boat key">
        {!owner || (status.connected && details === null) ? (
          <SettingRow
            label={`${organizationName}'s key`}
            description={memberKeyLine(status.connected, organizationName)}
          />
        ) : details === null ? (
          <NoKey
            organizationName={organizationName}
            onConnect={() => {
              boat.connect.reset();
              setDialog("connect");
            }}
          />
        ) : (
          <ConnectedKey
            boat={boat}
            details={details}
            organizationName={organizationName}
            now={now}
            onReplace={openReplace}
            onRemove={() => {
              boat.disconnect.reset();
              setDialog("remove");
            }}
            onFullCheck={() => {
              boat.fullCheck.reset();
              setDialog("full-check");
            }}
          />
        )}
      </SettingSection>
      {owner && details !== null && report !== null ? <ReportFacts report={report} /> : null}
      <WhereBoatIsUsed runtime={status.sessionRuntime} organizationName={organizationName} />
      <KeyDialog
        boat={boat}
        mode={dialog === "connect" || dialog === "replace" ? dialog : null}
        organizationName={organizationName}
        onClose={() => setDialog(null)}
      />
      <RemoveDialog
        boat={boat}
        open={dialog === "remove"}
        organizationName={organizationName}
        onClose={() => setDialog(null)}
      />
      <FullCheckDialog boat={boat} open={dialog === "full-check"} onClose={() => setDialog(null)} />
    </SettingsPage>
  );
}

function ExpiryBanner({
  banner,
  onReplace,
}: {
  readonly banner: NonNullable<ReturnType<typeof expiryBanner>>;
  readonly onReplace: () => void;
}) {
  const phone = usePhone();
  return (
    <Banner
      tone={banner.tone}
      title={banner.title}
      layout={phone ? "stacked" : "inline"}
      actions={
        <Button type="button" variant="outline" size={phone ? "touch" : "sm"} onClick={onReplace}>
          Replace key…
        </Button>
      }
    >
      {banner.body}
    </Banner>
  );
}

function NoKey({
  organizationName,
  onConnect,
}: {
  readonly organizationName: string;
  readonly onConnect: () => void;
}) {
  const phone = usePhone();
  return (
    <SettingRow
      label={`${organizationName}'s key`}
      description={noKeyLine(organizationName)}
      layout="stack"
      control={
        <Button type="button" size={touch(phone)} onClick={onConnect}>
          Connect key…
        </Button>
      }
    />
  );
}

/** A note under the key's rows: the tone colours only its icon. */
function Note({
  tone,
  title,
  children,
}: {
  readonly tone: "info" | "warning" | "error";
  readonly title?: string;
  readonly children: ReactNode;
}) {
  const phone = usePhone();
  return (
    <InlineAlert
      tone={tone}
      size={phone ? "touch" : "default"}
      className="mt-3 max-lg:mx-4"
      {...(title === undefined ? {} : { title })}
    >
      {children}
    </InlineAlert>
  );
}

function ConnectedKey({
  boat,
  details,
  organizationName,
  now,
  onReplace,
  onRemove,
  onFullCheck,
}: {
  readonly boat: BoatKey;
  readonly details: BoatKeyDetailsDto;
  readonly organizationName: string;
  readonly now: Date;
  readonly onReplace: () => void;
  readonly onRemove: () => void;
  readonly onFullCheck: () => void;
}) {
  const phone = usePhone();
  const checked: BoatKeyCheckDto | null = boat.check.data ?? null;
  const report = checked?.report ?? details.report;
  const warnings = report === null ? [] : keyWarnings(report, now);
  const wallets = report === null ? null : boatWalletChoices(report, "other");
  const checkState =
    checked === null || checked.state === "active" ? null : CHECK_STATE_LINES[checked.state];
  const running = details.fullCheck.runningSince !== null || boat.fullCheck.isPending;
  return (
    <>
      <SettingRow
        label={`${organizationName}'s key`}
        description={keyLine(details, report, now)}
        layout="stack"
        control={
          <>
            <Button type="button" variant="outline" size={touch(phone)} onClick={onReplace}>
              Replace key…
            </Button>
            <Button type="button" variant="ghost" size={touch(phone)} onClick={onRemove}>
              Remove key…
            </Button>
          </>
        }
      />
      {wallets === null ? null : <WalletRow boat={boat} choices={wallets} />}
      <SettingRow
        label="Last check"
        description={lastCheckLine(report, now)}
        layout="stack"
        note={
          boat.check.isError ? (
            <p role="alert" className="text-destructive">
              Mend couldn't check the key.{" "}
              {failureWords(boat.check.error, "Check your connection and try again.")}
            </p>
          ) : checked?.unanswered ? (
            <p className="text-muted-foreground">{checked.unanswered}</p>
          ) : undefined
        }
        control={
          <Button
            type="button"
            variant="outline"
            size={touch(phone)}
            disabled={boat.check.isPending}
            onClick={() => boat.check.mutate()}
          >
            {boat.check.isPending ? <Spinner aria-hidden /> : null}
            {boat.check.isPending ? "Checking…" : report === null ? "Check now" : "Check again"}
          </Button>
        }
      />
      <SettingRow
        label="Full check"
        description={fullCheckLine(details.fullCheck, now)}
        layout="stack"
        note={
          details.fullCheck.runningSince === null && details.fullCheck.last !== null ? (
            <ProofSteps proof={details.fullCheck.last} />
          ) : undefined
        }
        control={
          <Button
            type="button"
            variant="outline"
            size={touch(phone)}
            disabled={running}
            onClick={onFullCheck}
          >
            {running ? <Spinner aria-hidden /> : null}
            {running ? "Running…" : "Run a full check…"}
          </Button>
        }
      />
      {checkState === null ? null : (
        <Note tone="error" title={checkState.title}>
          {checkState.body}
        </Note>
      )}
      {warnings.map((warning) => (
        <Note
          key={warning.text}
          tone={warning.tone === "bad" ? "error" : warning.tone === "wait" ? "warning" : "info"}
        >
          {warning.text}
        </Note>
      ))}
      {hasUnreachable(details.unreachable) ? (
        <Note tone="info">{unreachableWords(details.unreachable, "organization")}</Note>
      ) : null}
    </>
  );
}

/** The Full check row's line: running, never run, or the last one's outcome. */
const fullCheckLine = (fullCheck: BoatKeyDetailsDto["fullCheck"], now: Date): string => {
  if (fullCheck.runningSince !== null) {
    return `Running since ${ago(fullCheck.runningSince, now)}. It takes about a minute; you can leave this page and Sealant keeps the result.`;
  }
  if (fullCheck.last === null) {
    return "Never run. A full check starts a throwaway VM with the key, uses it as a session would, and deletes it.";
  }
  return `The last one ${proofOutcomeWords(fullCheck.last)}, ${ago(fullCheck.last.finishedAt, now)}.`;
};

const TONE_TEXT: Record<BoatKeyTone, string> = {
  wait: "text-warning",
  bad: "text-destructive",
  off: "text-muted-foreground",
};

/** Each step of the last full check, and what it left behind in Boat. */
function ProofSteps({ proof }: { readonly proof: BoatKeyProofDto }) {
  const tone = proofTone(proof);
  return (
    <div className="mt-1 grid gap-1.5">
      <ul aria-label="What the full check did" className="grid gap-1">
        {proof.steps.map((step) => {
          const words = proofStepWords(step, "organization");
          return (
            <li key={step.step} className="flex flex-wrap gap-x-2 text-row">
              <span className="text-muted-foreground">{words.label}</span>
              <span
                className={cn(
                  "font-mono text-meta",
                  words.tone === null ? "text-foreground-2" : TONE_TEXT[words.tone],
                )}
              >
                {words.word}
              </span>
              {words.reason === null ? null : (
                <span className="w-full text-muted-foreground">{words.reason}</span>
              )}
            </li>
          );
        })}
      </ul>
      {proof.outcome === "interrupted" ? (
        <p className="text-muted-foreground">{INTERRUPTED_WORDS}</p>
      ) : null}
      <p
        className={cn(
          proof.leftBehind.removalConfirmed || tone === null
            ? "text-muted-foreground"
            : TONE_TEXT[tone],
        )}
      >
        {proofLeftoverWords(proof)}
      </p>
    </div>
  );
}

/**
 * Which wallet a personal key bills, when its Boat account can bill more than one. Choosing one
 * takes effect at once, for the Boat sessions that start next. Never shown for a Boat
 * organization's key, which bills only its own organization.
 */
function WalletRow({
  boat,
  choices,
}: {
  readonly boat: BoatKey;
  readonly choices: BoatWalletChoices;
}) {
  const phone = usePhone();
  const { organizationName } = useViewer();
  const { chooseWallet } = boat;
  const value = chooseWallet.isPending ? chooseWallet.variables.wallet : (choices.current ?? "");
  return (
    <SettingRow
      label="Wallet"
      labelFor="boat-wallet"
      layout="stack"
      description={
        choices.pinned
          ? `Boat charges ${organizationName}'s sessions to this wallet. A change applies to the sessions that start next.`
          : "The key isn't pinned to a wallet, so it bills whichever wallet is active in Boat. Choosing one pins it."
      }
      note={
        chooseWallet.isError ? (
          <p role="alert" className="text-destructive">
            Mend didn't change the wallet.{" "}
            {failureWords(chooseWallet.error, "Check your connection and try again.")}
          </p>
        ) : chooseWallet.isPending ? (
          <p className="text-muted-foreground">Saving…</p>
        ) : undefined
      }
      control={
        <NativeSelect
          id="boat-wallet"
          size={phone ? "field" : "default"}
          value={value}
          disabled={chooseWallet.isPending}
          className="w-72 max-lg:w-full"
          onChange={(event) => {
            if (event.target.value !== "") chooseWallet.mutate({ wallet: event.target.value });
          }}
        >
          {choices.current === null ? (
            <NativeSelectOption value="">Choose a wallet</NativeSelectOption>
          ) : null}
          {choices.options.map((option) => (
            <NativeSelectOption key={option.id} value={option.id}>
              {`${option.label.charAt(0).toUpperCase()}${option.label.slice(1)}`}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      }
    />
  );
}

/** Everything Boat last reported about the key, one row per fact. */
function ReportFacts({ report }: { readonly report: NonNullable<BoatKeyCheckDto["report"]> }) {
  const now = new Date();
  return (
    <SettingSection
      title="What Boat reported"
      description={`Observed ${ago(report.observedAt, now)}.`}
    >
      {boatKeyFacts(report, now, "other").map((fact) => (
        <SettingRow
          key={fact.label}
          label={fact.label}
          description={
            <span
              className={cn(
                "font-mono text-meta wrap-anywhere",
                fact.tone === null ? "text-foreground-2" : TONE_TEXT[fact.tone],
              )}
            >
              {fact.value}
            </span>
          }
        />
      ))}
    </SettingSection>
  );
}

function WhereBoatIsUsed({
  runtime,
  organizationName,
}: {
  readonly runtime: BoatKeyStatusDto["sessionRuntime"];
  readonly organizationName: string;
}) {
  const words = runtimeLine(runtime, organizationName);
  return (
    <section aria-label="Where Boat is used" className="mt-10 max-lg:px-4">
      <h2 className="text-lead font-semibold">Where Boat is used</h2>
      <p className="mt-0.5 text-row text-pretty text-muted-foreground">
        {words.lead}{" "}
        <Link {...settingsLink("o-runtime")} className="underline underline-offset-2">
          {words.rest}
        </Link>
      </p>
    </section>
  );
}

/**
 * Connect a key, or replace it: the command that makes one, then one password field, checked by
 * Boat before anything is kept. The field empties the moment the key is sent; a refusal asks for
 * it again.
 */
function KeyDialog({
  boat,
  mode,
  organizationName,
  onClose,
}: {
  readonly boat: BoatKey;
  readonly mode: "connect" | "replace" | null;
  readonly organizationName: string;
  readonly onClose: () => void;
}) {
  // Kept while the dialog closes, so its words don't change as it goes.
  const [shown, setShown] = useState(mode);
  if (mode !== null && mode !== shown) setShown(mode);
  const replacing = shown === "replace";
  const close = () => {
    if (boat.connect.isPending) return;
    onClose();
  };
  return (
    <Overlay
      open={mode !== null}
      onOpenChange={(next) => (next ? undefined : close())}
      size="md"
      title={
        replacing
          ? `Replace ${organizationName}'s Boat key`
          : `Connect ${organizationName}'s Boat key`
      }
      description={
        replacing
          ? "Mend checks the new key with Boat before it saves it. The new key must be for the same Boat account; sessions that are running keep running."
          : "Mend checks the key with Boat before it saves it. The first session after connecting waits a few minutes while Sealant builds its image in this Boat account."
      }
      footer={null}
    >
      {mode === null ? null : <KeyForm boat={boat} replacing={replacing} onClose={onClose} />}
    </Overlay>
  );
}

function KeyForm({
  boat,
  replacing,
  onClose,
}: {
  readonly boat: BoatKey;
  readonly replacing: boolean;
  readonly onClose: () => void;
}) {
  const phone = usePhone();
  const [key, setKey] = useState("");
  const { connect } = boat;
  const submit = async () => {
    const typed = key.trim();
    if (typed === "") return;
    // Gone from the page the moment it is sent; a refusal asks for it again.
    setKey("");
    try {
      await connect.mutateAsync(Redacted.make(typed));
      toast.add({ description: replacing ? "Replaced the Boat key." : "Connected the Boat key." });
      onClose();
    } catch {
      // Said under the field, from the mutation's error.
    }
  };
  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="grid gap-2">
        <p className="text-row text-pretty text-foreground-2">
          Create a key in Boat with the permissions Mend needs, then paste it here. It lasts a year,
          the longest Boat allows.
        </p>
        {BOAT_KEY_COMMANDS.map((form) => (
          <div key={form.key} className="grid gap-1">
            <p className="text-meta text-muted-foreground">{form.caption}</p>
            <CopyField
              value={form.command}
              label="Copy command"
              size={phone ? "touch" : "default"}
            />
          </div>
        ))}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="boat-key">{replacing ? "New key" : "Boat key"}</Label>
        <Input
          id="boat-key"
          type="password"
          value={key}
          placeholder="boat_…"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={connect.isError}
          aria-describedby="boat-key-help"
          className="h-9 font-mono max-lg:h-11 max-lg:text-base"
          onChange={(event) => setKey(event.target.value)}
        />
        {connect.isError ? (
          <p id="boat-key-help" role="alert" className="text-row text-destructive">
            {failureWords(connect.error, "Mend couldn't reach Boat. Try again.")}
          </p>
        ) : (
          <p id="boat-key-help" className="text-meta text-muted-foreground">
            Sealant keeps the key sealed when you save it, so nobody can read it back.
          </p>
        )}
      </div>
      <div className="flex justify-end gap-2.5 pt-1 max-lg:*:flex-1">
        <Button
          type="button"
          variant="outline"
          size={touch(phone)}
          disabled={connect.isPending}
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button type="submit" size={touch(phone)} disabled={connect.isPending || key.trim() === ""}>
          {connect.isPending ? <Spinner aria-hidden /> : null}
          {connect.isPending ? "Checking with Boat…" : replacing ? "Replace key" : "Connect key"}
        </Button>
      </div>
    </form>
  );
}

function RemoveDialog({
  boat,
  open,
  organizationName,
  onClose,
}: {
  readonly boat: BoatKey;
  readonly open: boolean;
  readonly organizationName: string;
  readonly onClose: () => void;
}) {
  const { disconnect } = boat;
  const close = () => {
    if (disconnect.isPending) return;
    onClose();
  };
  const confirm = async () => {
    try {
      await disconnect.mutateAsync();
      toast.add({ description: "Removed the Boat key." });
      onClose();
    } catch {
      // Said in the dialog, from the mutation's error.
    }
  };
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => (next ? undefined : close())}
      size="sm"
      title={`Remove ${organizationName}'s Boat key?`}
      footer={
        <>
          <Button type="button" variant="outline" disabled={disconnect.isPending} onClick={close}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={disconnect.isPending}
            onClick={() => void confirm()}
          >
            {disconnect.isPending ? <Spinner aria-hidden /> : null}
            {disconnect.isPending ? "Removing…" : "Remove key"}
          </Button>
        </>
      }
    >
      <ul className="grid list-disc gap-1.5 pl-5 text-row text-pretty text-foreground-2">
        {REMOVAL_FACTS.map((fact) => (
          <li key={fact}>{fact}</li>
        ))}
      </ul>
      {disconnect.isError ? (
        <p role="alert" className="mt-3 text-row text-destructive">
          Mend didn't remove the key. {failureWords(disconnect.error, "Try again.")}
        </p>
      ) : null}
    </Overlay>
  );
}

function FullCheckDialog({
  boat,
  open,
  onClose,
}: {
  readonly boat: BoatKey;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const { fullCheck } = boat;
  const close = () => {
    if (fullCheck.isPending) return;
    onClose();
  };
  const confirm = async () => {
    try {
      await fullCheck.mutateAsync();
      onClose();
    } catch {
      // Said in the dialog, from the mutation's error.
    }
  };
  return (
    <Overlay
      open={open}
      onOpenChange={(next) => (next ? undefined : close())}
      size="sm"
      title="Run a full check of the Boat key?"
      footer={
        <>
          <Button type="button" variant="outline" disabled={fullCheck.isPending} onClick={close}>
            Cancel
          </Button>
          <Button type="button" disabled={fullCheck.isPending} onClick={() => void confirm()}>
            {fullCheck.isPending ? <Spinner aria-hidden /> : null}
            {fullCheck.isPending ? "Starting…" : "Run the full check"}
          </Button>
        </>
      }
    >
      <p className="text-row text-pretty text-foreground-2">{FULL_CHECK_WHY}</p>
      <p className="mt-2 text-row text-pretty text-muted-foreground">{FULL_CHECK_COST}</p>
      {fullCheck.isError ? (
        <p role="alert" className="mt-3 text-row text-destructive">
          The full check didn't start. {failureWords(fullCheck.error, "Try again.")}
        </p>
      ) : null}
    </Overlay>
  );
}
