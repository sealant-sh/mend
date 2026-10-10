#!/usr/bin/env node
// The verify skill's web driver: one headless Chromium against the tunnelled stack, one recipe.
//
//   node .claude/skills/verify/scripts/drive-web.mjs --web <url> --out <dir> --recipe <file.mjs> \
//     --private <dir> [--account <file>] [--state <file>] [--timeout <ms>]
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
// withheld: <name>.png.withheld says which kinds were on the page. A failing recipe is captured as
// <out>/failure.* (the same rules) before the driver exits 1, and its error is printed redacted.
// No trace, HAR or video is recorded.
//
// Playwright comes from $MEND_VERIFY_PLAYWRIGHT (default ~/.cache/mend-verify/playwright), never
// from this repository's dependencies.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CREDENTIAL_PATTERNS, redact } from "./redact.mjs";
import { loadSecrets, redactValues, register } from "./secrets.mjs";

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
if (!web || !out || !recipe || !privateDir) {
  process.stderr.write(
    "usage: drive-web.mjs --web <url> --out <dir> --recipe <file.mjs> --private <dir> [--account <file>] [--state <file>] [--timeout <ms>]\n",
  );
  process.exit(2);
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

/** The redacted snapshot, and the kinds of credential the page showed. */
const inspect = async (page) => {
  const raw = await page.locator("body").ariaSnapshot();
  const kinds = new Set(
    CREDENTIAL_PATTERNS.filter(({ pattern }) =>
      new RegExp(pattern.source, pattern.flags).test(raw),
    ).map(({ kind }) => kind),
  );
  if ([...secrets.keys()].some((value) => raw.includes(value))) kinds.add("a registered secret");
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

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  ...(storageState ? { storageState } : {}),
});
const page = await context.newPage();
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
  // Playwright writes PNGs with no text chunks: pixels only.
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
  note(`capture ${name} · ${page.url()}`);
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
  await capture("failure").catch(() => undefined);
  process.stderr.write(`drive-web: ${message}\n`);
} finally {
  if (state) {
    // What the browser holds now joins the registry before the file is rewritten.
    await context.storageState({ path: state });
    secrets = loadSecrets(privateDir);
  }
  await browser.close();
}
process.exit(failed ? 1 : 0);
