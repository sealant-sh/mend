import { describe, expect, it, vi } from "vitest";

import type { MendConnection } from "../config.js";
import { MendApiError } from "../mend-http.js";
import { ReviewClient } from "./review-client.js";

const answers = vi.hoisted(() => ({ status: 401, asked: new Array<string>() }));

vi.mock("../mend-http.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../mend-http.js")>();
  return {
    ...original,
    requestMend: async (connection: MendConnection) => {
      answers.asked.push(connection.url);
      throw new original.MendApiError("Signed out — sign in again.", answers.status);
    },
  };
});

const DANA: MendConnection = { url: "http://mend", token: "dana-token" };

describe("a review read Mend refuses", () => {
  it("drops the refused token, as every reader of Mend does, and still fails", async () => {
    const refused: Array<MendConnection> = [];
    const client = new ReviewClient(
      async () => DANA,
      (connection) => refused.push(connection),
    );
    answers.status = 401;
    await expect(client.comments("change-1")).rejects.toBeInstanceOf(MendApiError);
    expect(refused).toEqual([DANA]);
  });

  it("keeps the token when Mend fails for another reason", async () => {
    const refused: Array<MendConnection> = [];
    const client = new ReviewClient(
      async () => DANA,
      (connection) => refused.push(connection),
    );
    answers.status = 500;
    await expect(client.comments("change-1")).rejects.toBeInstanceOf(MendApiError);
    expect(refused).toEqual([]);
  });
});

describe("a review client pinned to one connection", () => {
  it("asks that server, whatever VS Code connects to afterwards", async () => {
    let connection = DANA;
    const client = new ReviewClient(
      async () => connection,
      () => undefined,
    );
    const pinned = client.pinned(DANA);
    connection = { url: "http://other", token: "other-token" };
    answers.status = 500;
    answers.asked.length = 0;
    await expect(pinned.comments("change-1")).rejects.toBeInstanceOf(MendApiError);
    await expect(client.comments("change-1")).rejects.toBeInstanceOf(MendApiError);
    expect(answers.asked).toEqual(["http://mend", "http://other"]);
  });
});
