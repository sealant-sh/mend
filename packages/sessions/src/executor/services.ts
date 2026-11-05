import { createHash, randomUUID } from "node:crypto";

import type { ExecutorRepo, ExecutorServiceConnectionRow } from "@mend/db";
import type { OrganizationId } from "@mend/domain";
import type {
  ExecutorAddService,
  ExecutorConnectService,
  ExecutorServiceAccountAction,
  ExecutorServiceConnection,
  ExecutorServiceDirectory,
  ExecutorServiceFinish,
  ExecutorServiceMethod,
  ExecutorServiceSubmit,
  ExecutorServiceTarget,
} from "@mend/domain/workbench";
import { Effect, Redacted, Schema } from "effect";

import { ExecutorFailure } from "./failure.ts";
import { requestExecutor, type ExecutorTarget } from "./http.ts";
import type { ExecutorGrant } from "./transport.ts";

/** All service mutations use a fresh service grant for the explicitly selected Mend identity. */
export interface ExecutorServiceManagement {
  readonly directory: (
    organization: OrganizationId,
    actor: string,
    target: ExecutorServiceTarget,
  ) => Effect.Effect<typeof ExecutorServiceDirectory.Type, ExecutorFailure>;
  readonly addService: (
    organization: OrganizationId,
    actor: string,
    input: typeof ExecutorAddService.Type,
  ) => Effect.Effect<void, ExecutorFailure>;
  readonly shareService: (
    organization: OrganizationId,
    actor: string,
    service: string,
  ) => Effect.Effect<void, ExecutorFailure>;
  readonly connectService: (
    organization: OrganizationId,
    actor: string,
    input: typeof ExecutorConnectService.Type,
  ) => Effect.Effect<typeof ExecutorServiceConnection.Type, ExecutorFailure>;
  readonly submitService: (
    organization: OrganizationId,
    actor: string,
    input: typeof ExecutorServiceSubmit.Type,
  ) => Effect.Effect<void, ExecutorFailure>;
  readonly finishService: (
    organization: OrganizationId,
    actor: string,
    input: typeof ExecutorServiceFinish.Type,
  ) => Effect.Effect<ExecutorServiceTarget, ExecutorFailure>;
  readonly disconnectService: (
    organization: OrganizationId,
    actor: string,
    input: typeof ExecutorServiceAccountAction.Type,
  ) => Effect.Effect<void, ExecutorFailure>;
  readonly useServiceAccount: (
    organization: OrganizationId,
    actor: string,
    input: typeof ExecutorServiceAccountAction.Type,
  ) => Effect.Effect<void, ExecutorFailure>;
}
export interface ServiceAccess {
  readonly configurationId: string;
  readonly linkId: string;
  readonly executorOrganizationId: string;
  readonly target: ExecutorTarget;
  readonly grant: ExecutorGrant;
}
const failure = (message: string) => new ExecutorFailure({ kind: "refused", message });
const invalid = () =>
  failure(
    "Executor returned an unreadable service answer · observed. Reload Settings before trying again.",
  );
const decode = <S extends Schema.Top>(schema: S, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(invalid));
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const segment = encodeURIComponent;
const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const Account = Schema.Struct({ id: Schema.String, label: Schema.String });
const AuthMethod = Schema.Struct({
  type: Schema.String,
  label: Schema.optionalKey(Schema.String),
  fields: Schema.optionalKey(JsonObject),
  plain: Schema.optionalKey(Schema.Array(Schema.String)),
});
const Requirement = Schema.Struct({
  scope: Schema.optionalKey(Schema.Literals(["app", "user"])),
  definition: Schema.Struct({ auth: Schema.Record(Schema.String, AuthMethod) }),
});
const App = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  requirements: Schema.Struct({ accounts: Schema.Record(Schema.String, Requirement) }),
});
const Access = Schema.Struct({
  audience: Schema.Struct({ kind: Schema.String }),
  revision: Schema.String,
  canUse: Schema.Boolean,
  canManage: Schema.Boolean,
});
const Directory = Schema.Struct({
  apps: Schema.Array(Schema.Struct({ app: App, access: Access })),
  accounts: Schema.Array(
    Schema.Struct({ account: Account, access: Schema.Struct({ canManage: Schema.Boolean }) }),
  ),
});
const RequirementAccounts = Schema.Struct({
  accounts: Schema.Array(Schema.Struct({ account: Account, linked: Schema.Boolean })),
});
const FieldSchema = Schema.Struct({
  type: Schema.Literal("object"),
  properties: Schema.Record(
    Schema.String,
    Schema.Struct({ type: Schema.Literal("string"), title: Schema.optionalKey(Schema.String) }),
  ),
  required: Schema.optionalKey(Schema.Array(Schema.String)),
});
const fieldsOf = (method: typeof AuthMethod.Type) => {
  if (!Schema.is(FieldSchema)(method.fields)) return null;
  return Object.entries(method.fields.properties).map(([name, field]) => ({
    name,
    label: field.title ?? name,
    secret: !method.plain?.includes(name),
    required:
      method.fields !== undefined &&
      Schema.is(FieldSchema)(method.fields) &&
      (method.fields.required?.includes(name) ?? false),
  }));
};
const methodsOf = (
  requirement: typeof Requirement.Type,
): ReadonlyArray<typeof ExecutorServiceMethod.Type> =>
  Object.entries(requirement.definition.auth).map(([name, method]) => {
    const fields = fieldsOf(method);
    return {
      name,
      label: method.label ?? name,
      kind:
        method.type === "oauth2"
          ? "oauth"
          : method.type === "secrets" && fields !== null
            ? "fields"
            : "unsupported",
      fields: fields ?? [],
    };
  });
const requirementsFor = (app: typeof App.Type, target: ExecutorServiceTarget) =>
  Object.entries(app.requirements.accounts).filter(
    ([, requirement]) => target === "member" || (requirement.scope ?? "user") === "user",
  );
const pathOf = (service: string, scope: string, requirement: string) =>
  `/apps/${segment(service)}/accounts/${scope}/${segment(requirement)}`;
const importFailure = (value: unknown) => {
  const code = Schema.is(Schema.Struct({ code: Schema.String }))(value) ? value.code : "";
  switch (code) {
    case "mcp_timeout":
      return "Executor timed out contacting this MCP address · observed. Check the address and try again.";
    case "mcp_probe":
      return "Executor could not discover this MCP service · observed. Check that the address answers MCP requests.";
    case "destination_blocked":
      return "Executor refused this MCP destination · observed. Check its network access policy.";
    case "agent_setup_required":
      return "Executor could not import this MCP address. It must allow anonymous use or advertise OAuth sign-in. API-key services need an existing service definition.";
    default:
      return "Executor could not import this MCP address · observed. Check the address and Executor's service import log.";
  }
};
const request = (access: ServiceAccess, path: string, method = "GET", payload?: unknown) =>
  Effect.gen(function* () {
    const response = yield* requestExecutor(
      access.target,
      `/api/organizations/${segment(access.executorOrganizationId)}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${Redacted.value(access.grant.accessToken)}`,
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      },
      100_000,
    );
    const value = yield* Effect.tryPromise({
      try: (): Promise<unknown> => response.json(),
      catch: invalid,
    });
    if (!response.ok) {
      const tag = Schema.is(Schema.Struct({ _tag: Schema.String }))(value) ? value._tag : "";
      return yield* failure(
        tag === "CatalogImportFailed"
          ? importFailure(value)
          : tag === "VersionBuildFailed"
            ? "Executor discovered the service but could not build it · observed. Ask the operator to check Executor's build log and internet access."
            : tag === "AccountLinkedToApp"
              ? "This account is used by another service for everyone. Disconnect it there first."
              : tag === "AccountFieldsInvalid"
                ? "Executor refused these account fields. Check the service's required values and try again."
                : `Executor refused the service request · HTTP ${response.status} · observed. Reload Settings before trying again.`,
      );
    }
    return value;
  });

/** Keeps Executor protocol details out of the organization policy and HTTP handlers. */
export const executorServiceManagement = (options: {
  readonly repo: ExecutorRepo["Service"];
  readonly appUrl: string;
  readonly access: (
    organization: OrganizationId,
    actor: string,
    target: ExecutorServiceTarget,
  ) => Effect.Effect<ServiceAccess, ExecutorFailure>;
}): ExecutorServiceManagement => {
  const { repo, access } = options;
  const callback = `${options.appUrl}/executor/service-callback`;
  const directoryOf = (selected: ServiceAccess) =>
    request(selected, "/resources?view=available").pipe(
      Effect.flatMap((value) => decode(Directory, value)),
    );
  const share = (selected: ServiceAccess, service: string) =>
    Effect.gen(function* () {
      const path = `/apps/${segment(service)}/access`;
      const current = yield* request(selected, path).pipe(
        Effect.flatMap((value) => decode(Access, value)),
      );
      yield* request(selected, path, "PATCH", {
        audience: { kind: "everyone" },
        revision: current.revision,
      });
    });
  const connectionAccess = (
    organization: OrganizationId,
    actor: string,
    row: ExecutorServiceConnectionRow,
  ) =>
    Effect.gen(function* () {
      const selected = yield* access(organization, actor, row.target);
      if (row.configurationId !== selected.configurationId || row.linkId !== selected.linkId)
        return yield* failure(
          "This service connection belongs to an older Executor link. Start connecting again.",
        );
      return selected;
    });
  return {
    directory: (organization, actor, target) =>
      Effect.gen(function* () {
        const selected = yield* access(organization, actor, target);
        const directory = yield* directoryOf(selected);
        const services = yield* Effect.forEach(
          directory.apps.filter((item) => item.access.canUse),
          (item) =>
            Effect.gen(function* () {
              const requirements = yield* Effect.forEach(
                requirementsFor(item.app, target),
                ([name, requirement]) =>
                  Effect.gen(function* () {
                    const scope = requirement.scope ?? "user";
                    const available = yield* request(
                      selected,
                      pathOf(item.app.id, scope, name),
                    ).pipe(Effect.flatMap((value) => decode(RequirementAccounts, value)));
                    return {
                      name,
                      scope,
                      methods: methodsOf(requirement),
                      accounts: available.accounts.map(({ account, linked }) => ({
                        ...account,
                        linked,
                        canDisconnect: directory.accounts.some(
                          (resource) =>
                            resource.account.id === account.id && resource.access.canManage,
                        ),
                      })),
                    };
                  }),
              );
              return {
                id: item.app.id,
                name: item.app.name,
                shared: item.access.audience.kind === "everyone",
                requirements,
              };
            }),
          { concurrency: 4 },
        );
        return { services, observedAt: new Date() };
      }),
    addService: (organization, actor, input) =>
      Effect.gen(function* () {
        const selected = yield* access(organization, actor, input.target);
        const url = yield* Effect.try({
          try: () => new URL(input.url),
          catch: () => failure("Enter an HTTP or HTTPS MCP address."),
        });
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          /[{}]/.test(url.href)
        )
          return yield* failure(
            "Enter an MCP address without credentials, query parameters, or a fragment.",
          );
        const created = yield* request(selected, "/apps/import", "POST", {
          source: { kind: "mcp", name: input.name.trim(), url: url.href },
        }).pipe(Effect.flatMap((value) => decode(App, value)));
        if (input.target === "member")
          yield* share(selected, created.id).pipe(
            Effect.mapError(() =>
              failure(
                "Executor added the service, but sharing was not observed. Reload and choose Share with everyone.",
              ),
            ),
          );
      }),
    shareService: (organization, actor, service) =>
      Effect.flatMap(access(organization, actor, "member"), (selected) => share(selected, service)),
    connectService: (organization, actor, input) =>
      Effect.gen(function* () {
        const selected = yield* access(organization, actor, input.target);
        const app = yield* request(selected, `/apps/${segment(input.service)}`).pipe(
          Effect.flatMap((value) => decode(App, value)),
        );
        const requirement = app.requirements.accounts[input.requirement];
        if (
          requirement === undefined ||
          (input.target === "person" && (requirement.scope ?? "user") !== "user")
        )
          return yield* failure(
            "This service account requirement is unavailable. Reload Settings.",
          );
        const method = methodsOf(requirement).find((option) => option.name === input.method);
        if (method === undefined || method.kind === "unsupported")
          return yield* failure("Mend cannot display this service's account form.");
        const created = yield* request(
          selected,
          `${pathOf(app.id, requirement.scope ?? "user", input.requirement)}/connections`,
          "POST",
          {
            destination:
              input.target === "member"
                ? { kind: "shared", audience: { kind: "everyone" } }
                : { kind: "personal" },
          },
        ).pipe(Effect.flatMap((value) => decode(Schema.Struct({ id: Schema.String }), value)));
        const row: ExecutorServiceConnectionRow = {
          id: randomUUID(),
          configurationId: selected.configurationId,
          linkId: selected.linkId,
          actorId: actor,
          connectionId: created.id,
          method: method.name,
          target: input.target,
          stateHash: null,
          expiresAt: new Date(Date.now() + 15 * 60_000),
        };
        if (method.kind === "fields") {
          yield* repo.saveServiceConnection(row);
          return { id: row.id, url: null, fields: method.fields, completed: false };
        }
        const started = yield* request(
          selected,
          `/connections/${segment(created.id)}/oauth/start`,
          "POST",
          { method: method.name },
        ).pipe(
          Effect.flatMap((value) =>
            decode(
              Schema.Union([
                Schema.Struct({
                  status: Schema.Literal("redirect"),
                  authorizationUrl: Schema.String,
                  redirectUri: Schema.String,
                }),
                Schema.Struct({ status: Schema.Literal("completed") }),
              ]),
              value,
            ),
          ),
        );
        if (started.status === "completed")
          return { id: null, url: null, fields: [], completed: true };
        const url = yield* Effect.try({
          try: () => new URL(started.authorizationUrl),
          catch: invalid,
        });
        const state = url.searchParams.get("state");
        // Only the service's own page may reach a browser. The retained Executor never does.
        if (
          started.redirectUri !== callback ||
          !state ||
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.hostname === "executor.localhost"
        )
          return yield* failure(
            "Executor did not start sign-in with Mend's callback. Ask the operator to check APP_URL.",
          );
        yield* repo.saveServiceConnection({ ...row, stateHash: digest(state) });
        return { id: null, url: url.href, fields: [], completed: false };
      }),
    submitService: (organization, actor, input) =>
      repo.withLock(
        `service-connection:${input.id}`,
        Effect.gen(function* () {
          const row = yield* repo.serviceConnection(input.id, actor);
          if (row === null || row.stateHash !== null)
            return yield* failure("This service connection expired. Start connecting again.");
          const selected = yield* connectionAccess(organization, actor, row);
          yield* request(selected, `/connections/${segment(row.connectionId)}/submit`, "POST", {
            method: row.method,
            fields: Redacted.value(input.fields),
          });
          yield* repo.deleteServiceConnection(row.id);
        }),
      ),
    finishService: (organization, actor, input) =>
      Effect.gen(function* () {
        const url = yield* Effect.try({
          try: () => new URL(Redacted.value(input.callbackUrl)),
          catch: invalid,
        });
        const state = url.searchParams.get("state");
        if (url.origin + url.pathname !== callback || !state || url.username || url.password)
          return yield* failure("This service return does not match Mend's callback.");
        const config = yield* repo.configuration(organization);
        if (config === null) return yield* failure("This organization's Executor was removed.");
        const row = yield* repo.consumeServiceConnection(digest(state), actor, config.id);
        if (row === null)
          return yield* failure(
            "This service sign-in expired, belongs to another person, or was already completed. Start connecting again.",
          );
        const selected = yield* connectionAccess(organization, actor, row);
        yield* request(
          selected,
          `/connections/${segment(row.connectionId)}/oauth/complete`,
          "POST",
          { callbackUrl: url.href },
        );
        return row.target;
      }),
    useServiceAccount: (organization, actor, input) =>
      Effect.gen(function* () {
        const selected = yield* access(organization, actor, input.target);
        const app = yield* request(selected, `/apps/${segment(input.service)}`).pipe(
          Effect.flatMap((value) => decode(App, value)),
        );
        const requirement = app.requirements.accounts[input.requirement];
        if (!requirement || (input.target === "person" && (requirement.scope ?? "user") !== "user"))
          return yield* failure("This service account requirement is unavailable.");
        yield* request(
          selected,
          `${pathOf(input.service, requirement.scope ?? "user", input.requirement)}/${segment(input.account)}`,
          "PUT",
          {},
        );
      }),
    disconnectService: (organization, actor, input) =>
      Effect.gen(function* () {
        const selected = yield* access(organization, actor, input.target);
        const directory = yield* directoryOf(selected);
        if (
          !directory.accounts.some(
            (item) => item.account.id === input.account && item.access.canManage,
          )
        )
          return yield* failure("This account is not yours to disconnect.");
        // Personal deletion removes its user links. App links need an explicit unlink first.
        for (const item of directory.apps.filter((resource) => resource.access.canManage)) {
          for (const [name] of requirementsFor(item.app, input.target).filter(
            ([, requirement]) => requirement.scope === "app",
          )) {
            const path = pathOf(item.app.id, "app", name);
            const linked = yield* request(selected, path).pipe(
              Effect.flatMap((value) => decode(RequirementAccounts, value)),
            );
            if (
              linked.accounts.some(
                (account) => account.account.id === input.account && account.linked,
              )
            )
              yield* request(selected, `${path}/${segment(input.account)}`, "DELETE");
          }
        }
        yield* request(selected, `/accounts/${segment(input.account)}`, "DELETE");
      }),
  };
};
