// The helpers a drive-vscode recipe receives: gestures on VS Code's real workbench DOM, over
// Playwright attached through CDP, the way a person clicks through it. Nothing here calls the
// extension's API: a recipe that needs the extension for setup goes through `api` (Mend's HTTP
// API, marked `via: "api"` in its step) and never for the action under test.
//
// Every window of the instance is a page of the one browser context. A Remote-SSH open either
// reloads a window (the same page navigates) or opens a new one (a new page): `windows()` re-reads
// the pages each time, and `waitForWindow(known)` waits for one that was not there before.
//
// VS Code draws its modals and context menus in the DOM only with `window.dialogStyle` and
// `window.titleBarStyle` set to `custom` (drive-vscode.mjs writes both into the run's settings);
// with the native style they are GTK windows outside the page, and no helper here can reach them.
// The terminal is read from the DOM renderer (`terminal.integrated.gpuAcceleration: off`, also
// written there): the canvas renderer leaves no text to read.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { CREDENTIAL_PATTERNS, redact } from "./redact.mjs";
import { redactValues } from "./secrets.mjs";

const QUICK_INPUT = ".quick-input-widget";
const QUICK_INPUT_BOX = `${QUICK_INPUT} .quick-input-box input`;
const QUICK_INPUT_ROW = `${QUICK_INPUT} .quick-input-list .monaco-list-row`;
const SIDEBAR_ROW = ".part.sidebar .monaco-list-row";
const TOAST = ".notifications-toasts .notification-list-item";
const DIALOG = ".monaco-dialog-box";
const CONTEXT_MENU_ITEM = ".context-view .monaco-menu .action-item:not(.disabled) .action-label";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What a step returned, as JSON data: a Playwright page or any other live object is left out. */
const plain = (value) => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(plain).filter((item) => item !== undefined);
  if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, inner]) => [key, plain(inner)])
      .filter(([, inner]) => inner !== undefined),
  );
};

/** Every text node's text, open shadow roots included; input values too. */
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

/** The active terminal's rows as the DOM renderer draws them, blank rows at the end dropped. */
const terminalRows = () => {
  const active =
    document.querySelector(".terminal-wrapper.active .xterm-rows") ??
    document.querySelector(".terminal .xterm-rows");
  if (active === null) return null;
  const rows = [...active.children].map((row) => row.textContent ?? "");
  while (rows.length > 0 && rows.at(-1).trim() === "") rows.pop();
  return rows;
};

/**
 * The helper set over one browser context. `options`: `out` (the evidence directory), `secrets`
 * (the registry, for redaction), `steps` (the step log), `api` (the run's Mend client), `state`
 * (the run's state file), `timeout` (per gesture), `log` (stdout).
 */
export const workbenchHelpers = async (context, options) => {
  const { out, secrets, steps, api, state, timeout, log } = options;
  const scrub = (text) => redact(redactValues(text, secrets));
  const pages = () => context.pages().filter((page) => !page.url().startsWith("devtools:"));
  let current = pages()[0];
  if (current === undefined) throw new Error("the instance has no workbench window");
  // Over CDP the pages come in no fixed order: start in the local window, not in a leftover
  // workspace window of an earlier recipe.
  const start = (async () => {
    for (const candidate of pages())
      if (!(await candidate.title().catch(() => "")).includes("[SSH:")) return candidate;
    return current;
  })();
  const page = () => current;
  let shots = 0;
  let lastShot = null;
  let stepIndex = 0;

  const waitUntil = async (what, read, limit = timeout) => {
    const deadline = Date.now() + limit;
    let last = null;
    while (Date.now() < deadline) {
      try {
        const value = await read();
        if (value !== null && value !== undefined && value !== false) return value;
      } catch (cause) {
        last = cause;
      }
      await sleep(250);
    }
    throw new Error(
      `timed out after ${limit} ms waiting for ${what}${last instanceof Error ? `: ${scrub(last.message.split("\n")[0])}` : ""}`,
    );
  };

  const text = async (target = page()) => target.evaluate(deepText);

  const windows = async () =>
    Promise.all(
      pages().map(async (candidate, index) => ({
        index,
        page: candidate,
        title: await candidate.title().catch(() => ""),
        url: candidate.url(),
        current: candidate === current,
      })),
    );

  /** A window that is not among `known` (pages from an earlier `windows()`), once it has a workbench. */
  const waitForWindow = async (known, limit = timeout) => {
    const seen = new Set(known.map((window) => window.page ?? window));
    const found = await waitUntil(
      "a new window",
      () => pages().find((candidate) => !seen.has(candidate)) ?? null,
      limit,
    );
    await found.locator(".monaco-workbench").first().waitFor({ timeout: limit });
    return found;
  };

  /**
   * Every window opened since `known`, once no new one has appeared for `settle` ms (at most
   * `limit` ms in all): what one gesture opened, counted after it has finished opening.
   */
  const newWindows = async (known, { settle = 15_000, limit = 60_000 } = {}) => {
    const seen = new Set(known.map((window) => window.page ?? window));
    const deadline = Date.now() + limit;
    let found = [];
    let changedAt = Date.now();
    while (Date.now() < deadline && Date.now() - changedAt < settle) {
      const now = pages().filter((candidate) => !seen.has(candidate));
      if (now.length !== found.length) changedAt = Date.now();
      found = now;
      await sleep(500);
    }
    return found;
  };

  const useWindow = async (target) => {
    current = target.page ?? target;
    await current.bringToFront();
    return current;
  };

  /** The window that is not a Remote-SSH workspace: the first window `up` opened on the clone. */
  const homeWindow = async () => {
    for (const candidate of pages()) {
      const title = await candidate.title().catch(() => "");
      if (!title.includes("[SSH:")) return candidate;
    }
    throw new Error("no local window is left");
  };

  /** `Close Window` from that window's own palette; the page is closed outright if it never answers. */
  const closeWindow = async (target) => {
    const victim = target.page ?? target;
    if (victim.isClosed()) return "already closed";
    const was = current;
    try {
      await useWindow(victim);
      await palette("Close Window");
      await waitUntil("the window to close", () => (victim.isClosed() ? true : null), 15_000);
      return "closed from its palette";
    } catch {
      await victim.close().catch(() => undefined);
      return "closed over CDP (its palette did not answer)";
    } finally {
      current = was.isClosed() ? await homeWindow() : was;
      await current.bringToFront().catch(() => undefined);
    }
  };

  /** The command palette: F1, the command's title typed, its row clicked. */
  const palette = async (title) => {
    const target = page();
    await target.bringToFront();
    if (await target.locator(QUICK_INPUT).isVisible()) await target.keyboard.press("Escape");
    await target.keyboard.press("F1");
    const box = target.locator(QUICK_INPUT_BOX);
    await box.waitFor({ timeout });
    // F1 opens quick open in command mode, the `>` already in the box: keep it.
    await box.fill(`>${title.replace(/…$/, "")}`);
    // The row whose label is the title itself, not a longer one the fuzzy filter also lists
    // (`Mend: New session in this worktree…` beside `Mend: New Session…`), and not a position
    // that another row takes once the filter settles.
    const exact = new RegExp(`^${escapeRegExp(title.replace(/…$/, ""))}…?$`);
    const row = target
      .locator(QUICK_INPUT_ROW)
      .filter({ has: target.locator(".label-name", { hasText: exact }) })
      .first();
    await row.waitFor({ timeout });
    await sleep(300);
    await row.click();
    // The palette's own list is gone before the command's first quick input can be read. A command
    // that closes the window (`Close Window`) ends the wait too.
    await waitUntil(
      "the palette to close",
      async () => {
        if (target.isClosed()) return true;
        const open = await target.locator(QUICK_INPUT).isVisible();
        if (!open) return true;
        const value = await target.locator(QUICK_INPUT_BOX).inputValue();
        return value.startsWith(">") ? null : true;
      },
      timeout,
    );
  };

  const quickInput = {
    /** The widget's title, or null while none is open. */
    title: async () => {
      const shown = page().locator(`${QUICK_INPUT} .quick-input-title`);
      return (await shown.count()) > 0 && (await shown.first().isVisible())
        ? (await shown.first().innerText()).trim()
        : null;
    },
    isOpen: async () => page().locator(QUICK_INPUT).isVisible(),
    waitFor: (limit = timeout) => page().locator(QUICK_INPUT_BOX).waitFor({ timeout: limit }),
    items: async () =>
      Promise.all((await page().locator(QUICK_INPUT_ROW).all()).map((row) => row.innerText())),
    type: async (value) => {
      const box = page().locator(QUICK_INPUT_BOX);
      await box.waitFor({ timeout });
      await box.fill(value);
    },
    pick: async (label) => {
      const row = page().locator(QUICK_INPUT_ROW, { hasText: label }).first();
      await row.waitFor({ timeout });
      await row.click();
    },
    accept: () => page().keyboard.press("Enter"),
    cancel: () => page().keyboard.press("Escape"),
    /**
     * Watches the widget from now: every time it is shown, or shown with another title, one
     * event `{ at, title }`. Two commands asking at once show two (the second replaces the first).
     * `stop()` returns the events.
     */
    watch: async () => {
      await page().evaluate((selector) => {
        const events = [];
        const widget = document.querySelector(selector);
        let last = null;
        const sample = () => {
          if (widget === null) return;
          const visible = widget.style.display !== "none" && widget.offsetParent !== null;
          const title = widget.querySelector(".quick-input-title")?.textContent?.trim() ?? "";
          const key = visible ? `shown:${title}` : "hidden";
          if (key !== last) {
            last = key;
            if (visible) events.push({ at: Date.now(), title });
          }
        };
        sample();
        const observer = new MutationObserver(sample);
        if (widget !== null)
          observer.observe(widget, {
            attributes: true,
            childList: true,
            subtree: true,
            characterData: true,
          });
        window.mendVerifyQuickInputWatch = { events, stop: () => observer.disconnect() };
      }, QUICK_INPUT);
      return {
        stop: () =>
          page().evaluate(() => {
            const watch = window.mendVerifyQuickInputWatch;
            watch?.stop();
            delete window.mendVerifyQuickInputWatch;
            return watch?.events ?? [];
          }),
      };
    },
  };

  /** The Mend view: its Activity Bar entry clicked, its tree waited for. */
  const view = async (name) => {
    const entry = page().locator(`.activitybar .action-item .action-label[aria-label^="${name}"]`);
    await entry.first().waitFor({ timeout });
    const header = page().locator(".part.sidebar .pane-header");
    if ((await header.count()) === 0 || !(await page().locator(".part.sidebar").isVisible()))
      await entry.first().click();
    else if (
      !(await page().locator(".part.sidebar .composite.title", { hasText: name }).isVisible())
    )
      await entry.first().click();
    await page().locator(".part.sidebar .monaco-list").first().waitFor({ timeout });
  };

  /** A row of the sidebar's tree, by a substring or pattern of its text. */
  const treeItem = (label) => {
    const row = () => page().locator(SIDEBAR_ROW, { hasText: label }).first();
    return {
      waitFor: (limit = timeout) => row().waitFor({ timeout: limit }),
      text: async () => (await row().innerText()).replace(/\s+/g, " ").trim(),
      description: async () => {
        const description = row().locator(".label-description");
        return (await description.count()) > 0
          ? (await description.first().innerText()).trim()
          : "";
      },
      click: () => row().click(),
      dblclick: () => row().dblclick(),
      hover: () => row().hover(),
      /** The inline action that appears on hover, by its title. */
      inline: async (title) => {
        await row().hover();
        const action = row().locator(`.actions .action-label[aria-label="${title}"]`);
        await action.first().waitFor({ timeout });
        await action.first().click();
      },
      /** The row's context menu item, by its label. */
      contextMenu: async (item) => {
        await row().click({ button: "right" });
        const entry = page().locator(CONTEXT_MENU_ITEM, { hasText: item }).first();
        await entry.waitFor({ timeout });
        await entry.click();
      },
    };
  };

  /** A toast whose text holds `pattern`; `click(button)` presses one of its buttons. */
  const notification = (pattern) => {
    const toast = () => page().locator(TOAST, { hasText: pattern }).first();
    return {
      waitFor: (limit = timeout) => toast().waitFor({ timeout: limit }),
      text: async () => (await toast().innerText()).replace(/\s+/g, " ").trim(),
      click: async (button) => {
        const found = toast().locator(".notification-list-item-buttons-container .monaco-button", {
          hasText: button,
        });
        await found.first().waitFor({ timeout });
        await found.first().click();
      },
      dismiss: () => toast().locator(".codicon-notifications-clear").first().click(),
    };
  };
  const notifications = async () =>
    Promise.all(
      (await page().locator(TOAST).all()).map(async (toast) =>
        (await toast.innerText()).replace(/\s+/g, " ").trim(),
      ),
    );

  /** A modal dialog (custom style) whose text holds `pattern`. */
  const dialog = (pattern) => {
    const box = () => page().locator(DIALOG, { hasText: pattern }).first();
    return {
      waitFor: (limit = timeout) => box().waitFor({ timeout: limit }),
      text: async () => (await box().innerText()).replace(/\s+/g, " ").trim(),
      click: async (button) => {
        const found = box().locator(".monaco-button", { hasText: button });
        await found.first().waitFor({ timeout });
        await found.first().click();
      },
    };
  };
  const dialogs = async () =>
    Promise.all(
      (await page().locator(DIALOG).all()).map(async (box) =>
        (await box.innerText()).replace(/\s+/g, " ").trim(),
      ),
    );

  const statusBar = (pattern) => {
    const item = () =>
      page().locator(".part.statusbar .statusbar-item", { hasText: pattern }).first();
    return {
      waitFor: (limit = timeout) => item().waitFor({ timeout: limit }),
      text: async () => (await item().innerText()).replace(/\s+/g, " ").trim(),
      click: () => item().click(),
    };
  };

  /** The active integrated terminal: typed into as a person types; read from its DOM rows. */
  const terminal = () => ({
    waitFor: (limit = timeout) =>
      waitUntil("a terminal", async () => (await page().evaluate(terminalRows)) !== null, limit),
    type: async (line) => {
      await page().locator(".terminal-wrapper.active .xterm, .terminal .xterm").first().click();
      await page().keyboard.type(line);
      await page().keyboard.press("Enter");
    },
    read: async () => (await page().evaluate(terminalRows)) ?? [],
    waitForText: (pattern, limit = timeout) =>
      waitUntil(
        `the terminal to show ${pattern}`,
        async () => {
          const rows = ((await page().evaluate(terminalRows)) ?? []).join("\n");
          return (typeof pattern === "string" ? rows.includes(pattern) : pattern.test(rows))
            ? rows
            : null;
        },
        limit,
      ),
  });

  const waitForText = (pattern, { timeout: limit = timeout, page: target } = {}) =>
    waitUntil(
      `the window to show ${pattern}`,
      async () => {
        const body = await text(target ?? page());
        return (typeof pattern === "string" ? body.includes(pattern) : pattern.test(body))
          ? true
          : null;
      },
      limit,
    );

  /**
   * A numbered screenshot of the current window. A window whose text shows a credential shape
   * or a registered value keeps no image: `<name>.png.withheld` says why; a kept image gets
   * `<name>.png.checked` with its digest (the evidence scan refuses one without).
   */
  const shot = async (slug) => {
    shots += 1;
    const name = `${String(shots).padStart(2, "0")}-${slug.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
    const body = await text().catch(() => "");
    const kinds = CREDENTIAL_PATTERNS.filter(({ pattern }) =>
      new RegExp(pattern.source, pattern.flags).test(body),
    ).map(({ kind }) => kind);
    if ([...secrets.keys()].some((value) => body.includes(value)))
      kinds.push("a registered secret");
    const file = join(out, `${name}.png`);
    if (kinds.length > 0) {
      writeFileSync(
        `${file}.withheld`,
        `screenshot withheld: the window showed ${kinds.join(", ")}\n`,
      );
      lastShot = `${name}.png.withheld`;
      return lastShot;
    }
    const png = await page().screenshot();
    writeFileSync(file, png);
    writeFileSync(
      `${file}.checked`,
      `${JSON.stringify({ sha256: createHash("sha256").update(png).digest("hex"), masked: { opaqueElements: 0, frames: 0 } })}\n`,
    );
    lastShot = `${name}.png`;
    return lastShot;
  };

  /**
   * One step: its name, what it observed (the string `fn` returns, or `observed` of the object it
   * returns), the last screenshot taken in it, and its timing, as one line of steps.jsonl. A step
   * that calls the server or any other setup path says so with `via: "api"` or `"setup"`.
   */
  const step = async (name, fn, { via = "dom" } = {}) => {
    stepIndex += 1;
    const startedAt = new Date();
    const before = lastShot;
    const finish = (fields) => {
      const line = steps.write({
        name,
        via,
        startedAt: startedAt.toISOString(),
        ms: Date.now() - startedAt.getTime(),
        shot: lastShot !== before ? lastShot : null,
        window: current.url().replace(/.*\//, ""),
        ...fields,
      });
      log(
        `step ${line.n} · ${name}${via === "dom" ? "" : ` · via ${via}`} · ${fields.error === undefined ? line.observed : `FAILED · ${line.error}`} · ${line.ms} ms`,
      );
      return line;
    };
    try {
      const result = await fn();
      const observed =
        typeof result === "string"
          ? result
          : result && typeof result === "object" && "observed" in result
            ? result.observed
            : "done";
      const extra = result && typeof result === "object" ? { ...result } : {};
      delete extra.observed;
      finish({ observed, ...(Object.keys(extra).length > 0 ? { detail: plain(extra) } : {}) });
      return result;
    } catch (cause) {
      const message = String(cause?.message ?? cause).split("\n")[0];
      const line = finish({ observed: null, error: message });
      throw new Error(`step ${line.n} (${name}) failed: ${scrub(message)}`, { cause });
    }
  };

  const note = (message) => {
    const line = steps.write({ note: message });
    log(`note · ${line.note}`);
  };

  current = await start;
  return {
    page,
    windows,
    waitForWindow,
    newWindows,
    useWindow,
    homeWindow,
    closeWindow,
    serverLogs: options.serverLogs,
    palette,
    quickInput,
    view,
    treeItem,
    notification,
    notifications,
    dialog,
    dialogs,
    statusBar,
    terminal,
    waitForText,
    waitUntil,
    text,
    shot,
    step,
    note,
    api,
    state,
    sleep,
  };
};
