import type { WorkspaceRuntimesReading } from "@mend/domain";
import type {
  BoatAddress,
  BoatAddressPurpose,
  BoatLaunch,
  ServerBoatFacts,
  ServerBoatKey,
} from "@mend/domain/workbench";
import { SealantClients, WorkspaceRuntimesReport } from "@mend/sealant";
import { BlobStoreConfig, DeploymentConfig } from "@mend/store";
import { Clock, Duration, Effect, Layer, Ref } from "effect";
import * as Context from "effect/Context";

/**
 * What this server observed about Boat, for its operator's machine view (SLNT-799): the public
 * addresses Boat VMs dial, its own Boat key as Sealant last checked it, and whether Sealant lists
 * Boat. Never fails: a fact Mend could not read says why.
 */
export class MachineBoatReport extends Context.Service<
  MachineBoatReport,
  { readonly read: () => Effect.Effect<ServerBoatFacts> }
>()("@mend/api/MachineBoatReport") {}

/** A reading is kept this long, so a page that asks every thirty seconds asks Boat's addresses at most twice a minute. */
export const MACHINE_BOAT_KEPT = Duration.seconds(30);
/** How long an address or Sealant has to answer. */
const ANSWER_TIMEOUT_MS = 3_000;

/** Why a fetch got no HTTP answer, as Node's fetch reports it: the cause's code where it has one. */
const noAnswerDetail = (cause: unknown): string => {
  if (cause instanceof Error && cause.name === "TimeoutError")
    return `no answer within ${ANSWER_TIMEOUT_MS / 1000} seconds`;
  const inner: unknown = cause instanceof Error ? cause.cause : undefined;
  const code: unknown =
    typeof inner === "object" && inner !== null ? Reflect.get(inner, "code") : undefined;
  if (typeof code === "string") return code;
  return cause instanceof Error ? cause.message : "no answer";
};

/** Asks one address from this server. Any HTTP status is an answer: the forwarding reached something. */
export const askAddress = (
  purpose: BoatAddressPurpose,
  url: string,
): Effect.Effect<BoatAddress> =>
  Effect.gen(function* () {
    const answer = yield* Effect.promise(() =>
      fetch(`${url.replace(/\/+$/, "")}/`, {
        redirect: "manual",
        signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
      }).then(
        (response): BoatAddress["answer"] => {
          void response.body?.cancel();
          return { answered: true, status: response.status };
        },
        (cause: unknown): BoatAddress["answer"] => ({
          answered: false,
          detail: noAnswerDetail(cause),
        }),
      ),
    );
    return { purpose, url, answer, observedAt: new Date(yield* Clock.currentTimeMillis) };
  });

/** Whether Sealant lists Boat, from the runtime report every page reads. */
export const boatLaunchOf = (reading: WorkspaceRuntimesReading): BoatLaunch => {
  if (reading.state === "unread") return reading;
  const boat = reading.runtimes.runtimes.find((entry) => entry.runtime === "boat");
  return boat === undefined
    ? { state: "not-listed", observedAt: reading.observedAt }
    : {
        state: "listed",
        observedAt: reading.observedAt,
        resourceGateway: boat.resources.supported,
      };
};

const UNREACHED = "Sealant did not answer";

export const MachineBoatReportLive: Layer.Layer<
  MachineBoatReport,
  never,
  SealantClients | WorkspaceRuntimesReport | DeploymentConfig | BlobStoreConfig
> = Layer.effect(
  MachineBoatReport,
  Effect.gen(function* () {
    const clients = yield* SealantClients;
    const runtimes = yield* WorkspaceRuntimesReport;
    const deployment = yield* DeploymentConfig;
    const blobStore = yield* BlobStoreConfig;
    const addresses: ReadonlyArray<readonly [BoatAddressPurpose, string]> = [
      ...(deployment.sessionEndpoint === undefined
        ? []
        : [["sessions", deployment.sessionEndpoint.url] as const]),
      ...(blobStore.publicUrl === undefined ? [] : [["saved-work", blobStore.publicUrl] as const]),
    ];
    const timeout = Duration.millis(ANSWER_TIMEOUT_MS);
    const serverKey: Effect.Effect<ServerBoatKey> = clients.boatInstallKey().pipe(
      Effect.timeout(timeout),
      Effect.map(
        (key): ServerBoatKey => (key === null ? { state: "none" } : { state: "held", ...key }),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("machine view: the server's Boat key could not be read").pipe(
          Effect.annotateLogs({ cause: String(cause) }),
          Effect.as<ServerBoatKey>({ state: "unread", reason: UNREACHED }),
        ),
      ),
    );
    const storedKeys: Effect.Effect<number | null> = clients.listBoatAccounts().pipe(
      Effect.timeout(timeout),
      Effect.map((accounts) => accounts.filter((account) => account.state === "active").length),
      Effect.orElseSucceed(() => null),
    );
    const observe = Effect.all(
      {
        addresses: Effect.forEach(addresses, ([purpose, url]) => askAddress(purpose, url), {
          concurrency: "unbounded",
        }),
        serverKey,
        storedKeys,
        launch: runtimes.read().pipe(Effect.map(boatLaunchOf)),
      },
      { concurrency: "unbounded" },
    );
    const kept = yield* Ref.make<{ readonly until: number; readonly facts: ServerBoatFacts } | null>(
      null,
    );
    const read = Effect.fn("MachineBoatReport.read")(function* () {
      const now = yield* Clock.currentTimeMillis;
      const known = yield* Ref.get(kept);
      if (known !== null && known.until > now) return known.facts;
      const facts = yield* observe;
      yield* Ref.set(kept, { until: now + Duration.toMillis(MACHINE_BOAT_KEPT), facts });
      return facts;
    });
    return { read };
  }),
);
