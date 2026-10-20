// Story a, flow 3 of the VS Code redesign, driven as Dana meets it: `Mend: New session` opens one
// quick input on the project her window's origin matched, Enter starts claude on her prompt as a
// terminal agent, the row goes `starting` then `running`, no window opens and nothing toasts, and
// Open shows claude's TUI on her prompt (a1-a3). Then the edge cases, in an order where each leaves
// the next a usable world: Change… (codex and a model, one Back, remembered for the project), the
// join title, a base Mend's store has not seen (a local commit on a new branch), the base as the
// ref that proved it (a branch tracking origin/<default> under another name, one pushed without
// -u, one the store cannot find), a separate repository nested inside the checkout with an origin of
// its own (Adopt this repository, not the project), a folder named like the project whose origin is
// not adopted (Adopt this repository, then the prompt), a refused launch (Claude disconnected; the row reads
// the server's state, one toast with Retry, which relaunches the same session once Claude is
// back), and Mend going offline while she has typed a prompt (kept, the cursor after it, and there
// again once Mend is back).
//
//   node .claude/skills/verify/scripts/drive-vscode.mjs run \
//     .claude/skills/verify/recipes/vscode-new-session.mjs --out <dir>
//
// Needs a world from `up` that is signed in with workspace SSH set up (the default) and an extension
// that has flow 3. Claude runs on the skill's fake setup token and Codex on its fake auth.json
// (`scripts/fakes.mjs`): each starts as a terminal agent on its prompt, and the provider's refusal
// (claude's 401) is the only answer that comes back. The no-match lane clones a second public GitHub
// repository (octocat/Spoon-Knife) next to the first, and the server adopts it from there.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { FAKES } from "../scripts/fakes.mjs";

const world = await import(
  pathToFileURL(join(import.meta.dirname, "../../../../scripts/vscode-remote-world.mjs")).href
);

const PROMPT = "add rate limiting to the login route";
const PROMPT_CODEX = "list the files in this repository";
const PROMPT_FAILS = "write a changelog entry";
const PROMPT_OFFLINE = "rename the config loader";
/** Pasted whole: 100,000 and 130,000 ASCII characters, so as many bytes; the cap is 120,000. */
const pasted = (length) => "summarize this build log line by line. ".repeat(4_000).slice(0, length);
const LONG_PROMPT = pasted(100_000);
const OVER_PROMPT = pasted(130_000);
const UNPUSHED = "verify-unpushed";
const OTHER_REPO = "https://github.com/octocat/Spoon-Knife.git";
/** Never fetched: the nested repository only needs an origin no project has. */
const NESTED_ORIGIN = "https://github.com/verify-invalid/nested.git";
const OPEN = /^Mend: Open$/;
const OFFLINE = "Mend is offline · retrying";
/**
 * A refused launch reads the server's state: `failed · <its summary>` once the server settles it,
 * `starting · launch refused · <the refusal>` while it still reads it starting.
 */
const REFUSED_ROW = /^failed · |^starting · launch refused · /;
const REFUSED_TOAST = / failed · | · launch refused · /;

const expect = (holds, message) => {
  if (!holds) throw new Error(message);
};

const linesMatching = (log, needle) =>
  log.split("\n").filter((line) => line.includes(needle)).length;

const liveAgent = (processes) =>
  processes.find((process) => process.kind === "agent-pty" && process.exitedAt === null);

/** A quick input as one line: title, step, placeholder, value, each row. */
const said = (seen) =>
  `title "${seen.title}"${seen.step === null ? "" : ` · step ${seen.step}/${seen.total}`} · placeholder "${seen.placeholder}" · value "${seen.value.length > 200 ? `<${seen.value.length} characters>` : seen.value}"${seen.rows.length === 0 ? "" : ` · rows ${JSON.stringify(seen.rows.map(({ label, icons, description, buttons }) => ({ label, icons, description, buttons })))}`}${seen.line === "" ? "" : ` · line "${seen.line}"${seen.warned ? " (warning)" : ""} · buttons ${JSON.stringify(seen.buttons)}`}`;

const shown = (seen) =>
  seen === null
    ? "the window navigated, its watch went with it"
    : `toasts ${JSON.stringify(seen.toasts)} · dialogs ${JSON.stringify(seen.dialogs)} · status bar ${JSON.stringify(seen.statusBar)}`;

/** A step as the recipe tells one from the next. */
const key = (seen) =>
  `${seen.step}|${seen.placeholder}|${seen.rows.map((row) => row.label).join(",")}`;

/** The row whose label is `name` whatever its case (`codex`, `Codex`), as the step lists it. */
const labelOf = (seen, name) =>
  seen.rows.find((row) => row.label.toLowerCase() === name.toLowerCase())?.label ?? name;

export default async (h) => {
  const {
    view,
    viewRows,
    viewActions,
    viewAction,
    palette,
    paletteRows,
    quickInput,
    treeItem,
    notification,
    notifications,
    statusBar,
    statusBarItems,
    terminal,
    watch,
    userSettings,
    openFolder,
    windows,
    newWindows,
    waitForWindow,
    useWindow,
    homeWindow,
    closeWindow,
    waitUntil,
    shot,
    step,
    note,
    api,
    state,
    serverLogs,
    opens,
    sleep,
  } = h;
  const project = state.project;
  const env = { ...process.env, HOME: state.home, XDG_CONFIG_HOME: state.configHome };
  const git = (args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Dana",
        "-c",
        "user.email=dana@verify.invalid",
        "-C",
        state.checkout,
        ...args,
      ],
      { env, encoding: "utf8" },
    ).trim();
  const docker = (verb) =>
    world.run(
      "docker",
      [
        "--context",
        state.context,
        verb,
        ...(verb === "stop" ? ["-t", "5"] : []),
        state.server.container,
      ],
      // The world's Docker context is registered under its own HOME.
      { timeout: 120_000, env },
    );
  const connect = async (provider, input) => {
    const ran = await world.cli(["connect", provider, "--from-stdin"], env, {
      input,
      allowFailure: true,
    });
    expect(ran.status === 0, `mend connect ${provider} exited ${ran.status}: ${ran.stderr.trim()}`);
    return ran.stdout.trim();
  };

  /** The Mend view with Projects and the project open, so every session has a row. */
  const mendView = async () => {
    await view("Mend");
    await waitUntil(
      "the Mend view's first rows",
      async () => ((await viewRows()).rows.some((one) => one.label === "Projects") ? true : null),
      120_000,
    );
    for (const label of ["Projects", project.name]) {
      const row = (await viewRows()).rows.find((one) => one.label === label);
      if (row?.expanded === "false") {
        await treeItem(label).click();
        await waitUntil(
          `${label} open`,
          async () =>
            (await viewRows()).rows.find((one) => one.label === label)?.expanded === "true"
              ? true
              : null,
          15_000,
        );
      }
    }
  };

  /** The line under the input box, `warned` when it is decorated, and the title bar's buttons. */
  const promptLine = async () => {
    const message = await quickInput.message();
    const bar = (await quickInput.buttons()).filter((button) => button.where === "title bar");
    return {
      line: message?.text ?? "",
      warned: message?.severity === "warning" || message?.severity === "error",
      buttons: bar.map((button) => button.tooltip),
    };
  };

  /** The quick input as she reads it. */
  const read = async () => {
    const counter = await quickInput.step();
    return {
      title: counter?.title ?? null,
      step: counter?.step ?? null,
      total: counter?.total ?? null,
      placeholder: await quickInput.placeholder(),
      value: await quickInput.value(),
      rows: await quickInput.rows(),
      // The prompt step is an InputBox: its dim line is the line under the box, Change… a title
      // bar button, and a warning decorates the box.
      ...(await promptLine()),
    };
  };

  /** `Mend: New session` from the palette, read once it shows. */
  const newSession = async () => {
    await palette("Mend: New session");
    await quickInput.waitFor();
    await sleep(500);
    return read();
  };

  /**
   * Change…'s steps, from the prompt step's button until the prompt step returns (no counter).
   * `choose(seen)` answers each step: `{ pick: label }`, `{ back: true }`, or `{ keep: true }`
   * (the row marked current, else the active one). Returns each step as read and what was done.
   */
  const change = async (choose) => {
    // The title and placeholder change a moment before the list does (run ns2 read the thinking
    // step over the model step's rows): a step is read once two samples a poll apart agree.
    let candidate = null;
    const next = (previous) =>
      waitUntil(
        "the next step",
        async () => {
          const now = await read();
          const settled = candidate !== null && key(candidate) === key(now);
          candidate = now;
          return settled && key(now) !== previous && (now.rows.length > 0 || now.step === null)
            ? now
            : null;
        },
        30_000,
      );
    let previous = key(await read());
    await quickInput.button("Change…");
    const trail = [];
    for (let guard = 0; guard < 12; guard += 1) {
      const seen = await next(previous);
      previous = key(seen);
      if (seen.step === null) return { trail, prompt: seen };
      const answer = choose(seen);
      const current = seen.rows.find((row) => row.icons.includes("check"));
      if (answer.back) await quickInput.back();
      else if (answer.pick !== undefined) await quickInput.pick(answer.pick, { exact: true });
      else if (current !== undefined) await quickInput.pick(current.label, { exact: true });
      else await quickInput.accept();
      trail.push(
        `${seen.step}/${seen.total} "${seen.placeholder}" [${seen.rows.map((row) => `${row.label}${row.description ? ` (${row.description})` : ""}`).join(", ")}] → ${answer.back ? "Back" : (answer.pick ?? current?.label ?? "Enter")}`,
      );
    }
    throw new Error(`Change… did not return to the prompt: ${trail.join(" · ")}`);
  };

  const sessionIds = async () =>
    new Set((await api(`/projects/${project.id}`)).sessions.map((one) => one.id));
  const createdSince = async (before) =>
    (await api(`/projects/${project.id}`)).sessions.filter((one) => !before.has(one.id));
  const launches = async (id) => linesMatching(await serverLogs(), `'/api/sessions/${id}/launch'`);
  const sessionRows = async (labels) =>
    (await viewRows()).rows.filter((row) => row.level >= 2 && !labels.has(row.label));

  /**
   * After Enter: the view's rows that were not there before, sampled every 150 ms until one reads
   * `want`, each distinct `label · description` once, in order.
   */
  const followNewRow = async (labels, want, limit) => {
    const seen = [];
    const since = Date.now();
    let firstMs = null;
    let starting = false;
    const found = await waitUntil(
      `a new row reading ${want}`,
      async () => {
        for (const row of await sessionRows(labels)) {
          firstMs ??= Date.now() - since;
          const line = `${row.label} · ${row.description}`;
          if (!seen.includes(line)) seen.push(line);
          if (!starting && row.description.startsWith("starting")) {
            starting = true;
            await shot("row-starting");
          }
          if (want.test(row.description)) return row;
        }
        await sleep(150);
        return null;
      },
      limit,
    );
    return { row: found, seen, firstMs };
  };

  // ── the world ──
  const { project: read0 } = await api(`/projects/${project.id}`);
  const base = read0.defaultBranch;
  const catalog = await api("/harnesses/models");
  const codexModel = catalog
    .find((one) => one.harness === "codex")
    ?.models.find((model) => !model.isDefault && model.efforts === null);
  expect(codexModel !== undefined, `no codex model to choose: ${JSON.stringify(catalog)}`);

  await step(
    "the Mend view lists the project; the window is the project's own checkout",
    async () => {
      await useWindow(await homeWindow());
      if (await quickInput.isOpen()) await quickInput.cancel();
      await mendView();
      await shot("mend-view");
      return `row "${await treeItem(project.name).text()}" · checkout on ${git(["branch", "--show-current"])}, origin ${git(["remote", "get-url", "origin"])} · project ${project.name} adopted from ${read0.originUrl}, default branch ${base}`;
    },
  );

  await step(
    "Claude connected with the skill's fake setup token (mend connect claude --from-stdin); every open keeps the local window (window.openFoldersInNewWindow on)",
    async () => {
      const connected = await connect("claude", FAKES.claude);
      userSettings({ "window.openFoldersInNewWindow": "on" });
      await sleep(2_000);
      return connected;
    },
    { via: "setup" },
  );

  // ── a1-a3: start claude on her prompt ──
  const before = {
    ids: await sessionIds(),
    labels: new Set((await viewRows()).rows.map((row) => row.label)),
    opens: await opens(),
    windows: (await windows()).length,
  };

  await step(
    `a1 · Mend: New session from the palette: one quick input "New session · ${project.name}", one dim line "claude · default model · from ${base}" with Change…`,
    async () => {
      const seen = await newSession();
      await shot("a1-new-session");
      expect(seen.title === `New session · ${project.name}`, `the title: ${said(seen)}`);
      expect(seen.step === null, `a step counter shows: ${said(seen)}`);
      expect(seen.rows.length === 0, `${seen.rows.length} rows under the prompt: ${said(seen)}`);
      expect(
        seen.line === `claude · default model · from ${base}` && !seen.warned,
        `the dim line: ${said(seen)}`,
      );
      expect(seen.buttons.includes("Change…"), `no Change… on the title bar: ${said(seen)}`);
      expect(seen.placeholder === "What should claude do?", `the placeholder: ${said(seen)}`);
      return said(seen);
    },
  );

  const watching = await watch();
  const started = await step(
    "a2 · she types her prompt and presses Enter: the input closes, a row appears reading starting, then running",
    async () => {
      await quickInput.type(PROMPT);
      await shot("a2-prompt-typed");
      await quickInput.accept();
      await waitUntil("the input to close", async () => !(await quickInput.isOpen()), 60_000);
      const { row, seen, firstMs } = await followNewRow(before.labels, /^running/, 600_000);
      await shot("a2-row-running");
      expect(
        seen.some((line) => / · starting/.test(line)),
        `no sample read starting: ${JSON.stringify(seen)}`,
      );
      return {
        observed: `the first new row ${firstMs} ms after Enter · rows sampled ${JSON.stringify(seen)}`,
        label: row.label,
      };
    },
  );

  const first = await step(
    "a2 · over the API: exactly one new session, its agent a claude agent-pty (PTY) whose argv ends with her prompt",
    async () => {
      const created = await createdSince(before.ids);
      expect(created.length === 1, `${created.length} sessions created`);
      const [session] = created;
      const detail = await waitUntil(
        "a live agent-pty",
        async () => {
          const now = await api(`/sessions/${session.id}`);
          return liveAgent(now.processes) === undefined ? null : now;
        },
        120_000,
      );
      const agent = liveAgent(detail.processes);
      expect(detail.session.harness === "claude", `harness ${detail.session.harness}`);
      expect(agent.harness === "claude", `the agent's harness ${agent.harness}`);
      expect(agent.argv.at(-1) === PROMPT, `argv ${JSON.stringify(agent.argv)}`);
      return {
        observed: `1 session ${session.id.slice(0, 8)} · ${detail.session.status} · harness ${detail.session.harness} · model ${detail.session.model} · base ${detail.session.baseRef ?? "(project default)"} · process ${agent.kind} ${agent.harness} argv ${JSON.stringify(agent.argv)} · launches on its id ${await launches(session.id)}`,
        id: session.id,
      };
    },
    { via: "api" },
  );

  await step(
    "a2 · no window opened, nothing asked, no toast; a3 · the status bar reads Mend · 1 running",
    async () => {
      const seen = await watching.stop();
      const after = { opens: await opens(), windows: (await windows()).length };
      const items = await statusBarItems();
      await shot("a3-status-bar");
      const observed = `opens ${before.opens} → ${after.opens} · windows ${before.windows} → ${after.windows} · ${shown(seen)} · status bar ${JSON.stringify(items)}`;
      expect(after.opens === before.opens, `a window opened: ${observed}`);
      expect(after.windows === before.windows, `a window opened: ${observed}`);
      expect(seen !== null && seen.toasts.length === 0, `a toast: ${observed}`);
      expect(seen.dialogs.length === 0, `a dialog: ${observed}`);
      expect(items.includes("Mend · 1 running"), `the status bar: ${observed}`);
      return observed;
    },
  );

  await step(
    "flow 1 · Open on its row: one window, claude's TUI on her prompt (the same opens counter reads +1 here)",
    async () => {
      await mendView();
      const known = await windows();
      const opensBefore = await opens();
      const { title } = await treeItem(started.label).inline(OPEN);
      const opened = await newWindows(known, { settle: 10_000, limit: 120_000 });
      expect(opened.length === 1, `${opened.length} window(s) opened`);
      await useWindow(opened[0]);
      await statusBar(/SSH:/).waitFor(600_000);
      const tabs = await waitUntil(
        "claude's tab attached and active",
        async () => {
          const now = await terminal().tabs();
          return now.active?.startsWith("claude · ") ? now : null;
        },
        120_000,
      );
      const rows = await terminal().waitForText(
        /rate limiting|401|API Error|authenticat/i,
        120_000,
      );
      const opensAfter = await opens();
      await shot("a-open-claude-tui");
      const lines = rows
        .split("\n")
        .filter((line) => /rate limiting|401|API Error|authenticat/i.test(line))
        .map((line) => line.trim());
      const result = await closeWindow(opened[0]);
      await useWindow(await homeWindow());
      await mendView();
      expect(opensAfter - opensBefore === 1, `opens ${opensBefore} → ${opensAfter}`);
      return `button "${title}" · 1 window · opens ${opensBefore} → ${opensAfter} · tabs ${JSON.stringify(tabs.names)} active "${tabs.active}" focused ${tabs.focused} · terminal ${JSON.stringify(lines.slice(0, 4))} · ${result}`;
    },
  );

  // ── Change…: codex and a model, one Back, remembered ──
  await step(
    "Codex connected with the skill's fake auth.json (mend connect codex --from-stdin)",
    () => connect("codex", FAKES.codexAuth),
    { via: "setup" },
  );

  const beforeCodex = await sessionIds();
  await step(
    `Change…: harness codex, Back once from its model step, codex again, model ${codexModel.label}, the rest kept; her prompt is still typed and the dim line reads the choice`,
    async () => {
      const opened = await newSession();
      expect(opened.value === "", `the prompt step opened with "${opened.value}"`);
      await quickInput.type(PROMPT_CODEX);
      let backed = false;
      const { trail, prompt } = await change((seen) => {
        if (seen.placeholder === "Harness") return { pick: labelOf(seen, "codex") };
        if (seen.placeholder === "Model for codex" && !backed) {
          backed = true;
          return { back: true };
        }
        if (seen.placeholder === "Model for codex") return { pick: codexModel.label };
        return { keep: true };
      });
      await shot("change-done");
      const steps = trail.map((line) => line.split(" ")[0]);
      expect(backed, `Back was never offered a model step: ${trail.join(" · ")}`);
      expect(
        trail.filter((line) => line.includes('"Harness"')).length === 2,
        `Back did not return to the harness step: ${trail.join(" · ")}`,
      );
      expect(prompt.title === `New session · ${project.name}`, `the title: ${said(prompt)}`);
      expect(prompt.value === PROMPT_CODEX, `the prompt: ${said(prompt)}`);
      expect(
        prompt.line.startsWith(`codex · ${codexModel.label} · `),
        `the dim line: ${said(prompt)}`,
      );
      return `steps ${steps.join(" → ")} · ${trail.join(" · ")} · then ${said(prompt)}`;
    },
  );

  await step(
    "Enter: one codex session on her prompt, with that model, launched in a PTY",
    async () => {
      await quickInput.accept();
      const session = await waitUntil(
        "the codex session",
        async () => (await createdSince(beforeCodex))[0] ?? null,
        60_000,
      );
      const detail = await waitUntil(
        "a live agent-pty",
        async () => {
          const now = await api(`/sessions/${session.id}`);
          return liveAgent(now.processes) === undefined ? null : now;
        },
        300_000,
      );
      const agent = liveAgent(detail.processes);
      const created = await createdSince(beforeCodex);
      const observed = `${created.length} session ${session.id.slice(0, 8)} · harness ${detail.session.harness} · model ${detail.session.model} · process ${agent.kind} ${agent.harness} argv ${JSON.stringify(agent.argv)}`;
      expect(created.length === 1, `${created.length} sessions created: ${observed}`);
      expect(detail.session.harness === "codex", observed);
      expect(detail.session.model === codexModel.id, observed);
      expect(agent.argv.includes(codexModel.id) && agent.argv.at(-1) === PROMPT_CODEX, observed);
      return observed;
    },
    { via: "api" },
  );

  await step(
    `New session again: the dim line remembers codex · ${codexModel.label}; Change… marks codex remembered for ${project.name}`,
    async () => {
      const seen = await newSession();
      await shot("remembered");
      await quickInput.button("Change…");
      const harness = await waitUntil(
        "the harness step",
        async () => {
          const now = await read();
          return now.placeholder === "Harness" ? now : null;
        },
        30_000,
      );
      await shot("remembered-harness-step");
      await quickInput.cancel();
      const codex = harness.rows.find((row) => row.label.toLowerCase() === "codex");
      const observed = `prompt step ${said(seen)} · harness step ${said(harness)}`;
      expect(seen.line.startsWith(`codex · ${codexModel.label} · `), `the dim line: ${observed}`);
      expect(
        codex?.icons.includes("check") && codex.description === `remembered for ${project.name}`,
        `codex is not marked remembered: ${observed}`,
      );
      return observed;
    },
  );

  await step(
    `New session in this worktree on ${started.label}'s row: the title names the worktree by its session, never wt-<uuid>`,
    async () => {
      await mendView();
      await treeItem(started.label).contextMenu("Mend: New session in this worktree…");
      await quickInput.waitFor();
      const seen = await waitUntil(
        "the join title",
        async () => {
          const now = await read();
          return now.title?.includes(" · in ") ? now : null;
        },
        30_000,
      );
      await shot("join-title");
      await quickInput.cancel();
      const observed = said(seen);
      expect(
        seen.title === `New session · ${project.name} · in ${started.label}'s worktree` ||
          (seen.title?.startsWith(`New session · ${project.name} · in `) &&
            !/wt-[0-9a-f-]{36}/.test(seen.title)),
        `the title: ${observed}`,
      );
      expect(!/wt-[0-9a-f-]{36}/.test(seen.line), observed);
      return observed;
    },
  );

  // ── base not in the store ──
  await step(
    `a local commit on a new branch ${UNPUSHED} in the window's checkout`,
    async () => {
      git(["switch", "-q", "-c", UNPUSHED]);
      git(["commit", "-q", "--allow-empty", "-m", "local only"]);
      return git(["log", "--oneline", "-1", "--decorate"]);
    },
    { via: "setup" },
  );

  await step(
    `base not in the store: the dim line reads "from ${base} · your branch ${UNPUSHED} isn't pushed", the row marked with a warning`,
    async () => {
      const seen = await waitUntil(
        "the dim line to name the unpushed branch",
        async () => {
          const now = await newSession();
          if (now.line.includes(UNPUSHED)) return now;
          await quickInput.cancel();
          return null;
        },
        60_000,
      );
      await shot("base-unpushed");
      await quickInput.cancel();
      expect(
        seen.line.endsWith(`from ${base} · your branch ${UNPUSHED} isn't pushed`),
        `the dim line: ${said(seen)}`,
      );
      expect(seen.warned, `the line is not a warning: ${said(seen)}`);
      return said(seen);
    },
  );

  await step(
    `the checkout back on ${base}`,
    async () => {
      git(["switch", "-q", base]);
      return git(["branch", "--show-current"]);
    },
    { via: "setup" },
  );

  // ── the base is the ref that proved her commits are on origin ──
  /** Enter on a typed prompt; the session it created, and its worktree's base over the API. */
  const startAndReadBase = async (prompt) => {
    const ids = await sessionIds();
    await quickInput.type(prompt);
    await quickInput.accept();
    await waitUntil("the input to close", async () => !(await quickInput.isOpen()), 120_000);
    const session = await waitUntil(
      "the created session",
      async () => (await createdSince(ids))[0] ?? null,
      60_000,
    );
    const detail = await api(`/projects/${project.id}`);
    const worktree = detail.worktrees?.find((one) => one.id === session.worktreeId);
    expect(worktree !== undefined, `no worktree ${session.worktreeId} for ${session.id}`);
    return { session, worktree, created: (await createdSince(ids)).length };
  };

  await step(
    `a branch verify-tracks that tracks origin/${base} under another name`,
    async () => {
      git(["switch", "-q", "-c", "verify-tracks", "--track", `origin/${base}`]);
      return `${git(["branch", "--show-current"])} · @{upstream} ${git(["rev-parse", "--symbolic-full-name", "@{upstream}"])}`;
    },
    { via: "setup" },
  );

  await step(
    `its upstream is the base: the dim line reads "from ${base}" with no warning, and the created session's worktree is based on ${base} at origin/${base}'s commit`,
    async () => {
      const seen = await waitUntil(
        "the dim line to read the upstream",
        async () => {
          const now = await newSession();
          if (now.line.endsWith(`from ${base}`)) return now;
          await quickInput.cancel();
          return null;
        },
        60_000,
      );
      await shot("base-upstream");
      expect(!seen.warned, `a warning: ${said(seen)}`);
      const { session, worktree, created } = await startAndReadBase("check the base");
      const upstream = git(["rev-parse", `origin/${base}`]);
      const observed = `${said(seen)} · ${created} session ${session.id.slice(0, 8)} · worktree ${worktree.name} baseRef ${worktree.baseRef} baseSha ${worktree.baseSha} · origin/${base} ${upstream}`;
      expect(created === 1, observed);
      expect(worktree.baseRef === base && worktree.baseSha === upstream, observed);
      return observed;
    },
    { via: "api" },
  );

  const remoteTest = (() => {
    try {
      return git(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/test"]);
    } catch {
      return null;
    }
  })();
  if (remoteTest === null) {
    note("origin has no branch test: the pushed-without -u lane is skipped");
  } else {
    await step(
      `a local branch test at origin/test, its @{upstream} set to origin/${base} (pushed without -u)`,
      async () => {
        git(["switch", "-q", "-c", "test", "origin/test"]);
        git(["branch", "-q", "--set-upstream-to", `origin/${base}`]);
        return `HEAD ${git(["rev-parse", "--short", "HEAD"])} · @{upstream} ${git(["rev-parse", "--symbolic-full-name", "@{upstream}"])} · origin/test ${remoteTest.slice(0, 7)}`;
      },
      { via: "setup" },
    );

    await step(
      `pushed without -u: origin/test proves it, not @{upstream}: the dim line reads "from test", and the created session's worktree is based on test`,
      async () => {
        const seen = await waitUntil(
          "the dim line to read test",
          async () => {
            const now = await newSession();
            if (now.line.endsWith("from test")) return now;
            await quickInput.cancel();
            return null;
          },
          60_000,
        );
        await shot("base-pushed-without-u");
        expect(!seen.warned, `a warning: ${said(seen)}`);
        const { session, worktree, created } = await startAndReadBase("check the pushed branch");
        const observed = `${said(seen)} · ${created} session ${session.id.slice(0, 8)} · worktree baseRef ${worktree.baseRef} baseSha ${worktree.baseSha} · origin/test ${remoteTest}`;
        expect(worktree.baseRef === "test" && worktree.baseSha === remoteTest, observed);
        return observed;
      },
      { via: "api" },
    );
  }

  await step(
    "a branch verify-gone with a remote-tracking ref origin/verify-gone that origin does not have",
    async () => {
      git(["switch", "-q", "-c", "verify-gone", `origin/${base}`]);
      git(["update-ref", "refs/remotes/origin/verify-gone", "HEAD"]);
      return git(["rev-parse", "--symbolic-full-name", "origin/verify-gone"]);
    },
    { via: "setup" },
  );

  await step(
    `the store can't find it: Enter keeps the input with her prompt and the line "from ${base} · Mend's store couldn't find verify-gone"; Enter again starts from ${base}`,
    async () => {
      const ids = await sessionIds();
      await waitUntil(
        "the dim line to read verify-gone",
        async () => {
          const now = await newSession();
          if (now.line.endsWith("from verify-gone")) return now;
          await quickInput.cancel();
          return null;
        },
        60_000,
      );
      await quickInput.type("check the missing base");
      await quickInput.accept();
      const refused = await waitUntil(
        "the store's refusal on the line",
        async () => {
          const now = await read();
          return now.line.includes("couldn't find") ? now : null;
        },
        180_000,
      );
      await shot("base-store-refused");
      const between = (await createdSince(ids)).length;
      const { worktree, created } = await startAndReadBase("check the missing base");
      const observed = `${said(refused)} · sessions created by the refused Enter ${between} · after Enter again ${created}, worktree baseRef ${worktree.baseRef}`;
      expect(
        refused.line.endsWith(`from ${base} · Mend's store couldn't find verify-gone`) &&
          refused.value === "check the missing base",
        observed,
      );
      expect(between === 0 && created === 1 && worktree.baseRef === base, observed);
      return observed;
    },
    { via: "api" },
  );

  await step(
    `the checkout back on ${base}, origin/verify-gone removed`,
    async () => {
      git(["update-ref", "-d", "refs/remotes/origin/verify-gone"]);
      git(["switch", "-q", base]);
      return git(["branch", "--show-current"]);
    },
    { via: "setup" },
  );

  // ── a separate repository nested inside the adopted repository's checkout ──
  const nested = join(state.checkout, "vendor", "nested");
  await step(
    `a separate git repository at vendor/nested inside the project's checkout, its own origin ${NESTED_ORIGIN} adopted by no project, excluded from the checkout's status`,
    async () => {
      const inNested = (args) =>
        execFileSync(
          "git",
          ["-c", "user.name=Dana", "-c", "user.email=dana@verify.invalid", "-C", nested, ...args],
          { env, encoding: "utf8" },
        ).trim();
      execFileSync("mkdir", ["-p", nested]);
      inNested(["init", "-q", "-b", "main"]);
      inNested(["commit", "-q", "--allow-empty", "-m", "nested"]);
      inNested(["remote", "add", "origin", NESTED_ORIGIN]);
      execFileSync("sh", [
        "-c",
        'printf "vendor/nested/\\n" >> "$1/.git/info/exclude"',
        "sh",
        state.checkout,
      ]);
      const adopted = (await api("/projects")).map((one) => one.originUrl);
      expect(!adopted.includes(NESTED_ORIGIN), `already adopted: ${JSON.stringify(adopted)}`);
      return `git root ${inNested(["rev-parse", "--show-toplevel"])} · origin ${inNested(["remote", "get-url", "origin"])} · the checkout's root ${git(["rev-parse", "--show-toplevel"])}, status "${git(["status", "--porcelain"])}"`;
    },
    { via: "setup" },
  );

  const nestedWindow = await step(
    "she opens vendor/nested in a new window (code --new-window <folder>)",
    async () => {
      const known = await windows();
      await openFolder(nested);
      const opened = await waitForWindow(known, 120_000);
      await useWindow(opened);
      await view("Mend");
      await shot("nested-window");
      return { observed: `title "${await opened.title()}"`, page: opened };
    },
  );

  await step(
    `inside ${project.name}'s checkout but a repository of its own: New session lists Adopt this repository on top, not ${project.name}'s prompt`,
    async () => {
      const seen = await newSession();
      await shot("nested-no-match");
      await quickInput.cancel();
      const [adopt, ...rest] = seen.rows;
      const observed = said(seen);
      expect(seen.title === "New session", `the title: ${observed}`);
      expect(seen.placeholder === "Choose a project", `the placeholder: ${observed}`);
      expect(adopt?.label === "Adopt this repository", `the first row: ${observed}`);
      expect(adopt.description === NESTED_ORIGIN, `the first row's description: ${observed}`);
      expect(
        rest.some((row) => row.label === project.name),
        `${project.name} is not listed: ${observed}`,
      );
      return observed;
    },
  );

  await step(
    "that window closed and vendor/nested removed, back to the project's window",
    async () => {
      const result = await closeWindow(nestedWindow.page);
      execFileSync("rm", ["-rf", nested]);
      await useWindow(await homeWindow());
      await mendView();
      const seen = await newSession();
      await quickInput.cancel();
      expect(seen.title === `New session · ${project.name}`, `the checkout itself: ${said(seen)}`);
      return `${result} · the checkout's own window: title "${seen.title}"`;
    },
  );

  // ── no project matched ──
  // Its folder is named after the adopted project: an origin that differs is not that project.
  const other = join(state.scratch, "same-name", project.name);
  await step(
    `a second local repository, cloned from ${OTHER_REPO} into a folder named ${project.name} like the adopted project, its origin adopted by no project`,
    async () => {
      execFileSync("git", ["clone", "-q", OTHER_REPO, other], { env, timeout: 300_000 });
      const adopted = (await api("/projects")).map((one) => one.originUrl);
      expect(!adopted.includes(OTHER_REPO), `already adopted: ${JSON.stringify(adopted)}`);
      return `cloned into ${other} · adopted origins ${JSON.stringify(adopted)}`;
    },
    { via: "setup" },
  );

  const otherWindow = await step(
    "she opens that folder in a new window (code --new-window <folder>)",
    async () => {
      const known = await windows();
      await openFolder(other);
      const opened = await waitForWindow(known, 120_000);
      await useWindow(opened);
      await view("Mend");
      await shot("other-window");
      return { observed: `title "${await opened.title()}"`, page: opened };
    },
  );

  const projectsBefore = (await api("/projects")).map((one) => one.id);
  await step(
    `no project matched, though the folder is named ${project.name}: the first step lists Adopt this repository on top, then the projects`,
    async () => {
      const seen = await newSession();
      await shot("no-match");
      const [adopt, ...rest] = seen.rows;
      const observed = said(seen);
      expect(seen.title === "New session", `the title: ${observed}`);
      expect(seen.placeholder === "Choose a project", `the placeholder: ${observed}`);
      expect(adopt?.label === "Adopt this repository", `the first row: ${observed}`);
      expect(adopt.description === OTHER_REPO, `the first row's description: ${observed}`);
      expect(
        rest.some((row) => row.label === project.name),
        `${project.name} is not listed: ${observed}`,
      );
      return observed;
    },
  );

  await step("Adopt this repository: the prompt step of the adopted project follows", async () => {
    const since = Date.now();
    await quickInput.pick("Adopt this repository", { exact: true });
    // VS Code draws a busy input's progress bar only after 800 ms: a faster adopt shows none.
    let busy = false;
    const prompt = await waitUntil(
      "the prompt step",
      async () => {
        busy ||= await quickInput.busy();
        const now = await read();
        return now.title?.startsWith("New session · ") ? now : null;
      },
      300_000,
    );
    const busyLine = `busy ${busy ? "seen" : "not seen"}, the prompt step ${Date.now() - since} ms after the pick`;
    await shot("adopted-prompt");
    await quickInput.cancel();
    const adopted = (await api("/projects")).filter((one) => !projectsBefore.includes(one.id));
    const observed = `${busyLine} · ${said(prompt)} · new projects ${JSON.stringify(adopted.map((one) => ({ name: one.name, originUrl: one.originUrl })))}`;
    expect(adopted.length === 1 && adopted[0].originUrl === OTHER_REPO, observed);
    expect(prompt.title === `New session · ${adopted[0].name}`, `the title: ${observed}`);
    expect(prompt.rows.length === 0 && prompt.line !== "", observed);
    return observed;
  });

  await step("that window closed, back to the project's window", async () => {
    const result = await closeWindow(otherWindow.page);
    await useWindow(await homeWindow());
    await mendView();
    return result;
  });

  // ── launch fails ──
  await step(
    "Claude disconnected (mend connect claude --remove)",
    async () => {
      const ran = await world.cli(["connect", "claude", "--remove"], env, { allowFailure: true });
      expect(ran.status === 0, `exited ${ran.status}: ${ran.stderr.trim()}`);
      return ran.stdout.trim();
    },
    { via: "setup" },
  );

  const beforeFail = {
    ids: await sessionIds(),
    labels: new Set((await viewRows()).rows.map((row) => row.label)),
  };
  const failWatch = await watch();
  const failed = await step(
    "launch refused: New session, Change… back to claude, Enter: the row reads what the server holds with the refusal's words, one error toast with Retry",
    async () => {
      await newSession();
      await quickInput.type(PROMPT_FAILS);
      const { trail, prompt } = await change((seen) =>
        seen.placeholder === "Harness" ? { pick: labelOf(seen, "claude") } : { keep: true },
      );
      expect(prompt.line.startsWith("claude · "), `the dim line: ${said(prompt)}`);
      await quickInput.accept();
      const { row, seen } = await followNewRow(beforeFail.labels, REFUSED_ROW, 120_000);
      const toast = await waitUntil(
        "the failure's toast",
        async () => {
          const all = await notifications();
          return all.find((text) => REFUSED_TOAST.test(text)) ?? null;
        },
        60_000,
      );
      await sleep(3_000);
      const caught = await failWatch.stop();
      await shot("launch-failed");
      const created = await createdSince(beforeFail.ids);
      const server = await api(`/sessions/${created[0]?.id}`);
      const observed = `Change… ${trail.join(" · ")} · dim line "${prompt.line}" · rows sampled ${JSON.stringify(seen)} · the server reads ${server.session.status} · "${server.session.summary}" · toast "${toast}" · ${shown(caught)} · sessions created ${created.length}`;
      const failures = (caught?.toasts ?? []).filter((text) => REFUSED_TOAST.test(text));
      expect(created.length === 1, observed);
      expect(
        row.description.startsWith(`${server.session.status} · `),
        `the row reads a state the server does not hold: ${observed}`,
      );
      expect(failures.length === 1, `${failures.length} failure toasts: ${observed}`);
      expect(/Retry/.test(toast), `the toast offers no Retry: ${observed}`);
      return {
        observed,
        id: created[0].id,
        label: row.label,
        launchesBefore: await launches(created[0].id),
      };
    },
  );

  await step(
    "Claude reconnected with the fake setup token",
    () => connect("claude", FAKES.claude),
    { via: "setup" },
  );

  await step(
    "Retry on the toast: the same session launches again (no new session, a second launch on its id) and its row reads running",
    async () => {
      const ids = await sessionIds();
      await notification(REFUSED_TOAST).click("Retry");
      const detail = await waitUntil(
        "the same session running",
        async () => {
          const now = await api(`/sessions/${failed.id}`);
          return now.session.status === "running" && liveAgent(now.processes) ? now : null;
        },
        300_000,
      );
      const description = await waitUntil(
        "its row to read running",
        async () => {
          const now = await treeItem(failed.label).description();
          return now.startsWith("running") ? now : null;
        },
        120_000,
      );
      await shot("retried-running");
      const created = [...(await sessionIds())].filter((id) => !ids.has(id));
      const after = await launches(failed.id);
      const observed = `session ${failed.id.slice(0, 8)} ${detail.session.status} · argv ${JSON.stringify(liveAgent(detail.processes).argv)} · launches on its id ${failed.launchesBefore} → ${after} · sessions created ${created.length} · row "${failed.label} · ${description}"`;
      expect(created.length === 0, observed);
      expect(after === failed.launchesBefore + 1, observed);
      return observed;
    },
  );

  // ── a long prompt pasted ──
  // A QuickPick matched its value against its rows as a regular expression the renderer could not
  // build past about 32,000 characters: the extension never heard the prompt and started claude
  // without one. The prompt is an InputBox now.
  const beforeLong = await sessionIds();
  await step(
    `a prompt of ${LONG_PROMPT.length.toLocaleString("en")} characters pasted: Enter starts one claude whose argv carries it whole`,
    async () => {
      const seen = await newSession();
      expect(seen.line.startsWith("claude · "), `the dim line: ${said(seen)}`);
      await quickInput.type(LONG_PROMPT);
      const typed = await read();
      await shot("long-prompt-typed");
      expect(typed.value === LONG_PROMPT, `the box holds ${typed.value.length} characters`);
      expect(!typed.warned, `the line warns: ${said(typed)}`);
      await quickInput.accept();
      await waitUntil("the input to close", async () => !(await quickInput.isOpen()), 120_000);
      const created = await waitUntil(
        "the session it started",
        async () => {
          const now = (await api(`/projects/${project.id}`)).sessions.filter(
            (one) => !beforeLong.has(one.id),
          );
          return now.length > 0 ? now : null;
        },
        120_000,
      );
      const [session] = created;
      const detail = await waitUntil(
        "a live agent-pty",
        async () => {
          const now = await api(`/sessions/${session.id}`);
          return liveAgent(now.processes) === undefined ? null : now;
        },
        300_000,
      );
      const argv = liveAgent(detail.processes).argv;
      const sent = argv.at(-1) ?? "";
      const observed = `${said(typed)} · sessions created ${created.length} · ${session.id.slice(0, 8)} argv ${JSON.stringify(argv.slice(0, -1))} + a last word of ${sent.length} characters, ${sent === LONG_PROMPT ? "equal to" : "not"} what she pasted`;
      expect(created.length === 1, observed);
      expect(argv.length === 2 && sent === LONG_PROMPT, observed);
      return observed;
    },
    { via: "api" },
  );

  await step(
    `a prompt of ${OVER_PROMPT.length.toLocaleString("en")} characters: the line says it is too long, and Enter sends nothing`,
    async () => {
      const ids = await sessionIds();
      await newSession();
      await quickInput.type(OVER_PROMPT);
      await quickInput.accept();
      await sleep(3_000);
      const seen = await read();
      await shot("over-prompt-refused");
      const open = await quickInput.isOpen();
      const created = [...(await sessionIds())].filter((id) => !ids.has(id));
      const observed = `${said(seen)} · open ${open} · sessions created ${created.length}`;
      expect(
        seen.line === "the prompt is 130,000 bytes · claude takes at most 120,000" && seen.warned,
        `the line: ${observed}`,
      );
      expect(open && seen.value === OVER_PROMPT && created.length === 0, observed);
      // Cleared, so the next New session does not keep it.
      await quickInput.type("");
      await quickInput.cancel();
      return observed;
    },
  );

  // ── offline with a typed prompt ──
  await step("offline: she opens New session and types a prompt", async () => {
    const seen = await newSession();
    await quickInput.type(PROMPT_OFFLINE);
    await shot("offline-typed");
    return said(await read()) + ` (opened with "${seen.value}")`;
  });

  await step(
    "the server stopped",
    async () => {
      await docker("stop");
      return "stopped";
    },
    { via: "setup" },
  );

  await step(
    `offline: the row reads "${OFFLINE}"; Enter keeps the input open with her prompt`,
    async () => {
      const seen = await waitUntil(
        "the offline line",
        async () => {
          const now = await read();
          return now.line === OFFLINE ? now : null;
        },
        120_000,
      );
      await quickInput.accept();
      await sleep(2_000);
      const after = await read();
      const open = await quickInput.isOpen();
      await shot("offline-row");
      const observed = `${said(seen)} · after Enter open ${open} · ${said(after)}`;
      expect(open && after.value === PROMPT_OFFLINE, observed);
      await quickInput.cancel();
      return observed;
    },
  );

  await step(
    "offline, Escaped: what VS Code shows for New session (the palette, the view's title bar button and its tooltip)",
    async () => {
      await mendView();
      const listed = await paletteRows("Mend: New session");
      const actions = await viewActions();
      const button = viewAction(/^(Mend: New session|Mend is offline)/);
      const title = await button.title();
      const disabled = await button.disabled();
      const tooltip = await button.tooltip();
      await shot("offline-button");
      const runnable = listed.filter((row) => row.label === "Mend: New session" && !row.disabled);
      const observed = `palette for "Mend: New session" ${JSON.stringify(listed)} · view buttons ${JSON.stringify(actions)} · "${title}" disabled ${disabled} · tooltip "${tooltip}"`;
      expect(runnable.length === 0, `the palette runs it: ${observed}`);
      expect(disabled, `the button is enabled: ${observed}`);
      return observed;
    },
  );

  await step(
    "the server started; the view reads Mend again",
    async () => {
      await docker("start");
      const items = await waitUntil(
        "Mend back in the status bar",
        async () => {
          const now = await statusBarItems();
          return now.some((item) => item.startsWith("Mend") && !item.includes("last heard"))
            ? now
            : null;
        },
        240_000,
      );
      return `status bar ${JSON.stringify(items)}`;
    },
    { via: "setup" },
  );

  await step(
    "New session again: her offline prompt is still there, the cursor after it, and what she types adds to it",
    async () => {
      const seen = await waitUntil(
        "New session to run",
        async () => newSession().catch(() => null),
        120_000,
      );
      await shot("offline-prompt-kept");
      const selection = await quickInput.selection();
      await quickInput.keys(" now");
      const typed = await quickInput.value();
      await quickInput.cancel();
      const observed = `${said(seen)} · selection ${JSON.stringify(selection)} · after typing " now" "${typed}"`;
      expect(seen.value === PROMPT_OFFLINE, `the prompt: ${observed}`);
      expect(seen.line !== OFFLINE, `still offline: ${observed}`);
      expect(typed === `${PROMPT_OFFLINE} now`, `the kept prompt was replaced: ${observed}`);
      return observed;
    },
  );

  note(`sessions: claude ${first.id} · retried ${failed.id}`);
};
