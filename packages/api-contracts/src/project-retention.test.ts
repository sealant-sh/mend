import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ProjectRemovalReport } from "./project-retention.ts";
import { RemovalReport } from "./workbench-views.ts";

describe("retained removal compatibility", () => {
  it("an older removal client still decodes the additive answer", () => {
    const answer = new ProjectRemovalReport({
      removed: true,
      leftover: null,
      retained: true,
      message: "Files and history are kept. Restore from Removed projects.",
    });
    expect(Schema.decodeUnknownSync(RemovalReport)(answer)).toEqual(
      new RemovalReport({ removed: true, leftover: null }),
    );
  });
});
