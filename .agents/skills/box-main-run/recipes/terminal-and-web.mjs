// One session driven from its terminal and from the web (flows.md: attach-resume.terminal-and-web,
// SLNT-1235). A Codex conversation is taken over by `mend attach` in tmux; a turn typed there shows
// in the web's conversation; the web's composer types the next one into the same terminal; once the
// terminal closes the session goes back to being a conversation by itself; and a session started
// in a terminal shows its turns too. Each word carries the commit's first 8 characters, so it can
// match nothing else.
//
//   MAIN_RUN_M=<the checker's mend> MAIN_RUN_SHA8=<sha8> MAIN_RUN_PROJECT=<project> \
//     pnpm verify drive web --box --recipe .agents/skills/box-main-run/recipes/terminal-and-web.mjs \
//     --timeout 900000
//
// MAIN_RUN_PROJECT defaults to boat-check-ubuntu; on a copy without Boat name a Docker project
// (verify-fixture). It stops both sessions it starts, and kills its own tmux server, however it ends.
import { spawnSync } from "node:child_process";

const DESKTOP = { width: 1280, height: 900 };
const GRACE_MS = 45_000;

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
};

/** The composer answers once React has hydrated its field: typing before that is lost. */
const hydrated = (page) =>
  page.waitForFunction(() =>
    [...document.querySelectorAll("textarea")].some((textarea) =>
      Object.keys(textarea).some((key) => key.startsWith("__reactProps")),
    ),
  );

export default async ({ page, web, capture, note }) => {
  const M = env("MAIN_RUN_M");
  const sha8 = env("MAIN_RUN_SHA8");
  const project = env("MAIN_RUN_PROJECT", "boat-check-ubuntu");
  const socket = `main-run-${sha8}`;
  const ask = (word) => `Reply with exactly the word ${word}-${sha8} and nothing else.`;
  const mend = (...args) => {
    const run = spawnSync(M, args, { encoding: "utf8", timeout: 300_000 });
    note(`mend ${args.join(" ")} → exit ${run.status}`);
    if (run.status !== 0) throw new Error(`mend ${args[0]} failed: ${run.stderr || run.stdout}`);
    return run.stdout;
  };
  const tmux = (...args) => spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
  const pane = (window) =>
    tmux("capture-pane", "-p", "-J", "-S", "-200", "-t", window).stdout ?? "";
  const until = async (what, check, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await check()) return Date.now();
      if (Date.now() > end) throw new Error(`not seen within ${ms / 1000} s: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  };
  const count = (text, word) => text.split(`${word}-${sha8}`).length - 1;
  const main = () =>
    page
      .getByRole("main")
      .innerText()
      .catch(() => "");
  const started = [];

  try {
    await page.setViewportSize(DESKTOP);

    // 1. A conversation, its first turn sent from the CLI.
    const opened = JSON.parse(
      mend(
        "codex",
        ask("ALPHA"),
        "--name",
        `main-run-both-${sha8}`,
        "--project",
        project,
        "--detach",
        "--conversation",
        "--json",
      ),
    );
    const id = opened.data.sessionId;
    started.push(id);
    mend("wait", id, "--turn", "--timeout", "8m");
    note(`conversation ${id} answered ALPHA`);

    // 2. Taken over in a terminal: `mend attach` in tmux, and a turn typed into Codex's TUI.
    tmux(
      "new-session",
      "-d",
      "-s",
      "both",
      "-x",
      "160",
      "-y",
      "45",
      `${M} attach ${id.slice(0, 8)}; sleep 3600`,
    );
    await until(
      "Codex's prompt in the terminal",
      () => pane("both").includes(`ALPHA-${sha8}`),
      120_000,
    );
    // Codex's TUI reads an Enter that follows fast typing as more of a paste: it waits a moment.
    tmux("send-keys", "-t", "both", "-l", ask("BRAVO"));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    tmux("send-keys", "-t", "both", "Enter");
    await until("BRAVO answered in the terminal", () => count(pane("both"), "BRAVO") >= 2, 180_000);
    note("BRAVO asked and answered in the terminal");

    // 3. The web shows the terminal's turn, and its composer still sends.
    await page.goto(`${web}/sessions/${id}`);
    const landed = Date.now();
    await until(
      "BRAVO's question and answer in the web",
      async () => count(await main(), "BRAVO") >= 2,
      45_000,
    );
    note(
      `the web showed BRAVO ${Math.round((Date.now() - landed) / 1000)} s after the page opened`,
    );
    const shown = await main();
    if (count(shown, "ALPHA") !== 2)
      throw new Error(`ALPHA shows ${count(shown, "ALPHA")} times, not twice`);
    if (shown.includes("AGENTS.md instructions"))
      throw new Error("a setup message shows as a message");
    if (shown.includes("runs in a terminal in this session"))
      throw new Error("the composer is locked");
    const field = page
      .getByRole("textbox", { name: "Message Codex" })
      .filter({ visible: true })
      .first();
    await field.waitFor({ timeout: 15_000 });
    await hydrated(page);
    await capture("terminal-turn-in-the-web");
    await field.fill(ask("CHARLIE"));
    await field.press("Enter");
    await until(
      "CHARLIE answered in the web",
      async () => count(await main(), "CHARLIE") >= 2,
      180_000,
    );
    await until(
      "CHARLIE typed into the terminal",
      () => count(pane("both"), "CHARLIE") >= 2,
      30_000,
    );
    if (pane("both").includes("session ended")) throw new Error("the terminal's attach ended");
    note("CHARLIE sent from the web, typed into the terminal, answered in both");
    await capture("composer-typed-into-the-terminal");

    // 4. The terminal closes: past the grace, the session is a conversation again by itself.
    tmux("kill-session", "-t", "both");
    const closed = Date.now();
    note("closed the terminal");
    await until(
      "the line that the session continued as a conversation",
      async () => (await main()).includes("Continued as a conversation after the terminal closed"),
      GRACE_MS + 120_000,
    );
    note(
      `continued as a conversation ${Math.round((Date.now() - closed) / 1000)} s after the terminal closed`,
    );
    const waited = Date.now() - closed;
    if (waited < GRACE_MS)
      throw new Error(
        `it went back ${Math.round(waited / 1000)} s after the terminal closed, inside the grace`,
      );
    await page.reload();
    const again = page
      .getByRole("textbox", { name: "Message Codex" })
      .filter({ visible: true })
      .first();
    await again.waitFor({ timeout: 30_000 });
    await hydrated(page);
    await again.fill(ask("DELTA"));
    await again.press("Enter");
    await until(
      "DELTA answered in the web",
      async () => count(await main(), "DELTA") >= 2,
      180_000,
    );
    const after = await main();
    for (const word of ["ALPHA", "BRAVO", "CHARLIE"])
      if (count(after, word) !== 2)
        throw new Error(`${word} shows ${count(after, word)} times, not twice`);
    note("DELTA answered as a conversation; every earlier turn shows once");
    await capture("back-to-a-conversation");

    // 5. A session started in a terminal shows its turns in the web.
    tmux(
      "new-session",
      "-d",
      "-s",
      "tui",
      "-x",
      "160",
      "-y",
      "45",
      `${M} codex '${ask("FOXTROT")}' --name main-run-tui-${sha8} --project ${project}; sleep 3600`,
    );
    await until(
      "FOXTROT answered in its terminal",
      () => count(pane("tui"), "FOXTROT") >= 2,
      240_000,
    );
    const listed = JSON.parse(mend("sessions", "--project", project, "--json")).data.sessions;
    const bornId = listed.find((row) => row.worktree === `main-run-tui-${sha8}`)?.id;
    if (bornId === undefined) throw new Error("the terminal session is not listed");
    started.push(bornId);
    await page.goto(`${web}/sessions/${bornId}`);
    await until("FOXTROT in the web", async () => count(await main(), "FOXTROT") >= 2, 45_000);
    note("a session started in a terminal shows its turn in the web");
    await capture("terminal-born-session");
  } catch (failure) {
    // What the page showed when the check failed, before the sessions are stopped below.
    await capture("where-it-failed").catch(() => undefined);
    throw failure;
  } finally {
    tmux("kill-server");
    for (const id of started)
      spawnSync(M, ["stop", id.slice(0, 8)], { encoding: "utf8", timeout: 120_000 });
  }
};
