import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  AgentConversationRepo,
  ExecutorRepo,
  OrganizationsRepo,
  ProjectsRepo,
  SessionsRepo,
  executorCallView,
  type ExecutorCallRow,
  type ExecutorConfigurationRow,
  type ExecutorLinkRow,
} from "@mend/db";
import type { OrganizationId, SessionId } from "@mend/domain";
import {
  EXECUTOR_APPROVAL_MS,
  executorOrigin,
  type ExecutorApprovalInput,
  type ExecutorCall,
  type ExecutorConfiguration,
  type ExecutorManagedAction,
  type ExecutorLinkStatus,
  type ExecutorLinkTarget,
  type ExecutorPersonalStatus,
  type ExecutorServices,
  type ExecutorToolObservation,
} from "@mend/domain/workbench";
import { NetworkConfig } from "@mend/network";
import { SecretCipher } from "@mend/store";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { McpSchema } from "effect/ai";

import type { Caller } from "../mend-mcp/caller.ts";
import type { ExecutorTarget } from "./http.ts";
import { MendRunExecutor } from "./mend-run.ts";
import { executorServiceManagement, type ExecutorServiceManagement } from "./services.ts";
import {
  ExecutorCredentials,
  ExecutorFailure,
  ExecutorGrant,
  ExecutorRegistration,
  ExecutorTransport,
  executorResource,
} from "./transport.ts";

const FlowCommon = {
  registration: ExecutorRegistration,
  verifier: Schema.RedactedFromValue(Schema.String),
};
const Flow = Schema.Union([
  Schema.Struct({ stage: Schema.Literal("tool"), ...FlowCommon }),
  Schema.Struct({ stage: Schema.Literal("service"), ...FlowCommon, tool: ExecutorGrant }),
]);
type Flow = typeof Flow.Type;
const RecordJson = Schema.Record(Schema.String, Schema.Unknown);
const Held = Schema.Struct({
  status: Schema.Literals(["approval-required", "input-required"]),
  requestId: Schema.String,
  expiresAt: Schema.Number,
  elicitation: Schema.Struct({ message: Schema.String, requestedSchema: Schema.Json }),
});
const Invocation = Schema.Struct({ app: Schema.String, tool: Schema.String });
const ToolCalls = Schema.Array(Schema.Struct({ name: Schema.String, outcome: Schema.String }));
const hash = (input: string) => createHash("sha256").update(input).digest("hex");
const personSubject = (userId: string) => `person:${userId}`;
const unlinked: ExecutorLinkStatus = { state: "unlinked", observedAt: null };
const failure = (message: string) => new ExecutorFailure({ kind: "refused", message });
const textResult = (value: unknown, isError = false): McpSchema.CallToolResult =>
  new McpSchema.CallToolResult({
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError,
  });
const parseJson = (input: string): unknown => {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
};
const dataOf = (result: McpSchema.CallToolResult): unknown =>
  result.structuredContent ??
  parseJson(
    result.content
      .filter((x) => x.type === "text")
      .map((x) => x.text)
      .join("\n"),
  );
const heldOf = (result: McpSchema.CallToolResult) => {
  const data = dataOf(result);
  return Schema.is(Held)(data) ? data : null;
};
const statusOf = (row: ExecutorLinkRow | null): ExecutorLinkStatus =>
  row === null ? unlinked : { state: row.state, observedAt: row.observedAt };
const serviceOf = (path: string): string => {
  const member = /^tools(?:\.([A-Za-z_$][\w$]*)|\[("(?:[^"\\]|\\.)*")\])/.exec(path);
  const service = member?.[1] ?? (member?.[2] === undefined ? null : parseJson(member[2]));
  return typeof service === "string" && !service.startsWith("app_")
    ? service
    : "Service name unavailable";
};

// Match Executor's catalog expressions, including routers and reserved/empty tool segments.
const toolPath = (slug: string, tool: string) =>
  "tools" +
  [
    slug,
    ...tool
      .split(".")
      .map((segment) =>
        segment === ""
          ? "%00"
          : ["__proto__", "prototype", "constructor"].includes(segment)
            ? `%${segment}`
            : segment.replaceAll("%", "%25"),
      ),
  ]
    .map((segment) =>
      /^[A-Za-z_$][\w$]*$/.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`,
    )
    .join("");

/** Held calls need service metadata; completed calls carry their exact paths in the SDK trace. */
export const executorObservations = (
  result: McpSchema.CallToolResult,
  service: { readonly name: string; readonly slug: string } | null = null,
): ReadonlyArray<ExecutorToolObservation> => {
  const data = dataOf(result);
  if (!Schema.is(RecordJson)(data)) return [];
  const invocation = data.invocation ?? data.tool;
  if (Schema.is(Invocation)(invocation))
    return [
      {
        service: service?.name ?? "Service name unavailable",
        tool:
          service === null
            ? `${invocation.tool} (exact path unavailable)`
            : toolPath(service.slug, invocation.tool),
        outcome: typeof data.status === "string" ? data.status : "observed",
      },
    ];
  const execution = data.execution;
  if (!Schema.is(RecordJson)(execution) || !Schema.is(ToolCalls)(execution.toolCalls)) return [];
  return execution.toolCalls.map((call) => ({
    service: serviceOf(call.name),
    tool: call.name,
    outcome: call.outcome,
  }));
};

export class OrganizationExecutor extends Context.Service<
  OrganizationExecutor,
  ExecutorServiceManagement & {
    readonly configuration: (
      organizationId: OrganizationId,
    ) => Effect.Effect<typeof ExecutorConfiguration.Type>;
    readonly configure: (
      organizationId: OrganizationId,
      input: { readonly mode: "own" | "mend-run"; readonly url: string } | null,
    ) => Effect.Effect<typeof ExecutorConfiguration.Type, ExecutorFailure>;
    readonly manage: (
      organizationId: OrganizationId,
      action: typeof ExecutorManagedAction.Type,
    ) => Effect.Effect<typeof ExecutorConfiguration.Type, ExecutorFailure>;
    readonly personalStatus: (
      organizationId: OrganizationId,
      userId: string,
    ) => Effect.Effect<typeof ExecutorPersonalStatus.Type>;
    readonly services: (
      organizationId: OrganizationId,
      userId: string,
      offset: number,
    ) => Effect.Effect<typeof ExecutorServices.Type, ExecutorFailure>;
    readonly begin: (
      organizationId: OrganizationId,
      userId: string,
      target: ExecutorLinkTarget,
    ) => Effect.Effect<string, ExecutorFailure>;
    readonly finish: (
      organizationId: OrganizationId,
      userId: string,
      owner: boolean,
      state: string,
      code: string,
    ) => Effect.Effect<
      { readonly url: string | null; readonly target: ExecutorLinkTarget },
      ExecutorFailure
    >;
    readonly unlink: (
      organizationId: OrganizationId,
      userId: string,
      target: ExecutorLinkTarget,
    ) => Effect.Effect<void, ExecutorFailure>;
    readonly relay: (
      caller: Caller,
      tool: string,
      input: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<McpSchema.CallToolResult>;
    readonly approve: (
      sessionId: SessionId,
      callId: string,
      userId: string,
      input: ExecutorApprovalInput,
    ) => Effect.Effect<ExecutorCall, ExecutorFailure>;
    readonly approval: (
      sessionId: SessionId,
      callId: string,
      userId: string,
    ) => Effect.Effect<
      {
        readonly call: ExecutorCall;
        readonly message: string;
        readonly inputSchema: Schema.Json;
        readonly arguments: Schema.Json;
      },
      ExecutorFailure
    >;
  }
>()("@mend/sessions/OrganizationExecutor") {}

export const OrganizationExecutorLive: Layer.Layer<
  OrganizationExecutor,
  never,
  | ExecutorRepo
  | MendRunExecutor
  | ExecutorTransport
  | SecretCipher
  | NetworkConfig
  | SessionsRepo
  | ProjectsRepo
  | OrganizationsRepo
  | AgentConversationRepo
> = Layer.effect(
  OrganizationExecutor,
  Effect.gen(function* () {
    const repo = yield* ExecutorRepo;
    const managed = yield* MendRunExecutor;
    const addressOf = (config: ExecutorConfigurationRow) =>
      config.mode === "mend-run"
        ? managed.target(config.organizationId)
        : Effect.succeed(config.url);
    const transport = yield* ExecutorTransport;
    const cipher = yield* SecretCipher;
    const network = yield* NetworkConfig;
    const sessions = yield* SessionsRepo;
    const projects = yield* ProjectsRepo;
    const organizations = yield* OrganizationsRepo;
    const conversation = yield* AgentConversationRepo;
    const callback = `${network.appUrl}/executor/callback`;
    const seal = <A, I>(schema: Schema.Codec<A, I>, value: A) =>
      cipher
        .encrypt(Schema.encodeSync(Schema.fromJsonString(schema))(value))
        .pipe(Effect.mapError(() => failure("Mend could not seal the Executor link.")));
    const unseal = <A, I>(schema: Schema.Codec<A, I>, value: string) =>
      cipher.decrypt(value).pipe(
        Effect.mapError(() =>
          failure("The saved Executor link could not be unsealed. Link again."),
        ),
        Effect.flatMap((text) =>
          Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
            Effect.mapError(() =>
              failure("The saved Executor link could not be read. Link again."),
            ),
          ),
        ),
      );
    const requireConfiguration = (organizationId: OrganizationId) =>
      Effect.gen(function* () {
        const row = yield* repo.configuration(organizationId);
        if (row === null)
          return yield* failure(
            "This organization has no Executor. An owner sets it up in Settings → MCP servers.",
          );
        return row;
      });
    const configuration = (organizationId: OrganizationId) =>
      Effect.gen(function* () {
        const row = yield* repo.configuration(organizationId);
        const status = yield* managed.status(organizationId);
        return {
          managed: status,
          mode: row?.mode ?? null,
          url: row?.mode === "mend-run" ? null : (row?.url ?? null),
          mendRunAvailable: status.available,
          member: row === null ? unlinked : statusOf(yield* repo.link(row.id, "member")),
        };
      });
    const revokeCredentials = (url: ExecutorTarget, credentials: ExecutorCredentials) =>
      Effect.gen(function* () {
        // Try both grants even if one is already refused. A retained row lets the person retry.
        const results = yield* Effect.forEach([credentials.tool, credentials.service], (grant) =>
          Effect.result(transport.revoke(url, credentials.registration, grant)),
        );
        const refused = results.find((result) => result._tag === "Failure");
        if (refused?._tag === "Failure") return yield* refused.failure;
      });
    const clearFlows = (config: ExecutorConfigurationRow, subject?: string, expiredOnly = false) =>
      Effect.gen(function* () {
        for (const row of yield* repo.flows(config.id)) {
          if (
            (subject !== undefined && row.subject !== subject) ||
            (expiredOnly && row.expiresAt.getTime() > Date.now())
          )
            continue;
          const flow = yield* unseal(Flow, row.sealedFlow);
          if (flow.stage === "service")
            yield* transport.revoke(yield* addressOf(config), flow.registration, flow.tool);
          yield* repo.deleteFlow(row.stateHash);
        }
      });
    const unlinkRow = (config: ExecutorConfigurationRow, id: string) =>
      repo.withLock(
        `link:${id}`,
        Effect.gen(function* () {
          const row = yield* repo.linkById(id);
          if (row === null) return;
          const credentials = yield* unseal(ExecutorCredentials, row.sealedCredentials);
          yield* revokeCredentials(yield* addressOf(config), credentials);
          yield* repo.deleteLink(id);
        }),
      );
    const configure = (
      organizationId: OrganizationId,
      input: { readonly mode: "own" | "mend-run"; readonly url: string } | null,
    ) =>
      input?.mode === "mend-run"
        ? managed
            .act(organizationId, "start")
            .pipe(Effect.flatMap(() => configuration(organizationId)))
        : repo.withLock(
            `organization:${organizationId}`,
            Effect.gen(function* () {
              const retained = yield* repo.configuration(organizationId);
              if (retained?.mode === "mend-run")
                return yield* failure(
                  "Remove the Mend-run Executor before changing this organization's Executor. Stop keeps its service logins.",
                );
              const url = input === null ? null : executorOrigin(input.url);
              if (input !== null && url === null)
                return yield* failure(
                  "Enter an Executor origin with HTTPS, or HTTP on loopback, without a path or credentials.",
                );
              const current = yield* repo.configuration(organizationId);
              if (current !== null && current.url === url)
                return yield* configuration(organizationId);
              if (current !== null) {
                yield* clearFlows(current);
                for (const link of yield* repo.links(current.id))
                  yield* unlinkRow(current, link.id);
                yield* repo.deleteConfiguration(organizationId);
              }
              if (url !== null)
                yield* repo.saveConfiguration({
                  organizationId,
                  id: randomUUID(),
                  mode: "own",
                  url,
                });
              return yield* configuration(organizationId);
            }),
          );
    const fresh = (config: ExecutorConfigurationRow, id: string) =>
      repo.withLock(
        `link:${id}`,
        Effect.gen(function* () {
          const row = yield* repo.linkById(id);
          if (row === null || row.configurationId !== config.id || row.state !== "active")
            return yield* failure("Executor refused this link. Link again.");
          const loaded = yield* Effect.result(unseal(ExecutorCredentials, row.sealedCredentials));
          if (loaded._tag === "Failure") {
            yield* repo.saveLink({ ...row, state: "refused", observedAt: new Date() });
            return yield* loaded.failure;
          }
          let credentials = loaded.success;
          for (const kind of ["tool", "service"] as const) {
            if (credentials[kind].expiresAt > Date.now() + 60_000) continue;
            // A timeout can mean the server rotated a token whose reply was lost. Never replay it.
            const result = yield* Effect.result(
              transport.grant(yield* addressOf(config), credentials.registration, kind, {
                grant_type: "refresh_token",
                refresh_token: Redacted.value(credentials[kind].refreshToken),
              }),
            );
            if (result._tag === "Failure") {
              yield* repo.saveLink({ ...row, state: "refused", observedAt: new Date() });
              return yield* failure("Executor refused this link · observed. Link again.");
            }
            if (result.success.subject !== credentials[kind].subject) {
              yield* repo.saveLink({ ...row, state: "refused", observedAt: new Date() });
              return yield* failure(
                "Executor returned a different member for this link. Link again.",
              );
            }
            credentials = { ...credentials, [kind]: result.success };
            // Persist each rotation before attempting the second grant or releasing the DB lock.
            yield* repo.saveLink({
              ...row,
              sealedCredentials: yield* seal(ExecutorCredentials, credentials),
              observedAt: new Date(),
            });
          }
          return { row, credentials };
        }).pipe(Effect.uninterruptible),
      );
    const serviceManagement = executorServiceManagement({
      repo,
      appUrl: network.appUrl,
      access: (organizationId, actorId, target) =>
        Effect.gen(function* () {
          const role = yield* organizations.roleOf(organizationId, actorId);
          if (role === null || (target === "member" && role !== "owner"))
            return yield* failure(
              "Only an organization owner manages shared services and accounts.",
            );
          const config = yield* requireConfiguration(organizationId);
          if (config.mode !== "mend-run")
            return yield* failure("Manage services at your organization's own Executor.");
          const executorOrganizationId = yield* repo.managedOrganizationId(organizationId);
          if (executorOrganizationId === null)
            return yield* failure("Start this organization's Executor first.");
          const link = yield* repo.link(
            config.id,
            target === "member" ? "member" : personSubject(actorId),
          );
          if (link === null)
            return yield* failure("Link your Executor account before managing your services.");
          const selected = yield* fresh(config, link.id);
          return {
            configurationId: config.id,
            linkId: link.id,
            executorOrganizationId,
            target: yield* addressOf(config),
            grant: selected.credentials.service,
          };
        }),
    });
    const services = (organizationId: OrganizationId, userId: string, offset: number) =>
      Effect.gen(function* () {
        const config = yield* requireConfiguration(organizationId);
        const link = yield* repo.link(config.id, personSubject(userId));
        if (link === null)
          return yield* failure("Link your Executor account to read its services.");
        const selected = yield* fresh(config, link.id);
        const result = yield* transport.mcp(
          yield* addressOf(config),
          selected.credentials.tool,
          "tools/call",
          {
            name: "search",
            arguments: { limit: 100, offset },
          },
        );
        const decoded = yield* Schema.decodeUnknownEffect(McpSchema.CallToolResult)(result).pipe(
          Effect.mapError(() => failure("Executor returned an unreadable service list.")),
        );
        const page = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            namespaces: Schema.Array(Schema.Struct({ path: Schema.String, app: Schema.String })),
            next: Schema.NullOr(Schema.Struct({ offset: Schema.Number })),
          }),
        )(dataOf(decoded)).pipe(
          Effect.mapError(() => failure("Executor returned an unreadable service list.")),
        );
        return {
          services: [
            ...new Map(
              page.namespaces.map((item) => [item.app, { id: item.path, name: item.app }]),
            ).values(),
          ],
          observedAt: new Date(),
          nextOffset: page.next?.offset ?? null,
        };
      });
    const authorize = (
      config: ExecutorConfigurationRow,
      actorId: string,
      subject: string,
      flow: Flow,
    ) =>
      Effect.gen(function* () {
        const state = randomBytes(32).toString("base64url");
        yield* repo.saveFlow({
          stateHash: hash(state),
          configurationId: config.id,
          actorId,
          subject,
          sealedFlow: yield* seal(Flow, flow),
          expiresAt: new Date(Date.now() + EXECUTOR_APPROVAL_MS),
        });
        const url = new URL(config.url + "/api/auth/oauth2/authorize");
        url.search = new URLSearchParams({
          response_type: "code",
          client_id: flow.registration.client_id,
          redirect_uri: callback,
          scope: flow.stage === "tool" ? "mcp offline_access" : "executor offline_access",
          resource: executorResource(config.url, flow.stage),
          state,
          code_challenge: createHash("sha256")
            .update(Redacted.value(flow.verifier))
            .digest("base64url"),
          code_challenge_method: "S256",
        }).toString();
        return url.href;
      });
    const begin = (organizationId: OrganizationId, userId: string, target: ExecutorLinkTarget) =>
      Effect.gen(function* () {
        const savedConfiguration = yield* requireConfiguration(organizationId);
        if (savedConfiguration.mode === "mend-run") {
          if (target !== "person") return yield* failure("Mend manages its member automatically.");
          yield* managed.link(organizationId, userId);
          return `${network.appUrl}/settings/workspace`;
        }
        return yield* repo.withLock(
          `organization:${organizationId}`,
          Effect.gen(function* () {
            const config = yield* requireConfiguration(organizationId);

            yield* clearFlows(config, undefined, true);
            const registration = yield* transport.register(yield* addressOf(config), callback);
            return yield* authorize(
              config,
              userId,
              target === "member" ? "member" : personSubject(userId),
              {
                stage: "tool",
                registration,
                verifier: Redacted.make(randomBytes(32).toString("base64url")),
              },
            );
          }),
        );
      });
    const finish = (
      organizationId: OrganizationId,
      userId: string,
      owner: boolean,
      state: string,
      code: string,
    ) =>
      repo.withLock(
        `organization:${organizationId}`,
        Effect.gen(function* () {
          const config = yield* requireConfiguration(organizationId);
          const row = yield* repo.consumeFlow(hash(state), userId);
          if (row === null || row.configurationId !== config.id)
            return yield* failure(
              "This Executor link expired or was already used. Start linking again.",
            );
          if (row.subject === "member" && !owner)
            return yield* failure("Only an owner can link Mend's member.");
          if (row.subject !== "member" && row.subject !== personSubject(userId))
            return yield* failure("This Executor link belongs to another person.");
          const flow = yield* unseal(Flow, row.sealedFlow);
          const exchanged = yield* Effect.result(
            transport.grant(yield* addressOf(config), flow.registration, flow.stage, {
              grant_type: "authorization_code",
              redirect_uri: callback,
              code,
              code_verifier: Redacted.value(flow.verifier),
            }),
          );
          if (exchanged._tag === "Failure") {
            if (flow.stage === "service")
              yield* transport
                .revoke(yield* addressOf(config), flow.registration, flow.tool)
                .pipe(Effect.ignore);
            return yield* exchanged.failure;
          }
          const target: ExecutorLinkTarget = row.subject === "member" ? "member" : "person";
          if (flow.stage === "tool")
            return {
              url: yield* authorize(config, userId, row.subject, {
                stage: "service",
                registration: flow.registration,
                verifier: Redacted.make(randomBytes(32).toString("base64url")),
                tool: exchanged.success,
              }),
              target,
            };
          const credentials = {
            registration: flow.registration,
            tool: flow.tool,
            service: exchanged.success,
          };
          if (flow.tool.subject !== exchanged.success.subject) {
            yield* revokeCredentials(yield* addressOf(config), credentials).pipe(Effect.ignore);
            return yield* failure(
              "Both Executor consents must name the same member. Start linking again.",
            );
          }
          yield* repo.withLock(
            `subject:${config.id}:${row.subject}`,
            Effect.gen(function* () {
              const old = yield* repo.link(config.id, row.subject);
              if (old !== null) yield* unlinkRow(config, old.id);
              yield* repo.saveLink({
                id: randomUUID(),
                configurationId: config.id,
                subject: row.subject,
                userId: target === "member" ? null : userId,
                state: "active",
                sealedCredentials: yield* seal(ExecutorCredentials, credentials),
                observedAt: new Date(),
              });
            }),
          );
          return { url: null, target };
        }),
      );
    const personalStatus = (organizationId: OrganizationId, userId: string) =>
      Effect.gen(function* () {
        const config = yield* repo.configuration(organizationId);
        return {
          configured: config !== null,
          url: config?.mode === "mend-run" ? null : (config?.url ?? null),
          link:
            config === null
              ? unlinked
              : statusOf(yield* repo.link(config.id, personSubject(userId))),
        };
      });
    const unlink = (organizationId: OrganizationId, userId: string, target: ExecutorLinkTarget) =>
      repo.withLock(
        `organization:${organizationId}`,
        Effect.gen(function* () {
          const config = yield* repo.configuration(organizationId);
          if (config === null) return;
          if (config.mode === "mend-run" && target === "member")
            return yield* failure(
              "Mend's member belongs to this organization's retained Executor. Stop or remove that Executor in Settings.",
            );
          yield* clearFlows(config, target === "member" ? "member" : personSubject(userId));
          const row = yield* repo.link(
            config.id,
            target === "member" ? "member" : personSubject(userId),
          );
          if (row !== null) yield* unlinkRow(config, row.id);
        }),
      );
    const sessionConfiguration = (sessionId: SessionId) =>
      Effect.gen(function* () {
        const session = yield* sessions
          .byId(sessionId)
          .pipe(Effect.mapError(() => failure("This session is unavailable.")));
        const project = yield* projects
          .byId(session.projectId)
          .pipe(Effect.mapError(() => failure("This session's project is unavailable.")));
        if (project.organizationId === null)
          return yield* failure("This project has no organization's Executor.");
        return yield* requireConfiguration(project.organizationId);
      });
    const select = (config: ExecutorConfigurationRow, accountId: string | null) =>
      Effect.gen(function* () {
        if (
          accountId !== null &&
          (yield* organizations.roleOf(config.organizationId, accountId)) !== null
        ) {
          const personal = yield* repo.link(config.id, personSubject(accountId));
          if (personal?.state === "active") {
            const result = yield* Effect.result(fresh(config, personal.id));
            if (result._tag === "Success") return result.success;
          }
        }
        const member = yield* repo.link(config.id, "member");
        if (member === null)
          return yield* failure(
            "Link your Executor account in Settings → You → Workspace, or ask an owner to link Mend's member.",
          );
        return yield* fresh(config, member.id);
      });
    const expire = (row: ExecutorCallRow) =>
      Effect.gen(function* () {
        if (
          (row.outcome === "held" || row.outcome === "answering") &&
          row.expiresAt !== null &&
          row.expiresAt.getTime() <= Date.now()
        ) {
          const expired: ExecutorCallRow = {
            ...row,
            outcome: "expired",
            message: "This Executor call expired. Run the tool again if it is still needed.",
            observedAt: new Date(),
            sealedResult: null,
          };
          yield* repo.saveCall(expired);
          return expired;
        }
        return row;
      });
    const savedAnswer = (row: ExecutorCallRow) =>
      Effect.gen(function* () {
        const current = yield* expire(row);
        if (
          current.outcome === "held" ||
          current.outcome === "answering" ||
          current.outcome === "requested"
        )
          return textResult({
            status: current.outcome === "held" ? "approval-required" : current.outcome,
            requestId: current.id,
            message: current.message,
            expiresAt: current.expiresAt?.getTime(),
          });
        if (current.sealedResult !== null)
          return yield* unseal(McpSchema.CallToolResult, current.sealedResult);
        return textResult(
          { status: current.outcome, requestId: current.id, message: current.message },
          current.outcome !== "completed",
        );
      });
    const settle = (
      row: ExecutorCallRow,
      result: McpSchema.CallToolResult,
      config: ExecutorConfigurationRow,
      credentials: ExecutorCredentials,
      declined = false,
    ) =>
      Effect.gen(function* () {
        const held = heldOf(result);
        const data = dataOf(result);
        const invocation = Schema.is(RecordJson)(data) ? (data.invocation ?? data.tool) : null;
        const service = Schema.is(Invocation)(invocation)
          ? yield* transport
              .service(yield* addressOf(config), credentials.service, invocation.app)
              .pipe(Effect.catch(() => Effect.succeed(null)))
          : null;
        const observations = executorObservations(result, service).map((observation) => ({
          ...observation,
          service:
            row.observations.find((previous) => previous.tool === observation.tool)?.service ??
            observation.service,
        }));
        const failed =
          result.isError ||
          (Schema.is(RecordJson)(data) &&
            Schema.is(RecordJson)(data.execution) &&
            data.execution.ok === false);
        const last = observations.at(-1);
        const expired =
          held !== null &&
          Math.min(held.expiresAt, row.createdAt.getTime() + EXECUTOR_APPROVAL_MS) <= Date.now();
        const next: ExecutorCallRow = {
          ...row,
          service: last?.service ?? row.service,
          tool: last?.tool ?? row.tool,
          observations: [...row.observations, ...observations],
          outcome: expired
            ? "expired"
            : held !== null
              ? "held"
              : declined
                ? "denied"
                : failed
                  ? "refused"
                  : "completed",
          message: expired
            ? "This Executor call expired."
            : held !== null
              ? "Executor is waiting for a person to answer in Mend."
              : declined
                ? "The person denied this Executor call."
                : failed
                  ? "Executor refused this call · observed"
                  : "Executor answered · observed",
          observedAt: new Date(),
          expiresAt:
            held === null
              ? null
              : new Date(Math.min(held.expiresAt, row.createdAt.getTime() + EXECUTOR_APPROVAL_MS)),
          sealedResult: yield* seal(McpSchema.CallToolResult, result),
        };
        yield* repo.saveCall(next);
        return next;
      });
    const relay = (caller: Caller, tool: string, input: Readonly<Record<string, unknown>>) =>
      Effect.gen(function* () {
        if (tool === "resume") {
          if (input.response !== undefined)
            return textResult(
              {
                message:
                  "Only a person can approve or deny an Executor call in Mend. Pass requestId alone to read its outcome.",
              },
              true,
            );
          if (typeof input.requestId !== "string")
            return textResult({ message: "Pass the Mend call's requestId." }, true);
          const row = yield* repo.call(input.requestId);
          if (row === null || row.sessionId !== caller.sessionId)
            return textResult({ message: "That Executor call is not in this session." }, true);
          return yield* savedAnswer(row);
        }
        const id =
          caller.callKey === null ? randomUUID() : hash(`${caller.sessionId}:${caller.callKey}`);
        const now = new Date();
        let row: ExecutorCallRow = {
          id,
          sessionId: caller.sessionId,
          linkId: null,
          asUserId: null,
          asMember: true,
          approverId: caller.accountId,
          service: "Executor",
          tool,
          outcome: "requested",
          message: "Mend asked Executor · observed",
          observations: [],
          sealedResult: null,
          createdAt: now,
          observedAt: now,
          expiresAt: null,
        };
        if (!(yield* repo.claimCall(row))) {
          const previous = yield* repo.call(id);
          return previous === null
            ? textResult({ message: "The Executor call is unavailable." }, true)
            : yield* savedAnswer(previous);
        }
        const selection = yield* Effect.result(
          Effect.gen(function* () {
            const config = yield* sessionConfiguration(caller.sessionId);
            return { config, selected: yield* select(config, caller.accountId) };
          }),
        );
        if (selection._tag === "Failure") {
          yield* repo.saveCall({
            ...row,
            outcome: "refused",
            message: selection.failure.message,
            observedAt: new Date(),
          });
          return textResult({ requestId: id, message: selection.failure.message }, true);
        }
        const { config, selected } = selection.success;
        const isMember = selected.row.subject === "member";
        const turns =
          isMember && caller.accountId === null
            ? yield* conversation.openTurns(caller.sessionId)
            : [];
        const sender =
          caller.accountId ??
          turns.find(
            (turn) => turn.status === "running" && turn.processId === caller.agentProcess?.id,
          )?.author ??
          null;
        row = {
          ...row,
          linkId: selected.row.id,
          asUserId: selected.row.userId,
          asMember: isMember,
          approverId: isMember ? sender : selected.row.userId,
        };
        yield* repo.saveCall(row);
        const dispatched = yield* Effect.result(
          transport
            .mcp(yield* addressOf(config), selected.credentials.tool, "tools/call", {
              name: tool,
              arguments: input,
            })
            .pipe(
              Effect.flatMap((value) =>
                Schema.decodeUnknownEffect(McpSchema.CallToolResult)(value).pipe(
                  Effect.mapError(() => failure("Executor returned an unreadable tool result.")),
                ),
              ),
            ),
        );
        if (dispatched._tag === "Failure") {
          if (dispatched.failure.kind === "refused")
            yield* repo.withLock(
              `link:${selected.row.id}`,
              Effect.gen(function* () {
                const link = yield* repo.linkById(selected.row.id);
                if (link !== null)
                  yield* repo.saveLink({ ...link, state: "refused", observedAt: new Date() });
              }),
            );
          yield* repo.saveCall({
            ...row,
            outcome: "unavailable",
            message: dispatched.failure.message,
            observedAt: new Date(),
          });
          return textResult({ requestId: id, message: dispatched.failure.message }, true);
        }
        return yield* savedAnswer(
          yield* settle(row, dispatched.success, config, selected.credentials),
        );
      }).pipe(
        Effect.catch((error: ExecutorFailure) =>
          Effect.succeed(textResult({ message: error.message }, true)),
        ),
      );
    const ownCall = (sessionId: SessionId, id: string, userId: string) =>
      Effect.gen(function* () {
        const row = yield* repo.call(id);
        if (row === null || row.sessionId !== sessionId || row.approverId !== userId)
          return yield* failure("This Executor approval is not yours.");
        return yield* expire(row);
      });
    const approval = (sessionId: SessionId, id: string, userId: string) =>
      Effect.gen(function* () {
        const row = yield* ownCall(sessionId, id, userId);
        if (row.outcome !== "held" || row.sealedResult === null)
          return yield* failure(
            row.outcome === "expired"
              ? "This Executor call expired."
              : "This Executor call is no longer waiting for an answer.",
          );
        const result = yield* unseal(McpSchema.CallToolResult, row.sealedResult);
        const held = heldOf(result);
        if (held === null) return yield* failure("This Executor approval is unavailable.");
        return {
          call: executorCallView(row),
          message: held.elicitation.message,
          inputSchema: held.elicitation.requestedSchema,
          arguments: (() => {
            const data = dataOf(result);
            return Schema.is(RecordJson)(data) &&
              Schema.is(RecordJson)(data.invocation) &&
              Schema.is(Schema.Json)(data.invocation.input)
              ? data.invocation.input
              : null;
          })(),
        };
      });
    const approve = (
      sessionId: SessionId,
      id: string,
      userId: string,
      input: ExecutorApprovalInput,
    ) =>
      Effect.gen(function* () {
        const row = yield* ownCall(sessionId, id, userId);
        if (row.outcome !== "held" || row.sealedResult === null) return executorCallView(row);
        const config = yield* sessionConfiguration(sessionId);
        if (row.linkId === null)
          return yield* failure("The Executor link was removed. This call cannot be approved.");
        const selected = yield* fresh(config, row.linkId);
        const result = yield* unseal(McpSchema.CallToolResult, row.sealedResult);
        const held = heldOf(result);
        if (held === null) return yield* failure("This Executor approval is unavailable.");
        if (!(yield* repo.claimApproval(id, userId)))
          return executorCallView(yield* ownCall(sessionId, id, userId));
        const resumed = yield* Effect.result(
          transport
            .mcp(yield* addressOf(config), selected.credentials.tool, "tools/call", {
              name: "resume",
              arguments: { requestId: held.requestId, response: input },
            })
            .pipe(
              Effect.flatMap((value) =>
                Schema.decodeUnknownEffect(McpSchema.CallToolResult)(value).pipe(
                  Effect.mapError(() =>
                    failure("Executor returned an unreadable approval result."),
                  ),
                ),
              ),
            ),
        );
        if (resumed._tag === "Failure")
          return yield* repo.saveCall({
            ...row,
            outcome: "unavailable",
            message:
              "The answer was sent, but Executor's result was not observed. Do not repeat a mutation without checking its service.",
            observedAt: new Date(),
            sealedResult: null,
          });
        return executorCallView(
          yield* settle(
            row,
            resumed.success,
            config,
            selected.credentials,
            input.action === "decline",
          ),
        );
      });
    return {
      ...serviceManagement,
      manage: (organizationId, action) =>
        managed
          .act(organizationId, action)
          .pipe(Effect.flatMap(() => configuration(organizationId))),
      configuration,
      configure,
      personalStatus,
      services,
      begin,
      finish,
      unlink,
      relay,
      approval,
      approve,
    };
  }),
);
