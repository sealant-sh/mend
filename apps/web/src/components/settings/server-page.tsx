import { Status } from "@mend/ui/components/status";
import { Button } from "@mend/ui/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mend/ui/components/ui/collapsible";
import { cn } from "@mend/ui/lib/utils";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { ChevronRightIcon, TerminalIcon } from "lucide-react";
import { type ReactNode, useSyncExternalStore } from "react";

import type { MachineDto, SealantConnectionDto } from "#/lib/api";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import {
  addressSentence,
  boatWords,
  type CheckContext,
  type CheckWords,
  changeHow,
  createdLine,
  creationWords,
  DECLARED_WORDS,
  type Deployment,
  deploymentLine,
  exposureGroups,
  exposureSetWith,
  gateGroups,
  gateInPlaceLine,
  goPublicLead,
  goPublicLine,
  imageExtras,
  imageName,
  inPlaceLine,
  keyedParts,
  type NeedsYouWords,
  organizationCounts,
  packagesLine,
  platformName,
  RUNTIME_NAMES,
  RUNTIME_PLACES,
  RUNTIMES,
  runSeveralLine,
  runtimeOffer,
  sealantConnected,
  sealantNeedsYou,
  sessionChannelWords,
  setupCommandsLine,
  TENANCY_WORDS,
  type Tenancy,
  whenChecked,
  type Words,
  wordsText,
} from "#/lib/server-settings";
import { signedInOptions } from "#/lib/sign-in";
import { type TrpcProxy, useTRPC } from "#/lib/trpc";

import type { AppRouter } from "../../server/routers/index.ts";
import { SettingRow, SettingSection } from "./setting-row.tsx";
import { SettingsPage } from "./settings-page.tsx";

/** The live round-trip to Sealant: asked when the page opens and every few minutes while it stays. */
export const sealantConnectionOptions = (trpc: TrpcProxy) =>
  trpc.platform.sealantConnection.queryOptions(undefined, {
    staleTime: 0,
    refetchInterval: 180_000,
    retry: false,
  });

/** The reads each section waits on, apart, so one that fails leaves the others standing. */
export const serverQueries = (trpc: TrpcProxy) => ({
  exposure: trpc.platform.exposure.queryOptions(undefined, { retry: false }),
  machine: trpc.platform.machine.queryOptions(undefined, { retry: false }),
  health: trpc.platform.health.queryOptions(undefined, { retry: false }),
  settings: trpc.settings.get.queryOptions(undefined, { retry: false }),
  organizations: trpc.operator.organizations.queryOptions(undefined, { retry: false }),
  gate: trpc.operator.gate.queryOptions(undefined, { retry: false }),
});

type Outputs = inferRouterOutputs<AppRouter>;
type HealthDto = Outputs["platform"]["health"];
type ExposureDto = Outputs["platform"]["exposure"];
type GateDto = Outputs["operator"]["gate"];

/** A control's size: 32px beside a row on the desk, a 44px touch target on a phone. */
const touch = (phone: boolean) => (phone ? "touch" : "default");

const noChange = () => () => {};

/** The address the browser opened Mend at; empty while the page renders on the server. */
const useOrigin = (): string =>
  useSyncExternalStore(
    noChange,
    () => window.location.origin,
    () => "",
  );

/**
 * Settings → Server (Doop "Settings · Server (viewer: Grace Hopper, operator)", SLNT-1195): what
 * its operators read about the server they run, all of it read-only (docs/adr/0025: the Server's
 * values change with `mend server setup` or Helm). It answers, in order, what this server is,
 * whether anything needs the operator ("Needs you", drawn only when something does), and what it
 * offers. Each section reads on its own, and says so on its own when its read fails.
 */
export function ServerPage() {
  const trpc = useTRPC();
  const queries = serverQueries(trpc);
  const health = useQuery(queries.health);
  const machine = useQuery(queries.machine);
  const exposure = useQuery(queries.exposure);
  const gate = useQuery(queries.gate);
  const connection = useQuery(sealantConnectionOptions(trpc));
  const origin = useOrigin();
  const host = origin === "" ? "" : new URL(origin).host;
  const context: CheckContext = {
    deployment: health.data?.deploymentMode ?? null,
    address: origin,
  };
  const needsYou = needsYouOf({ connection, machine, exposure, gate, health }, context);
  return (
    <SettingsPage
      page="s-server"
      intro={
        <>
          How {host === "" ? "this server" : host} is set up. You can read everything here, but you
          change it on the server.
          <span className="mt-2 flex items-start gap-1.5 text-row text-muted-foreground [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0">
            <TerminalIcon aria-hidden />
            <span>To change something, {changeHowWords(context.deployment)}.</span>
          </span>
        </>
      }
    >
      <ThisServerSection
        health={health}
        machine={machine}
        connection={connection}
        origin={origin}
      />
      {needsYou.length === 0 ? null : <NeedsYouSection items={needsYou} />}
      <ReachSection exposure={exposure} context={context} />
      <SessionsSection machine={machine} />
      <ImageSection />
      <OrganizationsSection health={health} gate={gate} />
      <StorageSection health={health} />
    </SettingsPage>
  );
}

/** "run `mend server setup` on the server", with the command in mono. */
function changeHowWords(mode: Deployment | null): ReactNode {
  const how = changeHow(mode);
  const command = "mend server setup";
  const at = how.indexOf(command);
  if (at === -1) return how;
  return (
    <>
      {how.slice(0, at)}
      <code className="font-mono">{command}</code>
      {how.slice(at + command.length)}
    </>
  );
}

// -----------------------------------------------------------------------------------------------
// Pieces

/** Words with their machine facts in mono. */
function Said({ words }: { readonly words: Words }) {
  return (
    <>
      {keyedParts(words).map(({ key, part }) =>
        typeof part === "string" ? (
          <span key={key}>{part}</span>
        ) : (
          <code key={key} className="font-mono break-words">
            {part.code}
          </code>
        ),
      )}
    </>
  );
}

/**
 * A fact the server reports: its name and a muted line under it, its value on the right on the
 * desk, and under the text on a phone (the Phone · Settings · Server frame).
 */
function FactRow({
  label,
  description,
  value,
  mono = false,
  under = true,
  children,
}: {
  readonly label: string;
  readonly description?: ReactNode;
  readonly value?: ReactNode;
  readonly mono?: boolean;
  /** On a phone, put the value under the text (a long one) or keep it on the right (a short one). */
  readonly under?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <SettingRow
      label={label}
      description={description}
      note={children}
      layout={under ? "stack" : "row"}
      control={
        value === undefined ? undefined : (
          <span className={cn("break-words lg:text-right", mono && "font-mono text-row")}>
            {value}
          </span>
        )
      }
    />
  );
}

/** A query's own Loading line inside a section, padded like a row on a phone. */
function SectionBody({ children }: { readonly children: ReactNode }) {
  return <div className="border-b border-border py-3.5 max-lg:px-4">{children}</div>;
}

function Pending({ children }: { readonly children: string }) {
  return (
    <SectionBody>
      <Status tone="run" className="text-row">
        {children}
      </Status>
    </SectionBody>
  );
}

/**
 * One section's read, in every state: its own pending line, its failure in its place with Try
 * again (the rest of the page stays), and what it loaded.
 */
function SectionRead<T>({
  query,
  pending,
  children,
}: {
  readonly query: UseQueryResult<T, unknown>;
  readonly pending: ReactNode;
  readonly children: (data: T) => ReactNode;
}): ReactNode {
  switch (query.status) {
    case "pending":
      return pending;
    case "error":
      return (
        <SectionError
          error={query.error}
          retrying={query.isFetching}
          retry={() => void query.refetch()}
        />
      );
    case "success":
      return children(query.data);
  }
}

/** A section's read failed: what happened, and Try again, in the section's place. */
function SectionError({
  error,
  retry,
  retrying,
}: {
  readonly error: unknown;
  readonly retry: () => void;
  readonly retrying: boolean;
}) {
  const phone = usePhone();
  return (
    <div
      role="alert"
      className="flex items-start gap-3 border-b border-border py-3.5 max-lg:flex-col max-lg:px-4"
    >
      <div className="min-w-0 flex-1">
        <p className="font-semibold">This didn't load.</p>
        <p className="mt-0.5 text-row text-muted-foreground">
          {failureWords(error, "The server didn't answer. Try again in a moment.")}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        size={touch(phone)}
        className="max-lg:w-full"
        disabled={retrying}
        onClick={retry}
      >
        {retrying ? "Trying again…" : "Try again"}
      </Button>
    </div>
  );
}

/** A refresh button: says it is checking while it is, and stays put until the read settles. */
function CheckAgain({
  checking,
  onCheck,
}: {
  readonly checking: boolean;
  readonly onCheck: () => void;
}) {
  const phone = usePhone();
  return (
    <Button
      type="button"
      variant="outline"
      size={touch(phone)}
      className="max-lg:w-full"
      disabled={checking}
      onClick={onCheck}
    >
      {checking ? "Checking…" : "Check again"}
    </Button>
  );
}

/**
 * A closed line that opens into a list (the kit's Collapsible): the checks a server would have to
 * change, the ones in place, an image's packages.
 */
function Disclosure({ line, children }: { readonly line: string; readonly children: ReactNode }) {
  return (
    <Collapsible className="border-b border-border">
      <CollapsibleTrigger className="group flex min-h-12 w-full items-center gap-2.5 py-3 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 max-lg:min-h-11 max-lg:px-4">
        <ChevronRightIcon
          aria-hidden
          className="size-4 flex-none text-muted-foreground transition-transform group-data-panel-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="text-pretty">{line}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-border pl-6.5 max-lg:pr-4 max-lg:pl-10.5">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** One check in a list: its plain title with its id small beside it, what Mend saw, the fix. */
function CheckItem({ check }: { readonly check: CheckWords }) {
  return (
    <li className="border-b border-border py-3.5 last:border-b-0">
      <CheckText check={check} />
    </li>
  );
}

function CheckText({ check }: { readonly check: CheckWords }) {
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-0.5">
        <p className="font-semibold">{check.title}</p>
        <span className="font-mono text-xs text-faint">{check.id}</span>
      </div>
      <p className="mt-0.5 text-row text-pretty text-muted-foreground">
        <Said words={check.saw} />
      </p>
      {check.fix === null ? null : (
        <p className="mt-1 text-row text-pretty">
          <Said words={check.fix} />
        </p>
      )}
    </>
  );
}

function CheckList({
  label,
  lead,
  checks,
}: {
  readonly label: string;
  readonly lead?: string;
  readonly checks: ReadonlyArray<CheckWords>;
}) {
  return (
    <>
      {lead === undefined ? null : (
        <p className="pt-3.5 text-row text-pretty text-muted-foreground">{lead}</p>
      )}
      <ul aria-label={label}>
        {checks.map((check) => (
          <CheckItem key={check.id} check={check} />
        ))}
      </ul>
    </>
  );
}

// -----------------------------------------------------------------------------------------------
// What this server is

function ThisServerSection({
  health,
  machine,
  connection,
  origin,
}: {
  readonly health: UseQueryResult<HealthDto, unknown>;
  readonly machine: UseQueryResult<MachineDto, unknown>;
  readonly connection: UseQueryResult<SealantConnectionDto, unknown>;
  readonly origin: string;
}) {
  const exposure = machine.data?.exposure;
  return (
    <SettingSection title="This server">
      <FactRow
        label="Address"
        description={exposure === undefined ? undefined : addressSentence(exposure)}
        value={origin === "" ? undefined : origin}
        mono
      />
      <SectionRead query={health} pending={<Pending>Asking the server…</Pending>}>
        {(data) => (
          <>
            <FactRow label="Version" value={data.version} mono under={false} />
            <FactRow
              label="Runs on"
              description={
                machine.data === undefined ? undefined : platformName(machine.data.platform)
              }
              value={deploymentLine(data, machine.data?.hostname ?? null)}
            />
          </>
        )}
      </SectionRead>
      <SealantRow connection={connection} />
    </SettingSection>
  );
}

/**
 * The Sealant connection (doctor-web-connection), while it is connected or being checked: what Mend
 * saw when it last asked, never the service key. Not connected, it moves into "Needs you".
 */
function SealantRow({
  connection,
}: {
  readonly connection: UseQueryResult<SealantConnectionDto, unknown>;
}) {
  const phone = usePhone();
  const checking = connection.isFetching;
  const action = <CheckAgain checking={checking} onCheck={() => void connection.refetch()} />;
  switch (connection.status) {
    case "pending":
      return (
        <SettingRow
          label="Sealant"
          description={
            phone ? "Checking… Mend is asking Sealant now." : "Mend is asking Sealant now."
          }
          control={
            phone ? undefined : (
              <Status tone="run" className="text-prose">
                Checking…
              </Status>
            )
          }
        />
      );
    case "error":
      return (
        <SectionError
          error={connection.error}
          retrying={checking}
          retry={() => void connection.refetch()}
        />
      );
    case "success": {
      if (connection.data.status !== "connected") return null;
      const word = checking ? "Checking…" : "Connected";
      const said = sealantConnected(connection.data, new Date());
      return (
        <SettingRow
          label="Sealant"
          layout="stack"
          description={phone ? `${word}. ${said}` : said}
          control={
            phone ? (
              action
            ) : (
              <>
                <span className="text-prose text-muted-foreground">{word}</span>
                {action}
              </>
            )
          }
        />
      );
    }
  }
}

// -----------------------------------------------------------------------------------------------
// Needs you

interface NeedsYouItem {
  readonly key: string;
  readonly words: NeedsYouWords;
  /** A check's id, small beside its title. */
  readonly id?: string;
}

const checkNeedsYou = (check: CheckWords, prefix: string): NeedsYouItem => ({
  key: `${prefix}-${check.id}`,
  id: check.id,
  words: {
    title: check.title,
    word: null,
    saw: check.saw,
    asked: null,
    fix: check.fix,
    recheck: null,
  },
});

/**
 * Everything that needs the operator, in one list: Sealant not connected; Boat's addresses, the
 * server's Boat key or Boat's launch, when Boat is offered; on a public server, each exposure check
 * not in place; on a server running several organizations, each gate item missing. An open check
 * on a private server isn't here: nothing is wrong with that server.
 */
function needsYouOf(
  reads: {
    readonly connection: UseQueryResult<SealantConnectionDto, unknown>;
    readonly machine: UseQueryResult<MachineDto, unknown>;
    readonly exposure: UseQueryResult<ExposureDto, unknown>;
    readonly gate: UseQueryResult<GateDto, unknown>;
    readonly health: UseQueryResult<HealthDto, unknown>;
  },
  context: CheckContext,
): ReadonlyArray<NeedsYouItem> {
  const now = new Date();
  const sealantWords =
    reads.connection.status === "success"
      ? sealantNeedsYou(reads.connection.data, now, context.deployment)
      : null;
  const sealantItems: ReadonlyArray<NeedsYouItem> =
    sealantWords === null ? [] : [{ key: "sealant", words: sealantWords }];
  const machine = reads.machine.status === "success" ? reads.machine.data : null;
  const boatItems =
    machine?.boat !== undefined && machine.sessionRuntimes?.offered.includes("boat") === true
      ? boatWords(machine.boat, now).needsYou.map((words) => ({
          key: `boat-${words.title}`,
          words,
        }))
      : [];
  const exposureItems =
    reads.exposure.status === "success"
      ? exposureGroups(reads.exposure.data, context).needsYou.map((check) =>
          checkNeedsYou(check, "exposure"),
        )
      : [];
  const tenancy = reads.health.status === "success" ? reads.health.data.tenancy : null;
  const gateItems =
    reads.gate.status === "success" && tenancy !== null
      ? gateGroups(reads.gate.data, tenancy).needsYou.map((check) => checkNeedsYou(check, "gate"))
      : [];
  return [...sealantItems, ...boatItems, ...exposureItems, ...gateItems];
}

/** The check an item carries beside it: Sealant's connection, or the server's Boat key. */
function Recheck({ which }: { readonly which: "sealant" | "boat-key" }) {
  const trpc = useTRPC();
  const connection = useQuery(sealantConnectionOptions(trpc));
  return which === "sealant" ? (
    <CheckAgain checking={connection.isFetching} onCheck={() => void connection.refetch()} />
  ) : (
    <CheckBoatKey compact />
  );
}

/** The one amber on the page: a heading, then each thing with what Mend saw and what fixes it. */
function NeedsYouSection({ items }: { readonly items: ReadonlyArray<NeedsYouItem> }) {
  return (
    <section aria-label="Needs you" className="mt-7 first:mt-0">
      <div className="border-b border-border pb-2.5 max-lg:px-4">
        <h2 className="text-lead font-semibold text-warning">Needs you</h2>
      </div>
      <ul aria-label="Needs you">
        {items.map((item) => (
          <li key={item.key}>
            <NeedsYouRow item={item} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function NeedsYouRow({ item }: { readonly item: NeedsYouItem }) {
  const phone = usePhone();
  const { words } = item;
  const word = words.word === null ? null : words.word;
  return (
    <div className="flex items-start gap-8 border-b border-border py-3.5 max-lg:flex-col max-lg:gap-3 max-lg:px-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-0.5">
          <p className="font-semibold">{words.title}</p>
          {item.id === undefined ? null : (
            <span className="font-mono text-xs text-faint">{item.id}</span>
          )}
        </div>
        <p className="mt-0.5 text-row text-pretty text-muted-foreground">
          {phone && word !== null ? `${word}. ` : null}
          <Said words={words.saw} />
        </p>
        {words.asked === null ? null : (
          <p className="mt-1 text-row text-pretty text-muted-foreground">
            <Said words={words.asked} />
          </p>
        )}
        {words.fix === null ? null : (
          <p className="mt-1 text-row text-pretty">
            <Said words={words.fix} />
          </p>
        )}
      </div>
      {word === null && words.recheck === null ? null : (
        <div className="flex flex-none items-center justify-end gap-2 max-lg:w-full">
          {phone || word === null ? null : (
            <span className="text-prose text-muted-foreground">{word}</span>
          )}
          {words.recheck === null ? null : <Recheck which={words.recheck} />}
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------------------------
// Who can reach it

function ReachSection({
  exposure,
  context,
}: {
  readonly exposure: UseQueryResult<ExposureDto, unknown>;
  readonly context: CheckContext;
}) {
  return (
    <SettingSection
      title="Who can reach it"
      description={
        exposure.isSuccess
          ? `Mend checked this server ${whenChecked(new Date(exposure.dataUpdatedAt), new Date())}.`
          : undefined
      }
    >
      <SectionRead query={exposure} pending={<Pending>Reading what Mend checked…</Pending>}>
        {(report) => {
          const groups = exposureGroups(report, context);
          const total = report.items.length;
          return (
            <>
              <SettingRow
                label={DECLARED_WORDS[report.declared].word}
                description={DECLARED_WORDS[report.declared].means}
                note={
                  <span className="text-muted-foreground">
                    <Said words={exposureSetWith(context.deployment)} />
                  </span>
                }
              />
              {groups.toGoPublic.length === 0 ? null : (
                <Disclosure line={goPublicLine(groups.toGoPublic.length)}>
                  <CheckList
                    label="What would have to change"
                    lead={goPublicLead(groups.toGoPublic)}
                    checks={groups.toGoPublic}
                  />
                </Disclosure>
              )}
              {groups.inPlace.length === 0 ? null : (
                <Disclosure line={inPlaceLine(groups.inPlace.length, total)}>
                  <CheckList label="Checks in place" checks={groups.inPlace} />
                </Disclosure>
              )}
            </>
          );
        }}
      </SectionRead>
    </SettingSection>
  );
}

// -----------------------------------------------------------------------------------------------
// Where sessions run

function SessionsSection({ machine }: { readonly machine: UseQueryResult<MachineDto, unknown> }) {
  const phone = usePhone();
  return (
    <SettingSection
      title="Where sessions run"
      description="Each organization picks one of these on its Runtime page."
    >
      <SectionRead query={machine} pending={<Pending>Reading where sessions run…</Pending>}>
        {(data) => {
          const offer = data.sessionRuntimes;
          if (offer === undefined) {
            return (
              <FactRow
                label="Sealant picks"
                description="This server offers no choice of runtime. Sealant decides where each workspace runs."
              />
            );
          }
          return RUNTIMES.map((runtime) => {
            const offered = runtimeOffer(runtime, offer);
            const place = `${RUNTIME_PLACES[runtime]}${offered.startsHere ? " New organizations start on it." : ""}`;
            return (
              <FactRow
                key={runtime}
                label={RUNTIME_NAMES[runtime]}
                description={phone ? `${offered.word}. ${place}` : place}
                value={
                  phone ? undefined : <span className="text-muted-foreground">{offered.word}</span>
                }
                under={false}
              >
                {runtime === "boat" && data.boat !== undefined && offer.offered.includes("boat") ? (
                  <BoatFacts boat={data.boat} />
                ) : null}
              </FactRow>
            );
          });
        }}
      </SectionRead>
    </SettingSection>
  );
}

/** What the server saw about Boat, as sentences, and the server key's check when it holds one. */
function BoatFacts({ boat }: { readonly boat: NonNullable<MachineDto["boat"]> }) {
  const words = boatWords(boat, new Date());
  return (
    <div className="grid gap-1.5 text-row text-pretty">
      {words.sentences.map((sentence) => (
        <p key={wordsText(sentence)}>
          <Said words={sentence} />
        </p>
      ))}
      {boat.serverKey.state === "held" &&
      words.needsYou.every((item) => item.recheck !== "boat-key") ? (
        <CheckBoatKey />
      ) : null}
    </div>
  );
}

/**
 * Sealant checks the server's own Boat key with Boat now; the machine view, read again, says what it
 * saw. `compact` is the button alone, as "Needs you" carries it beside its status word.
 */
function CheckBoatKey({ compact = false }: { readonly compact?: boolean }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const phone = usePhone();
  const checkKey = useMutation(
    trpc.platform.checkServerBoatKey.mutationOptions({
      onSettled: () => queryClient.invalidateQueries(trpc.platform.machine.pathFilter()),
    }),
  );
  const failed =
    checkKey.error === null ? null : (
      <span role="alert" className="text-row text-destructive">
        The check didn't run. {failureWords(checkKey.error, "Try again in a moment.")}
      </span>
    );
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1.5 max-lg:flex-col max-lg:items-stretch",
        compact ? "max-lg:w-full" : "mt-1.5",
      )}
    >
      <Button
        type="button"
        variant="outline"
        size={touch(phone)}
        disabled={checkKey.isPending}
        onClick={() => checkKey.mutate()}
      >
        {checkKey.isPending ? "Checking with Boat…" : "Check the key now"}
      </Button>
      {failed ??
        (compact ? null : (
          <span className="text-row text-muted-foreground">Sealant also checks it once a day.</span>
        ))}
    </div>
  );
}

// -----------------------------------------------------------------------------------------------
// Starting workspace image

function ImageSection() {
  const trpc = useTRPC();
  const settings = useQuery(serverQueries(trpc).settings);
  return (
    <SettingSection
      title="Starting workspace image"
      description="Each new organization starts with a copy of this image. Changing it never touches an organization that already exists."
    >
      <SectionRead query={settings} pending={<Pending>Reading the image…</Pending>}>
        {({ workspaceImage: image }) => (
          <>
            <SettingRow label={imageName(image)} description={imageExtras(image)} />
            {image.packages.length === 0 ? null : (
              <Disclosure line={packagesLine(image.packages.length)}>
                <ul
                  aria-label="Packages"
                  className="flex flex-wrap gap-x-3 gap-y-1 py-3.5 font-mono text-row"
                >
                  {image.packages.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </Disclosure>
            )}
            {image.mode === "custom" && image.setupCommands.length > 0 ? (
              <Disclosure line={setupCommandsLine(image.setupCommands.length)}>
                <ol aria-label="Setup commands" className="grid gap-1 py-3.5 font-mono text-row">
                  {keyedParts(image.setupCommands).map(({ key, part }) => (
                    <li key={key} className="break-words whitespace-pre-wrap">
                      {typeof part === "string" ? part : part.code}
                    </li>
                  ))}
                </ol>
              </Disclosure>
            ) : null}
          </>
        )}
      </SectionRead>
    </SettingSection>
  );
}

// -----------------------------------------------------------------------------------------------
// Organizations

function OrganizationsSection({
  health,
  gate,
}: {
  readonly health: UseQueryResult<HealthDto, unknown>;
  readonly gate: UseQueryResult<GateDto, unknown>;
}) {
  const trpc = useTRPC();
  const organizations = useQuery(serverQueries(trpc).organizations);
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const phone = usePhone();
  const tenancy = health.data?.tenancy ?? null;
  const creation = creationWords(viewer.canCreateOrganizations);
  return (
    <SettingSection
      title="Organizations"
      description="Everyone who signs in to this server is in at least one of these."
    >
      <SectionRead query={organizations} pending={<Pending>Reading the organizations…</Pending>}>
        {(list) =>
          list.length === 0 ? (
            <SettingRow
              label="No organizations yet"
              description="The first account created on this server makes the first one."
            />
          ) : (
            <ul aria-label="Organizations on this server">
              {list.map((summary) => {
                const counts = organizationCounts(summary);
                const created = createdLine(summary.organization.createdAt);
                return (
                  <li key={summary.organization.id}>
                    <FactRow
                      label={summary.organization.name}
                      description={phone ? `${counts}. ${created}.` : created}
                      value={phone ? undefined : counts}
                      under={false}
                    />
                  </li>
                );
              })}
            </ul>
          )
        }
      </SectionRead>
      {tenancy === null ? null : (
        <SettingRow
          label={TENANCY_WORDS[tenancy].word}
          description={TENANCY_WORDS[tenancy].means}
          note={
            <span className="text-muted-foreground">
              Set with <code className="font-mono">MEND_TENANCY</code>.
            </span>
          }
        />
      )}
      {tenancy === "multi" ? (
        <FactRow
          label="Who may create one"
          description={creation.means}
          value={phone ? undefined : creation.word}
          under={false}
        >
          <span className="text-muted-foreground">
            Set with <code className="font-mono">MEND_ORGANIZATION_CREATION</code>.
          </span>
        </FactRow>
      ) : null}
      {tenancy === null ? null : <GateRows gate={gate} tenancy={tenancy} />}
    </SettingSection>
  );
}

/**
 * The multi mode gate, closed: on a server with one organization, what would have to change before
 * it could run several, then what is in place. On a server with several, missing items are in
 * "Needs you" and this lists what is in place.
 */
function GateRows({
  gate,
  tenancy,
}: {
  readonly gate: UseQueryResult<GateDto, unknown>;
  readonly tenancy: Tenancy;
}) {
  return (
    <SectionRead query={gate} pending={null}>
      {(items) => {
        const groups = gateGroups(items, tenancy);
        return (
          <>
            {groups.toRunSeveral.length === 0 ? null : (
              <Disclosure line={runSeveralLine(groups.toRunSeveral.length)}>
                <CheckList label="What would have to change" checks={groups.toRunSeveral} />
              </Disclosure>
            )}
            {groups.inPlace.length === 0 ? null : (
              <Disclosure line={gateInPlaceLine(groups.inPlace.length, items.length)}>
                <CheckList label="Items in place" checks={groups.inPlace} />
              </Disclosure>
            )}
          </>
        );
      }}
    </SectionRead>
  );
}

// -----------------------------------------------------------------------------------------------
// Storage and connections

function StorageSection({ health }: { readonly health: UseQueryResult<HealthDto, unknown> }) {
  return (
    <SettingSection title="Storage and connections">
      <SectionRead query={health} pending={<Pending>Asking the server…</Pending>}>
        {(data) => (
          <>
            <FactRow
              label="Central store"
              description="Where Mend keeps every project's repository and worktrees."
              value={data.storeRoot}
              mono
            />
            <FactRow
              label="Session channel"
              description="How workspaces reach their session."
              value={<Said words={sessionChannelWords(data.sessionChannel)} />}
            />
          </>
        )}
      </SectionRead>
    </SettingSection>
  );
}
