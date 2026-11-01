import { Readable } from "node:stream";

import { Effect, Fiber, Logger, References } from "effect";
import { describe, expect, it } from "vitest";

import { makeFakeSlack, makeSlackApi, updateRefusalOf, type FakeSlackWorkspace } from "./client.ts";

/** One request as the SDK sent it: the method, the bearer and the form body. */
interface Sent {
  readonly url: string;
  readonly authorization: string | null;
  readonly body: URLSearchParams;
}

/** A Slack that answers each method from a table, and records what it was sent. */
const fakeFetch = (
  answers: Record<string, ReadonlyArray<unknown>>,
  responseHeaders: Record<string, string> = {},
) => {
  const sent: Array<Sent> = [];
  const served = new Map<string, number>();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers);
    const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    sent.push({ url, authorization: headers.get("authorization"), body });
    const method = url.split("/").at(-1) ?? "";
    const index = served.get(method) ?? 0;
    served.set(method, index + 1);
    const pages = answers[method] ?? [{ ok: false, error: "unknown_method" }];
    const answer = pages[Math.min(index, pages.length - 1)];
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "content-type": "application/json", ...responseHeaders },
    });
  };
  return { fetch, sent };
};

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.result(effect));

/** One page of `conversations.replies`: three messages from `1.<from>`, then the cursor. */
const page = (from: number, cursor: string) => ({
  ok: true,
  messages: [0, 1, 2].map((offset) => ({
    ts: `1.${from + offset}`,
    user: "U1",
    text: `message ${from + offset}`,
  })),
  response_metadata: { next_cursor: cursor },
});

/** A thread message as the fake Slack holds it, its text its timestamp. */
const threadMessage = (ts: string) => ({
  ts,
  userId: "U1",
  teamId: "T1",
  isBot: false,
  displayName: null,
  text: ts,
  files: [],
});

describe("the live Slack client (over @slack/web-api)", () => {
  it("sends the token as a bearer and reads auth.test", async () => {
    const slack = fakeFetch({
      "auth.test": [
        {
          ok: true,
          team_id: "T1",
          team: "Acme",
          user_id: "UBOT",
          bot_id: "B1",
          url: "https://acme.slack.com/",
        },
      ],
    });
    const api = makeSlackApi({ fetch: slack.fetch });
    const result = await run(api.authTest("xoxb-1"));
    expect(result).toMatchObject({
      _tag: "Success",
      success: {
        teamId: "T1",
        teamName: "Acme",
        userId: "UBOT",
        botId: "B1",
        appId: null,
        enterpriseId: null,
      },
    });
    expect(slack.sent[0]?.url).toBe("https://slack.com/api/auth.test");
    expect(slack.sent[0]?.authorization).toBe("Bearer xoxb-1");
  });

  it("reports Slack's own error code, and never the token", async () => {
    const slack = fakeFetch({ "auth.test": [{ ok: false, error: "invalid_auth" }] });
    const result = await run(makeSlackApi({ fetch: slack.fetch }).authTest("xoxb-secret"));
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SlackApiError", method: "auth.test", code: "invalid_auth" },
    });
    expect(JSON.stringify(result)).not.toContain("xoxb-secret");
  });

  it("sends an app-level token as a bearer only, and names its app from auth.test", async () => {
    // Slack refuses an app-level token in a form body with invalid_auth; the SDK's `token`
    // argument puts it there. The socket URL's app_id is a hash, so the app comes from auth.test.
    const slack = fakeFetch({
      "apps.connections.open": [
        {
          ok: true,
          url: "wss://wss-primary.slack.com/link/?ticket=abc&app_id=92bd9032a523d8dc9539ee49",
        },
      ],
      "auth.test": [
        { ok: true, team_id: "T1", team: "Acme", user_id: "U1", app_id: "A0C4HUQT6F7" },
      ],
    });
    const result = await run(makeSlackApi({ fetch: slack.fetch }).appsConnectionsOpen("xapp-1"));
    expect(result).toMatchObject({ _tag: "Success", success: { appId: "A0C4HUQT6F7" } });
    expect(slack.sent.map((request) => request.url.split("/").at(-1))).toEqual([
      "apps.connections.open",
      "auth.test",
    ]);
    for (const request of slack.sent) {
      expect(request.authorization).toBe("Bearer xapp-1");
      expect(request.body.has("token")).toBe(false);
    }
  });

  it("reads a thread across pages, up to the mention, as thread messages", async () => {
    const slack = fakeFetch({
      "conversations.replies": [
        {
          ok: true,
          messages: [
            { ts: "1.1", user: "U1", team: "T1", text: "the login test flakes" },
            { ts: "1.2", bot_id: "B9", subtype: "bot_message", text: "CI failed" },
          ],
          has_more: true,
          response_metadata: { next_cursor: "page-2" },
        },
        {
          ok: true,
          messages: [
            {
              ts: "1.3",
              user: "U2",
              user_team: "T2",
              text: "<@UBOT> fix it",
              files: [
                {
                  id: "F1",
                  name: "shot.png",
                  mimetype: "image/png",
                  url_private: "https://files.slack.com/f",
                  size: 48213,
                },
              ],
            },
          ],
          has_more: false,
          response_metadata: { next_cursor: "" },
        },
      ],
    });
    const result = await run(
      makeSlackApi({ fetch: slack.fetch }).conversationsReplies("xoxb-1", {
        channel: "C1",
        ts: "1.1",
        latest: "1.3",
      }),
    );
    expect(result).toMatchObject({
      _tag: "Success",
      success: [
        {
          ts: "1.1",
          userId: "U1",
          teamId: "T1",
          isBot: false,
          displayName: null,
          text: "the login test flakes",
          files: [],
        },
        {
          ts: "1.2",
          userId: null,
          teamId: null,
          isBot: true,
          displayName: null,
          text: "CI failed",
          files: [],
        },
        {
          ts: "1.3",
          userId: "U2",
          teamId: "T2",
          isBot: false,
          displayName: null,
          text: "<@UBOT> fix it",
          files: [
            {
              id: "F1",
              name: "shot.png",
              mimetype: "image/png",
              urlPrivate: "https://files.slack.com/f",
              size: 48213,
            },
          ],
        },
      ],
    });
    expect(slack.sent.map((request) => request.body.get("cursor"))).toEqual([null, "page-2"]);
    expect(slack.sent[0]?.body.get("latest")).toBe("1.3");
  });

  it("reads every page and keeps the newest messages, the mention among them", async () => {
    const slack = fakeFetch({
      "conversations.replies": [page(1, "page-2"), page(4, "page-3"), page(7, "")],
    });
    const result = await run(
      makeSlackApi({ fetch: slack.fetch }).conversationsReplies("xoxb-1", {
        channel: "C1",
        ts: "1.1",
        latest: "1.9",
        max: 4,
      }),
    );
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    expect(result.success.map((message) => message.ts)).toEqual(["1.6", "1.7", "1.8", "1.9"]);
    expect(slack.sent).toHaveLength(3);
    expect(slack.sent[0]?.body.get("inclusive")).toBe("true");
  });

  it("keeps Slack's Retry-After when an edit stays rate limited past the client's own waits", async () => {
    let calls = 0;
    const limited: typeof globalThis.fetch = async () => {
      calls += 1;
      return new Response("", { status: 429, headers: { "retry-after": "0" } });
    };
    const result = await run(
      makeSlackApi({ fetch: limited }).update("xoxb-1", { channel: "C1", ts: "1.1", text: "x" }),
    );
    expect(calls).toBe(3);
    if (result._tag !== "Failure") throw new Error("a rate-limited edit succeeded");
    expect(result.failure).toMatchObject({ code: "ratelimited", retryAfterSeconds: 0 });
    expect(updateRefusalOf(result.failure)).toEqual({ _tag: "Refused", retryAfterMs: 0 });
  });

  it("says only a deleted message or channel is gone; an archived channel or a lost invite may come back", async () => {
    const codes = [
      "message_not_found",
      "channel_not_found",
      "is_archived",
      "not_in_channel",
      "cant_update_message",
      "invalid_blocks",
      "internal_error",
    ];
    const slack = fakeFetch({ "chat.update": codes.map((error) => ({ ok: false, error })) });
    const api = makeSlackApi({ fetch: slack.fetch });
    const refusals = [];
    for (let attempt = 0; attempt < codes.length; attempt++) {
      const result = await run(api.update("xoxb-1", { channel: "C1", ts: "1.1", text: "x" }));
      if (result._tag !== "Failure") throw new Error("a refused edit succeeded");
      refusals.push(updateRefusalOf(result.failure));
    }
    expect(refusals).toEqual([
      { _tag: "MessageGone" },
      { _tag: "MessageGone" },
      ...Array.from({ length: 5 }, () => ({ _tag: "Refused", retryAfterMs: null })),
    ]);
  });

  it("treats a reaction already there as done", async () => {
    const slack = fakeFetch({ "reactions.add": [{ ok: false, error: "already_reacted" }] });
    const result = await run(
      makeSlackApi({ fetch: slack.fetch }).reactionsAdd("xoxb-1", {
        channel: "C1",
        timestamp: "1.3",
        name: "hourglass_flowing_sand",
      }),
    );
    expect(result._tag).toBe("Success");
  });

  it.each([
    {
      profile: { display_name: "Ada display", real_name: "Ada profile" },
      real: "Ada top",
      display: "Ada display",
      expectedReal: "Ada profile",
    },
    {
      profile: { display_name: "", real_name: "Ada profile" },
      real: "Ada top",
      display: "Ada profile",
      expectedReal: "Ada profile",
    },
    {
      profile: { display_name: "", real_name: "" },
      real: "Ada top",
      display: "Ada top",
      expectedReal: "Ada top",
    },
    { profile: undefined, real: "Ada top", display: "Ada top", expectedReal: "Ada top" },
    { profile: {}, real: "", display: "ada", expectedReal: null },
    { profile: undefined, real: undefined, display: "ada", expectedReal: null },
  ])(
    "uses user name precedence for $display with profile $profile",
    async ({ profile, real, display, expectedReal }) => {
      const slack = fakeFetch({
        "users.info": [
          {
            ok: true,
            user: {
              id: "U1",
              team_id: "T1",
              name: "ada",
              real_name: real,
              profile,
            },
          },
        ],
      });
      const result = await run(makeSlackApi({ fetch: slack.fetch }).usersInfo("xoxb-1", "U1"));
      expect(result).toMatchObject({
        _tag: "Success",
        success: {
          id: "U1",
          teamId: "T1",
          displayName: display,
          realName: expectedReal,
          name: "ada",
          isBot: false,
          deleted: false,
        },
      });
    },
  );

  it("sends the bot token for a file only to Slack", async () => {
    const slack = fakeFetch({});
    const api = makeSlackApi({ fetch: slack.fetch });
    for (const url of [
      "https://evil.example/files.slack.com/f",
      "http://files.slack.com/f",
      "https://files.slack.com.evil.example/f",
    ]) {
      const result = await run(api.filesDownload("xoxb-1", url, { maxBytes: 10 }));
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: "not_slack_host" } });
    }
    expect(slack.sent).toEqual([]);
  });
});

// These tests bound accepted bytes, not peak memory: the adapter reads arrayBuffer in full.
describe("live Slack file download", () => {
  const url = "https://files.slack.com/files-pri/T1-F1/image";

  it.each([undefined, "image/png"])(
    "returns exact byte-boundary content with type %s and guarded bearer",
    async (type) => {
      const bytes = Uint8Array.of(0, 255, 42, 128);
      const calls: Array<{
        url: string;
        bearerMatches: boolean;
        redirect: RequestRedirect | undefined;
        signal: AbortSignal | null | undefined;
      }> = [];
      const fetch: typeof globalThis.fetch = async (input, init) => {
        calls.push({
          url: String(input),
          bearerMatches: new Headers(init?.headers).get("authorization") === "Bearer xoxb-fixture",
          redirect: init?.redirect,
          signal: init?.signal,
        });
        return new Response(bytes, {
          headers: {
            "content-length": "4",
            ...(type === undefined ? {} : { "content-type": type }),
          },
        });
      };
      const result = await run(
        makeSlackApi({ fetch }).filesDownload("xoxb-fixture", url, { maxBytes: 4 }),
      );
      expect(result._tag).toBe("Success");
      if (result._tag !== "Success") throw new Error("Expected downloaded bytes");
      expect(result.success).toEqual({ bytes, contentType: type ?? null });
      expect(
        calls.map(({ signal, ...call }) => ({
          ...call,
          abortable: signal instanceof AbortSignal,
          aborted: signal?.aborted,
        })),
      ).toEqual([{ url, bearerMatches: true, redirect: "error", abortable: true, aborted: false }]);
    },
  );

  it("refuses a declared oversize before reading its body", async () => {
    let reads = 0;
    class ObservedResponse extends Response {
      override arrayBuffer() {
        reads += 1;
        return super.arrayBuffer();
      }
    }
    const fetch: typeof globalThis.fetch = async () =>
      new ObservedResponse(Uint8Array.of(1), { headers: { "content-length": "5" } });
    expect(
      await run(makeSlackApi({ fetch }).filesDownload("xoxb-fixture", url, { maxBytes: 4 })),
    ).toMatchObject({
      _tag: "Failure",
      failure: {
        method: "files.download",
        code: "too_large",
        message: "The file is over 4 bytes.",
      },
    });
    expect(reads).toBe(0);
  });

  it.each([null, "1"])("refuses actual oversize when declared length is %s", async (declared) => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(Uint8Array.of(1, 2, 3, 4, 5), {
        headers: declared === null ? {} : { "content-length": declared },
      });
    expect(
      await run(makeSlackApi({ fetch }).filesDownload("xoxb-fixture", url, { maxBytes: 4 })),
    ).toMatchObject({
      _tag: "Failure",
      failure: { method: "files.download", code: "too_large" },
    });
  });

  it("classifies HTTP refusal before reading its body", async () => {
    let reads = 0;
    class ObservedResponse extends Response {
      override arrayBuffer() {
        reads += 1;
        return super.arrayBuffer();
      }
    }
    const fetch: typeof globalThis.fetch = async () =>
      new ObservedResponse("private response body", { status: 403 });
    expect(
      await run(makeSlackApi({ fetch }).filesDownload("xoxb-fixture", url, { maxBytes: 100 })),
    ).toMatchObject({
      _tag: "Failure",
      failure: expect.objectContaining({
        method: "files.download",
        code: "http_403",
        message: "Slack answered 403 for the file.",
      }),
    });
    expect(reads).toBe(0);
  });

  it("retains transport refusal when redirect:error prevents following a destination", async () => {
    const redirects: Array<RequestRedirect | undefined> = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      redirects.push(init?.redirect);
      if (init?.redirect === "error") throw new TypeError("synthetic redirect refused");
      return new Response(Uint8Array.of(1));
    };
    expect(
      await run(makeSlackApi({ fetch }).filesDownload("xoxb-fixture", url, { maxBytes: 4 })),
    ).toMatchObject({
      _tag: "Failure",
      failure: {
        method: "files.download",
        code: "request_failed",
        message: "synthetic redirect refused",
      },
    });
    expect(redirects).toEqual(["error"]);
  });

  it("classifies a failed response-body read", async () => {
    const failure = new Error("synthetic body read failure");
    const fetch: typeof globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(failure);
          },
        }),
      );
    expect(
      await run(makeSlackApi({ fetch }).filesDownload("xoxb-fixture", url, { maxBytes: 4 })),
    ).toMatchObject({
      _tag: "Failure",
      failure: {
        method: "files.download",
        code: "request_failed",
        message: "synthetic body read failure",
      },
    });
  });

  it("aborts the actual supplied fetch when the download is interrupted", async () => {
    const entered = Promise.withResolvers<AbortSignal>();
    let aborted = 0;
    const fetch: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!(signal instanceof AbortSignal)) throw new Error("Expected an abortable download");
        signal.addEventListener(
          "abort",
          () => {
            aborted += 1;
            reject(new DOMException("cancelled", "AbortError"));
          },
          { once: true },
        );
        entered.resolve(signal);
      });
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* makeSlackApi({ fetch })
          .filesDownload("xoxb-fixture", url, { maxBytes: 4 })
          .pipe(Effect.forkChild);
        const signal = yield* Effect.promise(() => entered.promise);
        expect(signal.aborted).toBe(false);
        yield* Fiber.interrupt(fiber);
        expect(signal.aborted).toBe(true);
        expect(aborted).toBe(1);
      }).pipe(Effect.timeout("3 seconds")),
    );
  });
});

const acme: FakeSlackWorkspace = {
  teamId: "T1",
  teamName: "Acme",
  appId: "A1",
  botId: "B1",
  botUserId: "UBOT",
  botToken: "xoxb-acme",
  appToken: "xapp-acme",
};

describe("the fake Slack", () => {
  it("knows its tokens apart, as Slack does", async () => {
    const slack = makeFakeSlack([acme]);
    expect(await run(slack.service.authTest("xoxb-acme"))).toMatchObject({
      _tag: "Success",
      success: { teamId: "T1", botId: "B1" },
    });
    expect(await run(slack.service.authTest("xapp-acme"))).toMatchObject({
      failure: { code: "not_allowed_token_type" },
    });
    expect(await run(slack.service.appsConnectionsOpen("xoxb-acme"))).toMatchObject({
      failure: { code: "not_allowed_token_type" },
    });
    expect(await run(slack.service.authTest("xoxb-other"))).toMatchObject({
      failure: { code: "invalid_auth" },
    });
  });

  it("records writes and the reactions left on a message", async () => {
    const slack = makeFakeSlack([acme]);
    const reaction = { channel: "C1", timestamp: "1.3" };
    await run(
      Effect.gen(function* () {
        yield* slack.service.postMessage("xoxb-acme", {
          channel: "C1",
          threadTs: "1.1",
          text: "hi",
        });
        yield* slack.service.reactionsAdd("xoxb-acme", {
          ...reaction,
          name: "hourglass_flowing_sand",
        });
        yield* slack.service.reactionsAdd("xoxb-acme", { ...reaction, name: "white_check_mark" });
        yield* slack.service.reactionsRemove("xoxb-acme", {
          ...reaction,
          name: "hourglass_flowing_sand",
        });
      }),
    );
    expect(slack.calls.map((call) => call.kind)).toEqual([
      "postMessage",
      "reactionsAdd",
      "reactionsAdd",
      "reactionsRemove",
    ]);
    expect([...(slack.reactions.get("C1:1.3") ?? [])]).toEqual(["white_check_mark"]);
  });

  it("keeps a thread's newest messages up to the mention, as Slack's pages do", async () => {
    const slack = makeFakeSlack([
      { ...acme, threads: { "C1:1.1": ["1.1", "1.2", "1.3", "1.4", "1.5"].map(threadMessage) } },
    ]);
    const result = await run(
      slack.service.conversationsReplies("xoxb-acme", {
        channel: "C1",
        ts: "1.1",
        latest: "1.4",
        max: 2,
      }),
    );
    expect(result._tag).toBe("Success");
    if (result._tag !== "Success") return;
    expect(result.success.map((entry) => entry.ts)).toEqual(["1.3", "1.4"]);
  });
});

describe("Slack file upload transport", () => {
  it("reads the granted OAuth scopes header through the SDK", async () => {
    const transport = fakeFetch(
      { "auth.test": [{ ok: true, team_id: "T1", team: "Team", user_id: "UBOT", bot_id: "B1" }] },
      { "x-oauth-scopes": "chat:write,files:read,files:write" },
    );
    const api = makeSlackApi({ fetch: transport.fetch });
    expect(await Effect.runPromise(api.authTest("bot"))).toMatchObject({
      grantedScopes: ["chat:write", "files:read", "files:write"],
    });
  });

  it("reads the block identity used to reconcile a plain reply", async () => {
    const transport = fakeFetch({
      "conversations.replies": [
        {
          ok: true,
          messages: [
            {
              ts: "2.0",
              user: "UBOT",
              bot_id: "B1",
              text: "not captured",
              blocks: [{ type: "section", block_id: "receipt-1" }],
            },
          ],
        },
      ],
    });
    const api = makeSlackApi({ fetch: transport.fetch });
    expect(
      await Effect.runPromise(api.conversationsReplies("bot", { channel: "C1", ts: "1.0" })),
    ).toMatchObject([{ ts: "2.0", blockIds: ["receipt-1"], isBot: true }]);
  });

  it("gets a ticket, completes one file with its comment, and reads only shares in the requested channel", async () => {
    const transport = fakeFetch({
      "files.getUploadURLExternal": [
        { ok: true, upload_url: "https://files.slack.com/upload/ticket", file_id: "F1" },
      ],
      "files.completeUploadExternal": [{ ok: true, files: [{ id: "F1" }] }],
      "files.info": [
        {
          ok: true,
          file: {
            id: "F1",
            shares: {
              public: { C1: [{ ts: "2.0", thread_ts: "1.0" }], C2: [{ ts: "3.0" }] },
              private: { C1: [{ ts: "4.0", thread_ts: "1.0" }] },
            },
          },
        },
      ],
    });
    const api = makeSlackApi({ fetch: transport.fetch });
    expect(
      await Effect.runPromise(
        api.filesGetUploadUrl("bot", { filename: "proof.png", length: 4, altText: "before" }),
      ),
    ).toEqual({ uploadUrl: "https://files.slack.com/upload/ticket", fileId: "F1" });
    await Effect.runPromise(
      api.filesCompleteUpload("bot", {
        files: [{ id: "F1", title: "Board" }],
        channelId: "C1",
        threadTs: "1.0",
        initialComment: "before\ncaption",
      }),
    );
    expect(transport.sent[0]?.body.get("length")).toBe("4");
    expect(transport.sent[0]?.body.get("alt_txt")).toBe("before");
    expect(transport.sent[1]?.body.get("files")).toBe(
      JSON.stringify([{ id: "F1", title: "Board" }]),
    );
    expect(transport.sent[1]?.body.get("thread_ts")).toBe("1.0");
    expect(transport.sent[1]?.body.get("channel_id")).toBe("C1");
    expect(transport.sent[1]?.body.get("initial_comment")).toBe("before\ncaption");
    expect(await Effect.runPromise(api.filesInfo("bot", "F1", "C1"))).toEqual([
      { ts: "2.0", threadTs: "1.0" },
      { ts: "4.0", threadTs: "1.0" },
    ]);
  });

  it("completes multiple files in one thread message and omits image alt text from a video ticket", async () => {
    const transport = fakeFetch({
      "files.getUploadURLExternal": [
        { ok: true, upload_url: "https://files.slack.com/upload/ticket", file_id: "F2" },
      ],
      "files.completeUploadExternal": [{ ok: true, files: [{ id: "F1" }, { id: "F2" }] }],
    });
    const api = makeSlackApi({ fetch: transport.fetch });
    await Effect.runPromise(
      api.filesGetUploadUrl("bot", { filename: "proof.mp4", length: 1_072_344 }),
    );
    const files = [
      { id: "F1", title: "Board" },
      { id: "F2", title: "Interaction" },
    ];
    await Effect.runPromise(
      api.filesCompleteUpload("bot", {
        files,
        channelId: "D1",
        threadTs: "1.0",
        initialComment: "The app with the change.",
      }),
    );
    expect(transport.sent[0]?.body.has("alt_txt")).toBe(false);
    expect(transport.sent[1]?.body.get("files")).toBe(JSON.stringify(files));
    expect(transport.sent[1]?.body.get("channel_id")).toBe("D1");
    expect(transport.sent[1]?.body.get("thread_ts")).toBe("1.0");
    expect(transport.sent).toHaveLength(2);
  });

  it("keeps a DM video's absent shares distinct from a thread share and logs only allowlisted metadata", async () => {
    const file = {
      id: "FV",
      mimetype: "video/mp4",
      filetype: "mp4",
      mode: "hosted",
      size: 1_072_344,
      is_external: false,
      media_display_type: "video",
      duration_ms: 27_726,
      mp4: "https://files.slack.com/private-secret",
      hls: "https://files.slack.com/private-hls",
      ims: ["D1"],
      has_more_shares: false,
      skipped_shares: false,
      title: "Private app title",
      url_private: "https://files.slack.com/private-original",
    };
    const transport = fakeFetch({
      "files.info": [
        { ok: true, file },
        {
          ok: true,
          file: { ...file, shares: { private: { D1: [{ ts: "2.0", thread_ts: "1.0" }] } } },
        },
      ],
    });
    const logs: Array<Record<string, unknown>> = [];
    const logger = Logger.layer([
      Logger.make((options) => {
        logs.push(options.fiber.getRef(References.CurrentLogAnnotations));
      }),
    ]);
    const api = makeSlackApi({ fetch: transport.fetch });
    expect(
      await Effect.runPromise(
        api.filesInfo("secret-bot-token", "FV", "D1").pipe(Effect.provide(logger)),
      ),
    ).toEqual([]);
    expect(
      await Effect.runPromise(
        api.filesInfo("secret-bot-token", "FV", "D1").pipe(Effect.provide(logger)),
      ),
    ).toEqual([{ ts: "2.0", threadTs: "1.0" }]);
    expect(logs).toEqual([
      expect.objectContaining({
        slackFileId: "FV",
        mimetype: "video/mp4",
        filetype: "mp4",
        mode: "hosted",
        size: 1_072_344,
        isExternal: false,
        mediaDisplayType: "video",
        hasMp4: true,
        hasHls: true,
        durationMs: 27_726,
        sharesPresent: false,
        sharedInIm: true,
        channelShareCount: 0,
      }),
      expect.objectContaining({ sharesPresent: true, channelShareCount: 1 }),
    ]);
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("Private app");
    expect(logged).not.toContain("https://");
  });

  it.each(["bytes", "stream"])(
    "uploads %s with a known length, no token and no redirects",
    async (kind) => {
      const sent: Array<{ readonly init: RequestInit; readonly bytes: Uint8Array }> = [];
      const fetch: typeof globalThis.fetch = async (_url, init) => {
        if (init === undefined) throw new Error("expected upload options");
        const bytes = new Uint8Array(await new Response(init.body).arrayBuffer());
        sent.push({ init, bytes });
        return new Response("OK");
      };
      const body =
        kind === "bytes"
          ? new Uint8Array([1, 2, 3])
          : Readable.from([Buffer.from([1, 2]), Buffer.from([3])]);
      await Effect.runPromise(
        makeSlackApi({ fetch }).filesUpload("https://files.slack.com/upload/ticket", {
          body,
          length: 3,
        }),
      );
      expect(sent[0]?.bytes).toEqual(new Uint8Array([1, 2, 3]));
      expect(sent[0]?.init).toMatchObject({
        method: "POST",
        redirect: "error",
        headers: { "content-length": "3", "content-type": "application/octet-stream" },
      });
      expect(new Headers(sent[0]?.init.headers).has("authorization")).toBe(false);
    },
  );

  it("rejects off-Slack tickets before sending bytes", async () => {
    let requests = 0;
    const fetch: typeof globalThis.fetch = async () => {
      requests += 1;
      return new Response("OK");
    };
    for (const url of [
      "https://slack.com.attacker.test/upload",
      "http://files.slack.com/upload",
      "garbage",
    ]) {
      expect(
        await run(makeSlackApi({ fetch }).filesUpload(url, { body: new Uint8Array(1), length: 1 })),
      ).toMatchObject({ _tag: "Failure", failure: { code: "not_slack_host" } });
    }
    expect(requests).toBe(0);
  });

  it("rejects a mismatched length and closes a failed stream reader", async () => {
    let transfers = 0;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      transfers += 1;
      await new Response(init?.body).arrayBuffer();
      return new Response("OK");
    };
    const api = makeSlackApi({ fetch });
    expect(
      await run(
        api.filesUpload("https://files.slack.com/upload/ticket", {
          body: new Uint8Array(2),
          length: 3,
        }),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "invalid_length" } });
    const stream = Readable.from([Buffer.from([1, 2])]);
    expect(
      await run(
        api.filesUpload("https://files.slack.com/upload/ticket", { body: stream, length: 3 }),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "invalid_length" } });
    expect(stream.destroyed).toBe(true);
    expect(transfers).toBe(1);
  });

  it("reports a failed byte transfer and does not retry completion after a dropped response", async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async (url) => {
      if (String(url).includes("upload/ticket")) return new Response("gone", { status: 410 });
      calls += 1;
      throw new Error("response lost");
    };
    const api = makeSlackApi({ fetch });
    expect(
      await run(
        api.filesUpload("https://files.slack.com/upload/ticket", {
          body: new Uint8Array(1),
          length: 1,
        }),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "http_410" } });
    expect(
      await run(
        api.filesCompleteUpload("bot", {
          files: [{ id: "F1", title: "Board" }],
          channelId: "C1",
          threadTs: "1.0",
          initialComment: "caption",
        }),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "request_failed" } });
    expect(calls).toBe(1);
  });
});
