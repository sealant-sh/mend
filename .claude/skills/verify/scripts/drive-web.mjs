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
// Evidence holds no credential. Every snapshot, log line and error goes through the registry (every
// value, by value) and redact.mjs (every shape). A page that shows one (a field a secret was typed
// into, a registered value, a QR code, any shape redact.mjs knows, a filled credential field) keeps
// its redacted snapshot, with every credential field's subtree redacted, and its screenshot is
// withheld: <name>.png.withheld says which kinds were on the page. The page's whole text is checked
// as well as its ARIA snapshot (text a screen reader is told to skip, `aria-hidden`, is still drawn).
// Pixels no text check can read are never kept: every canvas (a terminal draws its output on one),
// video and embedded object is masked in every screenshot, and so is any frame that holds one or
// cannot be inspected. A kept screenshot gets <name>.png.checked (its sha256 and what was masked):
// scan-evidence.mjs refuses an image without one. A code a page shows (a pairing code, an
// authorization code and its link) joins the registry by value before anything is written. A failing recipe is captured as
// <out>/failure-<n>.* (the same rules; numbered, so earlier failures stay) before the driver exits 1, and its error is printed redacted.
// No trace, HAR or video is recorded.
//
// --web must be this run's own stack through its tunnel (guard/policy.mjs, with the private
// directory's tunnel.json and MEND_VERIFY_OUTER_URL), or the mobile proxy drive-mobile.mjs started
// in front of that tunnel (its mobile.json): the driver refuses (exit 97) any other server.
//
// Playwright comes from $MEND_VERIFY_PLAYWRIGHT (default ~/.cache/mend-verify/playwright), never
// from this repository's dependencies.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    { mobile: true },
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

// Pixels a text check cannot read: masked in every screenshot.
const OPAQUE = "canvas, video, embed, object";

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

/** The frames whose pixels cannot be checked: one that holds an opaque element, or cannot be read. */
const opaqueFrames = async (page) => {
  const found = [];
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const opaque = await frame
      .evaluate((selector) => document.querySelector(selector) !== null, OPAQUE)
      .catch(() => true);
    if (opaque) found.push(frame);
  }
  return found;
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
  const { snapshot, kinds } = await inspect(page);
  writeFileSync(join(out, `${name}.aria.yml`), snapshot);
  if (kinds.length > 0) {
    writeFileSync(
      join(out, `${name}.png.withheld`),
      `screenshot withheld: the page showed ${kinds.join(", ")}\n`,
    );
    note(`capture ${name} · ${page.url()} · screenshot withheld (${kinds.join(", ")})`);
    return;
  }
  // Every canvas, video and object is masked (CSS locators reach into open shadow roots), and every
  // frame that holds one or cannot be read: no pixel a text check cannot read is kept.
  const frames = await opaqueFrames(page);
  const mask = [page.locator(OPAQUE)];
  // A frame nested anywhere sits inside one of the page's own iframes: those are masked whole.
  if (frames.length > 0) mask.push(page.locator("iframe"));
  const masked = await page.locator(OPAQUE).count();
  // Playwright writes PNGs with no text chunks: pixels only.
  const png = await page.screenshot({ path: join(out, `${name}.png`), fullPage: true, mask });
  writeFileSync(
    join(out, `${name}.png.checked`),
    `${JSON.stringify({ sha256: createHash("sha256").update(png).digest("hex"), masked: { opaqueElements: masked, frames: frames.length } })}\n`,
  );
  note(
    `capture ${name} · ${page.url()}${masked + frames.length > 0 ? ` · ${masked} canvas/video/object and ${frames.length} frame(s) masked` : ""}`,
  );
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
