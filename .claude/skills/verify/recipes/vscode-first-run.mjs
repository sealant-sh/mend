// Story h, first run, as Dana meets it in VS Code. Which half runs is the world's:
//
// - From `up --signed-out --no-ssh-setup --no-remote-ssh` (nothing set up): h1's welcome
//   `Connect VS Code to your Mend server.`; Connect's one URL input, which warns about plain http to
//   another machine and says nothing for loopback; the approve page denied once in a browser of her
//   own (one error toast with Try again), then Try again and Authorize (one success toast, the code
//   in the status bar meanwhile, the account in the Accounts menu); h3's Set up, which installs
//   Remote-SSH, registers the key, writes one Host block and seeds the platform, after which Open
//   asks nothing; h4's Adopt <repo> from <origin> on an unadopted window, and Adopt a repository…
//   in an empty window; the editor's device revoked on the server, after which the Accounts menu
//   drops the account and one toast says sign in again, whose Connect to server signs in again;
//   Connect again while connected, which leaves one device; then Sign Out from the Accounts menu,
//   which revokes the editor's device and toasts only what Mend answered.
// - From `up --cli-only --no-ssh-setup --no-remote-ssh` (the Mend CLI signed in, the editor not
//   connected): the h1 variant `Use it`, one click with no URL and no browser; then Set up skipped;
//   Connect cancelled while its sign-in request is still out (held by a loopback proxy), which opens
//   no approve page; Open's one deferred consent cancelled, which installs nothing; then Open shows
//   it once more and opens after Set up.
//
//   node .claude/skills/verify/scripts/drive-vscode.mjs run \
//     .claude/skills/verify/recipes/vscode-first-run.mjs --out <dir>
//
// The approve page is the web's own `/authorize`, opened in Playwright's chromium (not the editor's
// Electron): the editor's external browser is `up`'s recorder, so the URL VS Code was asked to open
// is read from it, and the browser signs in on the web's sign-in page as the run's account first.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const CONNECT = "Connect VS Code to your Mend server.";
const SET_UP = "Open sessions in VS Code: needs Remote-SSH and an SSH key for Mend";
const PLAIN_HTTP = "Plain http: the token travels unencrypted";
const CONSENT = "Set up workspace SSH to open sessions (one Host block in ~/.ssh/config)";
const SETTING_UP = "Setting up: Remote-SSH · an SSH key for Mend · one Host block in ~/.ssh/config";
const WARM = "fresh worktree";

const expect = (holds, message) => {
  if (!holds) throw new Error(message);
};

const shown = (seen) =>
  seen === null
    ? "the window navigated, its watch went with it"
    : `toasts ${JSON.stringify(seen.toasts)} · dialogs ${JSON.stringify(seen.dialogs)} · quick inputs ${JSON.stringify(seen.quickInputs)}`;

/** The scratch HOME's ~/.ssh/config Host blocks Mend wrote (`mend-ws-…`). */
const mendHostBlocks = (state) =>
  readFileSync(join(state.sshDir, "config"), "utf8")
    .split("\n")
    .filter((line) => /^Host mend-ws-/.test(line));

const userSettings = (state) =>
  JSON.parse(readFileSync(join(state.userData, "User", "settings.json"), "utf8"));

const remoteSshInstalled = (state) =>
  existsSync(state.extensions) &&
  readdirSync(state.extensions).some((name) => name.startsWith("ms-vscode-remote.remote-ssh-"));

export default async (h) => {
  const { state, step, note } = h;
  if (state.signedIn === false) await signedOut(h);
  else if (state.editorConnected === false) await cliSignedIn(h);
  else throw new Error("this recipe needs `up --signed-out …` or `up --cli-only …`");
  note(`run ${state.run ?? ""} · server ${state.server.image}`);
  await step(
    "the world after the recipe",
    async () =>
      `Host blocks ${JSON.stringify(mendHostBlocks(state))} · Remote-SSH installed ${remoteSshInstalled(state)}`,
    { via: "setup" },
  );
};

/** The sessions tree's top rows once the welcome has gone; null while a welcome shows. */
const sessionsTree = async (h) => {
  if ((await h.welcome()) !== null) return null;
  const rows = (await h.viewRows()).rows.map((row) => row.label);
  return rows.includes("Projects") ? rows : null;
};

/**
 * An offer: the view's message saying the facts, and the one row that acts (VS Code's welcome
 * cannot carry facts). Null until the row labelled `label` shows.
 */
const offered = async (h, label) => {
  const { message, rows } = await h.viewRows();
  const labels = rows.map((row) => row.label);
  // The row and the message reach the workbench as two updates: a read between them sees the row
  // alone (fr4a2's step 11).
  return labels.length === 1 && labels[0] === label && message !== ""
    ? { message, rows: labels }
    : null;
};

/** The warm session's row, under Projects and its project, both collapsed until opened. */
const revealWarm = async (h) => {
  const { treeItem, viewRows, state } = h;
  const open = async (label) => {
    const row = (await viewRows()).rows.find((one) => one.label === label);
    if (row !== undefined && row.expanded === "false") await treeItem(label).click();
  };
  await open("Projects");
  await treeItem(state.project.name).waitFor();
  await open(state.project.name);
  await treeItem(WARM).waitFor(60_000);
};

const firstWindow = async (h) => {
  const { useWindow, homeWindow, quickInput, page, view } = h;
  await useWindow(await homeWindow());
  for (let tries = 0; tries < 3; tries += 1) {
    if (!(await page().locator(".context-view .monaco-menu").first().isVisible())) break;
    await page().keyboard.press("Escape");
  }
  if (await quickInput.isOpen()) await quickInput.cancel();
  const skip = page().getByText("Continue without Signing In");
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await view("Mend");
};

/**
 * One Connect walk up to the approve page: the URL accepted, VS Code's "open the external
 * website?" answered Open, and the page it handed the browser. Returns the code the progress
 * notification shows and the page.
 */
const toApprovePage = async (h, { url }) => {
  const { quickInput, notification, statusBar, dialog, browserOpened, waitUntil, shot } = h;
  await quickInput.type(url);
  const opened = browserOpened().length;
  await quickInput.accept();
  const progress = notification("Approve in the browser if it shows");
  await progress.waitFor(60_000);
  const progressText = await progress.text();
  const code = /shows ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(progressText)?.[1] ?? null;
  expect(code !== null, `no code in the progress notification: "${progressText}"`);
  const reminder = await statusBar("Mend sign-in").text();
  expect(reminder.includes(code), `the status bar does not keep the code: "${reminder}"`);
  const ask = dialog("external website");
  await ask.waitFor(30_000);
  const asked = await ask.text();
  await ask.click("Open");
  // After the dialog: it shows the approve link, which a screenshot must not keep.
  await shot("approve-in-the-browser");
  const page = await waitUntil(
    "the URL VS Code handed its browser",
    () => browserOpened().slice(opened)[0] ?? null,
    30_000,
  );
  return { code, progressText, reminder, asked, page };
};

/** The approve page, as she sees it in her browser: signed in first if the web asks. */
const approvePage = async (web, page) => {
  await web.goto(page);
  await web.waitForText(/Sign in|Authorize VS Code\?/, 60_000);
  if (!(await web.text()).includes("Authorize VS Code?")) {
    await web.signIn();
    await web.waitForText("Authorize VS Code?", 60_000);
  }
  return web.text();
};

/**
 * Mend's server behind a loopback port that holds every `POST /api/cli/auth` until `release()`
 * before passing it on: a sign-in request still out while she cancels. `boundMs` caps the hold, so
 * a run that never releases cannot hang.
 */
const slowSignInServer = (origin, boundMs) =>
  new Promise((resolve) => {
    let held = 0;
    let answered = 0;
    const released = Promise.withResolvers();
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const holding = request.method === "POST" && request.url === "/api/cli/auth";
      if (holding) {
        held += 1;
        const bound = setTimeout(released.resolve, boundMs);
        await released.promise;
        clearTimeout(bound);
      }
      const upstream = await fetch(new URL(request.url ?? "/", origin), {
        method: request.method,
        headers: { "content-type": request.headers["content-type"] ?? "application/json" },
        body: chunks.length === 0 ? undefined : Buffer.concat(chunks),
      });
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      response.end(Buffer.from(await upstream.arrayBuffer()));
      if (holding) answered += 1;
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        held: () => held,
        release: () => released.resolve(),
        answered: () => answered,
        close: () => {
          released.resolve();
          return new Promise((done) => server.close(done));
        },
      });
    });
  });

async function signedOut(h) {
  const {
    state,
    step,
    shot,
    welcome,
    welcomeAction,
    viewRows,
    quickInput,
    notification,
    notifications,
    statusBarItems,
    dialog,
    dialogs,
    watch,
    accounts,
    browser,
    browserOpened,
    treeItem,
    windows,
    newWindows,
    waitForWindow,
    useWindow,
    homeWindow,
    palette,
    waitUntil,
    statusBar,
    waitForText,
    api,
    opens,
    sleep,
  } = h;
  const origin = state.server.origin;
  const host = new URL(origin).hostname;
  const email = state.account.email;
  const signedInToast = `Signed in to ${host} as ${email}`;
  const web = await browser();
  /** The editor's devices under Settings → Devices, as Mend lists them. */
  const devices = async () =>
    (await api("/me/devices")).filter((device) => /^VS Code on /.test(device.name));
  /** One Connect walk from its URL input, authorized in the browser, to its one success toast. */
  const authorize = async () => {
    const walk = await toApprovePage(h, { url: origin });
    const pageText = await approvePage(web, walk.page);
    expect(pageText.includes(walk.code), `the approve page does not show ${walk.code}`);
    await web.click("Authorize");
    await web.waitForText("Authorized");
    await notification(signedInToast).waitFor(30_000);
    return walk;
  };

  await step(
    "the world: nothing set up",
    async () => {
      expect(!remoteSshInstalled(state), "Remote-SSH is installed: up --no-remote-ssh");
      expect(mendHostBlocks(state).length === 0, "a Mend Host block exists: up --no-ssh-setup");
      expect(userSettings(state)["mend.serverUrl"] === undefined, "mend.serverUrl is set");
      return `no Remote-SSH · no Mend Host block · no mend.serverUrl · no cli.json (${existsSync(join(state.configHome, "mend", "cli.json")) ? "present" : "absent"})`;
    },
    { via: "setup" },
  );

  await step("h1: the Mend view welcomes her with Connect", async () => {
    await firstWindow(h);
    const said = await waitUntil(
      "the Connect welcome",
      async () => {
        const seen = await welcome();
        return seen?.lines.includes(CONNECT) ? seen : null;
      },
      60_000,
    );
    await shot("h1-connect");
    const mendStatus = (await statusBarItems()).filter((text) => text.startsWith("Mend"));
    expect(
      JSON.stringify(said.buttons) === '["Connect"]',
      `buttons ${JSON.stringify(said.buttons)}`,
    );
    expect(mendStatus.length === 0, `the status bar says ${JSON.stringify(mendStatus)}`);
    return `welcome ${JSON.stringify(said.lines)} · buttons ${JSON.stringify(said.buttons)} · rows ${(await viewRows()).rows.length} · Mend status bar items ${mendStatus.length}`;
  });

  await step(
    "h2a: Connect asks one URL; loopback reads nothing, a plain-http server elsewhere warns",
    async () => {
      await welcomeAction("Connect").click();
      await quickInput.waitFor();
      const title = await quickInput.title();
      const value = await quickInput.value();
      await quickInput.type("http://localhost:3105");
      await sleep(500);
      const loopback = await quickInput.validation();
      await quickInput.type(origin);
      const warned = await waitUntil(
        "the plain-http warning",
        async () =>
          (await quickInput.validation())?.message.includes("Plain http")
            ? quickInput.validation()
            : null,
        10_000,
      );
      await shot("h2a-plain-http-warning");
      expect(title?.startsWith("Connect to your Mend server"), `title "${title}"`);
      expect(loopback === null, `loopback said ${JSON.stringify(loopback)}`);
      expect(warned.message === PLAIN_HTTP, `warning ${JSON.stringify(warned)}`);
      expect(warned.severity !== "error", `the warning blocks: ${JSON.stringify(warned)}`);
      return `title "${title}" · value "${value}" · http://localhost:3105 → ${JSON.stringify(loopback)} · ${origin} → ${JSON.stringify(warned)}`;
    },
  );

  await step(
    "edge: denied in the browser ends the progress in one error toast with Try again",
    async () => {
      const watching = await watch();
      const walk = await toApprovePage(h, { url: origin });
      const pageText = await approvePage(web, walk.page);
      expect(pageText.includes(walk.code), `the approve page does not show ${walk.code}`);
      await web.shot("h2b-approve-page-deny");
      await web.click("Deny");
      await web.waitForText("Denied");
      const failed = notification("Sign-in denied in the browser.");
      await failed.waitFor(30_000);
      await sleep(3_000);
      const seen = await watching.stop();
      await shot("edge-denied");
      const errors = (seen?.toasts ?? []).filter((text) => text.includes("denied"));
      const progressLeft = (await notifications()).some((text) =>
        text.includes("Approve in the browser"),
      );
      expect(errors.length === 1, `error toasts ${JSON.stringify(seen?.toasts)}`);
      expect((await failed.text()).includes("Try again"), "the error offers no Try again");
      expect(!progressLeft, "the progress notification is still up");
      return `page ${walk.page.replace(/code=[^&]+/, "code=<code>")} · progress "${walk.progressText}" · status bar "${walk.reminder}" · asked "${walk.asked}" · browser page shows the code · ${shown(seen)} · progress gone`;
    },
  );

  await step(
    "h2b-h2c: Try again, the URL kept; Authorize in the browser; exactly one success toast",
    async () => {
      const watching = await watch();
      await notification("Sign-in denied in the browser.").click("Try again");
      await quickInput.waitFor();
      const kept = await quickInput.value();
      expect(kept === origin, `Try again starts from "${kept}"`);
      const walk = await toApprovePage(h, { url: origin });
      const pageText = await approvePage(web, walk.page);
      expect(pageText.includes(walk.code), `the approve page does not show ${walk.code}`);
      await web.shot("h2b-approve-page-authorize");
      await web.click("Authorize");
      await web.waitForText("Authorized");
      const toast = `Signed in to ${host} as ${email}`;
      await notification(toast).waitFor(30_000);
      await sleep(5_000);
      const seen = await watching.stop();
      await shot("h2c-signed-in");
      const successes = (seen?.toasts ?? []).filter((text) => /Signed in|Connected to/.test(text));
      const reminder = (await statusBarItems()).filter((text) => text.includes("Mend sign-in"));
      expect(successes.length === 1, `success toasts ${JSON.stringify(successes)}`);
      expect(successes[0].startsWith(toast), `toast "${successes[0]}"`);
      expect(reminder.length === 0, `the status bar still says ${JSON.stringify(reminder)}`);
      return `URL kept "${kept}" · progress "${walk.progressText}" · success toasts ${JSON.stringify(successes)} · ${shown(seen)} · status bar code gone`;
    },
  );

  await step("h2c: the account in VS Code's Accounts menu", async () => {
    const items = await accounts({ shot: "h2c-accounts-menu" });
    const mine = items.filter((item) => item.includes(email));
    expect(mine.length === 1, `Accounts menu ${JSON.stringify(items)}`);
    return `Accounts menu ${JSON.stringify(items)}`;
  });

  await step("h3: the welcome's next step is Set up", async () => {
    const said = await waitUntil(
      "the Set up welcome",
      async () => {
        const seen = await welcome();
        return seen?.lines.includes(SET_UP) ? seen : null;
      },
      60_000,
    );
    await shot("h3-set-up");
    expect(said.buttons.includes("Set up"), `buttons ${JSON.stringify(said.buttons)}`);
    return `welcome ${JSON.stringify(said.lines)} · buttons ${JSON.stringify(said.buttons)} · links ${JSON.stringify(said.links)}`;
  });

  let alias = null;
  await step(
    "h3: Set up installs Remote-SSH, registers the key, writes one Host block, seeds the platform",
    async () => {
      const keysBefore = (await api("/workspace-ssh")).keys.length;
      const watching = await watch();
      await welcomeAction("Set up").click();
      const progress = notification("Setting up");
      const progressText = await progress
        .waitFor(30_000)
        .then(() => progress.text())
        .catch(() => null);
      if (progressText !== null) await shot("h3-setting-up");
      await waitUntil("the sessions tree in place of the welcome", () => sessionsTree(h), 600_000);
      await revealWarm(h);
      const seen = await watching.stop();
      await shot("h3-done");
      const blocks = mendHostBlocks(state);
      alias = blocks[0]?.replace(/^Host /, "") ?? null;
      const platforms = userSettings(state)["remote.SSH.remotePlatform"] ?? {};
      const keys = (await api("/workspace-ssh")).keys;
      expect(remoteSshInstalled(state), "Remote-SSH is not in the extensions directory");
      expect(blocks.length === 1, `Host blocks ${JSON.stringify(blocks)}`);
      expect(
        alias !== null && platforms[alias] === "linux",
        `platforms ${JSON.stringify(platforms)}`,
      );
      expect(keys.length === keysBefore + 1, `keys ${keysBefore} → ${keys.length}`);
      expect(seen === null || seen.dialogs.length === 0, `it asked: ${shown(seen)}`);
      return `progress "${progressText ?? "not caught"}" · Remote-SSH installed · Host blocks ${JSON.stringify(blocks)} · remote.SSH.remotePlatform ${JSON.stringify(platforms)} · keys ${keysBefore} → ${keys.length} · ${shown(seen)}`;
    },
  );

  await step("h3: Open (in a new window) opens the workspace and nothing asks", async () => {
    await firstWindow(h);
    await revealWarm(h);
    const known = await windows();
    const opensBefore = await opens();
    const watching = await watch();
    await treeItem(WARM).contextMenu("Mend: Open in New Window");
    const opened = await newWindows(known, { settle: 10_000, limit: 600_000 });
    const seen = await watching.stop();
    expect(opened.length === 1, `${opened.length} window(s) opened`);
    await useWindow(opened[0]);
    await statusBar(/SSH:/).waitFor(600_000);
    await waitForText("README", { timeout: 120_000 });
    const asked = await dialogs();
    await shot("h3-open-nothing-asked");
    const opensAfter = await opens();
    const title = await opened[0].title();
    await useWindow(await homeWindow());
    expect(
      seen === null || (seen.dialogs.length === 0 && seen.quickInputs.length === 0),
      `something asked: ${shown(seen)}`,
    );
    expect(asked.length === 0, `dialogs ${JSON.stringify(asked)}`);
    return `windows opened 1 · opens ${opensBefore} → ${opensAfter} · title "${title}" · ${shown(seen)}`;
  });

  await step(
    "setup for h4: the project's sessions stopped and the project removed, as on a server with none",
    async () => {
      const detail = await api(`/projects/${state.project.id}`);
      for (const session of detail.sessions)
        if (!["completed", "failed", "stopped"].includes(session.status))
          await api(`/sessions/${session.id}/stop`, { method: "POST", body: "{}" }).catch(
            () => null,
          );
      await waitUntil(
        "the sessions to settle",
        async () => {
          const now = await api(`/projects/${state.project.id}`);
          return now.sessions.every((session) =>
            ["completed", "failed", "stopped"].includes(session.status),
          )
            ? true
            : null;
        },
        300_000,
      );
      await api(`/projects/${state.project.id}`, { method: "DELETE" });
      return `projects now ${(await api("/projects")).length}`;
    },
    { via: "api" },
  );

  await step(
    "h4: a window on a repository Mend does not have offers Adopt, one click",
    async () => {
      await firstWindow(h);
      const offer = await waitUntil("the Adopt offer", () => offered(h, "Adopt"), 60_000);
      await shot("h4-adopt");
      const watching = await watch();
      await treeItem("Adopt").click();
      const rows = await waitUntil(
        "the sessions tree after the adopt",
        () => sessionsTree(h),
        600_000,
      );
      const seen = await watching.stop();
      await shot("h4-adopted");
      const projects = await api("/projects");
      expect(
        offer.message === "Adopt hello-world from github.com/octocat/Hello-World",
        `message "${offer.message}"`,
      );
      expect(projects.length === 1, `projects ${projects.length}`);
      expect(seen === null || seen.quickInputs.length === 0, `Adopt asked: ${shown(seen)}`);
      return `message "${offer.message}" · rows ${JSON.stringify(offer.rows)} · adopted ${JSON.stringify(projects.map((one) => [one.name, one.originUrl]))} · then rows ${JSON.stringify(rows)} · ${shown(seen)}`;
    },
  );

  await step(
    "setup for h4's empty window: the adopted project removed again",
    async () => {
      for (const project of await api("/projects"))
        await api(`/projects/${project.id}`, { method: "DELETE" });
      return `projects now ${(await api("/projects")).length}`;
    },
    { via: "api" },
  );

  await step(
    "h4: an empty window offers Adopt a repository…, which asks for a clone URL",
    async () => {
      const known = await windows();
      await palette("New Window");
      const empty = await waitForWindow(known);
      await useWindow(empty);
      await sleep(3_000);
      await firstWindow(h);
      await useWindow(empty);
      await h.view("Mend");
      const said = await waitUntil(
        "the Adopt a repository welcome",
        async () => {
          const seen = await welcome();
          return seen?.buttons.some((button) => button.startsWith("Adopt a repository"))
            ? seen
            : null;
        },
        60_000,
      );
      await shot("h4-empty-window");
      await welcomeAction("Adopt a repository").click();
      await quickInput.waitFor();
      const title = await quickInput.title();
      await quickInput.type("https://github.com/octocat/Hello-World.git");
      await quickInput.accept();
      await waitUntil(
        "the adopted project in the view",
        async () => ((await welcome()) === null ? true : null),
        600_000,
      );
      await shot("h4-empty-window-adopted");
      const projects = await api("/projects");
      await h.closeWindow(empty);
      await useWindow(await homeWindow());
      expect(projects.length === 1, `projects ${projects.length}`);
      return `welcome ${JSON.stringify(said.lines)} · buttons ${JSON.stringify(said.buttons)} · input "${title}" · adopted ${JSON.stringify(projects.map((one) => one.name))}`;
    },
  );

  await step(
    "setup for the refused token: the editor's device revoked, as Settings → Devices does",
    async () => {
      const listed = await devices();
      expect(listed.length === 1, `VS Code devices ${JSON.stringify(listed)}`);
      const [revoked] = listed;
      await api(`/me/devices/${encodeURIComponent(revoked.id)}`, { method: "DELETE" });
      return `revoked "${revoked.name}" · VS Code devices now ${(await devices()).length}`;
    },
    { via: "api" },
  );

  await step(
    "edge: Mend refuses the token; the Accounts menu drops the account, one toast says sign in again",
    async () => {
      await firstWindow(h);
      const watching = await watch();
      await palette("Mend: Refresh");
      const toast = notification("Signed out — sign in again.");
      await toast.waitFor(60_000);
      const said = await waitUntil(
        "the Connect welcome",
        async () => {
          const seen = await welcome();
          return seen?.lines.includes(CONNECT) ? seen : null;
        },
        60_000,
      );
      await sleep(5_000);
      const seen = await watching.stop();
      await shot("edge-refused-token");
      const toastText = await toast.text();
      const items = await accounts({ shot: "edge-refused-accounts-menu" });
      const signedOut = (seen?.toasts ?? []).filter((text) => text.includes("sign in again"));
      expect(signedOut.length === 1, `sign-in toasts ${JSON.stringify(seen?.toasts)}`);
      expect(toastText.includes("Connect to server"), `the toast reads "${toastText}"`);
      expect(!items.some((item) => item.includes(email)), `Accounts menu ${JSON.stringify(items)}`);
      return `toast "${toastText}" · ${shown(seen)} · welcome ${JSON.stringify(said.lines)} · Accounts menu ${JSON.stringify(items)}`;
    },
  );

  await step(
    "edge: Connect to server on that toast signs her in again, one success toast",
    async () => {
      const watching = await watch();
      await notification("Signed out — sign in again.").click("Connect to server");
      await quickInput.waitFor();
      const kept = await quickInput.value();
      await authorize();
      await sleep(5_000);
      const seen = await watching.stop();
      await shot("edge-signed-in-again");
      const successes = (seen?.toasts ?? []).filter((text) => text.startsWith("Signed in to"));
      const listed = await devices();
      const items = await accounts();
      expect(kept === origin, `the URL input starts from "${kept}"`);
      expect(successes.length === 1, `success toasts ${JSON.stringify(seen?.toasts)}`);
      expect(listed.length === 1, `VS Code devices ${JSON.stringify(listed)}`);
      expect(
        items.some((item) => item.includes(email)),
        `Accounts menu ${JSON.stringify(items)}`,
      );
      return `URL input "${kept}" · ${shown(seen)} · VS Code devices ${listed.length} · Accounts menu ${JSON.stringify(items)}`;
    },
  );

  await step(
    "h2: Connect again while connected revokes the device it replaced; Settings → Devices keeps one",
    async () => {
      const [before] = await devices();
      // The watch names a toast once per window, and this one reads as the last step's did: count
      // what shows instead, from a screen where the last one has hidden.
      const visibleSuccesses = async () =>
        (await notifications()).filter((text) => text.includes(signedInToast)).length;
      await waitUntil(
        "the last sign-in's toast hidden",
        async () => ((await visibleSuccesses()) === 0 ? true : null),
        120_000,
      );
      const watching = await watch();
      await palette("Mend: Connect to server");
      await quickInput.waitFor();
      const kept = await quickInput.value();
      await authorize();
      const successes = await visibleSuccesses();
      const after = await waitUntil(
        "the replaced device revoked",
        async () => {
          const listed = await devices();
          return listed.length === 1 && listed[0].id !== before.id ? listed : null;
        },
        60_000,
      );
      await sleep(3_000);
      const seen = await watching.stop();
      await shot("h2-connect-again");
      const warnings = (seen?.toasts ?? []).filter((text) => text.includes("earlier device"));
      expect(kept === origin, `the URL input starts from "${kept}"`);
      expect(successes === 1, `success toasts showing ${successes}`);
      expect(warnings.length === 0, `warnings ${JSON.stringify(warnings)}`);
      return `URL input "${kept}" · success toasts showing ${successes} · VS Code devices 1 → ${after.length} (a new device in place of the one replaced) · ${shown(seen)}`;
    },
  );

  await step(
    "Accounts menu: Sign Out revokes the editor's device and the view says Connect",
    async () => {
      const before = await devices();
      await firstWindow(h);
      const watching = await watch();
      await accounts({ signOut: email });
      // VS Code's own question before any provider's sign-out.
      const ask = dialog("Sign out of");
      await ask.waitFor();
      const confirm = await ask.text();
      await shot("sign-out-confirm");
      await ask.click("Sign Out");
      const said = await waitUntil(
        "the Connect welcome",
        async () => {
          const seen = await welcome();
          return seen?.lines.includes(CONNECT) ? seen : null;
        },
        60_000,
      );
      await sleep(5_000);
      const seen = await watching.stop();
      await shot("signed-out");
      const after = await devices();
      const items = await accounts();
      const toasts = seen?.toasts ?? [];
      expect(
        before.length === 1 && after.length === 0,
        `devices ${before.length} → ${after.length}`,
      );
      expect(!items.some((item) => item.includes(email)), `Accounts menu ${JSON.stringify(items)}`);
      expect(
        toasts.length === 1 && toasts[0].includes("and revoked this editor's device."),
        `toasts ${JSON.stringify(toasts)}`,
      );
      return `confirm ${JSON.stringify(confirm)} · VS Code devices ${before.length} → ${after.length} · welcome ${JSON.stringify(said.lines)} · Accounts menu ${JSON.stringify(items)} · ${shown(seen)}`;
    },
  );

  await web.close();
  h.note(`browser pages handed out: ${browserOpened().length}`);
}

async function cliSignedIn(h) {
  const {
    state,
    step,
    shot,
    palette,
    quickInput,
    notification,
    notifications,
    dialogs,
    sleep,
    welcome,
    welcomeAction,
    viewRows,
    watch,
    accounts,
    browserOpened,
    treeItem,
    windows,
    newWindows,
    useWindow,
    homeWindow,
    dialog,
    statusBar,
    waitForText,
    waitUntil,
    opens,
  } = h;
  const origin = state.server.origin;
  const email = state.account.email;

  await step(
    "the world: the Mend CLI signed in, the editor not connected, no workspace SSH",
    async () => {
      expect(existsSync(join(state.configHome, "mend", "cli.json")), "no cli.json: up --cli-only");
      expect(userSettings(state)["mend.serverUrl"] === undefined, "mend.serverUrl is set");
      expect(mendHostBlocks(state).length === 0, "a Mend Host block exists: up --no-ssh-setup");
      return `cli.json for ${origin} · no mend.serverUrl · no Mend Host block · Remote-SSH installed ${remoteSshInstalled(state)}`;
    },
    { via: "setup" },
  );

  await step("h1 variant: the view offers the CLI's sign-in, Use it", async () => {
    await firstWindow(h);
    const offer = await waitUntil("the Use it offer", () => offered(h, "Use it"), 60_000);
    await shot("h1-use-it");
    const words = `Mend at ${new URL(origin).host} · signed in as ${email} (from the Mend CLI)`;
    expect(offer.message === words, `message "${offer.message}"`);
    return `message "${offer.message}" · rows ${JSON.stringify(offer.rows)}`;
  });

  await step("h1 variant: Use it connects with no URL, no browser and no toast", async () => {
    const opened = browserOpened().length;
    const watching = await watch();
    await treeItem("Use it").click();
    const next = await waitUntil(
      "the Set up welcome",
      async () => {
        const seen = await welcome();
        return seen?.lines.includes(SET_UP) ? seen : null;
      },
      60_000,
    );
    const seen = await watching.stop();
    await shot("h1-used");
    const items = await accounts({ shot: "h1-accounts-menu" });
    expect(seen !== null && seen.quickInputs.length === 0, `an input showed: ${shown(seen)}`);
    expect(seen.dialogs.length === 0 && seen.toasts.length === 0, `it said: ${shown(seen)}`);
    expect(browserOpened().length === opened, "a browser page was opened");
    expect(
      items.some((item) => item.includes(email)),
      `Accounts menu ${JSON.stringify(items)}`,
    );
    expect(userSettings(state)["mend.serverUrl"] === origin, "mend.serverUrl was not written");
    return `${shown(seen)} · browser pages ${browserOpened().length - opened} · next welcome ${JSON.stringify(next.lines)} · Accounts menu ${JSON.stringify(items)}`;
  });

  await step("edge: she skips Set up; the view shows her sessions", async () => {
    await welcomeAction("Skip for now").click();
    await waitUntil("the sessions tree in place of the welcome", () => sessionsTree(h), 60_000);
    await revealWarm(h);
    await shot("skipped-set-up");
    const rows = (await viewRows()).rows.map(
      (row) => `${row.label}${row.description === "" ? "" : ` · ${row.description}`}`,
    );
    expect(mendHostBlocks(state).length === 0, "skipping wrote a Host block");
    const running = (await viewRows()).rows.find(
      (row) => row.level === 1 && row.label === "Running",
    );
    expect(
      running?.description === "nothing" && running.expanded === "true",
      `Running after the welcome: ${JSON.stringify(running)}`,
    );
    return `rows ${JSON.stringify(rows)} · Running drawn empty, expanded ${running.expanded} · Host blocks 0`;
  });

  await step(
    "edge: Connect cancelled while its sign-in request is out opens no approve page and keeps the connection",
    async () => {
      const slow = await slowSignInServer(origin, 300_000);
      try {
        const opened = browserOpened().length;
        const watching = await watch();
        await palette("Mend: Connect to server");
        await quickInput.waitFor();
        await quickInput.type(slow.url);
        await quickInput.accept();
        await waitUntil(
          "the sign-in request held at the proxy",
          async () => (slow.held() === 1 ? true : null),
          30_000,
        );
        const asking = notification(`Asking ${new URL(slow.url).host} for a sign-in code`);
        await asking.waitFor(30_000);
        await shot("edge-sign-in-asking");
        await asking.click("Cancel");
        slow.release();
        await waitUntil(
          "the held sign-in request answered",
          async () => (slow.answered() === 1 ? true : null),
          30_000,
        );
        await sleep(5_000);
        const seen = await watching.stop();
        await shot("edge-sign-in-cancelled");
        const reminders = (seen?.statusBar ?? []).filter((text) => text.includes("Mend sign-in"));
        const asks = (seen?.dialogs ?? []).filter((text) => text.includes("external website"));
        if ((await dialogs()).some((text) => text.includes("external website")))
          await dialog("external website").click("Cancel");
        const progressLeft = (await notifications()).some((text) =>
          text.includes("Approve in the browser"),
        );
        expect(asks.length === 0, `VS Code asked to open the approve page: ${shown(seen)}`);
        expect(
          reminders.length === 0,
          `the status bar showed a code: ${JSON.stringify(reminders)}`,
        );
        expect(browserOpened().length === opened, "a browser page was opened");
        expect(!progressLeft, "the progress notification still asks her to approve");
        expect(
          userSettings(state)["mend.serverUrl"] === origin,
          `mend.serverUrl is ${userSettings(state)["mend.serverUrl"]}`,
        );
        return `held sign-in requests answered ${slow.answered()} · external-website dialogs ${asks.length} · sign-in status items ${reminders.length} · browser pages ${browserOpened().length - opened} · mend.serverUrl still ${origin} · ${shown(seen)}`;
      } finally {
        await slow.close();
      }
    },
  );

  await step(
    "edge: Open, then Cancel on the deferred consent: nothing installs, nothing opens",
    async () => {
      const known = await windows();
      const before = remoteSshInstalled(state);
      const watching = await watch();
      await treeItem(WARM).contextMenu("Mend: Open in New Window");
      const ask = dialog(CONSENT);
      await ask.waitFor(600_000);
      await shot("edge-deferred-consent-cancel");
      const whileAsking = remoteSshInstalled(state);
      await ask.click("Cancel");
      const opened = await newWindows(known, { settle: 10_000, limit: 30_000 });
      const seen = await watching.stop();
      const after = remoteSshInstalled(state);
      expect(!before, "Remote-SSH was installed before the open: up --no-remote-ssh");
      expect(!whileAsking, "Remote-SSH was installed before she answered the question");
      expect(!after, "Remote-SSH is installed after she cancelled");
      expect(opened.length === 0, `${opened.length} window(s) opened`);
      expect(mendHostBlocks(state).length === 0, "a Host block was written");
      return `Remote-SSH installed before ${before} · while asking ${whileAsking} · after Cancel ${after} · windows opened ${opened.length} · Host blocks 0 · ${shown(seen)}`;
    },
  );

  await step(
    "edge: Open then shows the deferred consent once; Set up opens the workspace",
    async () => {
      const known = await windows();
      const opensBefore = await opens();
      const watching = await watch();
      await treeItem(WARM).contextMenu("Mend: Open in New Window");
      const ask = dialog(CONSENT);
      await ask.waitFor(120_000);
      const asked = await ask.text();
      await shot("edge-deferred-consent");
      await ask.click("Set up");
      const opened = await newWindows(known, { settle: 10_000, limit: 600_000 });
      const seen = await watching.stop();
      expect(opened.length === 1, `${opened.length} window(s) opened`);
      await useWindow(opened[0]);
      await statusBar(/SSH:/).waitFor(600_000);
      await waitForText("README", { timeout: 120_000 });
      await shot("edge-consent-opened");
      const title = await opened[0].title();
      const opensAfter = await opens();
      await useWindow(await homeWindow());
      const consents = (seen?.dialogs ?? []).filter((text) =>
        text.includes("Set up workspace SSH"),
      );
      expect(consents.length === 1, `consent dialogs ${JSON.stringify(seen?.dialogs)}`);
      expect((seen?.quickInputs ?? []).length === 0, `a quick input showed: ${shown(seen)}`);
      expect(
        mendHostBlocks(state).length === 1,
        `Host blocks ${JSON.stringify(mendHostBlocks(state))}`,
      );
      return `asked "${asked}" · ${shown(seen)} · windows opened 1 · opens ${opensBefore} → ${opensAfter} · title "${title}" · Host blocks ${JSON.stringify(mendHostBlocks(state))}`;
    },
  );

  await step(
    "the tree after the welcome: Running, drawn empty when the welcome gave way, shows the opened session",
    async () => {
      const under = await waitUntil(
        `${WARM} under Running`,
        async () => {
          const { rows } = await viewRows();
          const at = rows.findIndex((row) => row.level === 1 && row.label === "Running");
          const first = rows[at + 1];
          return at >= 0 && first !== undefined && first.level >= 2
            ? { group: rows[at], first }
            : null;
        },
        120_000,
      );
      await shot("running-after-welcome");
      expect(under.group.expanded === "true", `Running ${JSON.stringify(under.group)}`);
      expect(under.first.label === WARM, `Running's first row ${JSON.stringify(under.first)}`);
      return `Running ${under.group.description} · expanded ${under.group.expanded} · first row "${under.first.label} · ${under.first.description}"`;
    },
  );
}
