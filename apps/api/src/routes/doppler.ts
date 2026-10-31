import { CurrentUser, DopplerRejected, MendApi } from "@mend/api-contracts";
import { DopplerRepo } from "@mend/db";
import { dopplerSelectionIssue, dopplerTokenIssue } from "@mend/domain/workbench";
import { SecretCipher } from "@mend/store";
import { Effect, Redacted } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { ProjectAccess } from "../access.ts";
import { DopplerApi } from "../services/doppler.ts";

const ownToken = Effect.gen(function* () {
  const caller = yield* CurrentUser;
  const connection = yield* (yield* DopplerRepo).connection(caller.user.id);
  if (connection === null) return yield* new DopplerRejected({ message: "Connect Doppler first." });
  return yield* (yield* SecretCipher).decrypt(connection.sealedToken).pipe(
    Effect.map(Redacted.make),
    Effect.mapError(
      () =>
        new DopplerRejected({
          message: "Reconnect Doppler: the saved token could not be unsealed.",
        }),
    ),
  );
});

export const DopplerGroupLive = HttpApiBuilder.group(MendApi, "doppler", (handlers) =>
  handlers
    .handle("status", () =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const repo = yield* DopplerRepo;
        const connection = yield* repo.connection(caller.user.id);
        const projects = yield* (yield* ProjectAccess).visibleProjects();
        const names = new Map(projects.map((project) => [project.id, project.name]));
        const mappings = (yield* repo.mappings(caller.user.id)).flatMap((mapping) => {
          const projectName = names.get(mapping.projectId);
          return projectName === undefined ? [] : [{ ...mapping, projectName }];
        });
        return {
          connected: connection !== null,
          name: null,
          updatedAt: connection?.updatedAt ?? null,
          mappings,
        };
      }),
    )
    .handle("save", ({ payload }) =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        const issue = dopplerTokenIssue(Redacted.value(payload.token));
        if (issue !== null) return yield* new DopplerRejected({ message: issue });
        const sealed = yield* (yield* SecretCipher)
          .encrypt(Redacted.value(payload.token))
          .pipe(Effect.orDie);
        yield* (yield* DopplerRepo).save(caller.user.id, sealed);
        return { connected: true };
      }),
    )
    .handle("disconnect", () =>
      Effect.gen(function* () {
        const caller = yield* CurrentUser;
        return { removed: yield* (yield* DopplerRepo).disconnect(caller.user.id) };
      }),
    )
    .handle("use", ({ params, payload }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).project(params.projectId);
        const issue = dopplerSelectionIssue(payload);
        if (issue !== null) return yield* new DopplerRejected({ message: issue });
        const caller = yield* CurrentUser;
        const repo = yield* DopplerRepo;
        if ((yield* repo.connection(caller.user.id)) === null)
          return yield* new DopplerRejected({ message: "Connect Doppler first." });
        yield* repo.use(caller.user.id, params.projectId, payload);
        return { projectId: params.projectId, ...payload };
      }),
    )
    .handle("removeMapping", ({ params }) =>
      Effect.gen(function* () {
        yield* (yield* ProjectAccess).project(params.projectId);
        const caller = yield* CurrentUser;
        return {
          removed: yield* (yield* DopplerRepo).removeMapping(caller.user.id, params.projectId),
        };
      }),
    )
    .handle("projects", () =>
      Effect.gen(function* () {
        const token = yield* ownToken;
        return yield* (yield* DopplerApi).projects(token);
      }),
    )
    .handle("configs", ({ query }) =>
      Effect.gen(function* () {
        const issue = dopplerSelectionIssue({ dopplerProject: query.project, config: "dev" });
        if (issue !== null) return yield* new DopplerRejected({ message: issue });
        const token = yield* ownToken;
        return yield* (yield* DopplerApi).configs(token, query.project);
      }),
    ),
);
