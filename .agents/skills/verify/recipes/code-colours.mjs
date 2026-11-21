// Code coloured by its language in the conversation and in skills (SLNT-1260), with the review's
// highlighter and colours. Run the CLI batch first, once per stack: it starts one session in the
// worktree `code-colours`.
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/code-colours-sessions.json
//   pnpm verify drive web --recipe code-colours
//
// A local stack runs no agent (tooling/verify/local-stack-limits.json, `real-agent-turn`), so the
// agent's reply is a fixture answer to the session's reads (captures named `fixture-…`): a
// TypeScript block, a shell block, a block in a language the highlighter doesn't know, and one
// with none. Then the reply grows as a streamed one does, and the recipe checks that a line
// already coloured keeps its node (it isn't coloured again) while the new lines take colours. The
// skill is real: made on the stack with a TypeScript block in its SKILL.md and a shell script
// beside it, shown in the skill panel and in the editor's Preview; it is removed at the end.
import { history, item, patchDetail, turn } from "./session-fixtures.lib.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const TITLE = "Add retries to the checkout client";
const LEFT = /^retry-client-[a-z0-9]{4}$/;

const TS = [
  "```ts",
  "export async function withRetry<T>(run: () => Promise<T>, tries = 3): Promise<T> {",
  "  for (let attempt = 1; ; attempt += 1) {",
  "    try {",
  "      return await run();",
  "    } catch (error) {",
  "      // Give up after the last try.",
  "      if (attempt >= tries) throw error;",
  '      await sleep(200 * 2 ** attempt, "backoff");',
  "    }",
  "  }",
  "}",
  "```",
].join("\n");
const SH = [
  "```bash",
  "pnpm --filter @acme/checkout test -- retry.test.ts",
  'git commit -am "Retry checkout calls with backoff"',
  "```",
].join("\n");
const UNKNOWN = ["```no-such-language", "const stays = plain;", "```"].join("\n");
const NONE = ["```", "Tests  12 passed (12)", "```"].join("\n");

const REPLY = [
  "I added `withRetry` to the checkout client and used it for the charge call:",
  TS,
  "Run the tests and commit:",
  SH,
  "A block in a language Mend doesn't colour, and one with none, stay plain:",
  UNKNOWN,
  NONE,
].join("\n\n");

/** The reply as it streams: the TypeScript block cut after `cut` of its lines, still open. */
const partial = (cut) =>
  [
    "I added `withRetry` to the checkout client and used it for the charge call:",
    TS.split("\n")
      .slice(0, cut + 1)
      .join("\n"),
  ].join("\n\n");

const visible = (locator) => locator.filter({ visible: true }).first();

const skillMd = (name) =>
  [
    "---",
    `name: ${name}`,
    "description: Wrap a flaky network call in retries with backoff.",
    "---",
    "",
    "# Retry client",
    "",
    "Wrap the call, never the whole request handler:",
    "",
    "```ts",
    "const charge = await withRetry(() => stripe.charges.create(input), 3);",
    "// Three tries, then the error reaches the caller.",
    "```",
    "",
    "Then run `scripts/check.sh`.",
    "",
  ].join("\n");
const CHECK_SH = '#!/bin/sh\nset -eu\npnpm test -- retry.test.ts\necho "retries ok"\n';

export default async ({ page, web, capture, note }) => {
  const settled = () => page.waitForTimeout(500);
  const setTheme = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  const both = async (name) => {
    for (const theme of ["light", "dark"]) {
      await setTheme(theme);
      await capture(`${name}-${theme}`);
    }
    await setTheme("light");
  };
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
    await page.waitForFunction(() =>
      [...document.querySelectorAll("a[href], button")].some((element) =>
        Object.keys(element).some((key) => key.startsWith("__reactProps")),
      ),
    );
  };
  const go = (to) => page.evaluate((path) => window["__TSR_ROUTER__"].navigate({ to: path }), to);
  const call = (path, input, kind = "query") =>
    page.evaluate(
      async ({ path: route, input: value, kind: verb }) => {
        let target = window["__TSR_ROUTER__"].options.context.trpcClient;
        for (const part of route.split(".")) target = target[part];
        return target[verb](value);
      },
      { path, input, kind },
    );
  const reread = () =>
    page.evaluate(() =>
      window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries({
        queryKey: [["sessions"]],
      }),
    );
  /** The colour of each coloured piece of a code block, by its text, from the page. */
  const coloursIn = (block) =>
    block.evaluate((element) =>
      [...element.querySelectorAll("span[style]")].map((span) => [
        span.textContent,
        span.style.color,
        getComputedStyle(span).color,
      ]),
    );

  await page.setViewportSize(DESKTOP);
  await page.goto(`${web}/no-such-page`);
  await hydrated();
  await page.waitForTimeout(1_500);
  await hydrated();

  // The session the CLI batch started.
  const rows = await page.evaluate(async () => {
    const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
    await queryClient.refetchQueries({ queryKey: [["sessions", "inbox"]] });
    return queryClient.getQueryCache().findAll({ queryKey: [["sessions", "inbox"]] })[0]?.state
      .data;
  });
  const session = (rows ?? [])
    .filter((row) => row.worktreeName === "code-colours" && row.session.status === "running")
    .map((row) => row.session)
    .at(-1);
  if (session === undefined)
    throw new Error("code-colours needs a running session: run code-colours-sessions.json first");
  const me = session.ownerUserId;
  await call("sessions.setLabel", { id: session.id, label: TITLE }, "mutate");
  note(`session ${session.id} in code-colours`);

  // The fixture reply, laid over the session's real reads.
  let reply = { text: REPLY, live: false };
  const start = "2026-11-21T10:00:00.000Z";
  const end = "2026-11-21T10:02:10.000Z";
  const conversation = () => {
    const t = turn(
      session.id,
      me,
      0,
      reply.live ? "running" : "completed",
      "Add retries with backoff to the checkout client's charge call.",
      start,
      reply.live ? null : end,
    );
    return history({
      turns: [t],
      items: [
        item(t.id, "assistant-message", reply.live ? "in-progress" : "completed", start, end, {
          // One reply throughout, as a streamed one is: the same item, its text growing.
          id: "fixture-reply",
          seq: 1,
          text: reply.text,
        }),
      ],
    });
  };
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const inputs = JSON.parse(route.request().postData() ?? url.searchParams.get("input") ?? "{}");
    const mine = paths.map((path, index) => {
      if (inputs[String(index)]?.json?.id !== session.id) return null;
      if (path === "sessions.detail") return "detail";
      if (path.startsWith("sessions.history")) return { result: { data: conversation()[path] } };
      return null;
    });
    if (mine.every((each) => each === null)) return route.fallback();
    const response = await route.fetch();
    const body = await response.json();
    const answers = Array.isArray(body) ? body : [body];
    mine.forEach((answer, index) => {
      if (answer === null) return;
      if (answer === "detail") {
        const data = answers[index]?.result?.data;
        if (data === undefined) return;
        answers[index] = {
          result: {
            data: patchDetail(data, { status: "running", harness: "claude", protocolAgent: true }),
          },
        };
      } else answers[index] = answer;
    });
    await route.fulfill({ response, json: Array.isArray(body) ? answers : answers[0] });
  });

  // The conversation: the TypeScript and shell blocks coloured, the other two plain.
  await go(`/sessions/${session.id}`);
  const blocks = page.locator("pre:has(> code)").filter({ visible: true });
  const tsBlock = blocks.filter({ hasText: "withRetry<T>" }).first();
  const shBlock = blocks.filter({ hasText: "pnpm --filter" }).first();
  const unknownBlock = blocks.filter({ hasText: "const stays = plain;" }).first();
  const noneBlock = blocks.filter({ hasText: "Tests  12 passed" }).first();
  await tsBlock.waitFor({ timeout: 60_000 });
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("pre > code")].filter(
        (code) => code.querySelector("span[style]") !== null,
      ).length >= 2,
    undefined,
    { timeout: 30_000 },
  );
  const ts = await coloursIn(tsBlock);
  const sh = await coloursIn(shBlock);
  const find = (pieces, words) => pieces.find(([text]) => text.includes(words));
  const keyword = find(ts, "export");
  const comment = find(ts, "Give up");
  const string = find(sh, "Retry checkout calls");
  if (!keyword?.[1].includes("--color-syntax-keyword"))
    throw new Error(`"export" isn't a keyword's colour: ${JSON.stringify(keyword)}`);
  if (!comment?.[1].includes("--color-muted-foreground"))
    throw new Error(`the comment isn't muted: ${JSON.stringify(comment)}`);
  if (!string?.[1].includes("--color-syntax-string"))
    throw new Error(`the shell string isn't a string's colour: ${JSON.stringify(string)}`);
  const plainUnknown = (await coloursIn(unknownBlock)).length;
  const plainNone = (await coloursIn(noneBlock)).length;
  if (plainUnknown !== 0 || plainNone !== 0)
    throw new Error(`a block that should stay plain has colours: ${plainUnknown}, ${plainNone}`);
  // Inline code in a sentence stays as it was: no colours.
  const inline = await page
    .locator("p > code")
    .filter({ hasText: "withRetry" })
    .first()
    .evaluate((element) => element.querySelectorAll("span[style]").length);
  if (inline !== 0) throw new Error(`the inline \`withRetry\` has ${inline} coloured pieces`);
  note(
    `conversation-ts: ${ts.length} coloured pieces; "export" ${keyword[2]} (${keyword[1]}), the comment ${comment[2]}`,
  );
  note(`conversation-sh: ${sh.length} coloured pieces; the commit message ${string[2]}`);
  note(
    "conversation-plain: the no-such-language block, the block with no language and the inline `withRetry` have no colours",
  );
  await tsBlock.scrollIntoViewIfNeeded();
  await settled();
  await both("fixture-conversation");
  await setTheme("dark");
  const darkKeyword = await tsBlock.evaluate((element) =>
    [...element.querySelectorAll("span[style]")].find((span) => span.textContent.includes("export"))
      ? getComputedStyle(
          [...element.querySelectorAll("span[style]")].find((span) =>
            span.textContent.includes("export"),
          ),
        ).color
      : "",
  );
  await setTheme("light");
  if (darkKeyword === keyword[2])
    throw new Error(`the keyword is ${darkKeyword} in light and dark`);
  note(`conversation-dark: "export" is ${keyword[2]} in light, ${darkKeyword} in dark`);
  await page.setViewportSize(PHONE);
  await settled();
  await tsBlock.scrollIntoViewIfNeeded();
  await both("fixture-conversation-phone");
  await page.setViewportSize(DESKTOP);

  // Streaming: the reply grows a line at a time. A line already coloured keeps its node; the
  // lines after it take colours as they come.
  reply = { text: partial(3), live: true };
  await reread();
  const growing = blocks.filter({ hasText: "withRetry<T>" }).first();
  await page.waitForFunction(
    () => !document.body.innerText.includes("Run the tests and commit"),
    undefined,
    { timeout: 30_000 },
  );
  await growing.waitFor();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("pre > code span[style]")].some((span) =>
        span.textContent.includes("export"),
      ),
    undefined,
    { timeout: 30_000 },
  );
  // Mark the first line's coloured pieces, then grow the reply three times.
  const marked = await growing.evaluate((element) => {
    const spans = [...element.querySelectorAll("span[style]")].filter((span) =>
      ["export", "async", "function"].includes(span.textContent.trim()),
    );
    for (const span of spans) span.dataset.firstLine = "";
    return spans.length;
  });
  for (const cut of [5, 8, 11]) {
    reply = { text: partial(cut), live: true };
    await reread();
    await page.waitForTimeout(1_500);
  }
  await page.waitForFunction(
    () => document.body.innerText.includes("attempt >= tries"),
    undefined,
    { timeout: 30_000 },
  );
  const kept = await growing.evaluate(
    (element) => element.querySelectorAll("span[data-first-line]").length,
  );
  const later = find(await coloursIn(growing), "Give up");
  if (marked === 0 || kept !== marked)
    throw new Error(`the first line's coloured pieces were drawn again: ${kept} of ${marked} kept`);
  if (!later?.[1].includes("--color-muted-foreground"))
    throw new Error(`a line that streamed in isn't coloured: ${JSON.stringify(later)}`);
  note(
    `streaming: grew the reply three times; all ${marked} of the first line's coloured pieces kept their nodes, and the comment that streamed in is ${later[2]}`,
  );
  await both("fixture-streaming");
  reply = { text: REPLY, live: false };
  await page.unroute("**/trpc/**");

  // A real skill: a TypeScript block in its SKILL.md and a shell script beside it.
  for (const skill of (await call("skills.list")).filter((entry) => LEFT.test(entry.name)))
    await call("skills.remove", { skillId: skill.id }, "mutate").catch(() => undefined);
  const name = `retry-client-${Math.random().toString(36).slice(2, 6)}`;
  const made = await call(
    "skills.create",
    {
      scope: "user",
      projectId: null,
      name,
      description: "Wrap a flaky network call in retries with backoff.",
      files: [
        { path: "SKILL.md", contents: skillMd(name) },
        { path: "scripts/check.sh", contents: CHECK_SH },
      ],
    },
    "mutate",
  );
  try {
    await go(`/skills/${made.skill.id}`);
    const file = visible(page.getByLabel("SKILL.md", { exact: true }));
    await file.waitFor({ timeout: 30_000 });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("pre[aria-label='SKILL.md'] span[style]")].some((span) =>
          span.textContent.includes("await"),
        ),
      undefined,
      { timeout: 30_000 },
    );
    const inSkill = await coloursIn(file);
    const awaitWord = find(inSkill, "await");
    const heading = await file.evaluate((element) =>
      [...element.querySelectorAll("span[style]")].some((span) =>
        span.textContent.includes("# Retry client"),
      ),
    );
    if (!awaitWord?.[1].includes("--color-syntax-keyword"))
      throw new Error(
        `"await" in the skill isn't a keyword's colour: ${JSON.stringify(awaitWord)}`,
      );
    if (heading) throw new Error("the skill's Markdown outside the fence is coloured");
    note(
      `skill-panel: SKILL.md's ts block has ${inSkill.length} coloured pieces ("await" ${awaitWord[2]}); its Markdown text stays plain`,
    );
    await both("skill-panel");
    await page.setViewportSize(PHONE);
    await settled();
    await both("skill-panel-phone");
    await page.setViewportSize(DESKTOP);

    await visible(page.getByRole("link", { name: "scripts/check.sh" })).click();
    const script = visible(page.getByLabel("scripts/check.sh", { exact: true }));
    await script.waitFor({ timeout: 30_000 });
    await page.waitForFunction(
      () => document.querySelector("pre[aria-label='scripts/check.sh'] span[style]") !== null,
      undefined,
      { timeout: 30_000 },
    );
    const inScript = await coloursIn(script);
    const echoed = find(inScript, "retries ok");
    if (!echoed?.[1].includes("--color-syntax-string"))
      throw new Error(`the script's string isn't a string's colour: ${JSON.stringify(echoed)}`);
    note(`skill-script: scripts/check.sh is coloured as shell (${inScript.length} pieces)`);
    await both("skill-script");

    // The editor's Preview of SKILL.md.
    await go(`/skills/${made.skill.id}?edit=1`);
    await visible(page.getByRole("button", { name: "Preview", exact: true })).click();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("pre span[style]")].some((span) =>
          span.textContent.includes("await"),
        ),
      undefined,
      { timeout: 30_000 },
    );
    note("skill-preview: the editor's Preview colours the ts block");
    await both("skill-preview");
  } finally {
    await call("skills.remove", { skillId: made.skill.id }, "mutate").catch(() => undefined);
  }
};
