import { describe, expect, it, vi } from "vitest";

import type { MendConnection } from "../config.js";
import { MendApiError } from "../mend-http.js";
import { Unbound, type Bound } from "./binding.js";
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

const steady = (connection: MendConnection): Bound => ({ connection, current: () => true });

const WHOLE = {
  oldPath: null,
  newPath: null,
  side: null,
  startLine: null,
  endLine: null,
  hunkContextHash: null,
};

describe("a review read Mend refuses", () => {
  it("drops the refused token, as every reader of Mend does, and still fails", async () => {
    const refused: Array<MendConnection> = [];
    const client = new ReviewClient(
      async () => steady(DANA),
      (connection) => refused.push(connection),
    );
    answers.status = 401;
    await expect(client.comments("change-1")).rejects.toBeInstanceOf(MendApiError);
    expect(refused).toEqual([DANA]);
  });

  it("keeps the token when Mend fails for another reason", async () => {
    const refused: Array<MendConnection> = [];
    const client = new ReviewClient(
      async () => steady(DANA),
      (connection) => refused.push(connection),
    );
    answers.status = 500;
    await expect(client.comments("change-1")).rejects.toBeInstanceOf(MendApiError);
    expect(refused).toEqual([]);
  });
});

describe("a pinned review client", () => {
  it("asks the server its pin gives, whatever VS Code connects to, and asks nothing when the pin refuses", async () => {
    let connection = DANA;
    const client = new ReviewClient(
      async () => steady(connection),
      () => undefined,
    );
    const pinned = client.pinned(async () => steady(DANA));
    const refusing = client.pinned(async () => {
      throw new Unbound("switched");
    });
    connection = { url: "http://other", token: "other-token" };
    answers.status = 500;
    answers.asked.length = 0;
    await expect(pinned.comments("change-1")).rejects.toBeInstanceOf(MendApiError);
    await expect(client.comments("change-1")).rejects.toBeInstanceOf(MendApiError);
    await expect(refusing.postComment("change-1", "slice-1", WHOLE, "x")).rejects.toBeInstanceOf(
      Unbound,
    );
    expect(answers.asked).toEqual(["http://mend", "http://other"]);
  });
});
