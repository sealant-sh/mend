#!/usr/bin/env node
// The verify skill's web driver: one headless Chromium against the tunnelled stack, one recipe.
//
//   node .claude/skills/verify/scripts/drive-web.mjs --web <url> --out <dir> --recipe <file.mjs> \
//     --private <dir> [--account <file>] [--state <file>] [--timeout <ms>] [--viewport <w>x<h>] \
//     [--cdp <url>]
//
// --viewport sets the page size (default 1280x900; the map's mobile web runs at 390x844).
// --cdp attaches to a browser that is already running with a remote debugging port (the desktop
// app, started by drive-desktop.sh) instead of launching one, and drives its first window. It never
// closes that browser, and --account and --state do not apply: the app holds its own sign-in.
//
// --recipe is a module whose default export is
// `async ({ page, web, capture, note, typeSecret, registerSecret }) => {}`:
// - `capture(name)` saves <out>/<name>.aria.yml (the body's ARIA snapshot) and <out>/<name>.png;
// - `note(text)` appends a line to <out>/steps.log;
// - `typeSecret(locator, name, value)` puts a credential into a field: the value goes into the run's
//   secret registry first (--private, secrets.mjs), then into the field by script, never through
//   Playwright's `fill` (whose error log would print its argument), and the field is marked as
//   holding a secret;
// - `registerSecret(name, value)` registers a credential a page minted (a token, a pairing code).
// --account signs in at /login with the stack's first account (handover.mjs's account.json),
// typing its password the same way. --state keeps the signed-in browser between runs. Both hold
// credentials: keep them in the private directory, never under --out.
//
// Every snapshot, log line and error goes through the registry (every
// value, by value) and redact.mjs (every shape). A page that shows one (a field a secret was typed
// into, a registered value, a QR code, any shape redact.mjs knows, a filled credential field) keeps
// its redacted snapshot, with every credential field's subtree redacted, and its screenshot is
// withheld: <name>.png.withheld says which kinds were on the page. The page's whole text is checked
// as well as its ARIA snapshot (text a screen reader is told to skip, `aria-hidden`, is still drawn).
// Canvases, videos, embedded objects and child frames withhold the whole screenshot: Playwright's
// masks themselves use closed roots that cannot be distinguished from author content safely.
// Chromium's DOM
// metadata detects author closed roots before and after rasterization, and events latch roots
// added during capture. Those roots, or an unavailable inspection, withhold the whole image.
// A kept screenshot gets <name>.png.checked
// (its sha256 and zero mask counts): scan-evidence.mjs refuses an image without one. A code a page shows (a pairing code, an
// authorization code and its link) joins the registry by value before anything is written. A failing recipe is captured as
// <out>/failure-<n>.* (the same rules; numbered, so earlier failures stay) before the driver exits 1, and its error is printed redacted.
// No trace, HAR or video is recorded.
//
// --web must be this run's own stack through its tunnel (guard/policy.mjs, with the private
// directory's tunnel.json and MEND_VERIFY_OUTER_URL), the mobile proxy drive-mobile.mjs started
// in front of that tunnel (its mobile.json), or the t3code client serve-t3-client.mjs serves for
// the run's T3 gateway (its t3-client.json): the driver refuses (exit 97) any other server.
//
// Playwright comes from $MEND_VERIFY_PLAYWRIGHT (default ~/.cache/mend-verify/playwright), never
// from this repository's dependencies.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Refused, checkTarget } from "./guard/policy.mjs";
import { CREDENTIAL_PATTERNS, mintedCodes, redact } from "./redact.mjs";
import { loadSecrets, privateRoot, redactValues, register } from "./secrets.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const web = flag("web");
const out = flag("out");
const recipe = flag("recipe");
const privateDir = flag("private");
const state = flag("state");
const accountFile = flag("account");
const timeout = Number(flag("timeout") ?? "30000");
const cdp = flag("cdp");
const viewportFlag = /^(\d+)x(\d+)$/.exec(flag("viewport") ?? "1280x900");
if (!web || !out || !recipe || !privateDir || !viewportFlag || (cdp && (state || accountFile))) {
  process.stderr.write(
    "usage: drive-web.mjs --web <url> --out <dir> --recipe <file.mjs> --private <dir> [--account <file>] [--state <file>] [--timeout <ms>] [--viewport <w>x<h>] [--cdp <url>] (--cdp takes neither --account nor --state)\n",
  );
  process.exit(2);
}
const viewport = { width: Number(viewportFlag[1]), height: Number(viewportFlag[2]) };
try {
  checkTarget(
    web,
    { ...process.env, MEND_VERIFY_PRIVATE: privateRoot(privateDir) },
    { clients: true },
  );
} catch (error) {
  if (!(error instanceof Refused)) throw error;
  process.stderr.write(
    `drive-web: ${error.message}; refused · a verifier never talks to the owner's server\n`,
  );
  process.exit(97);
}
mkdirSync(out, { recursive: true });

let secrets = loadSecrets(privateDir);
const scrub = (text) => redact(redactValues(text, secrets));
const registerSecret = (name, value) => {
  register(privateDir, name, value);
  secrets = loadSecrets(privateDir);
};

// Anything that escapes the protected block below (setup, finalization) leaves scrubbed too.
const escaped = (error) => {
  process.stderr.write(`drive-web: ${scrub(String(error?.message ?? error)).split("\n")[0]}\n`);
  process.exit(1);
};
process.on("uncaughtException", escaped);
process.on("unhandledRejection", escaped);

// The browser state is private: parsed here, so a malformed file fails with a fixed message and
// never reaches Playwright, whose parse error prints the offending line.
let storageState;
if (state && existsSync(state))
  try {
    storageState = JSON.parse(readFileSync(state, "utf8"));
  } catch {
    process.stderr.write(
      "drive-web: the browser state file is not valid JSON; nothing of it shown\n",
    );
    process.exit(1);
  }

const note = (text) =>
  appendFileSync(join(out, "steps.log"), `${new Date().toISOString()} ${scrub(text)}\n`);

// The mark a field gets when a secret was typed into it, and the words that name a credential
// field. A field's snapshot node carries its name; its value is on the node or its children.
const SECRET_MARK = "data-verify-secret";
const CREDENTIAL_NAME =
  /token|key|secret|password|credential|passphrase|sk-ant|claudeAiOauth|auth\.json|paste|\bcode\b/i;

/** A snapshot with every credential field's node and subtree redacted, line by line. */
const redactFieldSubtrees = (snapshot) => {
  const lines = snapshot.split("\n");
  let fieldIndent = -1;
  return lines
    .map((line) => {
      const indent = line.length - line.trimStart().length;
      if (fieldIndent !== -1 && indent > fieldIndent) return `${" ".repeat(indent)}- <redacted>`;
      fieldIndent = -1;
      // `- textbox "Name": value`, or YAML-quoted when the name holds quotes:
      // `- 'textbox "sk-ant-oat01-… or { \"claudeAiOauth\" }"':`.
      const field = /^(\s*- '?(?:textbox|searchbox|combobox)\s+"((?:[^"\\]|\\.)*)"'?)(.*)$/.exec(
        line,
      );
      if (field && CREDENTIAL_NAME.test(field[2])) {
        fieldIndent = indent;
        return `${field[1]}${field[3].includes(":") ? ": <redacted>" : field[3]}`;
      }
      return line;
    })
    .join("\n");
};

// Pixels a text check cannot read: screenshots of these views are withheld.
const OPAQUE = "canvas, video, embed, object";
const FRAMES = "iframe, frame";
const OPAQUE_TAGS = new Set(["CANVAS", "VIDEO", "EMBED", "OBJECT", "IFRAME", "FRAME"]);

/** Every text node's text, open shadow roots included, scripts and styles not. */
const deepText = () => {
  const parts = [];
  const walk = (root) => {
    for (const node of root.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? "");
      else if (node.nodeType === Node.ELEMENT_NODE) {
        if (["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT"].includes(node.tagName)) continue;
        if (node.shadowRoot) walk(node.shadowRoot);
        if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement)
          parts.push(node.value);
        walk(node);
      }
    }
  };
  walk(document.documentElement);
  return parts.join("\n");
};

/** A top-level child hidden from masking locators makes the whole screenshot unavailable. */
const hasUnmaskableFrame = async (page) => {
  for (const frame of page.mainFrame().childFrames()) {
    let element;
    try {
      element = await frame.frameElement();
      const closed = await element.evaluate((node) => {
        let root = node.getRootNode();
        while (root instanceof ShadowRoot) {
          if (root.mode === "closed") return true;
          root = root.host.getRootNode();
        }
        return false;
      });
      if (closed) return true;
    } catch {
      return true;
    } finally {
      await element?.dispose().catch(() => {});
    }
  }
  return false;
};

/** Closed content cannot be read or bounded safely by Playwright's text/masking locators. */
const screenshotGuard = async (page) => {
  let session;
  let closed = false;
  let unavailable = false;
  let opaque = false;
  const observeNode = (root, includeDocuments = false) => {
    // Native controls have user-agent roots; they are not author-hidden page content. Events
    // conservatively include roots added in child documents on this target.
    const pending = [root];
    while (pending.length > 0) {
      const node = pending.pop();
      if (node.shadowRootType === "user-agent") continue;
      if (node.shadowRootType === "closed") closed = true;
      if (OPAQUE_TAGS.has(node.nodeName)) opaque = true;
      // Insertions may report only a subtree's child count, not its descendants. A closed host
      // can be appended and removed there before another DOM request can discover it.
      if (includeDocuments && (node.childNodeCount ?? 0) > (node.children?.length ?? 0))
        unavailable = true;
      pending.push(...(node.children ?? []), ...(node.shadowRoots ?? []));
      if (includeDocuments && node.contentDocument) pending.push(node.contentDocument);
    }
  };
  const observeRoot = ({ root }) => observeNode(root, true);
  const observeInsertion = ({ node }) => observeNode(node, true);
  const observeChildren = ({ nodes }) => {
    for (const node of nodes) observeNode(node, true);
  };
  // A reset drops the previously requested DOM tree and its event coverage. Do not vouch for
  // pixels from that interval even if the replacement document is readable at the final check.
  const observeReset = () => {
    unavailable = true;
  };
  const listeners = [
    ["DOM.shadowRootPushed", observeRoot],
    ["DOM.childNodeInserted", observeInsertion],
    ["DOM.setChildNodes", observeChildren],
    ["DOM.documentUpdated", observeReset],
  ];
  const check = async () => {
    if (!session || unavailable) return "screenshot inspection unavailable";
    try {
      const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
      // A child document's frame already withholds the image. Shadow roots on hosts in this
      // document still count, including closed roots nested in open ones.
      observeNode(root);
    } catch {
      unavailable = true;
    }
    return unavailable
      ? "screenshot inspection unavailable"
      : closed
        ? "a closed shadow root"
        : opaque
          ? "opaque content requiring screenshot masking"
          : undefined;
  };
  try {
    session = await page.context().newCDPSession(page);
    for (const [event, listener] of listeners) session.on(event, listener);
  } catch {
    unavailable = true;
  }
  return {
    check,
    close: async () => {
      for (const [event, listener] of listeners) session?.off(event, listener);
      await session?.detach().catch(() => {});
    },
  };
};

/** The redacted snapshot, and the kinds of credential the page showed. */
const inspect = async (page) => {
  const raw = await page.locator("body").ariaSnapshot();
  const text = await page.evaluate(deepText);
  for (const code of mintedCodes(`${raw}\n${text}`)) registerSecret("minted-code", code);
  const kinds = new Set(
    CREDENTIAL_PATTERNS.filter(({ pattern }) =>
      [raw, text].some((view) => new RegExp(pattern.source, pattern.flags).test(view)),
    ).map(({ kind }) => kind),
  );
  if ([...secrets.keys()].some((value) => raw.includes(value) || text.includes(value)))
    kinds.add("a registered secret");
  const onPage = await page.evaluate(
    ({ mark, words }) => {
      const credential = new RegExp(words, "i");
      const fields = [...document.querySelectorAll("textarea, input")];
      return {
        typed: fields.some((field) => field.hasAttribute(mark) && field.value !== ""),
        // A filled password field, or a filled field named, labelled or hinted as a credential.
        filled: fields.some(
          (field) =>
            field.value !== "" &&
            ((field.getAttribute("type") ?? "") === "password" ||
              credential.test(
                [
                  field.getAttribute("name") ?? "",
                  field.id,
                  field.getAttribute("placeholder") ?? "",
                  field.getAttribute("aria-label") ?? "",
                  ...[...(field.labels ?? [])].map((label) => label.textContent ?? ""),
                ].join(" "),
              )),
        ),
        // A QR code: an SVG drawn as one long path.
        qr: [...document.querySelectorAll("svg path")].some(
          (path) => (path.getAttribute("d") ?? "").length > 1500,
        ),
      };
    },
    { mark: SECRET_MARK, words: CREDENTIAL_NAME.source },
  );
  if (onPage.typed) kinds.add("a field a secret was typed into");
  if (onPage.filled) kinds.add("filled credential field");
  if (onPage.qr) kinds.add("QR code");
  return { snapshot: redactFieldSubtrees(scrub(raw)), kinds: [...kinds] };
};

const playwrightHome =
  process.env.MEND_VERIFY_PLAYWRIGHT ?? join(homedir(), ".cache", "mend-verify", "playwright");
const { chromium } = createRequire(join(playwrightHome, "package.json"))("playwright-core");

const browser = cdp ? await chromium.connectOverCDP(cdp) : await chromium.launch();
const context = cdp
  ? browser.contexts()[0]
  : await browser.newContext({ viewport, ...(storageState ? { storageState } : {}) });
// The desktop's window: the first page that is the app, not a devtools or blank target.
const page = cdp
  ? (context.pages().find((candidate) => !candidate.url().startsWith("devtools:")) ??
    (await context.waitForEvent("page")))
  : await context.newPage();
page.setDefaultTimeout(timeout);

const capture = async (name) => {
  // A reused name must not leave an older image or digest after this capture is withheld/fails.
  for (const suffix of [".png", ".png.checked", ".png.withheld"])
    rmSync(join(out, `${name}${suffix}`), { force: true });
  const withhold = (kinds) => {
    writeFileSync(
      join(out, `${name}.png.withheld`),
      `screenshot withheld: the page showed ${kinds.join(", ")}\n`,
    );
    note(`capture ${name} · ${page.url()} · screenshot withheld (${kinds.join(", ")})`);
  };
  const guard = await screenshotGuard(page);
  try {
    const before = await guard.check();
    const { snapshot, kinds } = await inspect(page);
    if (before) kinds.push(before);
    if (await hasUnmaskableFrame(page)) kinds.push("a frame that cannot be masked");
    writeFileSync(join(out, `${name}.aria.yml`), snapshot);
    if (kinds.length > 0) return withhold(kinds);
    // Playwright masks create their own closed roots. Withhold instead of exempting those roots
    // by a spoofable tag name or replacing masks with author-overridable CSS hiding.
    const frames = await page.locator(FRAMES).count();
    const masked = await page.locator(OPAQUE).count();
    if (masked + frames > 0) return withhold(["opaque content requiring screenshot masking"]);
    // Keep pixels in memory until the post-capture check and event latch have both passed.
    const png = await page.screenshot({ fullPage: true });
    const after = await guard.check();
    if (after) return withhold([after]);
    writeFileSync(join(out, `${name}.png`), png);
    writeFileSync(
      join(out, `${name}.png.checked`),
      `${JSON.stringify({ sha256: createHash("sha256").update(png).digest("hex"), masked: { opaqueElements: masked, frames } })}\n`,
    );
    note(`capture ${name} · ${page.url()}`);
  } finally {
    await guard.close();
  }
};

const typeSecret = async (locator, name, value) => {
  registerSecret(name, value);
  await locator.waitFor();
  // Set by script and announced as typed, so the page's own state follows; the value never
  // reaches a Playwright action that could log it.
  await locator.evaluate(
    (field, { mark, text }) => {
      const prototype =
        field instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(field, text);
      field.setAttribute(mark, "");
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { mark: SECRET_MARK, text: value },
  );
};

let failed = false;
try {
  if (accountFile) {
    const account = JSON.parse(readFileSync(accountFile, "utf8"));
    await page.goto(new URL("/login", web).href);
    await page.getByRole("button", { name: "Sign in" }).waitFor();
    await page.getByRole("textbox", { name: "Email" }).fill(account.email);
    await typeSecret(
      page.getByLabel("Password", { exact: true }),
      "account-password",
      account.password,
    );
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL((url) => url.pathname !== "/login");
    // An account's first sign-in may ask how it reaches its repositories first.
    if (new URL(page.url()).pathname === "/welcome")
      await page.getByRole("button", { name: "Continue to Mend" }).click();
    note(`signed in as the stack's first account (${account.email})`);
  }
  const run = (await import(pathToFileURL(resolve(recipe)).href)).default;
  await run({ page, web, capture, note, typeSecret, registerSecret });
  note("recipe ended");
} catch (error) {
  failed = true;
  // Playwright's messages carry their call log, arguments included: only the scrubbed text leaves.
  const message = scrub(String(error?.message ?? error));
  note(`FAILED · ${message.split("\n")[0]}`);
  // Numbered, so a second failed drive into the same folder keeps the first one's capture.
  let n = 1;
  while (existsSync(join(out, `failure-${n}.aria.yml`))) n += 1;
  await capture(`failure-${n}`).catch(() => undefined);
  process.stderr.write(`drive-web: ${message}\n`);
} finally {
  if (state) {
    // What the browser holds now joins the registry before the file is rewritten.
    await context.storageState({ path: state });
    secrets = loadSecrets(privateDir);
  }
  // Over CDP this only disconnects: the desktop app stays as it was for the next recipe.
  await browser.close();
}
process.exit(failed ? 1 : 0);
