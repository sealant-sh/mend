import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { ExecutorIdentity } from "@mend/auth";
import { ExecutorInstancesRepo, ExecutorRepo, type ExecutorInstanceRow } from "@mend/db";
import type { OrganizationId } from "@mend/domain";
import type { ExecutorManagedAction, ExecutorManagedStatus } from "@mend/domain/workbench";
import { NetworkConfig } from "@mend/network";
import {
  CallerServices,
  type ScopeInstance,
  type ScopeInstanceSpec,
  type SealantPlatformError,
} from "@mend/sealant";
import { SecretCipher, StoreConfig } from "@mend/store";
import { Config, Context, Effect, Layer, Redacted, Schema } from "effect";

import { ExecutorFailure } from "./failure.ts";
import { requestExecutor, type ExecutorTarget } from "./http.ts";
import { signInExecutorOwner, signInExecutorPerson } from "./sign-in.ts";
import { ExecutorCredentials, ExecutorTransport } from "./transport.ts";

/** Executor upgrades move only with this release pin. */
export const EXECUTOR_IMAGE =
  "ghcr.io/usefulsoftwareco/executor-selfhost@sha256:055217310f759bf87ff529ecf8b7a69e6eb3bb8bae9dde8164eedfb2afb2b467";
/** The native runtime needs this limit to collect under memory pressure. */
export const EXECUTOR_MEMORY_BYTES = 1536 * 1024 * 1024;
const secret = () => Redacted.make(randomBytes(32).toString("base64url"));
const storageBytes = 10 * 1024 * 1024 * 1024;
const origin = "http://executor.localhost:4400";
const budget = { cpuMillicores: 1000, memoryBytes: EXECUTOR_MEMORY_BYTES, storageBytes };
const Secret = Schema.RedactedFromValue(Schema.String);
const State = Schema.Struct({
  betterAuthSecret: Secret,
  encryptionKey: Secret,
  ownerPassword: Secret,
  ssoClientSecret: Secret,
  removingInstanceId: Schema.optionalKey(Schema.String),
});
const failure = (message: string) => new ExecutorFailure({ kind: "unavailable", message });
const platformFailure = (error: SealantPlatformError) =>
  failure(
    error.code === "ResourceRuntimeUnsupportedError"
      ? "Sealant cannot run a Mend-run Executor on this runtime. Use your organization's own Executor."
      : `Sealant refused the Executor lifecycle request · ${error.code} · observed. The operator can check its caller configuration.`,
  );

const route = (instance: ScopeInstance): ExecutorTarget | null =>
  instance.endpoint === undefined || instance.state.kind !== "running"
    ? null
    : { origin, endpoint: instance.endpoint };

/** Owns one organization's retained gateway, independently of any workspace or session. */
export class MendRunExecutor extends Context.Service<
  MendRunExecutor,
  {
    readonly status: (
      organizationId: OrganizationId,
    ) => Effect.Effect<typeof ExecutorManagedStatus.Type>;
    readonly act: (
      organizationId: OrganizationId,
      action: typeof ExecutorManagedAction.Type,
    ) => Effect.Effect<void, ExecutorFailure>;
    readonly link: (
      organizationId: OrganizationId,
      userId: string,
    ) => Effect.Effect<void, ExecutorFailure>;
    readonly target: (
      organizationId: OrganizationId,
    ) => Effect.Effect<ExecutorTarget, ExecutorFailure>;
  }
>()("@mend/sessions/MendRunExecutor") {}

type Dependencies =
  | ExecutorInstancesRepo
  | ExecutorRepo
  | CallerServices
  | ExecutorTransport
  | SecretCipher
  | StoreConfig
  | NetworkConfig
  | ExecutorIdentity;
const make: Effect.Effect<MendRunExecutor["Service"], never, Dependencies> = Effect.gen(
  function* () {
    const instances = yield* ExecutorInstancesRepo;
    const identity = yield* ExecutorIdentity;
    const identityFailure = (error: { readonly message: string }) => failure(error.message);
    const links = yield* ExecutorRepo;
    const services = yield* CallerServices;
    const transport = yield* ExecutorTransport;
    const cipher = yield* SecretCipher;
    const store = yield* StoreConfig;
    const network = yield* NetworkConfig;
    const runtime = yield* Config.String("MEND_EXECUTOR_RUNTIME").pipe(
      Config.withDefault("unconfigured"),
      Effect.orDie,
    );
    const caller = yield* Config.String("MEND_EXECUTOR_CALLER").pipe(
      Config.withDefault("mend"),
      Effect.orDie,
    );
    const reason =
      runtime === "docker"
        ? null
        : runtime === "kubernetes"
          ? "Mend cannot run Executor on Kubernetes yet. Sealant's caller services have only manifest verification there. Use your organization's own Executor."
          : "Mend-run Executor needs a Docker deployment with Mend's server configured as Sealant's caller. A server running on the host is not supported.";
    const scope = (row: ExecutorInstanceRow) =>
      services.organization(row.scopeKey, budget).pipe(Effect.mapError(platformFailure));
    const unseal = (row: ExecutorInstanceRow) =>
      cipher.decrypt(row.sealedState).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(State))),
        Effect.mapError(() =>
          failure(
            "Mend could not read this Executor's sealed state. Keep the instance stopped and restore Mend's secrets key.",
          ),
        ),
      );
    const target = Effect.fn("MendRunExecutor.target")(function* (organizationId: OrganizationId) {
      const row = yield* instances.get(organizationId);
      if (row === null)
        return yield* failure("This organization's Mend-run Executor has not started.");
      const service = yield* scope(row);
      const observation = yield* service.get().pipe(Effect.mapError(platformFailure));
      const endpoint = observation === null ? null : route(observation);
      if (endpoint === null)
        return yield* failure(
          "This organization's Executor is not running · observed. An owner can start it in Settings.",
        );
      return endpoint;
    });
    const backup = (row: ExecutorInstanceRow, stream: ReadableStream<Uint8Array>) =>
      Effect.tryPromise({
        try: async () => {
          const directory = path.join(
            store.root,
            "executor-backups",
            createHash("sha256").update(row.scopeKey).digest("hex"),
          );
          const reader = stream.getReader();
          try {
            await fs.mkdir(directory, { recursive: true, mode: 0o700 });
            const name = path.join(directory, `${Date.now()}-${randomUUID()}.tar`);
            const file = await fs.open(name + ".partial", "wx", 0o600);
            try {
              for (;;) {
                const next = await reader.read();
                if (next.done) break;
                await file.writeFile(next.value);
              }
              await file.sync();
            } finally {
              await file.close();
            }
            await fs.rename(name + ".partial", name);
          } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
          }
        },
        catch: () =>
          failure(
            "Mend could not finish the stopped Executor backup. Executor stays stopped; upgrade did not replace it.",
          ),
      });
    const act = Effect.fn("MendRunExecutor.act")(
      (organizationId: OrganizationId, action: typeof ExecutorManagedAction.Type) =>
        instances.withLock(
          organizationId,
          Effect.gen(function* () {
            if (reason !== null) return yield* failure(reason);
            const configured = yield* links.configuration(organizationId);
            if (configured !== null && configured.mode !== "mend-run")
              return yield* failure(
                "Clear the organization's own Executor address before starting a Mend-run Executor.",
              );
            let row = yield* instances.get(organizationId);
            if (row === null) {
              if (action === "remove") return;
              if (action !== "start")
                return yield* failure("Start this organization's Executor first.");
              const state = {
                betterAuthSecret: secret(),
                encryptionKey: Redacted.make(randomBytes(32).toString("hex")),
                ownerPassword: secret(),
                ssoClientSecret: secret(),
              };
              row = {
                organizationId,
                scopeKey: `mend:${randomUUID()}:organization:${organizationId}`,
                appliedSpec: null,
                image: null,
                backupAt: null,
                executorOrganizationId: null,
                sealedState: yield* cipher
                  .encrypt(Schema.encodeSync(Schema.fromJsonString(State))(state))
                  .pipe(
                    Effect.mapError(() =>
                      failure("Mend could not seal Executor's first-start secrets."),
                    ),
                  ),
              };
              // This committed row precedes every external side effect, including first setup.
              yield* instances.save(row);
            }
            const service = yield* scope(row);
            const state = yield* unseal(row);
            if (action === "remove") {
              const observed = yield* service.get().pipe(Effect.mapError(platformFailure));
              const expectedInstanceId = state.removingInstanceId ?? observed?.id;
              if (expectedInstanceId !== undefined) {
                if (observed !== null && observed.id !== expectedInstanceId)
                  return yield* failure(
                    "Executor's instance identity changed. Mend did not remove it. The operator must check this organization's retained instance.",
                  );
                // Keep the original identity across failed/ambiguous purges and API restarts.
                row = {
                  ...row,
                  sealedState: yield* cipher
                    .encrypt(
                      Schema.encodeSync(Schema.fromJsonString(State))({
                        ...state,
                        removingInstanceId: expectedInstanceId,
                      }),
                    )
                    .pipe(
                      Effect.mapError(() =>
                        failure("Mend could not save the Executor removal request."),
                      ),
                    ),
                };
                yield* instances.save(row);
                if (observed !== null && observed.state.kind !== "archived")
                  yield* service.stop().pipe(Effect.mapError(platformFailure));
                yield* service.purge(expectedInstanceId).pipe(Effect.mapError(platformFailure));
              }
              const directory = path.join(
                store.root,
                "executor-backups",
                createHash("sha256").update(row.scopeKey).digest("hex"),
              );
              yield* Effect.tryPromise({
                try: async () => {
                  try {
                    await fs.readdir(directory);
                    await fs.rm(directory, { recursive: true });
                  } catch (error) {
                    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
                      throw error;
                  }
                },
                catch: () =>
                  failure(
                    "Sealant purged Executor, but Mend could not delete its saved backups. Retry Remove to finish; the sealed removal record has been kept.",
                  ),
              });
              // The configuration cascades to all person/member grants and incomplete flows.
              yield* identity.remove(organizationId).pipe(Effect.mapError(identityFailure));
              yield* links.deleteConfiguration(organizationId);
              yield* instances.remove(organizationId);
              return;
            }
            if (state.removingInstanceId !== undefined)
              return yield* failure(
                "This Executor's removal has started. Retry Remove to finish deleting its service logins and backups.",
              );
            if (action === "stop") {
              yield* service.stop().pipe(Effect.mapError(platformFailure));
              return;
            }
            const sso = yield* identity
              .prepare(organizationId, state.ssoClientSecret)
              .pipe(Effect.mapError(identityFailure));
            const spec: ScopeInstanceSpec = {
              alias: "executor",
              worktreeKey: null,
              image: EXECUTOR_IMAGE,
              command: [
                "sh",
                "-c",
                'umask 077; printf %s "$MEND_EXECUTOR_CA_PEM" > /app/data/mend-ca.pem; exec executor-host serve',
              ],
              env: {
                NODE_EXTRA_CA_CERTS: "/app/data/mend-ca.pem",
                MEND_EXECUTOR_CA_PEM: sso.ca,
                SSO_DISCOVERY_URL: sso.discovery,
                SSO_CLIENT_ID: sso.clientId,
                SSO_ALLOWED_DOMAINS: sso.domain,
                DO_NOT_TRACK: "1",
                EXECUTOR_DISABLE_ANALYTICS: "1",
                BETTER_AUTH_URL: origin,
                EXECUTOR_OAUTH_CALLBACK_URL: `${network.appUrl}/executor/service-callback`,
              },
              volumes: [{ name: "data", mountPath: "/app/data", storageBytes }],
              limits: { cpuMillicores: budget.cpuMillicores, memoryBytes: budget.memoryBytes },
              ready: { kind: "tcp", port: 4400 },
              idleStopAfterSeconds: null,
              reach: { kind: "caller", caller, port: 4400, callbackPort: 4401 },
            };
            const digest = createHash("sha256").update(JSON.stringify(spec)).digest("hex");
            const before = yield* service.get().pipe(Effect.mapError(platformFailure));
            if (before !== null && (action === "upgrade" || row.appliedSpec !== digest)) {
              yield* service.stop().pipe(Effect.mapError(platformFailure));
              const stream = yield* service.backup().pipe(Effect.mapError(platformFailure));
              yield* backup(row, stream);
              row = { ...row, backupAt: new Date() };
              yield* instances.save(row);
            }
            const observation = yield* service
              .up(
                spec,
                Redacted.make({
                  BETTER_AUTH_SECRET: Redacted.value(state.betterAuthSecret),
                  EXECUTOR_ENCRYPTION_KEY: Redacted.value(state.encryptionKey),
                  SSO_CLIENT_SECRET: Redacted.value(state.ssoClientSecret),
                }),
              )
              .pipe(Effect.mapError(platformFailure));
            const endpoint = route(observation);
            if (endpoint === null)
              return yield* failure(
                `Sealant observed Executor ${observation.state.kind}. Start again after checking the runtime.`,
              );
            let answered = false;
            for (let attempt = 0; attempt < 60; attempt++) {
              const health = yield* Effect.result(requestExecutor(endpoint, "/health", {}, 2000));
              if (health._tag === "Success" && health.success.ok) {
                answered = true;
                break;
              }
              yield* Effect.sleep("1 second");
            }
            if (!answered)
              return yield* failure(
                "Executor did not answer its health request · observed. Start again after checking the runtime.",
              );
            row = { ...row, appliedSpec: digest, image: EXECUTOR_IMAGE };
            yield* instances.save(row);
            const current = yield* links.configuration(organizationId);
            if (current !== null && current.mode !== "mend-run")
              return yield* failure(
                "Remove the organization's own Executor configuration before starting a Mend-run Executor.",
              );
            const configuration = current ?? {
              organizationId,
              id: randomUUID(),
              mode: "mend-run",
              url: origin,
            };
            yield* links.saveConfiguration(configuration);
            if ((yield* links.link(configuration.id, "member")) === null) {
              const signedIn = yield* signInExecutorOwner(
                endpoint,
                {
                  email: `mend@${organizationId}.people.mend.invalid`,
                  password: state.ownerPassword,
                  organizationName: "Mend organization",
                },
                `${network.appUrl}/executor/callback`,
                transport,
              );
              const sealedCredentials = yield* cipher
                .encrypt(
                  Schema.encodeSync(Schema.fromJsonString(ExecutorCredentials))(
                    signedIn.credentials,
                  ),
                )
                .pipe(
                  Effect.mapError(() =>
                    failure("Mend could not seal the Executor grants. Start again."),
                  ),
                );
              yield* instances.save({ ...row, executorOrganizationId: signedIn.organizationId });
              yield* links.saveLink({
                id: randomUUID(),
                configurationId: configuration.id,
                subject: "member",
                userId: null,
                state: "active",
                sealedCredentials,
                observedAt: new Date(),
              });
            }
          }),
        ),
    );
    const status = Effect.fn("MendRunExecutor.status")(function* (organizationId: OrganizationId) {
      const row = yield* instances.get(organizationId);
      const observation =
        row === null
          ? null
          : yield* Effect.result(
              Effect.flatMap(scope(row), (service) =>
                service.get().pipe(Effect.mapError(platformFailure)),
              ),
            );
      return {
        available: reason === null,
        reason: reason ?? (observation?._tag === "Failure" ? observation.failure.message : null),
        state:
          observation?._tag === "Success"
            ? (observation.success?.state.kind ?? "not-started")
            : row === null
              ? "not-started"
              : "unknown",
        observedAt:
          observation?._tag === "Success" ? (observation.success?.observedAt ?? null) : null,
        image: row?.image ?? null,
        releaseImage: EXECUTOR_IMAGE,
        memoryBytes: EXECUTOR_MEMORY_BYTES,
        backupAt: row?.backupAt ?? null,
        retained: row !== null,
      };
    });
    const link = (organizationId: OrganizationId, userId: string) =>
      instances.withLock(
        organizationId,
        Effect.gen(function* () {
          const row = yield* instances.get(organizationId);
          if (row === null || row.executorOrganizationId === null)
            return yield* failure("Start this organization's Executor first.");
          const state = yield* unseal(row);
          if (state.removingInstanceId !== undefined)
            return yield* failure("This organization's Executor is being removed.");
          const configuration = yield* links.configuration(organizationId);
          if (configuration?.mode !== "mend-run")
            return yield* failure("This organization no longer uses a Mend-run Executor.");
          const endpoint = yield* target(organizationId);
          const subject = `person:${userId}`;
          const previous = yield* links.link(configuration.id, subject);
          if (previous !== null) {
            const saved = yield* cipher.decrypt(previous.sealedCredentials).pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(Schema.fromJsonString(ExecutorCredentials)),
              ),
              Effect.mapError(() =>
                failure("Mend could not read your previous Executor link. Unlink it first."),
              ),
            );
            yield* transport.revoke(endpoint, saved.registration, saved.tool);
            yield* transport.revoke(endpoint, saved.registration, saved.service);
            yield* links.deleteLink(previous.id);
          }
          const credentials = yield* signInExecutorPerson(
            endpoint,
            {
              organizationId: row.executorOrganizationId,
              userId,
              mendOrganizationId: organizationId,
              authorize: (url) =>
                identity
                  .authorize(organizationId, userId, url)
                  .pipe(Effect.mapError(identityFailure)),
            },
            `${network.appUrl}/executor/callback`,
            transport,
          );
          const sealedCredentials = yield* cipher
            .encrypt(Schema.encodeSync(Schema.fromJsonString(ExecutorCredentials))(credentials))
            .pipe(
              Effect.mapError(() =>
                failure("Mend could not seal your Executor link. Click Link again."),
              ),
              Effect.tapError(() =>
                Effect.all([
                  transport.revoke(endpoint, credentials.registration, credentials.tool),
                  transport.revoke(endpoint, credentials.registration, credentials.service),
                ]).pipe(Effect.ignore),
              ),
            );
          yield* links.saveLink({
            id: randomUUID(),
            configurationId: configuration.id,
            subject,
            userId,
            state: "active",
            sealedCredentials,
            observedAt: new Date(),
          });
        }),
      );
    return MendRunExecutor.of({ status, act, target, link });
  },
);

/** Deployment configuration can offer Docker; unsupported runtimes remain an explicit refusal. */
export const MendRunExecutorLive: Layer.Layer<MendRunExecutor, never, Dependencies> = Layer.effect(
  MendRunExecutor,
  make,
);
