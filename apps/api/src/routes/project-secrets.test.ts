import { ProjectEnvironmentVariableId, ProjectSecretId } from "@mend/domain";
import {
  ProjectEnvironmentSnapshot,
  ProjectEnvironmentVariable,
  ProjectSecret,
  ProjectSecretsSnapshot,
} from "@mend/domain/workbench";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

const project = ids("private-alice").project;

const loginWords = (name: string, label: string) =>
  `${name} is a ${label} login, not a project secret. Connect your ${label} login in Settings → Connected accounts.`;

const providerLoginNames = [
  ["ANTHROPIC_API_KEY", "Claude"],
  ["ANTHROPIC_AUTH_TOKEN", "Claude"],
  ["CLAUDE_CODE_OAUTH_TOKEN", "Claude"],
  ["OPENAI_API_KEY", "Codex"],
  ["CODEX_API_KEY", "Codex"],
] as const;

describe("loading a .env that names a provider login", () => {
  let api: TenancyApi;
  const stored: Array<string> = [];
  beforeAll(async () => {
    api = await createTenancyApi(undefined, {
      implement: {
        cipher: { encrypt: (plaintext) => Effect.succeed(`sealed:${plaintext.length}`) },
        engine: { launchUnderWay: () => false, reconcileHotSessions: () => Effect.void },
        environment: {
          snapshot: () =>
            Effect.succeed(new ProjectEnvironmentSnapshot({ revision: 0, variables: [] })),
          upsertByName: (projectId, input) =>
            Effect.sync(() => {
              stored.push(`configuration:${input.name}`);
              return {
                variable: new ProjectEnvironmentVariable({
                  id: ProjectEnvironmentVariableId.make(`variable-${input.name}`),
                  projectId,
                  name: input.name,
                  value: input.value,
                  revision: 1,
                  createdAt: new Date(0),
                  updatedAt: new Date(0),
                }),
                revision: 1,
                action: "created" as const,
              };
            }),
        },
        secrets: {
          snapshot: () => Effect.succeed(new ProjectSecretsSnapshot({ revision: 0, secrets: [] })),
          upsertByName: (projectId, input) =>
            Effect.sync(() => {
              stored.push(`secret:${input.name}`);
              return {
                secret: new ProjectSecret({
                  id: ProjectSecretId.make(`secret-${input.name}`),
                  projectId,
                  name: input.name,
                  revision: 1,
                  createdAt: new Date(0),
                  updatedAt: new Date(0),
                }),
                revision: 1,
                action: "created" as const,
              };
            }),
        },
      },
    });
  });
  afterAll(async () => {
    await api.dispose();
  });

  it("refuses each provider login with words that point to Connected accounts, and loads the rest", async () => {
    const contents = [
      ...providerLoginNames.map(([name]) => `${name}=fake-login-value`),
      "STRIPE_API_KEY=fake-stripe-value",
      "PORT=3000",
    ].join("\n");
    const response = await api.request(
      "alice",
      "POST",
      `/api/projects/${project}/environment/load`,
      { contents, allSecret: false, secretNames: [] },
    );
    expect(response.status).toBe(200);
    const report = await response.json();
    expect(report).toMatchObject({
      loaded: [
        { name: "STRIPE_API_KEY", lane: "secret", action: "created" },
        { name: "PORT", lane: "configuration", action: "created" },
      ],
      rejected: providerLoginNames.map(([name, label]) => ({
        name,
        reason: loginWords(name, label),
      })),
    });
    expect(stored).toEqual(["secret:STRIPE_API_KEY", "configuration:PORT"]);
  });
});
