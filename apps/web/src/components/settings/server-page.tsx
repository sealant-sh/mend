import { serverBoatLines } from "@mend/domain/workbench";
import { Status } from "@mend/ui/components/status";
import { Button } from "@mend/ui/components/ui/button";
import { Spinner } from "@mend/ui/components/ui/spinner";
import { cn } from "@mend/ui/lib/utils";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { TerminalIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { MachineDto, SealantConnectionDto } from "#/lib/api";
import { usePhone } from "#/lib/phone";
import { failureWords } from "#/lib/refusal";
import {
  addressKindsLine,
  addressLine,
  changeHow,
  creationWord,
  DECLARED_WORDS,
  deploymentLine,
  exposureResult,
  exposureSummary,
  gateSummary,
  imageExtras,
  imageLine,
  organizationCounts,
  refusesPublicStart,
  RUNTIME_NAMES,
  RUNTIME_PLACES,
  RUNTIMES,
  runtimeOffer,
  type Said,
  sealantReading,
  sessionChannelLine,
  TENANCY_WORDS,
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

type HealthDto = inferRouterOutputs<AppRouter>["platform"]["health"];

/** A control's size: 32px beside a row on the desk, a 44px touch target on a phone. */
const touch = (phone: boolean) => (phone ? "touch" : "default");

/**
 * Settings → Server (Doop "Settings · Server (viewer: Grace Hopper, operator)"): what its operators
 * read about the server they run, all of it read-only (docs/adr/0025: the Server's values change
 * with `mend server setup` or Helm). How it is reached and what the exposure report observed; its
 * version and where it runs; the Sealant connection with its check, and the runtimes it offers;
 * the starting workspace image; the organizations on it. Each section reads on its own, and says
 * so on its own when its read fails.
 *
 * Storage, limits and mirrors, which the frame also draws, have no answer from the server yet, so
 * the page leaves them out.
 */
export function ServerPage() {
  const trpc = useTRPC();
  const queries = serverQueries(trpc);
  const health = useQuery(queries.health);
  const machine = useQuery(queries.machine);
  return (
    <SettingsPage
      page="s-server"
      intro={
        <>
          How this server is set up. You can read everything here, but you change it on the server.
          <span className="mt-2 flex items-start gap-1.5 text-row text-muted-foreground [&_svg]:mt-0.5 [&_svg]:size-3.5 [&_svg]:shrink-0">
            <TerminalIcon aria-hidden />
            <span>To change something, {changeHow(health.data?.deploymentMode ?? null)}.</span>
          </span>
        </>
      }
    >
      <ExposureSection machine={machine} />
      <ThisServerSection health={health} machine={machine} />
      <RuntimesSection machine={machine} />
      <ImageSection />
      <OrganizationsSection health={health} />
    </SettingsPage>
  );
}

/**
 * A fact the server reports: its name, then its value with a muted line under it. On the desk the
 * name sits in a column of its own beside the value; on a phone the name is a small muted line
 * above it (the Phone · Settings · Server frame).
 */
function FactRow({
  label,
  value,
  note,
  mono = false,
  children,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly note?: ReactNode;
  readonly mono?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <div
      data-slot="fact-row"
      className="grid gap-x-8 gap-y-0.5 border-b border-border py-3.5 max-lg:px-4 lg:grid-cols-[14.5rem_1fr]"
    >
      <p className="font-semibold max-lg:text-row max-lg:font-normal max-lg:text-muted-foreground">
        {label}
      </p>
      <div className="min-w-0">
        <p className={cn("break-words", mono && "font-mono text-row")}>{value}</p>
        {note === undefined || note === null ? null : (
          <div className="mt-0.5 text-row text-pretty text-muted-foreground">{note}</div>
        )}
        {children}
      </div>
    </div>
  );
}

/** One item of a check list (the exposure report, the multi mode gate): id, result, what was seen. */
interface CheckItem {
  readonly id: string;
  readonly result: Said;
  readonly detail: string;
  readonly fix: string | null;
  readonly note?: string | undefined;
}

/**
 * A list of checks: three columns on the desk (Check, Result, What Mend saw); on a phone the id and
 * the result share a line and what Mend saw goes under them, as the phone frame draws it.
 */
function CheckList({
  label,
  items,
}: {
  readonly label: string;
  readonly items: ReadonlyArray<CheckItem>;
}) {
  const columns = "lg:grid lg:grid-cols-[14.5rem_8rem_1fr] lg:gap-x-8";
  return (
    <div role="table" aria-label={label}>
      <div
        role="row"
        className={cn(
          columns,
          "border-b border-border pt-4 pb-2 text-row text-muted-foreground max-lg:hidden",
        )}
      >
        <span role="columnheader">Check</span>
        <span role="columnheader">Result</span>
        <span role="columnheader">What Mend saw</span>
      </div>
      {items.map((item) => (
        <div
          key={item.id}
          role="row"
          className={cn(columns, "border-b border-border py-3 max-lg:px-4")}
        >
          <span role="cell" className="flex items-baseline justify-between gap-3">
            <span className="font-mono text-row break-all">{item.id}</span>
            <Status tone={item.result.tone} className="text-row lg:hidden">
              {item.result.word}
            </Status>
          </span>
          <span role="cell" className="max-lg:hidden">
            <Status tone={item.result.tone} className="text-prose">
              {item.result.word}
            </Status>
            {item.note === undefined ? null : (
              <span className="mt-0.5 block text-row text-muted-foreground">{item.note}</span>
            )}
          </span>
          <span
            role="cell"
            className="block text-pretty max-lg:mt-1 max-lg:text-row max-lg:text-muted-foreground"
          >
            {item.detail}
            {item.fix === null ? null : (
              <span className="mt-0.5 block text-row text-muted-foreground">{item.fix}</span>
            )}
            {item.note === undefined ? null : (
              <span className="mt-0.5 block text-row text-warning lg:hidden">{item.note}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

/** A section's action on a phone: under its rows, at full width (the desk shows it beside the title). */
function PhoneAction({ children }: { readonly children: ReactNode }) {
  return <div className="mt-4 px-4 lg:hidden [&>*]:w-full">{children}</div>;
}

/** A refresh button: says it is checking while it is, and stays put until the read settles. */
function CheckAgain({
  checking,
  onCheck,
  label = "Check again",
}: {
  readonly checking: boolean;
  readonly onCheck: () => void;
  readonly label?: string;
}) {
  const phone = usePhone();
  return (
    <Button
      type="button"
      variant="outline"
      size={touch(phone)}
      disabled={checking}
      onClick={onCheck}
    >
      {checking ? <Spinner aria-hidden /> : null}
      {checking ? "Checking…" : label}
    </Button>
  );
}

/** A query's own Loading line inside a section, padded like a row on a phone. */
function SectionBody({ children }: { readonly children: ReactNode }) {
  return <div className="py-3.5 max-lg:px-4">{children}</div>;
}

// -----------------------------------------------------------------------------------------------

function ExposureSection({ machine }: { readonly machine: UseQueryResult<MachineDto, unknown> }) {
  const trpc = useTRPC();
  const report = useQuery(serverQueries(trpc).exposure);
  const checking = report.isFetching || machine.isFetching;
  const checkAgain = () => {
    void report.refetch();
    void machine.refetch();
  };
  const action = report.isSuccess ? <CheckAgain checking={checking} onCheck={checkAgain} /> : null;
  return (
    <SettingSection
      title="Address and exposure"
      description={
        report.isSuccess
          ? exposureSummary(report.data.items, new Date(report.dataUpdatedAt), new Date())
          : "What Mend observed about how this server is reached, beside what you declared."
      }
      action={action ?? undefined}
    >
      <SectionRead
        query={report}
        pending={
          <SectionBody>
            <Status tone="run" className="text-row">
              Reading the exposure report…
            </Status>
          </SectionBody>
        }
      >
        {(data) => {
          const exposure = machine.data?.exposure;
          return (
            <>
              {exposure === undefined ? null : (
                <FactRow
                  label="Address"
                  value={addressLine(exposure)}
                  note={addressKindsLine(exposure.addressKinds)}
                />
              )}
              <FactRow
                label="Exposure"
                value={DECLARED_WORDS[data.declared].word}
                note={
                  <>
                    {DECLARED_WORDS[data.declared].means} Set with{" "}
                    <code className="font-mono">MEND_EXPOSURE</code>.
                  </>
                }
              />
              <CheckList
                label="Exposure checks"
                items={data.items.map((item) => ({
                  id: item.id,
                  result: exposureResult(item),
                  detail: item.detail,
                  fix: item.fix,
                  note: refusesPublicStart(item) ? "Refuses a public start" : undefined,
                }))}
              />
            </>
          );
        }}
      </SectionRead>
      {action === null ? null : <PhoneAction>{action}</PhoneAction>}
    </SettingSection>
  );
}

/**
 * One section's read, in every state: its own pending line, its failure in its place with Try
 * again (the rest of the page stays), and what it loaded. `empty` shows when the read holds an
 * empty list.
 */
function SectionRead<T>({
  query,
  pending,
  empty,
  children,
}: {
  readonly query: UseQueryResult<T, unknown>;
  readonly pending: ReactNode;
  readonly empty?: ReactNode;
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
      return empty !== undefined && Array.isArray(query.data) && query.data.length === 0
        ? empty
        : children(query.data);
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

// -----------------------------------------------------------------------------------------------

function ThisServerSection({
  health,
  machine,
}: {
  readonly health: UseQueryResult<HealthDto, unknown>;
  readonly machine: UseQueryResult<MachineDto, unknown>;
}) {
  return (
    <SettingSection title="This server" description="What the server says about itself when asked.">
      <SectionRead
        query={health}
        pending={
          <SectionBody>
            <Status tone="run" className="text-row">
              Asking the server…
            </Status>
          </SectionBody>
        }
      >
        {(data) => (
          <>
            <FactRow label="Version" value={data.version} mono />
            <FactRow
              label="Runs on"
              value={deploymentLine(data, machine.data?.hostname ?? null)}
              note={machine.data === undefined ? undefined : machine.data.platform}
            />
            <FactRow
              label="Central store"
              value={data.storeRoot}
              mono
              note="Where Mend keeps every project's repository and worktrees."
            />
            <FactRow label="Session channel" value={sessionChannelLine(data.sessionChannel)} />
          </>
        )}
      </SectionRead>
    </SettingSection>
  );
}

// -----------------------------------------------------------------------------------------------

function RuntimesSection({ machine }: { readonly machine: UseQueryResult<MachineDto, unknown> }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const connection = useQuery(sealantConnectionOptions(trpc));
  // Sealant checks the server's own Boat key with Boat now; the machine view, read again, says
  // what it observed (SLNT-822).
  const checkKey = useMutation(
    trpc.platform.checkServerBoatKey.mutationOptions({
      onSettled: () => queryClient.invalidateQueries(trpc.platform.machine.pathFilter()),
    }),
  );
  const checking = connection.isFetching;
  const action = <CheckAgain checking={checking} onCheck={() => void connection.refetch()} />;
  const phone = usePhone();
  return (
    <SettingSection
      title="Runtimes"
      description="Mend runs every workspace through Sealant. Each organization picks one of these runtimes on its Runtime page."
      action={action}
    >
      <SealantRow connection={connection} />
      <SectionRead
        query={machine}
        pending={
          <SectionBody>
            <Status tone="run" className="text-row">
              Reading the runtimes…
            </Status>
          </SectionBody>
        }
      >
        {(data) => {
          const offer = data.sessionRuntimes;
          if (offer === undefined) {
            return (
              <FactRow
                label="Where sessions run"
                value="Sealant picks"
                note="This server offers no choice of runtime: Sealant decides where each workspace runs."
              />
            );
          }
          const boat = data.boat;
          return RUNTIMES.map((runtime) => {
            const offered = runtimeOffer(runtime, offer);
            const lines =
              runtime === "boat" && boat !== undefined
                ? serverBoatLines({ facts: boat, now: new Date(), from: "the server" })
                : [];
            return (
              <FactRow
                key={runtime}
                label={RUNTIME_NAMES[runtime]}
                value={offered.word}
                note={
                  <>
                    {RUNTIME_PLACES[runtime]}
                    {offered.startsHere ? " New organizations start on it." : null}
                  </>
                }
              >
                {lines.length === 0 ? null : (
                  <ul aria-label="What Mend saw about Boat" className="mt-2 grid gap-1.5 text-row">
                    {lines.map((line) => (
                      <li key={`${line.label}-${line.detail}`} className="text-pretty">
                        <span className="font-mono">{line.label}</span>
                        <span className="text-muted-foreground"> · {line.detail}</span>
                        {line.fix === null ? null : (
                          <span className="mt-0.5 block text-warning">{line.fix}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {runtime === "boat" && boat?.serverKey.state === "held" ? (
                  <div className="mt-3 grid justify-items-start gap-1.5 max-lg:justify-items-stretch">
                    <Button
                      type="button"
                      variant="outline"
                      size={touch(phone)}
                      disabled={checkKey.isPending}
                      onClick={() => checkKey.mutate()}
                    >
                      {checkKey.isPending ? <Spinner aria-hidden /> : null}
                      {checkKey.isPending ? "Checking with Boat…" : "Check the server's Boat key"}
                    </Button>
                    {checkKey.error === null ? (
                      <span className="text-row text-muted-foreground">
                        Sealant asks Boat about the key now, read-only. Otherwise it checks once a
                        day.
                      </span>
                    ) : (
                      <span role="alert" className="text-row text-destructive">
                        The check didn't run.{" "}
                        {failureWords(checkKey.error, "Try again in a moment.")}
                      </span>
                    )}
                  </div>
                ) : null}
              </FactRow>
            );
          });
        }}
      </SectionRead>
      <PhoneAction>{action}</PhoneAction>
    </SettingSection>
  );
}

/**
 * The Sealant connection (doctor-web-connection): what Mend observed when it last asked Sealant,
 * never the service key. While a check runs the row says so; a failed one keeps what the last
 * check found beneath its own failure.
 */
function SealantRow({
  connection,
}: {
  readonly connection: UseQueryResult<SealantConnectionDto, unknown>;
}) {
  return (
    <SectionRead
      query={connection}
      pending={
        <FactRow
          label="Sealant"
          value={
            <Status tone="run" className="text-row">
              Checking…
            </Status>
          }
          note="Mend is asking Sealant now."
        />
      }
    >
      {(data) => {
        const reading = sealantReading(data, new Date());
        return (
          <FactRow
            label="Sealant"
            value={
              connection.isFetching ? (
                <Status tone="run" className="text-row">
                  Checking…
                </Status>
              ) : (
                <Status tone={reading.tone} className="text-prose">
                  {reading.word}
                </Status>
              )
            }
            note={
              <>
                {reading.line}
                {reading.saw === null ? null : (
                  <span className="mt-0.5 block">
                    What Mend saw: <span className="font-mono break-all">{reading.saw}</span>
                  </span>
                )}
              </>
            }
          />
        );
      }}
    </SectionRead>
  );
}

// -----------------------------------------------------------------------------------------------

function ImageSection() {
  const trpc = useTRPC();
  const settings = useQuery(serverQueries(trpc).settings);
  return (
    <SettingSection
      title="Starting workspace image"
      description="Each new organization gets a copy of this image, and its owners change their copy on its Workspace image page. Nothing follows this image: changing it never touches an organization that exists."
    >
      <SectionRead
        query={settings}
        pending={
          <SectionBody>
            <Status tone="run" className="text-row">
              Reading the image…
            </Status>
          </SectionBody>
        }
      >
        {({ workspaceImage: image }) => (
          <>
            <FactRow label="Image" value={imageLine(image)} note={imageExtras(image)} />
            {image.packages.length === 0 ? null : (
              <FactRow label="Packages" value={image.packages.join(" ")} mono />
            )}
            {image.mode === "custom" && image.setupCommands.length > 0 ? (
              <FactRow label="Setup commands" value={image.setupCommands.join("\n")} mono />
            ) : null}
          </>
        )}
      </SectionRead>
    </SettingSection>
  );
}

// -----------------------------------------------------------------------------------------------

function OrganizationsSection({ health }: { readonly health: UseQueryResult<HealthDto, unknown> }) {
  const trpc = useTRPC();
  const queries = serverQueries(trpc);
  const organizations = useQuery(queries.organizations);
  const gate = useQuery(queries.gate);
  const viewer = useSuspenseQuery(signedInOptions(trpc)).data;
  const tenancy = health.data?.tenancy ?? null;
  return (
    <SettingSection
      title="Organizations"
      description="Everyone who signs in to this server is in at least one of these."
    >
      {tenancy === null ? null : (
        <FactRow
          label="Tenancy"
          value={TENANCY_WORDS[tenancy].word}
          note={TENANCY_WORDS[tenancy].means}
        />
      )}
      {tenancy === "multi" ? (
        <FactRow
          label="Who may create one"
          value={creationWord(viewer.canCreateOrganizations)}
          note={
            <>
              Set with <code className="font-mono">MEND_ORGANIZATION_CREATION</code>.
            </>
          }
        />
      ) : null}
      <SectionRead query={gate} pending={null}>
        {(items) =>
          tenancy === null ? null : (
            <>
              <FactRow
                label="Multi-organization gate"
                value={gateSummary(items, tenancy)}
                note="What the server checks before it runs several organizations."
              />
              <CheckList
                label="Multi-organization gate"
                items={items.map((item) => ({
                  id: item.id,
                  result: item.ok
                    ? { word: "In place", tone: "idle" as const }
                    : { word: "Missing", tone: "wait" as const },
                  detail: item.detail,
                  fix: item.fix,
                }))}
              />
            </>
          )
        }
      </SectionRead>
      <SectionRead
        query={organizations}
        pending={
          <SectionBody>
            <Status tone="run" className="text-row">
              Reading the organizations…
            </Status>
          </SectionBody>
        }
        empty={
          <SettingRow
            label="No organizations yet"
            description="The first account created on this server makes the first one."
          />
        }
      >
        {(list) => (
          <ul aria-label="Organizations on this server">
            {list.map((summary) => (
              <li key={summary.organization.id}>
                <FactRow
                  label={summary.organization.name}
                  value={organizationCounts(summary)}
                  note={`Created ${summary.organization.createdAt.toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}`}
                />
              </li>
            ))}
          </ul>
        )}
      </SectionRead>
    </SettingSection>
  );
}
