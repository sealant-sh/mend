import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makeFakeSlack, makeSlackApi, type FakeSlackWorkspace } from "./client.ts";

/** One request as the SDK sent it: the method, the bearer and the form body. */
interface Sent {
  readonly url: string;
  readonly authorization: string | null;
  readonly body: URLSearchParams;
}

/** A Slack that answers each method from a table, and records what it was sent. */
const fakeFetch = (answers: Record<string, ReadonlyArray<unknown>>) => {
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
      headers: { "content-type": "application/json" },
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

  it("reads the app id off an app-level token's socket URL", async () => {
    const slack = fakeFetch({
      "apps.connections.open": [
        { ok: true, url: "wss://wss-primary.slack.com/link/?ticket=abc&app_id=A123" },
      ],
    });
    const result = await run(makeSlackApi({ fetch: slack.fetch }).appsConnectionsOpen("xapp-1"));
    expect(result).toMatchObject({ _tag: "Success", success: { appId: "A123" } });
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

  it("names the user by display name, then real name, then handle", async () => {
    const slack = fakeFetch({
      "users.info": [
        {
          ok: true,
          user: {
            id: "U1",
            team_id: "T1",
            name: "ada",
            real_name: "Ada Lovelace",
            profile: { display_name: "", real_name: "Ada Lovelace" },
          },
        },
      ],
    });
    const result = await run(makeSlackApi({ fetch: slack.fetch }).usersInfo("xoxb-1", "U1"));
    expect(result).toMatchObject({
      _tag: "Success",
      success: { displayName: "Ada Lovelace", name: "ada", isBot: false, deleted: false },
    });
  });

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
