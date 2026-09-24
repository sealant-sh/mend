import { describe, expect, it } from "vitest";

import { slackToPlain } from "./markup.ts";
import { DEFAULT_MENTION_VOCABULARY, parseMention, type MentionVocabulary } from "./mention.ts";

const BOT = "UMEND";

const vocabulary: MentionVocabulary = {
  ...DEFAULT_MENTION_VOCABULARY,
  projects: [
    { name: "billing-api", originUrl: "git@github.com:acme/billing-api.git" },
    { name: "web", originUrl: "https://github.com/acme/web" },
    { name: "billing api docs", originUrl: null },
  ],
};

const parse = (text: string) => parseMention(text, BOT, vocabulary);

describe("reading a mention's Slack markup", () => {
  it("turns links, mentions, channels and entities into plain text", () => {
    expect(
      slackToPlain(
        "see <https://github.com/acme/api/pull/4|the PR> &amp; ask <@U1|ana> in <#C1|eng> &lt;now&gt; <!here> <mailto:a@b.co|a@b.co>",
      ),
    ).toBe("see https://github.com/acme/api/pull/4 & ask @ana in #eng <now> @here a@b.co");
    expect(slackToPlain("<@U2> hi", (id) => (id === "U2" ? "Bo" : undefined))).toBe("@Bo hi");
    expect(slackToPlain("&amp;lt;")).toBe("&lt;");
  });
});

describe("parsing a mention", () => {
  it("strips the bot mention and keeps the request", () => {
    const parsed = parse("<@UMEND> fix the flaky login test");
    expect(parsed).toEqual({
      command: null,
      prompt: "fix the flaky login test",
      options: {
        project: null,
        branch: null,
        harness: null,
        model: null,
        effort: null,
        autopr: null,
      },
      rejected: [],
    });
    expect(parse("hey <@UMEND|mend> can you look").prompt).toBe("hey can you look");
  });

  it("reads inline options anywhere, with quoted values, and a later duplicate wins", () => {
    const parsed = parse(
      '<@UMEND> project=billing-api branch=release/2.3 harness=Codex effort=HIGH make the retry limit configurable model=gpt-5.5 project="billing api docs"',
    );
    expect(parsed.prompt).toBe("make the retry limit configurable");
    expect(parsed.options).toEqual({
      project: { value: "billing api docs", form: "inline" },
      branch: { value: "release/2.3", form: "inline" },
      harness: { value: "codex", form: "inline" },
      model: { value: "gpt-5.5", form: "inline" },
      effort: { value: "high", form: "inline" },
      autopr: null,
    });
  });

  it("takes smart quotes, single quotes and trailing punctuation off inline values", () => {
    const parsed = parse("<@UMEND> project=“billing api docs”, branch=main. add a --dry-run flag");
    expect(parsed.options.project).toEqual({ value: "billing api docs", form: "inline" });
    expect(parsed.options.branch).toEqual({ value: "main", form: "inline" });
    expect(parsed.prompt).toBe("add a --dry-run flag");
    expect(parse("<@UMEND> model='opus' go").options.model).toEqual({
      value: "opus",
      form: "inline",
    });
  });

  it("rejects an inline effort or harness it cannot use, and an empty value", () => {
    const parsed = parse('<@UMEND> effort=extreme harness=vim branch="" do it');
    expect(parsed.options.effort).toBeNull();
    expect(parsed.options.harness).toBeNull();
    expect(parsed.options.branch).toBeNull();
    expect(parsed.rejected).toEqual([
      { option: "effort", value: "extreme", reason: "not one of low, medium, high, xhigh, max" },
      { option: "harness", value: "vim", reason: "not one of claude, codex" },
      { option: "branch", value: "", reason: "no value" },
    ]);
    expect(parsed.prompt).toBe("do it");
  });

  it("reads a command as the first word only", () => {
    expect(parse("<@UMEND> help").command).toBe("help");
    expect(parse("<@UMEND> Settings").command).toBe("settings");
    expect(parse("<@UMEND> list my sessions")).toMatchObject({
      command: "list",
      prompt: "my sessions",
    });
    expect(parse("<@UMEND> new: in web, add dark mode")).toMatchObject({
      command: "new",
      prompt: "add dark mode",
      options: { project: { value: "web", form: "natural" } },
    });
    expect(parse("<@UMEND> please help with the list view").command).toBeNull();
  });

  it("reads natural options at the start of the request", () => {
    const parsed = parse("<@UMEND> in billing-api with codex, make the retry limit configurable");
    expect(parsed.prompt).toBe("make the retry limit configurable");
    expect(parsed.options.project).toEqual({ value: "billing-api", form: "natural" });
    expect(parsed.options.harness).toEqual({ value: "codex", form: "natural" });
  });

  it("reads natural options at the end of the request", () => {
    const parsed = parse("<@UMEND> fix the flaky login test in web on main with high effort.");
    expect(parsed.prompt).toBe("fix the flaky login test");
    expect(parsed.options).toEqual({
      project: { value: "web", form: "natural" },
      branch: { value: "main", form: "natural" },
      harness: null,
      model: null,
      effort: { value: "high", form: "natural" },
      autopr: null,
    });
  });

  it("joins natural phrases with and", () => {
    const parsed = parse("<@UMEND> add a changelog entry, in web and with claude");
    expect(parsed.prompt).toBe("add a changelog entry");
    expect(parsed.options.harness).toEqual({ value: "claude", form: "natural" });
    expect(parse("<@UMEND> bread and with codex").prompt).toBe("bread and");
  });

  it("names a project by repository, by URL or in quotes", () => {
    expect(parse("<@UMEND> in acme/billing-api, bump deps").options.project).toEqual({
      value: "acme/billing-api",
      form: "natural",
    });
    expect(
      parse("<@UMEND> in <https://github.com/acme/other|github.com/acme/other> bump deps").options
        .project,
    ).toEqual({ value: "https://github.com/acme/other", form: "natural" });
    expect(parse('<@UMEND> in "billing api docs" fix typos')).toMatchObject({
      prompt: "fix typos",
      options: { project: { value: "billing api docs", form: "natural" } },
    });
  });

  it("leaves words it does not recognise in the prompt", () => {
    for (const text of [
      "in short, the login test is flaky",
      "on Monday the deploy broke",
      "from scratch, write a parser",
      "with care, rename the module",
      "fix the bug in src/parser",
      "rewrite the parser from src/lib",
    ]) {
      const parsed = parse(`<@UMEND> ${text}`);
      expect(parsed.prompt).toBe(text);
      expect(parsed.options).toEqual({
        project: null,
        branch: null,
        harness: null,
        model: null,
        effort: null,
        autopr: null,
      });
    }
  });

  it("reads branches it can tell apart from prose", () => {
    expect(parse("<@UMEND> from release/2.3, backport the fix").options.branch).toEqual({
      value: "release/2.3",
      form: "natural",
    });
    expect(parse("<@UMEND> on `staging` check the flag").options.branch).toEqual({
      value: "staging",
      form: "natural",
    });
  });

  it("reads a model and the harness it belongs to, without overriding a named harness", () => {
    expect(parse("<@UMEND> with opus, tidy the README").options).toMatchObject({
      model: { value: "opus", form: "natural" },
      harness: { value: "claude", form: "natural" },
    });
    expect(parse("<@UMEND> with gpt-5.5 and with claude, tidy").options).toMatchObject({
      model: { value: "gpt-5.5", form: "natural" },
      harness: { value: "claude", form: "natural" },
    });
  });

  it("lets an inline option beat a natural one", () => {
    const parsed = parse(
      "<@UMEND> in web with codex, harness=claude project=billing-api add tests",
    );
    expect(parsed.options.project).toEqual({ value: "billing-api", form: "inline" });
    expect(parsed.options.harness).toEqual({ value: "claude", form: "inline" });
    expect(parsed.prompt).toBe("add tests");
  });

  it("reads autopr=true and autopr=false inline only, and rejects anything else", () => {
    expect(parse("<@UMEND> autopr=false why does the login test flake?")).toMatchObject({
      prompt: "why does the login test flake?",
      options: { autopr: false },
      rejected: [],
    });
    expect(parse("<@UMEND> fix the flaky login test AUTOPR=True").options.autopr).toBe(true);
    expect(parse("<@UMEND> autopr=true autopr=false tidy up").options.autopr).toBe(false);
    const rejected = parse("<@UMEND> autopr=maybe tidy up");
    expect(rejected.options.autopr).toBeNull();
    expect(rejected.rejected).toEqual([
      { option: "autopr", value: "maybe", reason: "not one of true, false" },
    ]);
    expect(parse("<@UMEND> open an autopr for it").options.autopr).toBeNull();
  });

  it("keeps the prompt's lines and code", () => {
    const parsed = parse("<@UMEND> in web, run this:\n```\n  pnpm test\n```");
    expect(parsed.prompt).toBe("run this:\n```\n  pnpm test\n```");
  });

  it("reads a natural project only against the projects it is given", () => {
    const bare = parseMention("<@UMEND> in web, add dark mode", BOT);
    expect(bare.options.project).toBeNull();
    expect(bare.prompt).toBe("in web, add dark mode");
  });
});

describe("the edges of the prompt", () => {
  it("drops a dash between options and the request, and keeps a list's dash", () => {
    expect(parse("<@UMEND> in web — fix the test").prompt).toBe("fix the test");
    expect(parse("<@UMEND> fix the test - in web").prompt).toBe("fix the test");
    expect(parse("<@UMEND>\n- fix a\n- fix b").prompt).toBe("- fix a\n- fix b");
    expect(parse("<@UMEND> new\n- fix a").prompt).toBe("- fix a");
    expect(parse("<@UMEND> run this: project=web").prompt).toBe("run this:");
    expect(parse("<@UMEND> fix it, project=web").prompt).toBe("fix it");
  });
});
