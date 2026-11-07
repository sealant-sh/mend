import { CurrentUser, ExecutorRejected, MendApi } from "@mend/api-contracts";
import { ExecutorRepo } from "@mend/db";
import { OrganizationExecutor, type ExecutorFailure } from "@mend/sessions";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { ProjectAccess } from "../access.ts";
import { membership, ownership } from "./organization.ts";

const rejected = (error: ExecutorFailure) => new ExecutorRejected({ message: error.message });
export const ExecutorGroupLive = HttpApiBuilder.group(MendApi, "executor", (handlers) =>
  handlers
    .handle("manage", ({ payload }) =>
      Effect.gen(function* () {
        const member = yield* ownership("Executor");
        return yield* (yield* OrganizationExecutor)
          .manage(member.organization.id, payload.action)
          .pipe(Effect.mapError(rejected));
      }),
    )
    .handle("configuration", () =>
      Effect.gen(function* () {
        const member = yield* membership;
        return yield* (yield* OrganizationExecutor).configuration(member.organization.id);
      }),
    )
    .handle("configure", ({ payload }) =>
      Effect.gen(function* () {
        const member = yield* ownership("Executor");
        return yield* (yield* OrganizationExecutor)
          .configure(member.organization.id, payload)
          .pipe(Effect.mapError(rejected));
      }),
    )
    .handle("personal", () =>
      Effect.gen(function* () {
        const member = yield* membership;
        const caller = yield* CurrentUser;
        return yield* (yield* OrganizationExecutor).personalStatus(
          member.organization.id,
          caller.user.id,
        );
      }),
    )
    .handle("services", ({ query }) =>
      Effect.gen(function* () {
        const member = yield* membership;
        const caller = yield* CurrentUser;
        return yield* (yield* OrganizationExecutor)
          .services(member.organization.id, caller.user.id, query.offset)
          .pipe(Effect.mapError(rejected));
      }),
    )
    .handle("directory", ({ query }) =>
      Effect.gen(function* () {
        const member = yield* query.target === "member" ? ownership("Executor") : membership;
        const caller = yield* CurrentUser;
        return yield* (yield* OrganizationExecutor)
          .directory(member.organization.id, caller.user.id, query.target)
          .pipe(Effect.mapError(rejected));
      }),
    )
    .handle("addService", ({ payload }) =>
      Effect.gen(function* () {
        const member = yield* payload.target === "member" ? ownership("Executor") : membership;
        const caller = yield* CurrentUser;
        return yield* (yield* OrganizationExecutor)
          .addService(member.organization.id, caller.user.id, payload)
          .pipe(Effect.mapError(rejected));
      }),
    )
    .handle("connectService", ({ payload }) =>
      Effect.gen(function* () {
        const member = yield* payload.target === "member" ? ownership("Executor") : membership;
        const caller = yield* CurrentUser;
        return yield* (yield* OrganizationExecutor)
          .connectService(member.organization.id, caller.user.id, payload)
          .pipe(Effect.mapError(rejected));
      }),
    )
    .handle("submitService", ({ payload }) =>
      Effect.gen(function* () {
        const member = yield* membership;
        const caller = yield* CurrentUser;
        return yield* (yield* OrganizationExecutor)
          .submitService(member.organization.id, caller.user.id, payload)
          .pipe(Effect.mapError(rejected));
      }),
    )
    .handle("finishService", ({ payload }) =>
      Effect.gen(function* () {
        const member = yield* membership;
        const caller = yield* CurrentUser;
        return {
          target: yield* (yield* OrganizationExecutor)
            .finishService(member.organization.id, caller.user.id, payload)
            .pipe(Effect.mapError(rejected)),
        };
      }),
    )
    .handle("disconnectService", ({ payload }) =>
      Effect.gen(function* () {
        const member = yield* payload.target === "member" ? ownership("Executor") : membership;
        const caller = yield* CurrentUser;
        return yield* (yield* OrganizationExecutor)
          .disconnectService(member.organization.id, caller.user.id, payload)
          .pipe(Effect.mapError(rejected));
      }),
    )
    .handle("useServiceAccount", ({ payload }) =>
      Effect.gen(function* () {
        const member = yield* payload.target === "member" ? ownership("Executor") : membership;
        const caller = yield* CurrentUser;
        return yield* (yield* OrganizationExecutor)
          .useServiceAccount(member.organization.id, caller.user.id, payload)
          .pipe(Effect.mapError(rejected));
      }),
    )
    .handle("shareService", ({ params }) =>
      Effect.gen(function* () {
        const member = yield* ownership("Executor");
        const caller = yield* CurrentUser;
        return yield* (yield* OrganizationExecutor)
          .shareService(member.organization.id, caller.user.id, params.service)
          .pipe(Effect.mapError(rejected));
      }),
    )
    .handle("begin", ({ payload }) =>
      Effect.gen(function* () {
        const member = yield* payload.target === "member" ? ownership("Executor") : membership;
        const caller = yield* CurrentUser;
        return {
          url: yield* (yield* OrganizationExecutor)
            .begin(member.organization.id, caller.user.id, payload.target)
            .pipe(Effect.mapError(rejected)),
        };
      }),
    )
    .handle("finish", ({ payload }) =>
      Effect.gen(function* () {
        const member = yield* membership;
        const caller = yield* CurrentUser;
        return yield* (yield* OrganizationExecutor)
          .finish(
            member.organization.id,
            caller.user.id,
            member.role === "owner",
            payload.state,
            payload.code,
          )
          .pipe(Effect.mapError(rejected));
      }),
    )
    .handle("unlink", ({ params }) =>
      Effect.gen(function* () {
        const member = yield* params.target === "member" ? ownership("Executor") : membership;
        const caller = yield* CurrentUser;
        yield* (yield* OrganizationExecutor)
          .unlink(member.organization.id, caller.user.id, params.target)
          .pipe(Effect.mapError(rejected));
      }),
    )
    .handle("calls", ({ params, query }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).session(params.sessionId);
        return yield* (yield* ExecutorRepo).calls(params.sessionId, query.before);
      }),
    )
    .handle("approval", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).session(params.sessionId);
        const caller = yield* CurrentUser;
        return yield* (yield* OrganizationExecutor)
          .approval(params.sessionId, params.callId, caller.user.id)
          .pipe(Effect.mapError(rejected));
      }),
    )
    .handle("approve", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).session(params.sessionId);
        const caller = yield* CurrentUser;
        return yield* (yield* OrganizationExecutor)
          .approve(params.sessionId, params.callId, caller.user.id, payload)
          .pipe(Effect.mapError(rejected));
      }),
    ),
);
