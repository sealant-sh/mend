// A waiting session's row names what it waits on (SLNT-1178, the cut-over audit's part 8, question
// 5): the command, file or tool the agent named ("Wants to run pnpm test"), on the second line of
// its row in the sidebar inbox, the phone inbox, the project's Sessions tab and the command
// palette. A question reads "Asked a question" in a list (a phone row quotes it), and a request that
// named nothing keeps today's words. Run the CLI batch first, once per stack: five `sleep` sessions
// named waits-…, which this recipe's fixture answers make wait.
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-waiting-row-sessions.json
//   pnpm verify drive new-web --recipe new-web-waiting-row
//
// A local stack runs no agent (tooling/verify/local-stack-limits.json, `real-agent-turn`), so no
// session there waits on a person: the server's answer to the inbox read is rewritten so those five
// rows read `waiting`, each with the request the server would name (`ask`). Every capture taken that
// way is named `fixture-…`.
import { existsSync } from "node:fs";
import { join } from "node:path";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

/** What each session waits on, and the words its row says on a desktop list and on a phone. */
const WAITS = {
  "waits-command": {
    ask: { kind: "command", subject: "pnpm test" },
    desktop: "Wants to run pnpm test",
    phone: "Wants to run pnpm test",
  },
  "waits-tool": {
    ask: { kind: "tool", subject: "Bash" },
    desktop: "Wants to use Bash",
    phone: "Wants to use Bash",
  },
  "waits-edit": {
    ask: { kind: "edit", subject: "src/checkout.ts" },
    desktop: "Wants to edit src/checkout.ts",
    phone: "Wants to edit src/checkout.ts",
  },
  "waits-question": {
    ask: { kind: "question", subject: "Back off on a 409?" },
    desktop: "Asked a question",
    phone: "Asked: Back off on a 409?",
  },
  "waits-unnamed": {
    ask: { kind: "tool", subject: null },
    desktop: "Wants to use a tool",
    phone: "Wants to use a tool",
  },
};

const visible = (locator) => locator.filter({ visible: true }).first();

/** The text of a row's lines under its title, as a person reads them. */
const lines = async (locator) =>
  (await locator.innerText()).split("\n").slice(1).join(" | ").replace(/\s+/g, " ");

export default async ({ page, web, capture: captureOnce, note }) => {
  const out = process.argv[process.argv.indexOf("--out") + 1] ?? "";
  const capture = async (name) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await page.evaluate(() => {
        const wrapper = document.querySelector("[data-slot=sidebar-wrapper]");
        if (wrapper instanceof HTMLElement) wrapper.style.maxHeight = "100dvh";
        document.querySelectorAll("vite-error-overlay").forEach((each) => each.remove());
      });
      await page.mouse.move(2, 2);
      await captureOnce(name);
      if (existsSync(join(out, `${name}.png`))) return;
      await page.waitForTimeout(500);
    }
  };
  const settled = () => page.waitForTimeout(500);
  const both = async (name) => {
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (on) => document.documentElement.classList.toggle("dark", on),
        theme === "dark",
      );
      await settled();
      await capture(`${name}-${theme}`);
    }
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
  };
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined, null, {
      timeout: 60_000,
    });
    await page.waitForFunction(
      () => {
        const control = document.querySelector("[data-slot=collapsible-trigger]");
        return (
          control !== null && Object.keys(control).some((key) => key.startsWith("__reactProps"))
        );
      },
      null,
      { timeout: 60_000 },
    );
  };
  const open = async (path) => {
    await page.goto(`${web}${path}`);
    await hydrated();
  };
  /** The server renders the first page with the real answer: read the inbox again, rewritten. */
  const readAgain = () =>
    page.evaluate(() =>
      window["__TSR_ROUTER__"].options.context.queryClient.invalidateQueries({
        queryKey: [["sessions", "inbox"]],
      }),
    );
  const call = (path, input, kind = "query") =>
    page.evaluate(
      async ({ path: route, input: value, kind: verb }) => {
        let target = window["__TSR_ROUTER__"].options.context.trpcClient;
        for (const part of route.split(".")) target = target[part];
        return target[verb](value);
      },
      { path, input, kind },
    );
  const inbox = () => page.getByRole("navigation", { name: "Inbox" }).filter({ visible: true });
  const group = (label) => inbox().getByRole("region", { name: label, exact: true });
  const row = (title) =>
    group("Waiting on you")
      .getByRole("link", { name: new RegExp(`^${title}`) })
      .first();

  await page.setViewportSize(DESKTOP);
  await page.goto(`${web}/no-such-page`);
  await page.evaluate(() => {
    document.cookie = "mend-inbox-folds=; path=/; max-age=0";
    document.cookie = "mend-inbox-filters=; path=/; max-age=0";
    localStorage.setItem("mend-theme", "light");
  });
  await open("/");

  // The batch's sessions, newest of each name.
  const rows = await call("sessions.inbox");
  const ids = new Map();
  for (const each of rows.toSorted(
    (a, b) => new Date(a.session.createdAt) - new Date(b.session.createdAt),
  ))
    if (each.title in WAITS) ids.set(each.session.id, each.title);
  if (ids.size < Object.keys(WAITS).length)
    throw new Error(
      "run new-web-waiting-row-sessions.json first: some waits-… sessions are missing",
    );
  note(`sessions: ${[...ids].map(([id, title]) => `${title} ${id}`).join(", ")}`);

  // Every inbox read answers those sessions as waiting on what WAITS names.
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const at = paths.indexOf("sessions.inbox");
    if (at === -1) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const answer = Array.isArray(body) ? body[at] : body;
    for (const each of answer?.result?.data?.json ?? []) {
      const title = ids.get(each.session.id);
      if (title === undefined) continue;
      each.session.status = "waiting";
      each.activity = null;
      each.ask = WAITS[title].ask;
    }
    await route.fulfill({ response, json: body });
  });
  await open("/");
  await readAgain();

  // 1. The sidebar inbox: each row's second line says what it waits on.
  for (const [title, words] of Object.entries(WAITS)) {
    await row(title).getByText(words.desktop).waitFor({ timeout: 20_000 });
    note(`sidebar: ${title} reads "${await lines(row(title))}"`);
  }
  await both("fixture-sidebar-waiting");

  // 2. The command palette: a waiting session's status names it too.
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox").fill("waits-command");
  const option = visible(palette.getByRole("option", { name: /^waits-command/ }));
  await option.getByText("Wants to run pnpm test").waitFor({ timeout: 20_000 });
  note(`command palette: waits-command reads "${(await option.innerText()).replace(/\s+/g, " ")}"`);
  await capture("fixture-palette-waiting-light");
  await page.keyboard.press("Escape");

  // 3. The project's Sessions tab lists the same words.
  const project = (await call("projects.list")).find((each) => each.name === "verify-fixture");
  await page.goto(`${web}/projects/${project.id}?q=waits`);
  await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
  await readAgain();
  for (const [title, words] of Object.entries(WAITS)) {
    const line = visible(page.getByRole("main").getByText(words.desktop, { exact: true }));
    await line.waitFor({ timeout: 20_000 });
    note(`project Sessions tab: ${title} reads "${words.desktop}"`);
  }
  await capture("fixture-project-sessions-waiting-light");

  // 4. A phone: the row quotes a question, and names the rest the same way.
  await page.setViewportSize(PHONE);
  await open("/");
  await readAgain();
  for (const [title, words] of Object.entries(WAITS)) {
    await row(title).getByText(words.phone).waitFor({ timeout: 20_000 });
    note(`phone: ${title} reads "${await lines(row(title))}"`);
  }
  await both("fixture-phone-waiting");
  await page.setViewportSize(DESKTOP);
  await page.unroute("**/trpc/**");
};
