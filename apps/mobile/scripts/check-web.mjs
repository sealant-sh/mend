#!/usr/bin/env node
// Proves the web build loads: the static export (what a static host serves)
// and the dev server (`expo start --web`, what verification runs drive). Each
// route is opened in headless Chromium and any page error fails the check.
// Both are needed: the dev server compiles the browser bundle differently from
// the export (see babel.config.js for the case that broke every Schema.Class
// there and nowhere else), and a bundle that builds can still throw on load.
//
// On the dev server it then drives one confirm-first action against a stubbed
// API: react-native-web's Alert.alert does nothing, so Stop session has to ask
// in the app's own dialog, Cancel has to send nothing, and Stop has to stop.
//
// On both, it opens an agent's pages against the stubbed API: in place in a
// conversation and in a terminal transcript, inside the conversation's side
// spacing, full screen and back, offline and back online, across a theme change,
// and a page whose request never completes. A frame whose sandbox grants
// `allow-same-origin` fails the check: this build keeps its bearer token in
// browser storage, which that grant would hand to the page.
//
//   node scripts/check-web.mjs        (from apps/mobile)
//   CHECK_WEB_SCREENSHOTS=<dir> node scripts/check-web.mjs   (also saves the page screens)

import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";

import { chromium } from "playwright-core";

const ROUTES = ["/", "/pair", "/projects", "/settings"];
const EXPORT_DIR = "dist";
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
};

const run = (args) =>
  new Promise((done, fail) => {
    const child = spawn("pnpm", ["exec", "expo", ...args], {
      stdio: "inherit",
      env: { ...process.env, CI: "1" },
    });
    child.on("exit", (code) => {
      if (code === 0) done();
      else fail(new Error(`expo ${args[0]} exited ${code}`));
    });
  });

const listen = (server) =>
  new Promise((ready) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      ready(typeof address === "object" && address ? address.port : 0);
    });
  });

const freePort = async () => {
  const probe = createServer();
  const port = await listen(probe);
  probe.close();
  return port;
};

// The export is one HTML file per route (`/pair` is pair.html, `/session/1` is
// session/[id].html) beside the bundles, the way a static host serves it.
const serveExport = async () => {
  const resolve = (pathname) => {
    const path = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
    for (const candidate of [
      path,
      `${path}.html`,
      join(path, "index.html"),
      join(dirname(path), "[id].html"),
    ]) {
      const file = join(EXPORT_DIR, candidate);
      if (existsSync(file) && statSync(file).isFile()) return file;
    }
    return undefined;
  };
  const server = createServer((request, response) => {
    const file = resolve(new URL(request.url ?? "/", "http://export").pathname);
    if (file === undefined) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  });
  const port = await listen(server);
  return { origin: `http://127.0.0.1:${port}`, stop: () => server.close() };
};

// Metro answers once it listens; the first page request bundles, so the
// route checks below give it room.
const startDevServer = async () => {
  const port = await freePort();
  const child = spawn("pnpm", ["exec", "expo", "start", "--web", "--port", String(port)], {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, CI: "1" },
    detached: true,
  });
  const stop = () => {
    if (child.pid !== undefined && child.exitCode === null) process.kill(-child.pid, "SIGTERM");
  };
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`expo start exited ${child.exitCode}`);
    if (Date.now() > deadline) {
      stop();
      throw new Error("expo start did not listen in 120 s");
    }
    const up = await fetch(`${origin}/status`).then(
      (response) => response.ok,
      () => false,
    );
    if (up) return { origin, stop };
    await new Promise((later) => setTimeout(later, 1_000));
  }
};

const checkRoutes = async (browser, label, origin) => {
  const failures = [];
  for (const route of ROUTES) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
    const response = await page.goto(origin + route, { timeout: 300_000 });
    if (response?.status() !== 200) errors.push(`HTTP ${response?.status()}`);
    // The app has rendered once the root holds text; a throw during module
    // load or the first render leaves it empty and raises a page error.
    await page
      .waitForFunction(
        () => (document.getElementById("root")?.innerText.trim() ?? "") !== "",
        null,
        {
          timeout: 60_000,
        },
      )
      .catch(() => errors.push("nothing rendered in 60 s"));
    // Let effects that run after the first paint raise theirs too.
    await page.waitForTimeout(1_000);
    if (errors.length > 0) failures.push(`${label} ${route}\n  ${errors.join("\n  ")}`);
    else console.log(`✓ ${label} ${route}`);
    await page.close();
  }
  return failures;
};

// One running session the check may stop, served from the page's own origin.
const SESSION_ID = "check-stop";
const NOW = new Date().toISOString();
const SESSION = {
  id: SESSION_ID,
  projectId: "check-project",
  harness: "claude",
  model: null,
  effort: null,
  label: "Stop check",
  branch: "mend/session/stop-check",
  baseSha: "0".repeat(40),
  baseRef: "main",
  status: "running",
  summary: null,
  sealantRunId: null,
  sealantSessionId: null,
  settledAt: null,
  startedAt: NOW,
  createdAt: NOW,
  ownerUserId: "check-user",
};
const AGENT = { id: "check-agent", kind: "agent-protocol", status: "running", exitedAt: null };

const stubApi = async (page, origin, stops) => {
  await page.route(`${origin}/api/**`, (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const json = (status, body) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (request.method() === "POST" && path === `/api/sessions/${SESSION_ID}/stop`) {
      stops.push(path);
      return json(200, { ...SESSION, status: "stopping" });
    }
    if (request.method() === "GET" && path === `/api/sessions/${SESSION_ID}`) {
      return json(200, {
        session: stops.length === 0 ? SESSION : { ...SESSION, status: "stopping" },
        checkpoints: [],
        change: null,
        landings: [],
        processes: [AGENT],
        currentAgent: AGENT,
        control: {
          own: true,
          steer: true,
          stop: true,
          toggleSharedControl: true,
          terminalInput: true,
        },
      });
    }
    if (request.method() === "GET" && path === "/api/organization") {
      return json(200, { userId: "check-user" });
    }
    return json(404, { _tag: "NotFound", message: "Not stubbed by check-web." });
  });
};

// The web build keeps its config in IndexedDB: save it the way a person types it in.
const saveServer = async (page, origin) => {
  await page.goto(`${origin}/settings`, { timeout: 300_000 });
  await page.getByText("Advanced", { exact: true }).click();
  await page.getByPlaceholder("https://mend.example.com").fill(origin);
  await page.getByPlaceholder("token").fill("check-token");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Saved", exact: true }).waitFor();
};

const checkStopAsks = async (browser, label, origin) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const stops = [];
  try {
    await stubApi(page, origin, stops);
    await saveServer(page, origin);

    await page.goto(`${origin}/session/${SESSION_ID}`, { timeout: 300_000 });
    const dialog = page.getByRole("alertdialog", { name: "Stop this session?" });
    const askToStop = async () => {
      await page.getByRole("button", { name: "More actions" }).click();
      await page.getByRole("menuitem", { name: "Stop session" }).click();
      await dialog.waitFor({ timeout: 10_000 });
    };

    await askToStop();
    await dialog
      .getByText("The agent ends, and Mend saves the session's work before its machine stops.")
      .waitFor();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog.waitFor({ state: "detached", timeout: 10_000 });
    // Long enough for a stop that Cancel wrongly sent to reach the stub.
    await page.waitForTimeout(1_000);
    if (stops.length !== 0) throw new Error("Cancel sent a stop");

    await askToStop();
    const stopped = page.waitForRequest(
      (request) =>
        request.method() === "POST" && request.url().endsWith(`/api/sessions/${SESSION_ID}/stop`),
      { timeout: 10_000 },
    );
    await dialog.getByRole("button", { name: "Stop session", exact: true }).click();
    await stopped;
    await dialog.waitFor({ state: "detached", timeout: 10_000 });
    if (stops.length !== 1) throw new Error(`Stop sent ${stops.length} stops, not 1`);
    console.log(`✓ ${label} stop session asks, Cancel sends nothing, Stop stops`);
    return [];
  } catch (error) {
    return [`${label} stop session\n  ${error instanceof Error ? error.message : String(error)}`];
  } finally {
    await page.close();
  }
};

const PAGES_SESSION = "check-pages";
const TERMINAL_SESSION = "check-pages-terminal";
const SANDBOX = "allow-scripts allow-forms";

const pageRef = (id, sessionId, title, height) => ({
  id,
  sessionId,
  title,
  height,
  publishedAt: NOW,
});
const CHART = pageRef("page-chart", PAGES_SESSION, "Latency by route", 360);
const TABLE = pageRef("page-table", TERMINAL_SESSION, "Slowest queries", 240);
const LATE = pageRef("page-late", TERMINAL_SESSION, "Queries after the fix", 240);
const STALLED = pageRef("page-stalled", PAGES_SESSION, "Error rate by route", 200);
const REFUSAL = "The page sets a height in vh units; give charts fixed pixel heights.";

const at = (seconds) => new Date(Date.parse(NOW) + seconds * 1000).toISOString();
const agentItem = (id, seconds, kind, fields) => ({
  id,
  seq: seconds,
  turnId: "check-turn",
  kind,
  status: "completed",
  title: null,
  text: null,
  createdAt: at(seconds),
  updatedAt: at(seconds),
  ...fields,
});
const ITEMS = [
  agentItem("failed-call", 1, "tool-call", {
    status: "failed",
    title: "mcp__mend__html_render",
    data: {
      mendPageCall: { attachmentId: null, failure: { code: "invalid_request", message: REFUSAL } },
    },
  }),
  agentItem("published-call", 2, "tool-call", {
    title: "mcp__mend__html_render",
    data: { mendPageCall: { attachmentId: CHART.id, failure: null } },
  }),
  agentItem("page-item", 3, "page", { title: CHART.title, data: CHART }),
  agentItem("reply", 4, "assistant-message", {
    text: "The checkout route is the slow one: its p95 doubled after the cache change.",
  }),
  agentItem("stalled-item", 5, "page", { title: STALLED.title, data: STALLED }),
];
const TRANSCRIPT = [
  { kind: "user", text: "Which queries are slowest?" },
  { kind: "assistant", text: "Here are the five slowest queries from the last hour." },
  { kind: "page", page: TABLE },
  { kind: "assistant", text: "And the same queries once the index is in." },
  { kind: "page", page: LATE },
].map((event) => ({ text: null, name: null, command: null, output: null, ...event }));

const sessionView = (id, kind) => ({
  session: {
    ...SESSION,
    id,
    label: "Pages check",
    status: "completed",
    settledAt: NOW,
    summary: null,
  },
  checkpoints: [],
  change: null,
  landings: [],
  processes: [],
  currentAgent: { id: `${id}-agent`, kind, status: "exited", exitedAt: NOW },
  control: { own: true, steer: true, stop: true, toggleSharedControl: true, terminalInput: true },
});

const pageDocument = (title, rows) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style id="theme"></style><style>
html{background:var(--background);color:var(--foreground);font:14px/1.5 var(--font-sans)}
body{margin:0}h1{font-size:15px;margin:0 0 12px}.row{display:flex;align-items:center;gap:10px;margin:8px 0}
.label{flex:none;width:96px;color:var(--muted-foreground);font:12px var(--font-mono)}
.bar{height:18px;border-radius:4px;background:var(--chart-1)}.bar.alt{background:var(--chart-2)}
</style><script>
(function(){
  var style=document.getElementById("theme");
  function apply(appearance,variables){
    var css=":root{color-scheme:"+appearance+";";
    for(var name in variables)css+=name+":"+variables[name]+";";
    style.textContent=css+"}";
    document.documentElement.dataset.theme=appearance;
  }
  var fragment=/[#&]t3-theme=([^&]*)/.exec(location.hash);
  if(fragment){var theme=JSON.parse(decodeURIComponent(fragment[1]));apply(theme.appearance,theme.variables);}
  window.checkLoad=Math.random();
  addEventListener("message",function(event){
    var data=event.data;
    if(data&&data.method==="ui/notifications/host-context-changed")apply(data.params.theme,data.params.styles.variables);
  });
  window.contentHeight=function(){return Math.ceil(document.documentElement.getBoundingClientRect().height);};
  function size(){parent.postMessage({jsonrpc:"2.0",method:"ui/notifications/size-changed",params:{height:contentHeight()}},"*");}
  addEventListener("load",size);
})();
</script></head><body><h1>${title}</h1>${rows
  .map(
    ([label, width], index) =>
      `<div class="row"><span class="label">${label}</span><span class="bar${index % 2 ? " alt" : ""}" style="width:${width}%"></span></div>`,
  )
  .join("")}</body></html>`;
const PAGE_DOCUMENTS = {
  [CHART.id]: pageDocument(CHART.title, [
    ["/checkout", 92],
    ["/cart", 41],
    ["/search", 33],
    ["/login", 18],
    ["/health", 4],
  ]),
  [TABLE.id]: pageDocument(TABLE.title, [
    ["orders", 80],
    ["sessions", 52],
    ["events", 30],
  ]),
  [LATE.id]: pageDocument(LATE.title, [
    ["orders", 22],
    ["sessions", 19],
    ["events", 12],
  ]),
};

const stubPagesApi = async (page, origin, network) => {
  await page.route(`${origin}/api/**`, (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (body) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    const frame = /^\/api\/pages\/([^/]+)\/frame$/.exec(path);
    if (frame !== null) {
      if (network.offline.has(frame[1])) return route.abort("internetdisconnected");
      network.mints.push({ page: frame[1], appearance: url.searchParams.get("appearance") });
      return json({
        url: `/api/page-view?view=${frame[1]}`,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      });
    }
    if (path === "/api/page-view") {
      if (url.searchParams.get("view") === STALLED.id) return new Promise(() => undefined);
      const html = PAGE_DOCUMENTS[url.searchParams.get("view") ?? ""];
      if (html === undefined) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({
        status: 200,
        contentType: "text/html",
        headers: { "content-security-policy": `sandbox ${SANDBOX}` },
        body: html,
      });
    }
    if (path === `/api/sessions/${PAGES_SESSION}`) {
      return json(sessionView(PAGES_SESSION, "agent-protocol"));
    }
    if (path === `/api/sessions/${TERMINAL_SESSION}`) {
      return json(sessionView(TERMINAL_SESSION, "agent-pty"));
    }
    if (path === `/api/sessions/${PAGES_SESSION}/turns`) {
      return json([
        {
          id: "check-turn",
          ordinal: 1,
          input: "Chart the slowest routes",
          status: "completed",
          error: null,
          createdAt: NOW,
        },
      ]);
    }
    if (path === `/api/sessions/${PAGES_SESSION}/items`) {
      return json(Number(url.searchParams.get("after") ?? 0) === 0 ? ITEMS : []);
    }
    if (path === `/api/sessions/${PAGES_SESSION}/requests`) return json([]);
    if (path === `/api/sessions/${TERMINAL_SESSION}/transcript`) {
      return json({ sourceHarness: "claude", events: TRANSCRIPT });
    }
    if (path === "/api/organization") return json({ userId: "check-user" });
    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ _tag: "NotFound", message: "Not stubbed by check-web." }),
    });
  });
};

const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

const checkSandboxes = async (page) => {
  const sandboxes = await page
    .locator("iframe")
    .evaluateAll((frames) => frames.map((frame) => frame.getAttribute("sandbox")));
  expect(sandboxes.length > 0, "no page frame on screen");
  for (const sandbox of sandboxes) {
    expect(!/allow-same-origin/i.test(sandbox ?? ""), `a frame allows same origin: ${sandbox}`);
    expect(sandbox === SANDBOX, `a frame's sandbox is "${sandbox}", not "${SANDBOX}"`);
  }
};

const fitted = async (page, title) => {
  // A stack keeps the screen under the current one mounted, hidden, with its own frames.
  const frame = page.locator(`iframe[title="${title}"]`).filter({ visible: true });
  await frame.waitFor({ timeout: 60_000 });
  const content = await frame.elementHandle().then((handle) => handle?.contentFrame());
  expect(content != null, `no document in ${title}`);
  await content.waitForLoadState("load");
  const deadline = Date.now() + 20_000;
  for (;;) {
    const reported = await content.evaluate(() => window.contentHeight());
    const box = await frame.boundingBox();
    if (box !== null && Math.abs(box.height - Math.max(80, reported)) <= 1) return content;
    if (Date.now() > deadline) {
      throw new Error(`${title} is ${box?.height}px tall for a page of ${reported}px`);
    }
    await page.waitForTimeout(200);
  }
};

const top = async (locator) => (await locator.first().boundingBox())?.y ?? Number.NaN;

const inGutters = async (page, title) => {
  const box = await page.locator(`iframe[title="${title}"]`).first().boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  expect(
    box !== null && box.x >= 16 && box.x + box.width <= width - 16,
    `${title} runs to the screen's edge: ${JSON.stringify(box)} in ${width}px`,
  );
};

const mintsOf = (network, id) => network.mints.filter((mint) => mint.page === id);

const shoot = async (page, label, name) => {
  const dir = process.env.CHECK_WEB_SCREENSHOTS;
  if (dir === undefined || dir === "") return;
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(dir, `${label.replace(/\W+/g, "-")}-${name}.png`) });
};

const checkPages = async (browser, label, origin) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    colorScheme: "light",
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? String(error)));
  const network = { offline: new Set([LATE.id]), mints: [] };
  try {
    await stubPagesApi(page, origin, network);
    await saveServer(page, origin);

    await page.goto(`${origin}/session/${PAGES_SESSION}`, { timeout: 300_000 });
    const chart = await fitted(page, CHART.title);
    await checkSandboxes(page);
    expect(
      (await page.getByText("mcp__mend__html_render", { exact: true }).count()) === 1,
      "the published call shows beside its page, or the failed call is gone",
    );
    const [failedAt, pageAt, replyAt] = await Promise.all([
      top(page.getByText("mcp__mend__html_render", { exact: true })),
      top(page.locator(`iframe[title="${CHART.title}"]`)),
      top(page.getByText("The checkout route is the slow one", { exact: false })),
    ]);
    expect(
      failedAt < pageAt && pageAt < replyAt,
      "the page is not between the failed call and the reply, where it was published",
    );
    await page.getByText(`page not shown · ${REFUSAL}`, { exact: true }).waitFor();
    await inGutters(page, CHART.title);
    await shoot(page, label, "conversation-light");

    const load = await chart.evaluate(() => window.checkLoad);
    expect(
      (await chart.evaluate(() => document.documentElement.dataset.theme)) === "light",
      "the page did not open light",
    );
    await page.emulateMedia({ colorScheme: "dark" });
    await chart.waitForFunction(() => document.documentElement.dataset.theme === "dark", null, {
      timeout: 10_000,
    });
    expect(
      (await chart.evaluate(() => window.checkLoad)) === load,
      "a theme change reloaded the page",
    );
    const chartMints = mintsOf(network, CHART.id).map((mint) => mint.appearance);
    expect(chartMints.length === 1, `a theme change minted again: ${chartMints.join(", ")}`);
    await shoot(page, label, "conversation-dark");
    await page.emulateMedia({ colorScheme: "light" });

    await page.getByRole("button", { name: `Open ${CHART.title}` }).click();
    await page.waitForURL(/\/page\/page-chart/, { timeout: 10_000 });
    await fitted(page, CHART.title);
    await checkSandboxes(page);
    await shoot(page, label, "full-screen-light");
    await page.goBack();
    await page.waitForURL(new RegExp(`/session/${PAGES_SESSION}`), { timeout: 10_000 });
    await fitted(page, CHART.title);

    await page.getByText("This page could not be loaded.", { exact: true }).waitFor({
      timeout: 45_000,
    });
    expect(mintsOf(network, STALLED.id).length === 2, "a stalled page was not minted afresh once");
    await shoot(page, label, "timed-out-light");
    await page.getByRole("button", { name: "Try again" }).click();
    await page.locator(`iframe[title="${STALLED.title}"]`).waitFor({ timeout: 10_000 });
    expect(mintsOf(network, STALLED.id).length === 3, "Try again did not ask for a fresh URL");

    await page.goto(`${origin}/session/${TERMINAL_SESSION}`, { timeout: 300_000 });
    await fitted(page, TABLE.title);
    await inGutters(page, TABLE.title);
    await page.getByText("Shown when the phone is back online", { exact: true }).waitFor({
      timeout: 30_000,
    });
    await checkSandboxes(page);
    await shoot(page, label, "terminal-offline-light");
    network.offline.delete(LATE.id);
    await fitted(page, LATE.title);
    expect(
      (await page.getByText("Shown when the phone is back online", { exact: true }).count()) === 0,
      "the offline line stayed once the page loaded",
    );
    await checkSandboxes(page);
    await page.emulateMedia({ colorScheme: "dark" });
    await shoot(page, label, "terminal-dark");

    expect(errors.length === 0, errors.join("\n  "));
    console.log(
      `✓ ${label} pages render in place, sandboxed, full screen, offline, themed and timed out`,
    );
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`${label} pages\n  ${[message, ...errors].join("\n  ")}`];
  } finally {
    await context.close();
  }
};

rmSync(EXPORT_DIR, { recursive: true, force: true });
await run(["export", "--platform", "web", "--output-dir", EXPORT_DIR]);

const browser = await chromium.launch();
const failures = [];
try {
  const exported = await serveExport();
  try {
    failures.push(...(await checkRoutes(browser, "export", exported.origin)));
    failures.push(...(await checkPages(browser, "export", exported.origin)));
  } finally {
    exported.stop();
  }
  const dev = await startDevServer();
  try {
    failures.push(...(await checkRoutes(browser, "dev server", dev.origin)));
    failures.push(...(await checkStopAsks(browser, "dev server", dev.origin)));
    failures.push(...(await checkPages(browser, "dev server", dev.origin)));
  } finally {
    dev.stop();
  }
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error(`✗ the web build fails in the browser:\n${failures.join("\n")}`);
  process.exit(1);
}
