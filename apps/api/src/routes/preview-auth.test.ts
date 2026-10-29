import { Auth } from "@mend/auth";
import { PreviewId } from "@mend/domain";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { PreviewIdentity, PreviewPoolFull } from "../preview-identity.ts";
import { answerPreviewAuth } from "./preview-auth.ts";

const signedIn = Layer.mock(Auth, {
  getSession: () =>
    Effect.succeed(
      Option.some({
        user: { id: "carol", email: "carol@example.com", name: "Carol" },
        expiresAt: new Date("2026-11-01T00:00:00Z"),
        credential: "session:carol-1",
      }),
    ),
});

describe("opening a preview through Mend", () => {
  it("answers a page of its own, naming the set's size and when the next port frees, when every tailnet port is in use", async () => {
    const identity = Layer.mock(PreviewIdentity, {
      issueTicket: () =>
        Effect.fail(
          new PreviewPoolFull({ size: 16, nextFreeAt: new Date("2026-10-30T14:04:30.200Z") }),
        ),
    });
    const reply = await Effect.runPromise(
      answerPreviewAuth({
        method: "GET",
        target: `/api/preview-auth?preview=${PreviewId.make("pv-1")}&path=%2F`,
        cookie: "__Host-better-auth.session_token=s",
      }).pipe(Effect.provide(Layer.merge(signedIn, identity))),
    );
    expect(reply.status).toBe(503);
    expect(reply.body).toContain("No preview port is free. All 16 ports");
    expect(reply.body).toContain(
      "The next one frees at 2026-10-30 14:05 UTC at the earliest, if its preview stays closed until then.",
    );
    expect(reply.headers["cache-control"]).toBe("no-store");
  });
});
