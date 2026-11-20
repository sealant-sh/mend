// The Terminal view (apps/web, route PR 17, SLNT-1146, ADR 0026): this workspace's shells, each a
// live terminal in a tab. The old shell address redirects to the view's own address, which opens
// the session with the Terminal tab focused; New shell opens a shell, a command typed there prints
// its output, a link in the output opens with Ctrl and a click, the terminal follows its tile's
// size, its tab moves to another tile and maximises with its connection and scrollback kept, Close
// shell… stops it and it leaves the list, someone with shared control watches and can't type, the phone's width shows the
// picker, and /tty-embed (the phone app's page) attaches with an upgrade ticket. Run the CLI batch
// first, once per stack: it starts a `sleep` session in the worktree `term-ws`.
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-terminal-sessions.json
//   pnpm verify drive new-web --recipe new-web-terminal
//
// The terminal draws on a canvas, and the driver withholds every picture with a canvas in it: the
// terminal's states are kept as ARIA snapshots, and what it shows is read through its Copy action.
// The watcher is a fixture: the session's reads answered as if another member owned it and shared
// control. Stop the batch session afterwards (`mend stop <id>`, the id this recipe notes).
import { existsSync } from "node:fs";
import { join } from "node:path";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };
const TITLE = "Fix flaky checkout retry";
const WATCHED_BY = "fixture-owner";
const OWNER_NAME = "Grace Hopper";

/** Where an element is on screen; the recipe can't go on without it. */
const boxOf = async (locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("an element the recipe needs isn't on screen");
  return box;
};

export default async ({ page, web, capture: captureOnce, note }) => {
  // The driver may withhold a picture when the page inserts a subtree while it looks: look again.
  const out = process.argv[process.argv.indexOf("--out") + 1] ?? "";
  // Vite's dev server shows an overlay when its proxy of a closing terminal socket resets
  // (ECONNRESET): it is the dev server's, not the page's, and it covers the page. Take it away.
  const dismissOverlay = () =>
    page.evaluate(() =>
      document.querySelectorAll("vite-error-overlay").forEach((each) => each.remove()),
    );
  const capture = async (name) => {
    await dismissOverlay();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await captureOnce(name);
      if (existsSync(join(out, `${name}.png`)) || existsSync(join(out, `${name}.png.withheld`)))
        return;
      await page.waitForTimeout(400);
    }
  };
  const settled = () => page.waitForTimeout(500);
  // A theme switch opens the terminal again (ghostty-web reads its colours as it opens): after one,
  // wait for it to connect, and mark the new one if the old one was marked.
  const both = async (name) => {
    const marked = (await page.locator('canvas[data-recipe-mark="kept"]').count()) > 0;
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        (on) => document.documentElement.classList.toggle("dark", on),
        theme === "dark",
      );
      await settled();
      await capture(`${name}-${theme}`);
    }
    await page.evaluate(() => document.documentElement.classList.remove("dark"));
    await settled();
    if ((await body.getByRole("textbox", { name: "Terminal input" }).count()) > 0) await live();
    if (marked) await markTerminal();
  };
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined);
    await page.waitForFunction(() =>
      [...document.querySelectorAll("a[href], button")].some((element) =>
        Object.keys(element).some((key) => key.startsWith("__reactProps")),
      ),
    );
  };
  const open = async (path) => {
    await page.goto(`${web}${path}`);
    await hydrated();
  };
  const go = (path) => page.evaluate((to) => window["__TSR_ROUTER__"].navigate({ href: to }), path);
  const client = (fn, arg) =>
    page.evaluate(
      async ([source, value]) => {
        const trpc = window["__TSR_ROUTER__"].options.context.trpcClient;
        // eslint-disable-next-line no-new-func
        return new Function("trpc", "value", `return (${source})(trpc, value)`)(trpc, value);
      },
      [fn.toString(), arg],
    );

  const VIEW = "view:terminal";
  const tiles = () => page.locator("[data-tile]").filter({ visible: true });
  const tabOf = (key) =>
    page.locator(`[data-tab="${key}"]`).filter({ visible: true }).getByRole("tab");
  const tileOf = (key) =>
    page.locator("[data-tile]").filter({ has: page.locator(`[data-tab="${key}"]`) });
  const body = page.locator(`[data-tab-body="${VIEW}"]`);
  const list = body.getByRole("navigation", { name: "This workspace's shells" });
  const expectTiles = async (count, what) => {
    await page
      .waitForFunction(
        (n) =>
          [...document.querySelectorAll("[data-tile]")].filter((t) => t.getClientRects().length > 0)
            .length === n,
        count,
        { timeout: 5_000 },
      )
      .catch(async () => {
        throw new Error(`${what}: ${await tiles().count()} tiles on screen, not ${count}`);
      });
  };
  const drag = async (key, x, y) => {
    await dismissOverlay();
    const from = await boxOf(tabOf(key));
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, y, { steps: 14 });
    await page.waitForTimeout(150);
    await page.mouse.up();
    await page.waitForTimeout(400);
  };

  /** Copy writes here instead of the system clipboard, so the recipe reads what was copied. */
  const keepCopies = () =>
    page.evaluate(() => {
      window["__copied"] = [];
      navigator.clipboard.writeText = async (text) => {
        window["__copied"].push(text);
      };
    });
  /** The terminal's text, through its Copy (the header's in a wide tile, the picker's in a narrow one). */
  const terminalText = async () => {
    await dismissOverlay();
    await keepCopies();
    const header = body.getByRole("button", { name: "Copy", exact: true });
    if (await header.isVisible()) await header.click();
    else {
      await body.getByRole("button", { name: / shells?$/ }).click();
      await page.getByRole("menuitem", { name: "Copy text" }).click();
    }
    await page.waitForFunction(() => window["__copied"].length > 0);
    return page.evaluate(() => window["__copied"].at(-1));
  };
  /** The terminal, connected: its input is in the page and it says nothing about connecting. */
  const live = async () => {
    await body.getByRole("textbox", { name: "Terminal input" }).first().waitFor();
    await page.waitForFunction(
      (key) => {
        const view = document.querySelector(`[data-tab-body="${key}"]`);
        return view !== null && !/Connecting…|Reconnecting…/.test(view.textContent ?? "");
      },
      VIEW,
      { timeout: 30_000 },
    );
  };
  const typeLine = async (line) => {
    await dismissOverlay();
    await body.getByRole("textbox", { name: "Terminal input" }).first().click();
    await page.keyboard.type(`${line}\n`, { delay: 15 });
    await page.waitForTimeout(900);
  };
  /** The shell's width in columns, as the shell itself reads it. */
  // Each probe prints its own marker: the replay after a reconnect holds every earlier one.
  let probes = 0;
  /** A number the shell prints (`tput cols`), under a marker of this probe's own. */
  const probe = async (command) => {
    probes += 1;
    const marker = `cols${probes}x`;
    await typeLine(`echo ${marker}=$(${command})`);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const found = (await terminalText()).match(new RegExp(`^${marker}=(\\d+)`, "m"));
      if (found !== null) return Number(found[1]);
      await page.waitForTimeout(500);
    }
    throw new Error(`the shell didn't print ${command} (${marker})`);
  };
  const columns = () => probe("tput cols");
  /** The terminal's canvas carries this mark while the same terminal stays in the page. */
  const markTerminal = () =>
    body
      .locator("canvas")
      .first()
      .evaluate((canvas) => {
        canvas.dataset.recipeMark = "kept";
      });
  const stillMarked = async (what) => {
    if ((await body.locator('canvas[data-recipe-mark="kept"]').count()) !== 1)
      throw new Error(`${what}: the terminal was opened again`);
  };

  await page.setViewportSize(DESKTOP);
  await open("/no-such-page");
  await page.evaluate(() => localStorage.setItem("mend-theme", "light"));

  // The session the CLI batch started in `term-ws`.
  const rows = await page.evaluate(async () => {
    const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
    await queryClient.refetchQueries({ queryKey: [["sessions", "inbox"]] });
    return queryClient.getQueryCache().findAll({ queryKey: [["sessions", "inbox"]] })[0]?.state
      .data;
  });
  if (!Array.isArray(rows)) throw new Error("the page holds no inbox read");
  const running = rows
    .filter(
      (row) =>
        row.worktreeName === "term-ws" &&
        !["completed", "stopped", "failed"].includes(row.session.status),
    )
    .toSorted((a, b) => String(b.session.createdAt).localeCompare(String(a.session.createdAt)));
  if (running.length === 0)
    throw new Error("term-ws has no running session: run the CLI batch first");
  const A = running[0].session.id;
  const projectId = running[0].session.projectId;
  // Every session of the workspace: a fixture answers them all as another member's.
  const worktreeId = running[0].session.worktreeId;
  const inWorkspace = new Set(
    rows.filter((row) => row.session.worktreeId === worktreeId).map((row) => row.session.id),
  );
  note(`the batch session is ${A}; stop it with \`mend stop ${A}\` after the drive`);
  await client(
    async (trpc, [id, label]) => trpc.sessions.setLabel.mutate({ id, label }),
    [A, TITLE],
  );
  await page.context().clearCookies({ name: "mend-tiles" });

  // The old shell page's address goes to the session's Terminal view.
  await open(`/projects/${projectId}/shell/${A}`);
  await page.waitForURL(`**/sessions/${A}/terminal`, { timeout: 15_000 });
  await tabOf(VIEW).waitFor();
  if ((await tabOf(VIEW).getAttribute("aria-selected")) !== "true")
    throw new Error("the Terminal tab isn't the one showing");
  note(`/projects/<id>/shell/<id> went to ${new URL(page.url()).pathname}; the Terminal tab shows`);
  await list.waitFor();
  // The list has read every session's processes: the session's own terminal is in it.
  await list.getByRole("button", { name: new RegExp(`^${TITLE}`) }).waitFor({ timeout: 20_000 });
  const rowsBefore = await list.getByRole("button").allInnerTexts();
  note(`this workspace's shells before New shell: ${JSON.stringify(rowsBefore)}`);
  await both("terminal-before-new-shell");

  // New shell: a shell opens in the workspace and shows, live.
  const shellsBefore = await list.getByRole("button", { name: /^Shell \d+/ }).count();
  await body.getByRole("button", { name: "New shell" }).click();
  await page.waitForFunction(
    (n) =>
      [...document.querySelectorAll('nav[aria-label="This workspace\'s shells"] button')].filter(
        (button) => /^Shell \d+/.test(button.textContent ?? ""),
      ).length > n,
    shellsBefore,
    { timeout: 60_000 },
  );
  const shellRow = list.getByRole("button", { name: /^Shell \d+/ }).last();
  if ((await shellRow.getAttribute("aria-current")) !== "true")
    throw new Error("the new shell isn't the one showing");
  await live();
  const shellName = (await shellRow.innerText()).split("\n")[0];
  note(
    `New shell: ${shellName} opened, showing and connected (row reads "${(await shellRow.innerText()).replace(/\n/g, " / ")}")`,
  );
  await both("terminal-shell-open");

  // A command typed in the shell prints its output.
  await typeLine("echo mend-$((6*7))");
  const typed = await terminalText();
  if (!typed.includes("mend-42"))
    throw new Error(`the terminal shows no output: ${typed.slice(-200)}`);
  await page
    .getByRole("region", { name: "Notifications" })
    .getByText("Copied the terminal's text.")
    .first()
    .waitFor({ timeout: 5_000 });
  note(
    "typed `echo mend-$((6*7))`: the terminal's text (read through Copy) holds mend-42; Copy said \"Copied the terminal's text.\"",
  );

  // A link in the output opens in a new tab with Ctrl and a click.
  const link = `${web}/terminal-link-check`;
  await typeLine(`clear; echo ${link}`);
  const canvas = await boxOf(body.locator("canvas").first());
  // A cell's width, in the face and size the terminal's box is styled with.
  const cell = await body
    .locator("canvas")
    .first()
    .evaluate((element) => {
      const style = getComputedStyle(element.parentElement);
      const context = document.createElement("canvas").getContext("2d");
      context.font = `${style.fontSize} ${style.fontFamily}`;
      return context.measureText("M").width;
    });
  const opened = page.context().waitForEvent("page", { timeout: 10_000 });
  await page.keyboard.down("Control");
  await page.mouse.click(canvas.x + cell * 6.5, canvas.y + 7);
  await page.keyboard.up("Control");
  const tab = await opened;
  await tab.waitForURL(/terminal-link-check/, { timeout: 10_000 }).catch(() => undefined);
  const openedUrl = tab.url();
  await tab.close();
  if (!openedUrl.includes("terminal-link-check"))
    throw new Error(`Ctrl and a click on the link opened ${openedUrl}`);
  note(`Ctrl and a click on the printed link opened a new tab at ${new URL(openedUrl).pathname}`);

  // The tab moves to a tile of its own on the right: the same terminal, narrower.
  const wide = await columns();
  await markTerminal();
  const one = await boxOf(tiles().first());
  await drag(VIEW, one.x + one.width * 0.92, one.y + one.height * 0.5);
  await expectTiles(2, "after the Terminal tab went to the right edge");
  await live();
  await stillMarked("moved to a tile of its own");
  const narrow = await columns();
  // Half the sheet, less the list the wide tile had beside it: well over half the columns.
  if (!(narrow < wide && narrow > wide / 2))
    throw new Error(`the shell is ${narrow} columns in half the width, ${wide} before`);
  const kept = await terminalText();
  // What came before the move is still there (bash redraws its prompt over the line above it
  // when the width changes, so look for the probe's command line and the link printed earlier).
  if (!kept.includes("terminal-link-check") || !kept.includes("echo cols1x="))
    throw new Error(`the scrollback is gone after the move: ${JSON.stringify(kept.slice(0, 400))}`);
  note(
    `moved to a tile on the right: the same terminal element, the shell went from ${wide} to ${narrow} columns, the scrollback is there`,
  );
  await both("terminal-beside-conversation");

  // A link longer than the half-width terminal wraps over two rows: Ctrl and a click on its second
  // row opens the whole address.
  const lines = await probe("tput lines");
  const wrapped = `${web}/terminal-link-check/wrapped-${"x".repeat(narrow)}`;
  await typeLine(`clear; echo ${wrapped}`);
  const half = await boxOf(body.locator("canvas").first());
  const rowHeight = half.height / lines;
  const openedWrapped = page.context().waitForEvent("page", { timeout: 10_000 });
  await page.keyboard.down("Control");
  await page.mouse.click(half.x + cell * 4.5, half.y + rowHeight * 1.5);
  await page.keyboard.up("Control");
  const wrappedTab = await openedWrapped;
  await wrappedTab.waitForURL(/wrapped-x+$/, { timeout: 10_000 }).catch(() => undefined);
  const wrappedUrl = wrappedTab.url();
  await wrappedTab.close();
  if (!wrappedUrl.endsWith(`wrapped-${"x".repeat(narrow)}`))
    throw new Error(`Ctrl and a click on the wrapped link's second row opened ${wrappedUrl}`);
  note(
    `a link wrapped over two rows of the ${narrow}-column terminal: Ctrl and a click on its second row opened the whole address (${new URL(wrappedUrl).pathname.length} characters of path)`,
  );

  // Maximised: the same terminal, wider again; then the layout back.
  await tileOf(VIEW).getByRole("button", { name: "Maximise tile" }).click();
  await expectTiles(1, "maximised");
  await live();
  await stillMarked("maximised");
  const maximised = await columns();
  if (!(maximised > narrow))
    throw new Error(`maximised, the shell is ${maximised} columns, ${narrow} before`);
  note(`maximised: the same terminal, ${maximised} columns`);
  await page.getByRole("button", { name: "Restore layout" }).click();
  await expectTiles(2, "restored");

  // Back into the conversation's tile, then under it (T07): the terminal alone in a short tile.
  const first = await boxOf(tiles().first());
  await drag(VIEW, first.x + first.width / 2, first.y + first.height * 0.97);
  await expectTiles(2, "after the Terminal tab went to the bottom edge");
  await stillMarked("moved under the conversation");
  note(
    `under the conversation: ${(await list.count()) === 0 ? "no list, the terminal alone" : "the list beside it"}`,
  );
  await both("terminal-under-conversation");
  const lower = await boxOf(tileOf(VIEW));
  const upper = await boxOf(tiles().first());
  await drag(VIEW, upper.x + upper.width / 2, upper.y + upper.height * 0.45);
  await expectTiles(1, "back in one tile");
  await tabOf(VIEW).click();
  await live();
  await stillMarked("back in one tile");
  note(`back in one tile (the lower tile was ${Math.round(lower.height)}px tall)`);

  // Close shell…: the shell stops and leaves the list (SLNT-1197).
  await body.getByRole("button", { name: "Close shell…" }).click();
  const dialog = page.getByRole("dialog", { name: `Close ${shellName}?` });
  await dialog.waitFor();
  await both("terminal-close-dialog");
  await dialog.getByRole("button", { name: "Close shell" }).click();
  await dialog.waitFor({ state: "hidden", timeout: 30_000 });
  await page.waitForFunction(
    (name) =>
      ![...document.querySelectorAll('nav[aria-label="This workspace\'s shells"] button')].some(
        (button) => (button.textContent ?? "").startsWith(name),
      ),
    shellName,
    { timeout: 30_000 },
  );
  note(`Close shell: ${shellName} left the list`);

  // A second shell for the watcher and the phone.
  await body.getByRole("button", { name: "New shell" }).click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('nav[aria-label="This workspace\'s shells"] button')].some(
        (button) => /^Shell \d+.*Running/.test(button.textContent ?? ""),
      ),
    undefined,
    { timeout: 60_000 },
  );
  await live();
  const shellRows = await client(async (trpc, id) => trpc.sessions.processes.query({ id }), A);
  const shell = shellRows.find((each) => each.kind === "shell" && each.exitedAt === null);
  if (shell === undefined) throw new Error("no live shell after New shell");

  /**
   * The session's reads answered as a fixture: owned by another member (`shared`: with control
   * shared), stopped, its processes none or failing. Reads go again from an empty cache.
   */
  const fixture = async ({ owner = null, shared = false, status = null, processes = null }) => {
    await page.route("**/trpc/**", async (route) => {
      const url = new URL(route.request().url());
      const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
      const inputs = JSON.parse(route.request().postData() ?? "{}");
      const touched = [
        "sessions.inbox",
        "sessions.detail",
        "organization.members",
        "sessions.processes",
      ];
      if (!paths.some((path) => touched.includes(path))) return route.continue();
      const response = await route.fetch();
      const answers = await response.json();
      const now = new Date().toISOString();
      const patch = (session, values, prefix) => {
        if (owner !== null) session.ownerUserId = owner;
        if (shared) {
          session.sharedControlEnabledAt = now;
          values[`${prefix}session.sharedControlEnabledAt`] = ["Date"];
        } else if (owner !== null) session.sharedControlEnabledAt = null;
        if (status !== null) session.status = status;
      };
      paths.forEach((path, index) => {
        const id = inputs[String(index)]?.json?.id;
        if (path === "sessions.processes" && inWorkspace.has(id) && processes === "fail") {
          answers[index] = {
            error: {
              json: {
                message: "The verify recipe failed this read on purpose.",
                code: -32603,
                data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path },
              },
            },
          };
          return;
        }
        const data = answers[index]?.result?.data;
        if (data === undefined) return;
        data.meta = data.meta ?? { values: {}, v: 1 };
        data.meta.values = data.meta.values ?? {};
        if (path === "sessions.processes" && inWorkspace.has(id) && processes === "none") {
          answers[index] = { result: { data: { json: [] } } };
          return;
        }
        if (path === "sessions.inbox")
          data.json.forEach((row, at) => {
            if (row.session.worktreeId === worktreeId)
              patch(row.session, data.meta.values, `${at}.`);
          });
        if (path === "sessions.detail" && data.json.session.worktreeId === worktreeId)
          patch(data.json.session, data.meta.values, "");
        if (path === "organization.members" && owner !== null && data.json.length > 0) {
          const at = data.json.length;
          data.json.push({
            ...data.json[0],
            userId: owner,
            name: OWNER_NAME,
            email: "grace@example.com",
          });
          for (const [key, kind] of Object.entries(data.meta.values))
            if (key.startsWith("0.")) data.meta.values[`${at}${key.slice(1)}`] = kind;
        }
      });
      await route.fulfill({ response, json: answers });
    });
    await go("/projects");
    await page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.clear());
    await go(`/sessions/${A}/terminal`);
  };
  const leaveFixture = async () => {
    await page.unroute("**/trpc/**");
    await go("/projects");
    await page.evaluate(() => window["__TSR_ROUTER__"].options.context.queryClient.clear());
    await go(`/sessions/${A}/terminal`);
  };
  /** Light and dark, desktop and 390px. */
  const everywhere = async (name) => {
    await both(`${name}-desktop`);
    await page.setViewportSize(PHONE);
    await settled();
    await both(`${name}-phone`);
    await page.setViewportSize(DESKTOP);
    await settled();
  };

  // A watcher: the session answered as another member's, with control shared. They see the shells
  // and the terminal, can't type, and have no New shell or Close shell.
  await fixture({ owner: WATCHED_BY, shared: true });
  await body
    .getByText(`Only ${OWNER_NAME} types here. You're watching.`)
    .waitFor({ timeout: 20_000 });
  await live();
  if ((await body.getByRole("button", { name: "New shell" }).count()) > 0)
    throw new Error("a watcher is offered New shell");
  if ((await body.getByRole("button", { name: "Close shell…" }).count()) > 0)
    throw new Error("a watcher is offered Close shell");
  note(
    `fixture-watcher: "Only ${OWNER_NAME} types here. You're watching."; no New shell, no Close shell; the terminal is read-only`,
  );
  await both("fixture-terminal-watcher");
  await leaveFixture();

  // Someone the owner doesn't share control with: no shells to see, and who can.
  await fixture({ owner: WATCHED_BY });
  await body
    .getByText(
      `Only ${OWNER_NAME} and the people they share control with see this workspace's shells.`,
    )
    .waitFor({ timeout: 20_000 });
  note(
    "fixture-not-shared: the view says only the owner and the people they share control with see the shells",
  );
  await everywhere("fixture-terminal-not-shared");
  await leaveFixture();

  // A stopped workspace with no shell to show: the line, and Resume and open a shell.
  await fixture({ status: "stopped", processes: "none" });
  await body
    .getByText("This workspace isn't running.", { exact: false })
    .first()
    .waitFor({ timeout: 20_000 });
  await body.getByRole("button", { name: "Resume and open a shell" }).waitFor();
  note("fixture-stopped: no shells, the workspace isn't running, Resume and open a shell");
  await everywhere("fixture-terminal-stopped-empty");
  await leaveFixture();

  // The processes can't be read: what went wrong, and Try again.
  await fixture({ processes: "fail" });
  await body.getByRole("button", { name: "Try again" }).waitFor({ timeout: 20_000 });
  note("fixture-failed: the shells' read failed; the view says so with Try again");
  await everywhere("fixture-terminal-failed");
  await leaveFixture();
  await live();

  // The phone: the picker over the terminal.
  await page.setViewportSize(PHONE);
  await settled();
  const picker = body.getByRole("button", { name: / shells?$/ });
  await picker.waitFor();
  await dismissOverlay();
  note(`390px: the picker reads "${(await picker.innerText()).replace(/\n/g, " ")}"`);
  await both("terminal-phone");
  await picker.click();
  await page.getByRole("menuitem", { name: "New shell" }).waitFor();
  await capture("terminal-phone-picker-light");
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "hidden" });
  await page.setViewportSize(DESKTOP);
  await settled();

  // /tty-embed, as the phone app loads it: no cookie, an upgrade ticket for this shell in the URL.
  const ticket = await page.evaluate(async (processId) => {
    const response = await fetch("/api/upgrade-tickets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target: "tty-embed", process: processId }),
    });
    if (!response.ok) throw new Error(`minting a ticket answered ${response.status}`);
    return (await response.json()).ticket;
  }, shell.id);
  const browser = page.context().browser();
  if (browser === null) throw new Error("no browser to open a signed-out page in");
  const signedOut = await browser.newContext({ viewport: PHONE });
  const embed = await signedOut.newPage();
  const traded = embed.waitForResponse((response) =>
    response.url().endsWith("/api/upgrade-tickets/exchange"),
  );
  // Every frame the page's sockets receive, counted from the first: a replay arrives at once.
  const received = [];
  let ws = null;
  embed.on("websocket", (socket) => {
    ws = socket;
    socket.on("framereceived", (frame) => {
      if (typeof frame.payload !== "string") received.push(frame.payload);
    });
  });
  await embed.goto(
    `${web}/tty-embed?session=${encodeURIComponent(A)}&process=${encodeURIComponent(shell.id)}&ticket=${encodeURIComponent(ticket)}`,
  );
  const exchange = await traded;
  for (let waited = 0; received.length === 0 && waited < 20_000; waited += 250)
    await embed.waitForTimeout(250);
  if (ws === null || received.length === 0) throw new Error("/tty-embed's socket received nothing");
  const frame = { payload: received[0] };
  const embedded = await embed.getByRole("textbox", { name: "Terminal input" }).count();
  await signedOut.close();
  if (exchange.status() !== 200) throw new Error(`the ticket trade answered ${exchange.status()}`);
  if (embedded === 0) throw new Error("/tty-embed shows no terminal");
  note(
    `/tty-embed (no cookie, ?session&process&ticket): the trade answered 200, the socket ${new URL(ws.url()).pathname} opened with a ticket and received output (${frame.payload.length} bytes in its first binary frame)`,
  );

  // Stopped: the last running session stops, and with it the workspace and its shells.
  await client(async (trpc, id) => trpc.sessions.stop.mutate({ id }), A);
  await body
    .getByText("This workspace isn't running.", { exact: false })
    .first()
    .waitFor({ timeout: 60_000 });
  await body.getByRole("button", { name: "Resume and open a shell" }).waitFor();
  note(
    "after Stop session: the view says the workspace isn't running, no shells are listed, and Resume and open a shell is offered",
  );
  await both("terminal-workspace-stopped");
};
