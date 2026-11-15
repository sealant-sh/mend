import { SetupStepFailure } from "@mend/domain/workbench";
import { ServiceStartError } from "@mend/sessions";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import { ids } from "../../test/support/tenancy-harness.ts";

const STORE_PATH = "/var/lib/mend/store/prj_9f2/repo.git";
const FAILED_WORDS = `setup did not finish, so nothing was started · \`pnpm install\` exited 1\n--- output ---\nERR_PNPM in ${STORE_PATH}`;

describe("a Run on a Service whose setup fails", () => {
  let failure: ServiceStartError = new ServiceStartError({ message: "" });
  let api: TenancyApi;

  beforeAll(async () => {
    api = await createTenancyApi(
      {},
      {
        errorDetail: { mode: "redacted" },
        implement: {
          engine: {
            launchUnderWay: () => false,
            runServiceRecipe: () => Effect.suspend(() => Effect.fail(failure)),
          },
        },
      },
    );
  });
  afterAll(async () => {
    await api.dispose();
  });

  const { session } = ids("shared-a");
  const run = () =>
    api.request("alice", "POST", `/api/sessions/${session}/services/recipe`, { name: "web" });

  it("is refused as ServiceSetupFailed, in the same words, with the step's facts scrubbed as the words are", async () => {
    failure = new ServiceStartError({
      message: FAILED_WORDS,
      setupFailed: new SetupStepFailure({
        step: `pnpm install --dir ${STORE_PATH}`,
        ended: { _tag: "Exited", exitCode: 1 },
        output: `ERR_PNPM in ${STORE_PATH}`,
      }),
    });
    const response = await run();
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      _tag: "ServiceSetupFailed",
      message: FAILED_WORDS.replace(STORE_PATH, "<path>/repo.git"),
      setup: {
        step: "pnpm install --dir <path>/repo.git",
        ended: { _tag: "Exited", exitCode: 1 },
        output: "ERR_PNPM in <path>/repo.git",
      },
    });
  });

  it("keeps StoreFailure for a start that failed for any other reason", async () => {
    failure = new ServiceStartError({ message: "a Stop came before web started" });
    const response = await run();
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      _tag: "StoreFailure",
      message: "a Stop came before web started",
    });
  });
});
