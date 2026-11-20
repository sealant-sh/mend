// What the conversation shows of checkpoints (SLNT-1200): at most one line per turn, after its
// reply, only when a file changed during the turn, and none above the first message. Hovering the
// line, or pressing or tapping it, says what Mend saved and offers Show changes and Open in Record.
// Run the CLI batch first, once per stack: three real `mend run` sessions in the worktree
// `ckpt-turns`, one after another. The first writes two files, the second only reads them, the
// third changes one. Each takes its real checkpoints: when it starts and when it ends.
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-checkpoints-sessions.json
//   pnpm verify drive new-web --recipe new-web-checkpoints
//
// A local stack runs no agent (tooling/verify/local-stack-limits.json, `real-agent-turn`), so the
// conversation is a fixture: one Claude Code session with three turns, each timed inside one of the
// three runs, and the worktree's real checkpoints read as that session's. Which files changed
// during each turn is read from the stack, between those real checkpoints; Show changes opens the
// real change over them. Every capture taken over the fixture is named `fixture-…`.
import { history, item, patchDetail, turn } from "./new-web-session-fixtures.lib.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const PROMPTS = [
  "Find why checkout charges twice, and write down the fix.",
  "Read the notes back to me. Don't change anything.",
  "Add partial refunds to the notes.",
];
const REPLIES = [
  "The retry sends the charge again without a key. I wrote NOTES.md and PLAN.md.",
  "NOTES.md says to retry with the order id as the key. I changed nothing.",
  "I added a line on partial refunds to NOTES.md.",
];

/** The one of a locator's matches a person sees: the desktop and phone layouts are both in the page. */
const visible = (locator) => locator.filter({ visible: true }).first();

export default async ({ page, web, capture, note }) => {
  const settled = () => page.waitForTimeout(500);
  const setTheme = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  const router = () => page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
  const hydrated = async () => {
    await router();
    await page.waitForFunction(() =>
      [...document.querySelectorAll("a[href]")].some((link) =>
        Object.keys(link).some((key) => key.startsWith("__reactProps")),
      ),
    );
  };
  const open = async (path) => {
    await page.goto(`${web}${path}`);
    await hydrated();
  };
  const go = (path) => page.evaluate((to) => window["__TSR_ROUTER__"].navigate({ href: to }), path);

  await page.setViewportSize(DESKTOP);
  await open("/no-such-page");
  await page.evaluate(() => localStorage.setItem("mend-theme", "light"));

  // The batch's three sessions, and the worktree's real chain of checkpoints.
  const found = await page.evaluate(async () => {
    const { queryClient, trpcClient } = window["__TSR_ROUTER__"].options.context;
    await queryClient.refetchQueries({ queryKey: [["sessions", "inbox"]] });
    const rows =
      queryClient.getQueryCache().findAll({ queryKey: [["sessions", "inbox"]] })[0]?.state.data ??
      [];
    const ids = rows
      .filter((row) => row.worktreeName === "ckpt-turns")
      .map((row) => row.session.id);
    if (ids.length === 0) return { ids, chain: [], me: null };
    const detail = await trpcClient.sessions.detail.query({ id: ids[0] });
    const me = queryClient.getQueryCache().findAll({ queryKey: [["organization", "current"]] })[0]
      ?.state.data?.userId;
    return {
      ids,
      me,
      chain: detail.checkpoints.map((checkpoint) => ({
        id: checkpoint.id,
        ordinal: checkpoint.ordinal,
        sessionId: checkpoint.sessionId,
        trigger: checkpoint.trigger,
        at: new Date(checkpoint.createdAt).getTime(),
      })),
    };
  });
  if (found.ids.length !== 3)
    throw new Error(
      `found ${found.ids.length} sessions in ckpt-turns: run the CLI batch once first`,
    );
  if (typeof found.me !== "string") throw new Error("the page holds no signed-in account");
  const chain = found.chain.toSorted((a, b) => a.ordinal - b.ordinal);
  // The runs in the order they ran: by each one's first checkpoint.
  const runs = found.ids
    .map((id) => chain.filter((checkpoint) => checkpoint.sessionId === id))
    .toSorted((a, b) => (a[0]?.ordinal ?? 0) - (b[0]?.ordinal ?? 0));
  for (const taken of runs)
    if (taken.length < 2)
      throw new Error(
        `a run took ${taken.length} checkpoint(s), not one when it started and one when it ended`,
      );
  note(
    `the worktree's real checkpoints: ${chain.map((checkpoint) => `${checkpoint.ordinal} ${checkpoint.trigger}`).join(", ")}`,
  );

  // One session's conversation: turn k runs inside run k, after its starting checkpoints and before
  // its last one.
  const viewed = found.ids[0];
  const iso = (ms) => new Date(ms).toISOString();
  const turns = runs.map((taken, index) => {
    const last = taken.at(-1);
    const before = taken.at(-2);
    const start = Math.round((before.at + last.at) / 2);
    return turn(viewed, found.me, index, "completed", PROMPTS[index], iso(start), iso(last.at - 1));
  });
  const conversation = (count) =>
    history({
      turns: turns.slice(0, count),
      items: turns.slice(0, count).map((each, index) => {
        const said = iso(new Date(each.endedAt).getTime() - 2);
        return item(each.id, "assistant-message", "completed", said, said, {
          text: REPLIES[index],
        });
      }),
    });
  // A scenario holds the first `count` turns and the checkpoints taken by then.
  let scenario = { count: 3, upTo: runs[2].at(-1).ordinal };
  const detailFor = (data) => {
    const patched = patchDetail(data, { status: "completed", harness: "claude" });
    const values = { ...patched.meta.values };
    const kept = patched.json.checkpoints
      .map((checkpoint, index) => ({ checkpoint, index }))
      .filter(({ checkpoint }) => checkpoint.ordinal <= scenario.upTo);
    for (const key of Object.keys(values)) if (key.startsWith("checkpoints.")) delete values[key];
    kept.forEach((_, index) => {
      values[`checkpoints.${index}.createdAt`] = ["Date"];
    });
    patched.json.checkpoints = kept.map(({ checkpoint }) =>
      checkpoint.ordinal === 0 ? checkpoint : { ...checkpoint, sessionId: viewed },
    );
    return { json: patched.json, meta: { ...patched.meta, values } };
  };
  const slices = [];
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const inputs = JSON.parse(route.request().postData() ?? url.searchParams.get("input") ?? "{}");
    paths.forEach((path, index) => {
      if (path === "worktrees.sliceFiles") slices.push(inputs[String(index)]?.json);
    });
    const mine = paths.map((path, index) => {
      const id = inputs[String(index)]?.json?.id;
      if (path.startsWith("sessions.history") && id === viewed) return "history";
      if (path === "sessions.detail" && id === viewed) return "detail";
      return null;
    });
    if (mine.every((each) => each === null)) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const answers = Array.isArray(body) ? body : [body];
    paths.forEach((path, index) => {
      if (mine[index] === "history")
        answers[index] = { result: { data: conversation(scenario.count)[path] } };
      else if (mine[index] === "detail")
        answers[index] = { result: { data: detailFor(answers[index].result.data) } };
    });
    await route.fulfill({ response, json: Array.isArray(body) ? answers : answers[0] });
  });

  /** The conversation from top to bottom: each message, each checkpoint line, nothing else. */
  const order = () =>
    page.evaluate((prompts) => {
      const items = [...document.querySelectorAll('[data-slot="conversation-item"]')].filter(
        (each) => each.getClientRects().length > 0,
      );
      return items.flatMap((each) => {
        const marker = each.querySelector('[data-slot="conversation-marker"]');
        const text = marker?.textContent ?? "";
        if (text.startsWith("Checkpoint")) return [`line: ${text.split("·Show")[0].trim()}`];
        const asked = prompts.findIndex((prompt) => each.textContent?.includes(prompt));
        return asked === -1 ? [] : [`you ${asked + 1}`];
      });
    }, PROMPTS);
  const show = async (count, upTo) => {
    scenario = { count, upTo };
    await open("/no-such-page");
    await go(`/sessions/${viewed}`);
    await visible(page.getByText(REPLIES[count - 1])).waitFor({ timeout: 30_000 });
    // The lines wait for the stack's answer on which files changed.
    await page.waitForFunction(
      (want) =>
        document.querySelectorAll('[data-slot="conversation-marker"][data-kind="checkpoint"]')
          .length >= want,
      count === 2 ? 1 : count === 3 ? 2 : 1,
      { timeout: 30_000 },
    );
    await settled();
    return order();
  };
  const expect = (seen, want, what) => {
    if (JSON.stringify(seen) !== JSON.stringify(want))
      throw new Error(`${what}: the conversation reads ${JSON.stringify(seen)}`);
  };
  const lineText = (changed) => `line: Checkpoint · ${changed}`;

  // A first prompt that edits files: no line above the message, one after the reply.
  const first = await show(1, runs[0].at(-1).ordinal);
  expect(first, ["you 1", lineText("2 files changed")], "a first prompt that edits files");
  note(`a first prompt that writes two files reads ${JSON.stringify(first)}`);
  await capture("fixture-first-prompt-desktop-light");

  // A prompt that edits nothing: its turn has no line.
  const second = await show(2, runs[1].at(-1).ordinal);
  expect(second, ["you 1", lineText("2 files changed"), "you 2"], "a prompt that edits nothing");
  note(`a second prompt that changes nothing reads ${JSON.stringify(second)}`);
  await capture("fixture-edits-nothing-desktop-light");

  // Three turns in a row, in light and dark, on a desktop and at phone width.
  const third = await show(3, runs[2].at(-1).ordinal);
  expect(
    third,
    ["you 1", lineText("2 files changed"), "you 2", "you 3", lineText("1 file changed")],
    "three turns in a row",
  );
  note(`three turns in a row read ${JSON.stringify(third)}`);
  for (const [viewport, size] of [
    ["desktop", DESKTOP],
    ["phone", PHONE],
  ]) {
    await page.setViewportSize(size);
    for (const theme of ["light", "dark"]) {
      await setTheme(theme);
      await capture(`fixture-three-turns-${viewport}-${theme}`);
    }
  }
  await setTheme("light");
  await page.setViewportSize(DESKTOP);
  const asked = slices.filter((slice) => slice?.id !== undefined);
  note(
    `the conversation asked the stack which files changed for ${asked.length} turn slice(s), e.g. ${JSON.stringify(asked.at(-1))}`,
  );

  // Hovering the last line says what it is and offers its actions.
  const label = () => visible(page.getByRole("button", { name: "Checkpoint · 1 file changed" }));
  await label().hover();
  const details = () => visible(page.getByRole("dialog"));
  await details().getByText("When this turn ended", { exact: false }).waitFor();
  const words = (await details().innerText()).replace(/\s+/g, " ");
  for (const want of [
    `Checkpoint ${runs[2].at(-1).ordinal}`,
    "1 file changed during this turn.",
    "NOTES.md",
    "Show changes",
    "Open in Record",
  ])
    if (!words.includes(want)) throw new Error(`the details read "${words}", without "${want}"`);
  if (/go back|restore|undo/i.test(words)) throw new Error(`the details promise "${words}"`);
  note(`hovering the line opens: "${words}"`);
  await settled();
  for (const theme of ["light", "dark"]) {
    await setTheme(theme);
    await capture(`fixture-line-hover-desktop-${theme}`);
  }
  await setTheme("light");
  await page.mouse.move(0, 0);
  await page.keyboard.press("Escape");

  // From the keyboard: Tab to the line and press Enter; Open in Record goes to that checkpoint.
  await label().focus();
  await page.keyboard.press("Enter");
  await details().getByRole("link", { name: "Open in Record" }).waitFor();
  await capture("fixture-line-keyboard-desktop-light");
  await details().getByRole("link", { name: "Open in Record" }).click();
  await page.waitForURL(`**/sessions/${viewed}/record#checkpoint-${runs[2].at(-1).ordinal}`);
  await visible(page.getByRole("button", { name: "Checkpoints" })).click();
  await settled();
  const recordRows = await page.getByText(/^Checkpoint \d+ ·/).count();
  note(
    `Open in Record goes to /sessions/<id>/record#checkpoint-${runs[2].at(-1).ordinal}; filtered to Checkpoints it lists ${recordRows} rows (the chain has ${chain.length - 1} beyond the worktree's start)`,
  );
  await capture("fixture-record-checkpoints-desktop-light");

  // Show changes opens the Change tab over the turn's checkpoints.
  await open("/no-such-page");
  await go(`/sessions/${viewed}`);
  await visible(page.getByText(REPLIES[2])).waitFor({ timeout: 30_000 });
  await visible(page.getByRole("button", { name: "Show changes" })).click();
  await page.waitForURL(`**/sessions/${viewed}/change`);
  await visible(page.getByText("NOTES.md", { exact: false })).waitFor({ timeout: 60_000 });
  await settled();
  const range = await page.evaluate(() =>
    [...document.querySelectorAll("button")]
      .map((each) => each.textContent ?? "")
      .find((text) => /checkpoint/i.test(text)),
  );
  note(`Show changes opens the Change tab; its range reads "${range}", listing NOTES.md`);
  await capture("fixture-show-changes-desktop-light");

  // On a phone the line is a tap target, and the details open in place.
  await page.setViewportSize(PHONE);
  await open("/no-such-page");
  await go(`/sessions/${viewed}`);
  await visible(page.getByText(REPLIES[2])).waitFor({ timeout: 30_000 });
  await label().click();
  await details().getByText("When this turn ended", { exact: false }).waitFor();
  const sideways = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  if (sideways) throw new Error("the page scrolls sideways at 390px with the details open");
  for (const theme of ["light", "dark"]) {
    await setTheme(theme);
    await capture(`fixture-line-tap-phone-${theme}`);
  }
  note("at 390px a tap on the line opens its details, with no sideways scroll");
  await setTheme("light");
  await page.setViewportSize(DESKTOP);
  await page.unroute("**/trpc/**");
};
