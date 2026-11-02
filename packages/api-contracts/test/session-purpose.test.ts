import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { NewWorkbenchSession } from "../src/project-environment.ts";

const decode = Schema.decodeUnknownSync(NewWorkbenchSession);
const input = { harness: "codex", label: null, base: null };

describe("creating a setup session", () => {
  it("accepts the setup purpose and keeps older requests compatible", () => {
    expect(decode({ ...input, purpose: "setup" }).purpose).toBe("setup");
    expect(decode(input).purpose).toBeUndefined();
    expect(decode(input).name).toBeNull();
  });

  it("refuses purposes the server does not support", async () => {
    const result = await Effect.runPromise(
      Schema.decodeUnknownEffect(NewWorkbenchSession)({ ...input, purpose: "other" }).pipe(
        Effect.result,
      ),
    );
    expect(result._tag).toBe("Failure");
  });
});
