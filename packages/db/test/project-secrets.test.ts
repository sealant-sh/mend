import { PgClient } from "@effect/sql-pg";
import { ProjectId, ProjectSecretId } from "@mend/domain";
import { Effect, Layer, Redacted, Result } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MendDBLive } from "../src/client.ts";
import { migrations } from "../src/migrations.ts";
import { ProjectSecretsRepo, ProjectSecretsRepoLive } from "../src/repos/project-secrets.ts";
import { postgresTestConfig } from "./postgres.ts";

const postgres = postgresTestConfig();
const ADMIN_URL = postgres.adminUrl;
const SCRATCH_DB = `mend_project_secrets_test_${process.pid}_${Date.now()}`;
const scratchUrl = (() => {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${SCRATCH_DB}`;
  return url.toString();
})();
const adminLayer = PgClient.layer({ url: Redacted.make(ADMIN_URL) });
const scratchLayer = PgClient.layer({ url: Redacted.make(scratchUrl) });
const repoLayer = ProjectSecretsRepoLive.pipe(
  Layer.provideMerge(MendDBLive.pipe(Layer.provideMerge(scratchLayer))),
);

const withAdmin = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(adminLayer), Effect.scoped));
const run = <A, E>(effect: Effect.Effect<A, E, ProjectSecretsRepo | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(repoLayer), Effect.scoped));

const PROJECT = ProjectId.make("p-web");

const codexLoginWords =
  "OPENAI_API_KEY is a Codex login. Connect it in Settings → Connected accounts, or with mend connect codex; a project secret never decides which login a session spends.";
const claudeLoginWords =
  "ANTHROPIC_API_KEY is a Claude login. Connect it in Settings → Connected accounts, or with mend connect claude; a project secret never decides which login a session spends.";

const refusal = <A, E>(effect: Effect.Effect<A, E, ProjectSecretsRepo | SqlClient.SqlClient>) =>
  run(effect.pipe(Effect.result)).then((outcome) =>
    Result.isFailure(outcome) ? outcome.failure : "accepted",
  );

const storedBeforeTheRule = (name: string, sealedValue: string) =>
  run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const id = ProjectSecretId.make(crypto.randomUUID());
      yield* sql`
        INSERT INTO project_secrets (id, project_id, name, sealed_value)
        VALUES (${id}, ${PROJECT}, ${name}, ${sealedValue})`;
      return id;
    }),
  );

describe.skipIf(postgres.skip)("project secrets named like a provider login, in Postgres", () => {
  beforeAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`CREATE DATABASE ${SCRATCH_DB}`);
      }),
    );
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ordered = Object.entries(migrations).toSorted(([a], [b]) => a.localeCompare(b));
        yield* Effect.forEach(ordered, ([, migration]) => migration, { discard: true });
        yield* sql`
          INSERT INTO projects (id, name, store_path, default_branch, organization_id)
          VALUES (${PROJECT}, 'web', '/store/p-web/repo.git', 'main',
                  (SELECT id FROM organizations LIMIT 1))`;
      }),
    );
  });

  afterAll(async () => {
    await withAdmin(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      }),
    );
  });

  it("refuses creating, renaming to, and loading a provider login name, with words that point to Connected accounts", async () => {
    const created = await refusal(
      Effect.gen(function* () {
        const secrets = yield* ProjectSecretsRepo;
        return yield* secrets.create(PROJECT, { name: "OPENAI_API_KEY", sealedValue: "sealed:a" });
      }),
    );
    expect(created).toMatchObject({
      _tag: "ProjectEnvironmentInvalidInputError",
      issues: [{ field: "name", rule: "name-provider-login", message: codexLoginWords }],
    });

    const loaded = await refusal(
      Effect.gen(function* () {
        const secrets = yield* ProjectSecretsRepo;
        return yield* secrets.upsertByName(PROJECT, {
          name: "ANTHROPIC_API_KEY",
          sealedValue: "sealed:b",
        });
      }),
    );
    expect(loaded).toMatchObject({
      issues: [{ rule: "name-provider-login", message: claudeLoginWords }],
    });

    const renamed = await refusal(
      Effect.gen(function* () {
        const secrets = yield* ProjectSecretsRepo;
        const { secret } = yield* secrets.create(PROJECT, {
          name: "STRIPE_API_KEY",
          sealedValue: "sealed:c",
        });
        return yield* secrets.update(PROJECT, secret.id, {
          name: "OPENAI_API_KEY",
          sealedValue: null,
          expectedRevision: secret.revision,
        });
      }),
    );
    expect(renamed).toMatchObject({
      issues: [{ rule: "name-provider-login", message: codexLoginWords }],
    });

    const names = await run(
      Effect.gen(function* () {
        const secrets = yield* ProjectSecretsRepo;
        return (yield* secrets.snapshot(PROJECT)).secrets.map((secret) => secret.name);
      }),
    );
    expect(names).toEqual(["STRIPE_API_KEY"]);
  });

  it("keeps a row stored before the rule: listed with the words, delivered at launch, removable and renamable, never given a new value", async () => {
    const codexId = await storedBeforeTheRule("OPENAI_API_KEY", "sealed:old-codex");
    const claudeId = await storedBeforeTheRule("ANTHROPIC_API_KEY", "sealed:old-claude");

    const listed = await run(
      Effect.gen(function* () {
        const secrets = yield* ProjectSecretsRepo;
        return (yield* secrets.snapshot(PROJECT)).secrets.map(({ name, nameRefusal }) => ({
          name,
          nameRefusal,
        }));
      }),
    );
    expect(listed).toEqual([
      { name: "ANTHROPIC_API_KEY", nameRefusal: claudeLoginWords },
      { name: "OPENAI_API_KEY", nameRefusal: codexLoginWords },
      { name: "STRIPE_API_KEY", nameRefusal: null },
    ]);

    const launched = await run(
      Effect.gen(function* () {
        const secrets = yield* ProjectSecretsRepo;
        return (yield* secrets.sealedForLaunch(PROJECT)).secrets;
      }),
    );
    expect(launched).toEqual([
      { name: "ANTHROPIC_API_KEY", sealedValue: "sealed:old-claude" },
      { name: "OPENAI_API_KEY", sealedValue: "sealed:old-codex" },
      { name: "STRIPE_API_KEY", sealedValue: "sealed:c" },
    ]);

    const replaced = await refusal(
      Effect.gen(function* () {
        const secrets = yield* ProjectSecretsRepo;
        return yield* secrets.update(PROJECT, codexId, {
          name: "OPENAI_API_KEY",
          sealedValue: "sealed:new-codex",
          expectedRevision: 1,
        });
      }),
    );
    expect(replaced).toMatchObject({
      issues: [{ rule: "name-provider-login", message: codexLoginWords }],
    });

    const renamedAway = await run(
      Effect.gen(function* () {
        const secrets = yield* ProjectSecretsRepo;
        return (yield* secrets.update(PROJECT, codexId, {
          name: "LEGACY_OPENAI_KEY",
          sealedValue: null,
          expectedRevision: 1,
        })).secret;
      }),
    );
    expect(renamedAway).toMatchObject({ name: "LEGACY_OPENAI_KEY", nameRefusal: null });

    await run(
      Effect.gen(function* () {
        const secrets = yield* ProjectSecretsRepo;
        yield* secrets.remove(PROJECT, claudeId, 1);
      }),
    );

    const after = await run(
      Effect.gen(function* () {
        const secrets = yield* ProjectSecretsRepo;
        return yield* secrets.sealedForLaunch(PROJECT);
      }),
    );
    expect(after.secrets).toEqual([
      { name: "LEGACY_OPENAI_KEY", sealedValue: "sealed:old-codex" },
      { name: "STRIPE_API_KEY", sealedValue: "sealed:c" },
    ]);
  });
});
