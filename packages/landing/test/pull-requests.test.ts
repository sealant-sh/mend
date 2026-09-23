import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { DESCRIPTION_END, DESCRIPTION_START } from "../src/description.ts";
import {
  type ExecOutput,
  type PublishInput,
  PullRequests,
  PullRequestsLive,
  PullRequestStepError,
  PullRequestWorkspaces,
} from "../src/pull-requests.ts";

const repository = { owner: "acme", name: "api", slug: "acme/api" };

const SECTION = `${DESCRIPTION_START}\n## Summary\n\nFixes the login loop.\n${DESCRIPTION_END}`;

const publishInput = (overrides: Partial<PublishInput> = {}): PublishInput => ({
  target: { ownerUserId: "ada", sessionId: null },
  repository,
  head: "mend/fix-login",
  base: "main",
  title: "login loop",
  titleGiven: false,
  section: SECTION,
  body: null,
  previous: null,
  ...overrides,
});

interface GhPullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly title: string;
  readonly body: string;
}

const pr = (number: number, overrides: Partial<GhPullRequest> = {}): GhPullRequest => ({
  number,
  url: `https://github.com/acme/api/pull/${number}`,
  state: "OPEN",
  title: "login loop",
  body: "",
  ...overrides,
});

/** The value of `--name=value` in a gh argv. */
const flag = (argv: ReadonlyArray<string>, name: string) =>
  argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

const ok = (stdout = ""): ExecOutput => ({ exitCode: 0, stdout, stderr: "" });

/**
 * A GitHub the fake workspace's `gh` talks to: the pull requests it holds, and every command the
 * step ran, in order. `gh pr create` fails with `createFails` when set.
 */
const fakeGitHub = (options: {
  readonly pullRequests?: ReadonlyArray<GhPullRequest>;
  readonly createFails?: string;
  readonly kind?: "session" | "short-lived";
}) => {
  const pulls = new Map((options.pullRequests ?? []).map((pull) => [pull.number, pull]));
  const commands: Array<ReadonlyArray<string>> = [];
  const files = new Map<string, string>();
  const exec = (argv: ReadonlyArray<string>): ExecOutput => {
    commands.push(argv);
    if (argv[0] === "sh") {
      const [, , , , file = "", ...chunks] = argv;
      files.set(file, Buffer.from(chunks.join(""), "base64").toString("utf8"));
      return ok();
    }
    if (argv[0] === "rm") {
      files.delete(argv.at(-1) ?? "");
      return ok();
    }
    const [verb, ...rest] = argv.slice(6);
    switch (verb) {
      case "view": {
        const ref = rest[0] ?? "";
        const number = Number(ref.split("/").at(-1));
        const found = pulls.get(number);
        return found === undefined
          ? { exitCode: 1, stdout: "", stderr: `no pull requests found for ${ref}` }
          : ok(JSON.stringify(found));
      }
      case "list": {
        const head = flag(argv, "head");
        const open = [...pulls.values()].filter((pull) => pull.state === "OPEN");
        return ok(JSON.stringify(head === "mend/fix-login" ? open.slice(0, 1) : []));
      }
      case "create": {
        if (options.createFails !== undefined) {
          return { exitCode: 1, stdout: "", stderr: options.createFails };
        }
        const number = 500 + pulls.size;
        pulls.set(
          number,
          pr(number, {
            title: flag(argv, "title") ?? "",
            body: files.get(flag(argv, "body-file") ?? "") ?? "",
          }),
        );
        return ok(`Creating pull request\n\nhttps://github.com/acme/api/pull/${number}\n`);
      }
      case "edit": {
        const number = Number(rest[0]);
        const current = pulls.get(number);
        if (current === undefined) return { exitCode: 1, stdout: "", stderr: "not found" };
        const title = flag(argv, "title");
        pulls.set(number, {
          ...current,
          body: files.get(flag(argv, "body-file") ?? "") ?? current.body,
          ...(title === null ? {} : { title }),
        });
        return ok(current.url);
      }
      default:
        return { exitCode: 2, stdout: "", stderr: `unknown gh call ${argv.join(" ")}` };
    }
  };
  const layer = PullRequestsLive.pipe(
    Layer.provide(
      Layer.succeed(PullRequestWorkspaces, {
        within: (_target, use) =>
          use({
            kind: options.kind ?? "short-lived",
            exec: (argv) => Effect.sync(() => exec(argv)),
          }),
      }),
    ),
  );
  const verbs = () =>
    commands.map((argv) => (argv[0] === "env" ? `gh ${argv[5]} ${argv[6]}` : (argv[0] ?? "")));
  return { layer, pulls, commands, files, verbs };
};

describe("PullRequests.publish", () => {
  it.effect("opens a pull request with the body from a file, then reads it back", () => {
    const github = fakeGitHub({});
    return Effect.gen(function* () {
      const published = yield* (yield* PullRequests).publish(publishInput());
      expect(published.action).toBe("opened");
      expect(published.pullRequest).toMatchObject({
        number: 500,
        url: "https://github.com/acme/api/pull/500",
        state: "open",
      });
      expect(github.verbs()).toEqual(["gh pr list", "sh", "gh pr create", "gh pr view", "rm"]);
      const created = github.pulls.get(500);
      expect(created?.title).toBe("login loop");
      expect(created?.body).toBe(SECTION);
      // The body file is gone from the workspace afterwards.
      expect(github.files.size).toBe(0);
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("updates the recorded pull request, replacing only Mend's section", () => {
    const earlier = `${DESCRIPTION_START}\nNo summary.\n${DESCRIPTION_END}`;
    const github = fakeGitHub({
      pullRequests: [
        pr(412, {
          title: "Fix login (edited on GitHub)",
          body: `Closes #12\n\n${earlier}\n\nDeploy after Friday.`,
        }),
      ],
    });
    return Effect.gen(function* () {
      const published = yield* (yield* PullRequests).publish(publishInput({ previous: 412 }));
      expect(published.action).toBe("updated");
      expect(published.pullRequest.number).toBe(412);
      expect(github.verbs()).toEqual(["gh pr view", "sh", "gh pr edit", "rm"]);
      const updated = github.pulls.get(412);
      expect(updated?.body).toBe(`Closes #12\n\n${SECTION}\n\nDeploy after Friday.`);
      // No title was given for this landing, so the edited one stays.
      expect(updated?.title).toBe("Fix login (edited on GitHub)");
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("writes the owner's own description above the section in place of the rest", () => {
    const earlier = `${DESCRIPTION_START}\nNo summary.\n${DESCRIPTION_END}`;
    const github = fakeGitHub({
      pullRequests: [pr(412, { body: `Closes #12\n\n${earlier}\n\nDeploy after Friday.` })],
    });
    return Effect.gen(function* () {
      yield* (yield* PullRequests).publish(
        publishInput({ previous: 412, body: "  Fixes the login loop for SSO users.\n" }),
      );
      expect(github.pulls.get(412)?.body).toBe(`Fixes the login loop for SSO users.\n\n${SECTION}`);
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("sends the title on update when the owner gave one", () => {
    const github = fakeGitHub({ pullRequests: [pr(412, { title: "Old" })] });
    return Effect.gen(function* () {
      yield* (yield* PullRequests).publish(
        publishInput({ previous: 412, title: "Fix login", titleGiven: true }),
      );
      expect(github.pulls.get(412)?.title).toBe("Fix login");
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("opens a new pull request when the recorded one was merged", () => {
    const github = fakeGitHub({ pullRequests: [pr(412, { state: "MERGED" })] });
    return Effect.gen(function* () {
      const published = yield* (yield* PullRequests).publish(publishInput({ previous: 412 }));
      expect(published.action).toBe("opened");
      expect(published.pullRequest.number).not.toBe(412);
      expect(github.verbs()).toEqual([
        "gh pr view",
        "gh pr list",
        "sh",
        "gh pr create",
        "gh pr view",
        "rm",
      ]);
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("adopts an open pull request from the branch when none was recorded", () => {
    const github = fakeGitHub({
      pullRequests: [pr(77, { title: "Agent's PR", body: "Opened by the agent." })],
    });
    return Effect.gen(function* () {
      const published = yield* (yield* PullRequests).publish(publishInput());
      expect(published.action).toBe("updated");
      expect(published.pullRequest.number).toBe(77);
      expect(github.pulls.get(77)?.body).toBe(`Opened by the agent.\n\n${SECTION}`);
      expect(github.pulls.get(77)?.title).toBe("Agent's PR");
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("fails in gh's words, and still removes the body file", () => {
    const github = fakeGitHub({
      createFails:
        "pull request create failed: GraphQL: No commits between main and mend/fix-login (createPullRequest)",
    });
    return Effect.gen(function* () {
      const error = yield* (yield* PullRequests).publish(publishInput()).pipe(Effect.flip);
      expect(error).toBeInstanceOf(PullRequestStepError);
      expect(error.message).toBe(
        "gh pr create · pull request create failed: GraphQL: No commits between main and mend/fix-login (createPullRequest)",
      );
      expect(github.verbs().at(-1)).toBe("rm");
      expect(github.files.size).toBe(0);
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("says where it ran", () => {
    const github = fakeGitHub({ kind: "session" });
    return Effect.gen(function* () {
      const published = yield* (yield* PullRequests).publish(publishInput());
      expect(published.workspace).toBe("session");
    }).pipe(Effect.provide(github.layer));
  });
});

describe("PullRequests.observe", () => {
  it.effect("reads the state gh reports now", () => {
    const github = fakeGitHub({ pullRequests: [pr(412, { state: "MERGED" })] });
    return Effect.gen(function* () {
      const observed = yield* (yield* PullRequests).observe({
        target: { ownerUserId: "ada", sessionId: null },
        repository,
        number: 412,
      });
      expect(observed).toMatchObject({ number: 412, state: "merged" });
      expect(observed.observedAt).toBeInstanceOf(Date);
    }).pipe(Effect.provide(github.layer));
  });
});
