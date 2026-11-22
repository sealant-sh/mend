// The real turn of now-and-sessions.new-web-session-states, on the box (SLNT-1199, SLNT-1206): a
// Codex session started from the composer with a one-line prompt, its row watched in the sidebar's
// Running group while the agent works (the row says what it does: "Running a command", "Thinking"…,
// not only "Starting"), then still under Running saying `Replied` with the dome once the turn ends,
// then Stop session… from its row moving it to To review or Done. The turn runs `sleep 25`, so the
// working state lasts long enough to read; a one-word reply is over before a poll sees it.
//
//   MAIN_RUN_PROJECT=boat-check-ubuntu ~/.local/state/mend-main-run/lanes/<lane>/bin/web <out> \
//     .agents/skills/verify/recipes/session-states-turn.mjs
//
// It needs a real Codex login: never run it after a batch that replaces it. It stops the session it
// started however it ends.
const DESKTOP = { width: 1280, height: 900 };
const TURN_MS = 600_000;
const PROJECT = process.env.MAIN_RUN_PROJECT ?? "boat-check-ubuntu";
const PROMPT =
  "Run the shell command `sleep 25` once, on its own, then reply with the single word ready, and nothing else.";
// The sidebar's activity words (`activityWords` in apps/web/src/lib/inbox.ts).
const WORKING =
  /Running a command|Editing files|Searching the web|Using a tool|Thinking|Writing a reply|Planning|Running a task/;

const visible = (locator) => locator.filter({ visible: true }).first();
const glyph = (row) => row.locator("[data-slot=lump]").first().getAttribute("data-status");

export default async ({ page, web, capture, note }) => {
  const hydrated = () =>
    page.waitForFunction(
      () =>
        window["__TSR_ROUTER__"] !== undefined &&
        [...document.querySelectorAll("textarea")].some((field) =>
          Object.keys(field).some((key) => key.startsWith("__reactProps")),
        ),
    );
  const client = (fn, arg) =>
    page.evaluate(
      async ([source, value]) => {
        const trpc = window["__TSR_ROUTER__"].options.context.trpcClient;
        // eslint-disable-next-line no-new-func
        return new Function("trpc", "value", `return (${source})(trpc, value)`)(trpc, value);
      },
      [fn.toString(), arg],
    );
  const inbox = () => visible(page.getByRole("navigation", { name: "Inbox" }));

  await page.setViewportSize(DESKTOP);
  await page.goto(`${web}/`);
  await hydrated();
  await visible(page.getByRole("button", { name: /^Project: / })).click();
  await page.getByPlaceholder("Find a project").fill(PROJECT);
  await page
    .getByRole("option", { name: new RegExp(`^${PROJECT}`) })
    .first()
    .click();
  await visible(page.getByRole("button", { name: /^Agent and model: / })).click();
  await page.getByRole("menuitemradio", { name: /^Codex/ }).click();
  await page.keyboard.press("Escape").catch(() => undefined);
  await visible(page.getByRole("textbox", { name: "Task" })).fill(PROMPT);
  await visible(page.getByRole("button", { name: "Start session", exact: true })).click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]+$/, { timeout: 120_000 });
  const id = new URL(page.url()).pathname.split("/").at(-1);
  note(
    `started Codex session ${id} in ${PROJECT} from the composer; the recipe stops it at the end`,
  );

  let stopped = false;
  try {
    const running = inbox().getByRole("region", { name: "Running", exact: true });
    const row = running.locator(`a[href='/sessions/${id}']`).first();
    await row.waitFor({ timeout: 120_000 });
    note(
      `real row at the start: ${JSON.stringify(await row.innerText())}; glyph ${await glyph(row)}`,
    );

    // Poll the row until it says what the agent does; Starting alone is not working.
    const seen = new Set();
    const deadline = Date.now() + TURN_MS;
    let working = null;
    while (Date.now() < deadline) {
      const words = await row.innerText().catch(() => "");
      const line = words.split("\n").slice(1).join(" ");
      if (!seen.has(line)) {
        seen.add(line);
        note(`real row reads ${JSON.stringify(words)}`);
      }
      if (WORKING.test(words)) {
        working = words;
        break;
      }
      if (/\bReplied\b/.test(words)) break;
      await page.waitForTimeout(250);
    }
    if (working === null)
      throw new Error(
        `the Running row never said what the agent was doing; it read ${JSON.stringify([...seen])}`,
      );
    note(`real working row under Running: ${JSON.stringify(working)}; glyph ${await glyph(row)}`);
    await row.scrollIntoViewIfNeeded();
    await capture("real-working");

    await visible(page.getByText(/^ready\.?$/i)).waitFor({ timeout: TURN_MS });
    await visible(page.getByRole("button", { name: "Stop turn" })).waitFor({
      state: "hidden",
      timeout: TURN_MS,
    });
    await row.getByText("Replied", { exact: true }).waitFor({ timeout: 30_000 });
    note(
      `real replied, still under Running: ${JSON.stringify(await row.innerText())}; glyph ${await glyph(row)}`,
    );
    await row.scrollIntoViewIfNeeded();
    await capture("real-replied");

    await row.hover();
    const title = (await row.innerText()).split("\n")[0];
    await running.getByRole("button", { name: `Actions for ${title}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Stop session…" }).click();
    await page
      .getByRole("dialog", { name: "Stop session?" })
      .getByRole("button", { name: "Stop session", exact: true })
      .click();
    stopped = true;
    const after = inbox()
      .getByRole("region", { name: /^(Done|To review)$/ })
      .locator(`a[href='/sessions/${id}']`)
      .first();
    await after.waitFor({ timeout: 120_000 });
    const inDone = await inbox()
      .getByRole("region", { name: "Done", exact: true })
      .locator(`a[href='/sessions/${id}']`)
      .count();
    const group = inDone > 0 ? "Done" : "To review";
    note(`real after Stop session…: under ${group}: ${JSON.stringify(await after.innerText())}`);
    await after.scrollIntoViewIfNeeded();
    await capture("real-stopped");
  } finally {
    if (!stopped) {
      await client(async (trpc, session) => trpc.sessions.stop.mutate({ id: session }), id).catch(
        (error) => note(`stopping ${id} after a failure: ${error}`),
      );
      note(`stopped session ${id} after the recipe failed`);
    }
  }
};
