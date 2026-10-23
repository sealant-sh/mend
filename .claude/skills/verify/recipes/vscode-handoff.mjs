// Run on drive-vscode up --build. The compatibility proxy is a wire fixture, not evidence from an
// old released server. A custom per-file limit needs a server started with
// MEND_BUDGET_HANDOFF_FILE_BYTES, which this world does not do, so that lane is unrun here; the
// over-limit file is proven against the server's default limit. Lane 9 needs a bridge-mode world
// and a private origin reachable only through the local SSH agent; it is unrun here.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { FAKES } from "../scripts/fakes.mjs";
import { fingerprint } from "../scripts/fingerprint.mjs";
import { handoffProxy } from "./vscode-handoff-http.mjs";

const world = await import(
  pathToFileURL(join(import.meta.dirname, "../../../../scripts/vscode-remote-world.mjs")).href
);
const COMMAND = "Mend: Hand off to Mend…";
const DONE = /Handed off as /;
const assertText = (value, text) =>
  assert.ok(value.includes(text), `Expected ${JSON.stringify(text)} in ${JSON.stringify(value)}`);

export default async (h) => {
  const {
    state,
    shot,
    note,
    api,
    page,
    palette,
    paletteRows,
    quickInput,
    view,
    viewActions,
    viewAction,
    viewOverflowItems,
    viewOverflowItem,
    viewRows,
    welcome,
    welcomeAction,
    treeItem,
    waitUntil,
    watch,
    userSettings,
    windows,
    newWindows,
    openFolder,
    waitForWindow,
    useWindow,
    homeWindow,
    closeWindow,
    sleep,
  } = h;
  // MEND_VERIFY_HANDOFF_FROM=<a step name's start> resumes a run on a world that already holds the
  // earlier lanes' sessions and adoptions; setup steps still run.
  const from = process.env["MEND_VERIFY_HANDOFF_FROM"] ?? null;
  let reached = from === null;
  const step = async (name, work, options) => {
    if (!reached && name.startsWith(from)) reached = true;
    if (!reached && !/setup|precondition/u.test(name)) {
      note(`not run on this resumed run: ${name}`);
      return null;
    }
    return h.step(name, work, options);
  };
  const overflowItems = () =>
    waitUntil("the view's ⋯ menu", () => viewOverflowItems().catch(() => null), 30_000);
  const env = {
    ...process.env,
    HOME: state.home,
    XDG_CONFIG_HOME: state.configHome,
  };
  const gitAt = (cwd, ...args) =>
    execFileSync(
      "git",
      ["-c", "user.name=Dana", "-c", "user.email=dana@verify.invalid", "-C", cwd, ...args],
      { env, encoding: "utf8" },
    ).trim();
  const git = (...args) => gitAt(state.checkout, ...args);
  const cliFile = join(state.configHome, "mend", "cli.json");
  const oldCli = readFileSync(cliFile, "utf8");
  const { token } = JSON.parse(oldCli);
  const settingsFile = join(state.userData, "User", "settings.json");
  const oldSettings = readFileSync(settingsFile, "utf8");
  const proxy = await handoffProxy(state.server.origin, token);
  // A launch needs a Claude login. The skill's fake one starts the agent, which is all a handoff's
  // launch is checked for here. Core marks it invalid within seconds of the first inference after
  // a connect (a new session's naming), so every gesture that launches connects right before it.
  const connectClaude = async () => {
    const connected = await world.cli(["connect", "claude", "--from-stdin"], env, {
      input: FAKES.claude,
      allowFailure: true,
    });
    assert.equal(connected.status, 0, connected.stderr);
  };
  const useServer = (url) => {
    writeFileSync(cliFile, JSON.stringify({ url, token }), { mode: 0o600 });
    userSettings({ "mend.serverUrl": url });
  };
  // The mutations a handoff can make: adoption, the upload, a launch. A window's own start-up
  // writes (its event stream, what it last saw) are not the handoff's.
  const writes = () =>
    proxy.requests.filter(
      (row) =>
        row.method === "POST" && /^\/api\/projects(\?|$)|\/handoffs\?|\/launch$/u.test(row.route),
    );
  const received = () =>
    proxy.requests.filter((row) => row.method === "POST" && row.route.includes("/handoffs?"));
  const launches = () =>
    proxy.requests.filter((row) => row.method === "POST" && row.route.endsWith("/launch"));
  const read = async () => ({
    title: await quickInput.title(),
    prompt: (await quickInput.message())?.text ?? "",
    placeholder: await quickInput.placeholder(),
    buttons: await quickInput.buttons(),
    value: await quickInput.value(),
  });
  const ready = () =>
    waitUntil(
      "snapshot facts",
      async () => {
        const seen = await read();
        return seen.prompt.includes("Snapshot as of") &&
          !seen.prompt.includes("Mend is offline") &&
          !(await quickInput.busy())
          ? seen
          : null;
      },
      120_000,
    );
  const listed = () =>
    waitUntil(
      "Files left out… rows",
      async () => {
        const rows = await quickInput.rows();
        return rows.length > 0 ? rows : null;
      },
      30_000,
    );
  // A window's context keys arrive after it starts: the palette lists the command once they do.
  const command = async () => {
    await waitUntil(
      "the command listed and enabled",
      async () =>
        (await paletteRows("Mend: Hand off")).some((row) => row.label === COMMAND && !row.disabled),
      120_000,
    );
    await palette(COMMAND);
  };
  const open = async (entry = "palette") => {
    if (entry === "scm") {
      await view("Source Control");
      await viewOverflowItem("Hand off to Mend…");
    } else if (entry === "title") {
      await view("Mend");
      const action = (await viewActions()).find(
        (one) => one.title?.includes("Hand off to Mend") || one.label?.includes("Hand off to Mend"),
      );
      await viewAction(action?.title ?? /Hand off to Mend/).click();
    } else await command();
    await quickInput.waitFor();
    return ready();
  };
  const refresh = async () => {
    proxy.reconnect();
    await palette("Mend: Refresh");
    await sleep(1000);
  };
  const snapshot = () => ({
    checkout: fingerprint(state.checkout),
    git: fingerprint(git("rev-parse", "--absolute-git-dir")),
    common: fingerprint(resolve(state.checkout, git("rev-parse", "--git-common-dir"))),
  });
  // What Mend observed of a session's change, one added line per file.
  const changedFiles = async (sessionId) => {
    const detail = await api(`/sessions/${sessionId}`);
    const { diff } = await api(`/changes/${detail.change.id}/diff`);
    return Object.fromEntries(
      diff
        .split(/^diff --git /mu)
        .filter((part) => part !== "")
        .map((part) => [
          /^a\/(\S+)/u.exec(part)[1],
          part
            .split("\n")
            .filter((line) => /^\+[^+]/u.test(line))
            .join("\n"),
        ]),
    );
  };
  const projectRead = () => api(`/projects/${state.project.id}`);
  const unchanged = async (before, counts) => {
    assert.deepEqual(snapshot(), before, "checkout, index, refs, objects and metadata unchanged");
    const now = await projectRead();
    assert.equal(now.sessions.length, counts.sessions.length);
    assert.equal(now.worktrees.length, counts.worktrees.length);
  };
  const mendRows = async () => {
    await view("Mend");
    // Workspace SSH was set up for the server's own address, so the view asks again for the
    // proxy's; nothing opens a workspace through the proxy, so that setup is skipped.
    const asked = await welcome();
    if (asked?.links.includes("Skip for now")) {
      note("skipped the view's SSH setup offer for the proxy's address");
      await welcomeAction("Skip for now").click();
    }
    return viewRows();
  };
  const waitReceived = async (before, projectId = state.project.id) =>
    waitUntil(
      "one new handoff",
      async () => {
        const now = await api(`/projects/${projectId}`);
        const added = now.worktrees.filter(
          (worktree) => !before.worktrees.some((known) => known.id === worktree.id),
        );
        assert.ok(added.length <= 1, "one gesture created several worktrees");
        const worktree = added[0];
        const session =
          worktree && now.sessions.find((candidate) => candidate.worktreeId === worktree.id);
        return session ? { worktree, session, project: now.project } : null;
      },
      600_000,
    );
  const clearToasts = () => palette("Notifications: Clear All Notifications");
  // An information toast leaves the screen after a few seconds and stays in the notification
  // center; a toast no longer on screen is read and answered from the bell's list, as she would.
  const questionClosed = async () => !(await quickInput.isOpen());
  const ITEM = ".notification-list-item";
  const BUTTON = ".notification-list-item-buttons-container .monaco-button";
  const told = async (pattern, limit = 120_000) =>
    waitUntil(
      `a notification matching ${pattern}`,
      async () => {
        const toasted = page()
          .locator(`.notifications-toasts ${ITEM}`, { hasText: pattern })
          .first();
        if (await toasted.isVisible()) return toasted;
        const centered = page()
          .locator(`.notifications-center ${ITEM}`, { hasText: pattern })
          .first();
        if (!(await questionClosed())) return null;
        if (!(await centered.isVisible())) await palette("Notifications: Show Notifications");
        return (await centered.isVisible()) ? centered : null;
      },
      limit,
    );
  const toldText = async (pattern, limit) =>
    (await (await told(pattern, limit)).innerText()).replace(/\s+/g, " ").trim();
  const answer = async (pattern, button, limit) => {
    const item = await told(pattern, limit);
    await item.hover();
    await item.locator(BUTTON, { hasText: button }).first().click();
  };
  // `onToast` runs while the completion toast still shows: VS Code moves it out of view soon after.
  const accept = async (prompt = "", projectId = state.project.id, onToast = null) => {
    const before = await api(`/projects/${projectId}`);
    const knownWindows = await windows();
    const seen = await watch();
    const launchCount = launches().length;
    if (prompt !== "") await connectClaude();
    await quickInput.type(prompt);
    await quickInput.accept();
    const result = await waitReceived(before, projectId);
    const toast = await toldText(DONE, 600_000);
    assertText(toast, "Snapshot as of");
    assert.equal((await newWindows(knownWindows)).length, 0, "handoff opens no window");
    await shot("handoff-completed");
    await (onToast ?? clearToasts)();
    const detail = await waitUntil(
      "hold left starting",
      async () => {
        const now = await api(`/sessions/${result.session.id}`);
        return now.session.status !== "starting" ? now : null;
      },
      600_000,
    );
    if (prompt === "") {
      assert.equal(launches().length, launchCount, "an empty prompt launches nothing");
      assert.ok(!detail.processes.some((process) => process.kind.startsWith("agent-")));
    }
    const observed = await seen.stop();

    return { ...result, detail, observed, toast };
  };
  const agentRuns = (sessionId, prompt) =>
    waitUntil(
      "an agent-pty whose argv holds the prompt",
      async () => {
        const detail = await api(`/sessions/${sessionId}`);
        return detail.processes.some(
          (process) =>
            process.kind === "agent-pty" && JSON.stringify(process.argv).includes(prompt),
        )
          ? detail
          : null;
      },
      120_000,
    );
  const nextCut = (label) => appendFileSync(join(state.checkout, "untracked.txt"), `${label}\n`);
  let held;
  let H, M;
  const otherWindows = [];
  // Back to the first window, the others closed: with several local windows open, the first one
  // listed may be any of them.
  const goHome = async () => {
    for (const window of otherWindows.splice(0)) await closeWindow(window).catch(() => undefined);
    await useWindow(await homeWindow());
  };
  try {
    await step(
      "precondition: built server has project and first-adoption terms",
      async () => {
        const terms = await api("/handoffs");
        const perProject = await api(`/projects/${state.project.id}/handoffs`);
        assert.deepEqual(terms, perProject);
        assert.ok(terms.fileBytes > 0);
        note(
          `server image ${state.server.image}; version ${state.server.version}; use up --build for this checkout`,
        );
        assert.equal(
          (await projectRead()).project.defaultBranch,
          "master",
          "the fixture's default must be master",
        );
        return {
          observed: "both terms routes answered",
          terms,
          server: { image: state.server.image, version: state.server.version },
        };
      },
      { via: "api" },
    );
    await step(
      "setup: local Git fixture and a forwarding observation proxy",
      async () => {
        await connectClaude();
        useServer(proxy.url);
        userSettings({
          "git.autofetch": false,
          "git.autorefresh": false,
          "window.openFoldersInNewWindow": "on",
        });
        git("reset", "-q", "--hard");
        git("clean", "-qfdx");
        git("switch", "-q", "-C", "fix/login", "origin/master");
        for (const file of ["both.txt", "edit.txt", "delete.txt"])
          writeFileSync(join(state.checkout, file), "initial\n");
        git("add", "both.txt", "edit.txt", "delete.txt");
        git("commit", "-m", "login foundation");
        writeFileSync(join(state.checkout, "login.txt"), "login\n");
        git("add", "login.txt");
        git("commit", "-m", "login route");
        writeFileSync(join(state.checkout, "both.txt"), "staged\n");
        git("add", "both.txt");
        writeFileSync(join(state.checkout, "both.txt"), "working\n");
        writeFileSync(join(state.checkout, "edit.txt"), "edited\n");
        rmSync(join(state.checkout, "delete.txt"));
        writeFileSync(join(state.checkout, "untracked.txt"), "new\n");
        appendFileSync(
          join(state.checkout, ".git", "info", "exclude"),
          "\nignored.txt\n.env.ignored\n",
        );
        writeFileSync(join(state.checkout, "ignored.txt"), "ignored\n");
        writeFileSync(join(state.checkout, ".env.ignored"), "ignored=1\n");
        writeFileSync(join(state.checkout, ".env.local"), "local=1\n");
        writeFileSync(join(state.checkout, "big.bin"), Buffer.alloc(8 * 1024 * 1024 + 1, 7));
        H = git("rev-parse", "HEAD");
        M = git("merge-base", "HEAD", "origin/master");
        await refresh();
        await view("Source Control");
        await sleep(3000);
        const control = snapshot();
        await sleep(1000);
        assert.deepEqual(
          snapshot(),
          control,
          "no-change control must pass before attributing mutations to handoff",
        );
        return {
          observed: "two commits, three changed tracked files, one eligible untracked",
          H,
          M,
          index: git("ls-files", "--stage"),
          diff: git("diff", M),
          fingerprint: control,
        };
      },
      { via: "setup" },
    );

    await step("lane 1: SCM overflow opens the one optional prompt with frozen facts", async () => {
      await view("Source Control");
      const items = await overflowItems();
      assert.ok(items.some((item) => item.label === "Hand off to Mend…"));
      const overflow = (await viewActions()).find((action) =>
        /More Actions|Additional Actions/.test(action.title),
      );
      assert.ok(overflow, "SCM overflow button must be observed before opening it");
      await viewAction(overflow.title).click();
      await shot("handoff-scm-menu");
      await page().keyboard.press("Escape");
      const seen = await open("scm");
      assert.equal(seen.title, `Hand off fix/login to Mend · ${state.project.name}`);
      assertText(
        seen.prompt,
        "2 commits ahead of master · 3 uncommitted files · 1 untracked · .env left out",
      );
      assertText(seen.prompt, "Your checkout stays as it is.");
      assertText(seen.placeholder, "Continue with:");
      assert.ok(seen.buttons.some((button) => button.tooltip.startsWith("Include .env files")));
      await shot("handoff-question");
      await quickInput.cancel();
      return seen;
    });
    // Included .env files are hashed and stored, so many large ones make the recapture slow
    // enough to cancel while it is still reading.
    const slow = join(state.checkout, "many");
    for (const stage of ["preparing", "ready", "files", "include"]) {
      if (stage === "include" && reached) {
        mkdirSync(slow);
        for (let i = 0; i < 40; i++) writeFileSync(join(slow, `.env.${i}`), randomBytes(7 << 20));
      }
      const before = snapshot();
      const counts = await projectRead();
      const mutations = writes().length;
      await step(`lane 2: Escape at ${stage} leaves no remote or local change`, async () => {
        if (stage === "preparing") {
          await command();
          await quickInput.waitFor();
        } else await open();
        await quickInput.type("keep this prompt");
        if (stage === "files") {
          await quickInput.button("Files left out…");
          const rows = await listed();
          for (const name of [".env.local", ".env.ignored", "big.bin"])
            assert.ok(rows.some((row) => row.label === name));
          await shot("handoff-exclusions");
          await quickInput.back();
          await waitUntil(
            "the prompt back in the input",
            async () => (await quickInput.value()) === "keep this prompt",
            10_000,
          );
        }
        if (stage === "include") {
          await quickInput.button(/^Include .env files/);
          await waitUntil(
            "the recapture reading",
            async () => (await read()).prompt.includes("Reading your checkout…"),
            5000,
          );
          await shot("handoff-include-recapturing");
        }
        await quickInput.cancel();
        await sleep(1000);
        assert.equal(writes().length, mutations, "preview must not adopt, share, upload or launch");
        return stage;
      });
      await step(
        `lane 2: ${stage} cancellation evidence`,
        async () => {
          await unchanged(before, counts);
          if (stage === "include") rmSync(slow, { recursive: true });
          return {
            observed: "no projects/sessions/worktrees or checkout changes",
            fingerprint: before,
          };
        },
        { via: "api" },
      );
    }
    await step("lane 2: two gestures keep one owned question", async () => {
      await open();
      await quickInput.type("one question");
      // An InputBox with ignoreFocusOut stays open when the same title action is clicked again.
      await view("Mend");
      await viewAction(/Hand off to Mend/).click();
      await quickInput.waitFor();
      assert.equal(await quickInput.value(), "one question");
      await quickInput.cancel();
    });
    await step("lane 2: Refresh snapshot replaces the time and keeps the prompt", async () => {
      await open();
      await quickInput.type("keep through refresh");
      const before = await read();
      await sleep(1100);
      await quickInput.button("Refresh snapshot");
      const after = await waitUntil(
        "a new snapshot time",
        async () => {
          const seen = await ready();
          return seen.prompt === before.prompt ? null : seen;
        },
        120_000,
      );
      assert.equal(after.value, "keep through refresh");
      assert.notEqual(after.prompt, before.prompt);
      await quickInput.cancel();
      return {
        observed: "snapshot time changed only on explicit refresh",
        before,
        after,
      };
    });
    const beforeHeld = snapshot();
    await step(
      "lane 3: empty prompt receives one held session without opening a window",
      async () => {
        await open();
        held = await accept("", state.project.id, async () => {
          // The finished handoff no longer holds the gesture while its toast still shows.
          await open("title");
          await quickInput.cancel();
          await clearToasts();
        });
        await mendRows();
        const row = await waitUntil(
          "idle provenance row",
          async () =>
            (await viewRows()).rows.find(
              (one) =>
                one.label === held.worktree.name &&
                one.description === `idle · handed off from ${held.worktree.handoff.machine}`,
            ),
          120_000,
        );
        await shot("handoff-held-row");
        return { observed: row.description, progress: held.observed };
      },
    );
    await step(
      "lane 3: receipt names H, M, W and the unchanged checkout",
      async () => {
        assert.equal(held.worktree.handoff.head, H);
        assert.equal(held.worktree.baseSha, M);
        assert.equal(held.worktree.baseRef, "master");
        assert.deepEqual(snapshot(), beforeHeld);
        const files = await changedFiles(held.session.id);
        assert.deepEqual(Object.keys(files).toSorted(), [
          "both.txt",
          "edit.txt",
          "login.txt",
          "untracked.txt",
        ]);
        assert.equal(files["both.txt"], "+working");
        assert.equal(files["untracked.txt"], "+new");
        return {
          observed:
            "the change holds the captured working files; exclusions and the deleted file absent",
          files,
          provenance: held.worktree.handoff,
          fingerprint: beforeHeld,
        };
      },
      { via: "api" },
    );
    await step("lane 4: Review opens the native Change section", async () => {
      nextCut("review");
      await open();
      await accept("", state.project.id, () => answer(DONE, "Review"));
      await waitUntil(
        "Change section",
        async () =>
          (await page().locator(".monaco-workbench").innerText()).includes("untracked.txt"),
        120_000,
      );
      await shot("handoff-review-change");
      await treeItem(/both.txt/).click();
      await waitUntil(
        "the diff showing the handed-off line",
        async () => (await page().locator(".monaco-workbench").innerText()).includes("working"),
        30_000,
      );
      await shot("handoff-review-diff");
    });
    for (const [entry, prompt] of [
      ["title", "continue the login fix"],
      ["palette", "a".repeat(100_000)],
    ]) {
      await step(`lane 5: ${entry} prompt launches once through Launches`, async () => {
        nextCut(entry);
        await open(entry);
        const count = launches().length;
        const result = await accept(prompt);
        await waitUntil("one launch", async () => launches().length === count + 1, 120_000);
        await agentRuns(result.session.id, prompt);
        return {
          observed: `one session ${result.session.id}, one launch, ${prompt.length} prompt characters`,
        };
      });
    }
    await step("lane 5: a refused launch's Retry keeps its session and worktree", async () => {
      nextCut("retry");
      proxy.controls.refuseLaunch = true;
      await open();
      // The launch's refusal toast arrives before the completion's; clearing would take it too.
      const result = await accept("finish login tests", state.project.id, async () => {});
      const before = await projectRead();
      await told(/launch refused/);
      await mendRows();
      assert.ok(
        (await viewRows()).rows.some(
          (row) => row.label === result.worktree.name && row.description.includes("launch refused"),
        ),
      );
      proxy.controls.refuseLaunch = false;
      const n = launches().length;
      await connectClaude();
      await answer(/launch refused/, "Retry");
      await waitUntil("same session relaunched", async () => launches().length === n + 1, 120_000);
      const after = await projectRead();
      assert.equal(after.sessions.length, before.sessions.length);
      assert.equal(after.worktrees.length, before.worktrees.length);
      assert.ok(launches().at(-1).route.includes(result.session.id));
      await clearToasts();
      return "one handoff; Retry sent only a launch";
    });
    // A keyboard cannot type a NUL or a lone surrogate, so those two are unit tests (handoff.test.ts).
    for (const prompt of ["a".repeat(130_000)])
      await step("lane 5: an over-long prompt stays in the input and creates nothing", async () => {
        const n = writes().length;
        await open();
        await quickInput.type(prompt);
        await quickInput.accept();
        const shown = await waitUntil(
          "the prompt's validation",
          async () => (await quickInput.isOpen()) && (await quickInput.validation()),
          15_000,
        );
        await shot("handoff-prompt-too-long");
        assert.equal(writes().length, n);
        await quickInput.cancel();
        return shown;
      });
    await step(
      "prompt kept: a dismissed slow start keeps her prompt, and the next question launches it",
      async () => {
        nextCut("kept");
        const prompt = "carry the login fix through a slow start";
        const before = await projectRead();
        const n = launches().length;
        proxy.controls.forcedSessionStatus = "starting";
        let unsent;
        try {
          await open();
          await quickInput.type(prompt);
          await quickInput.accept();
          unsent = await waitReceived(before);
          assertText(await toldText(/your prompt has not been sent/, 120_000), "Check again");
          await shot("handoff-prompt-unsent");
          await clearToasts();
        } finally {
          proxy.controls.forcedSessionStatus = null;
        }
        assert.equal(launches().length, n, "nothing launched while the workspace read starting");
        const reopened = await open();
        assert.equal(reopened.value, prompt, "the next question opens with her prompt");
        await shot("handoff-prompt-kept");
        const result = await accept(prompt);
        await waitUntil("one launch", async () => launches().length === n + 1, 120_000);
        assert.ok(launches().at(-1).route.includes(result.session.id));
        await agentRuns(result.session.id, prompt);
        const first = await api(`/sessions/${unsent.session.id}`);
        assert.ok(!first.processes.some((process) => process.kind.startsWith("agent-")));
        return {
          observed: `prompt kept after the dismissed warning on ${unsent.worktree.name}; launched once on ${result.worktree.name}`,
        };
      },
    );
    await step(
      "agent share: a Mend-key project hands off with no SSH agent, whatever the account default",
      async () => {
        nextCut("mend-key");
        assert.equal((await projectRead()).project.gitAuthMode, "mend-key");
        proxy.controls.forcedAccountMode = "bridge";
        try {
          const asked = proxy.requests.length;
          await open();
          const result = await accept("");
          assert.ok(
            !proxy.requests.slice(asked).some((row) => row.route === "/api/me/git-access"),
            "a handoff to an adopted project never reads the account default",
          );
          return {
            observed: `handed off as ${result.worktree.name} with the account default forced to bridge`,
          };
        } finally {
          proxy.controls.forcedAccountMode = null;
        }
      },
    );
    await step(
      "lane 6: edits while uploading stay local, and Check again replays the same bytes",
      async () => {
        nextCut("delayed");
        await open();
        const preview = await read();
        const before = await projectRead();
        proxy.controls.delay = true;
        proxy.controls.drop = 3;
        const n = received().length;
        await quickInput.type("");
        await quickInput.accept();
        await waitUntil(
          "body reached forwarding proxy",
          async () => received().length > n,
          120_000,
        );
        writeFileSync(join(state.checkout, "edit.txt"), "newer local edit\n");
        const expected = snapshot();
        proxy.release();
        await answer(/hasn't confirmed the handoff/, "Check again", 600_000);
        const done = await toldText(DONE, 600_000);
        await shot("handoff-check-again-done");
        await clearToasts();
        const result = await waitReceived(before);
        assert.ok(
          received()
            .slice(n)
            .every((row) => row.digest === received()[n].digest),
        );
        assertText(done, /Snapshot as of ([\d:]+)/.exec(preview.prompt)[0]);
        assert.deepEqual(snapshot(), expected);
        assert.equal(
          (await changedFiles(result.session.id))["edit.txt"],
          "+edited",
          "the change holds the previewed edit, not the one made during the upload",
        );
        return {
          observed: "one replay receipt, identical request digests, newer local edit kept",
          requests: received().slice(n),
          fingerprint: expected,
        };
      },
    );

    // A real second repository is cloned only as fixture setup; the handoff itself is always the UI command.
    // Its folder has the adopted project's name, so a folder name can never stand in for an origin.
    const second = join(dirname(state.checkout), "unadopted", state.project.name);
    let secondProject;
    await step(
      "lane 7 setup: an unadopted public repository in a folder named like the adopted project",
      async () => {
        rmSync(dirname(second), { recursive: true, force: true });
        mkdirSync(dirname(second), { recursive: true });
        gitAt(
          dirname(state.checkout),
          "clone",
          "https://github.com/octocat/Spoon-Knife.git",
          second,
        );
        writeFileSync(join(second, "small.txt"), "small\n");
        const known = await windows();
        await openFolder(second);
        const opened = await waitForWindow(known, 180_000);
        otherWindows.push(opened);
        await useWindow(opened);
        return `second repository cloned into ${second}`;
      },
      { via: "setup" },
    );
    await step(
      "lane 7: adoption is offered before Enter, cancellation adopts nothing",
      async () => {
        const projects = await api("/projects");
        const n = writes().length;
        const seen = await open();
        assertText(seen.prompt, "Adopt github.com/octocat/Spoon-Knife and hand off");
        assert.ok(seen.title.endsWith("· spoon-knife"), seen.title);
        await shot("handoff-adopt-question");
        await quickInput.cancel();
        assert.deepEqual(await api("/projects"), projects);
        assert.equal(writes().length, n);
        await open();
        await quickInput.type("");
        await quickInput.accept();
        await told(DONE, 600_000);
        await shot("handoff-adopted");
        await clearToasts();
        secondProject = (await api("/projects")).find(
          (candidate) => !projects.some((known) => known.id === candidate.id),
        );
        assert.ok(secondProject);
        const now = await api(`/projects/${secondProject.id}`);
        assert.equal(now.worktrees.length, 1);
        assert.equal(now.sessions.length, 1);
        return {
          observed: "one adoption after Enter, then one handoff",
          project: secondProject.id,
        };
      },
    );
    await step(
      "lane 7: changed project terms refuse after adoption, with project retained (wire fixture)",
      async () => {
        // The real adoption remains; a controlled receipt advertises a different default. This tests the client refusal, not GitHub's default-setting API.
        await goHome();
        const third = join(dirname(second), "handoff-mismatch");
        rmSync(third, { recursive: true, force: true });
        gitAt(dirname(second), "clone", "https://github.com/octocat/git-consortium.git", third);
        writeFileSync(join(third, "local.txt"), "local\n");
        const known = await windows();
        await openFolder(third);
        const opened = await waitForWindow(known, 180_000);
        otherWindows.push(opened);
        await useWindow(opened);
        proxy.controls.mode = "no-instance";
        await command();
        await quickInput.waitFor();
        await waitUntil("missing instance limits route", async () =>
          (await read()).prompt.includes("first-adoption handoff limits route"),
        );
        const noInstance = writes().length;
        await quickInput.accept();
        assert.ok(await quickInput.isOpen());
        assert.equal(writes().length, noInstance);
        await quickInput.cancel();
        proxy.controls.mode = "normal";
        proxy.controls.adoptedDefault = "fixture-changed-default";
        const before = await api("/projects");
        const n = received().length;
        await open();
        await quickInput.type("");
        await quickInput.accept();
        assertText(await toldText(/stays adopted/, 600_000), "Nothing was handed off");
        assert.equal((await api("/projects")).length, before.length + 1);
        assert.equal(received().length, n);
        proxy.controls.adoptedDefault = null;
      },
      { via: "setup" },
    );
    await goHome();
    await step(
      "lane 8: offline while typing keeps the prompt; reconnect restores acceptance",
      async () => {
        await open();
        await quickInput.type("kept while offline");
        proxy.controls.mode = "offline";
        proxy.reconnect();
        await waitUntil(
          "offline words",
          async () => (await read()).prompt.includes("Mend is offline"),
          90_000,
        );
        const n = writes().length;
        await quickInput.accept();
        assert.equal(writes().length, n);
        assert.equal(await quickInput.value(), "kept while offline");
        proxy.controls.mode = "normal";
        await waitUntil(
          "online again",
          async () => !(await read()).prompt.includes("Mend is offline"),
          90_000,
        );
        await quickInput.cancel();
      },
    );
    for (const mode of ["old", "terms-refused", "normal"])
      await step(`lane 8: ${mode} compatibility wire fixture`, async () => {
        proxy.controls.mode = mode;
        await refresh();
        await view("Source Control");
        const items = await overflowItems();
        const rows = await paletteRows("Mend: Hand off");
        if (mode === "old") {
          assert.ok(
            items.some((item) => item.label.includes("doesn't take handoffs yet") && item.disabled),
          );
          assert.ok(!rows.some((row) => row.label === COMMAND));
        } else if (mode === "normal") {
          assert.ok(items.some((item) => item.label === "Hand off to Mend…"));
          await open();
          await quickInput.cancel();
        } else if (mode === "terms-refused") {
          await command();
          await quickInput.waitFor();
          await waitUntil("typed store refusal", async () =>
            (await read()).prompt.includes("co-located"),
          );
          await quickInput.cancel();
        }
        await shot(`handoff-${mode}`);
        return {
          observed: "fixture response classified",
          items,
          palette: rows,
        };
      });
    await step("lane 8: origin changed after preview refuses before a receive", async () => {
      await open();
      const origin = git("remote", "get-url", "origin");
      const n = received().length;
      git("remote", "set-url", "origin", "https://github.com/foreign/other.git");
      try {
        await quickInput.type("");
        await quickInput.accept();
        await told(/origin changed/);
        assert.equal(received().length, n);
      } finally {
        git("remote", "set-url", "origin", origin);
      }
    });
    await step(
      "lane 8: several local roots ask which repository, without choosing the first store match",
      async () => {
        const workspace = join(dirname(state.checkout), "handoff.code-workspace");
        writeFileSync(
          workspace,
          JSON.stringify({
            folders: [{ path: state.checkout }, { path: second }],
          }),
        );
        const known = await windows();
        await openFolder(workspace);
        const opened = await waitForWindow(known, 180_000);
        otherWindows.push(opened);
        await useWindow(opened);
        await command();
        await quickInput.waitFor();
        await waitUntil(
          "the repository pick's title",
          async () => (await quickInput.title()).includes("choose a repository"),
          60_000,
        );
        const n = writes().length;
        await quickInput.cancel();
        assert.equal(writes().length, n);
        await goHome();
      },
    );
    await step(
      "lane 1 setup: committed env history is an explicit exception",
      async () => {
        writeFileSync(join(state.checkout, ".env.example"), "EXAMPLE=value\n");
        git("add", ".env.example");
        git("commit", "-m", "document example environment");
        return { commit: git("rev-parse", "--short=7", "HEAD") };
      },
      { via: "setup" },
    );
    await step("lane 1: committed env is named beside the facts and in exclusions", async () => {
      const seen = await open();
      assertText(seen.prompt, ".env.example is already in commit");
      assertText(seen.prompt, "it travels in history");
      await quickInput.button("Files left out…");
      assert.ok((await listed()).some((row) => row.label === ".env.example"));
      await shot("handoff-committed-env");
      await quickInput.back();
      await quickInput.cancel();
    });
    await step(
      "ordinary Git refresh: record editor metadata changes separately from the strict proof",
      async () => {
        userSettings({ "git.autorefresh": true });
        await sleep(3000);
        const controlBefore = snapshot();
        await sleep(1000);
        const controlAfter = snapshot();
        await open();
        await quickInput.cancel();
        await sleep(1000);
        const after = snapshot();
        note(
          "This lane observes VS Code's ordinary Git refresh. Its fingerprints include index changes; no paths are masked. Strict cancellation evidence is in lane 2.",
        );
        userSettings({ "git.autorefresh": false });
        await sleep(2000);
        return {
          controlBefore,
          controlAfter,
          after,
          observed: "ordinary refresh fingerprints, separate from strict invariant checks",
        };
      },
      { via: "setup" },
    );
    await step(
      "lane 4: Open honors the new-window setting and attaches the held workspace",
      async () => {
        // Remote-SSH reaches the workspace through the server's own address, not the proxy's.
        useServer(state.server.origin);
        await sleep(3000);
        nextCut("open");
        await open();
        const known = await windows();
        const result = await accept("", state.project.id, () => answer(DONE, "Open"));
        const opened = await waitForWindow(known, 600_000);
        await useWindow(opened);
        await h.statusBar(/SSH:/).waitFor(600_000);
        await h.terminal().waitForText(/shell|bash|\$/, 120_000);
        await shot("handoff-open");
        await closeWindow(opened);
        await goHome();
        useServer(proxy.url);
        await sleep(3000);
        return result.worktree.name;
      },
    );
    // Last: refusal tombstones this editor's credential, as it should.
    await step("lane 8: auth refusal removes the action", async () => {
      proxy.controls.mode = "unauthorized";
      await refresh();
      const rows = await waitUntil(
        "the command gone from the palette",
        async () => {
          const found = await paletteRows("Mend: Hand off");
          return found.some((row) => row.label === COMMAND) ? null : found;
        },
        120_000,
      );
      await view("Source Control");
      const items = await overflowItems();
      assert.ok(!items.some((item) => item.label === "Hand off to Mend…" && !item.disabled));
      await shot("handoff-unauthorized");
      return { items, palette: rows };
    });
    note(
      "Lane 9 unrun: provision a bridge-mode server and a private origin accessible only through the local SSH agent; public clones are not bridge evidence.",
    );
  } finally {
    proxy.release();
    await goHome().catch(() => undefined);
    writeFileSync(cliFile, oldCli, { mode: 0o600 });
    writeFileSync(settingsFile, oldSettings);
    await proxy.close();
    note(
      "The isolated world's fixture branches and adopted projects are retained for evidence. Destroy the drive-vscode world after review.",
    );
  }
};
