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

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { menuItem, quickInputStep, remoteSshLogFiles, resolves } from "./drive-vscode.lib.mjs";
import { CREDENTIAL_PATTERNS, redact } from "./redact.mjs";
import { redactValues } from "./secrets.mjs";

const QUICK_INPUT = ".quick-input-widget";
const QUICK_INPUT_BOX = `${QUICK_INPUT} .quick-input-box input`;
const QUICK_INPUT_ROW = `${QUICK_INPUT} .quick-input-list .monaco-list-row`;
const TOAST = ".notifications-toasts .notification-list-item";
const DIALOG = ".monaco-dialog-box";
const CONTEXT_MENU_ITEM = ".context-view .monaco-menu .action-item:not(.disabled) .action-label";
const HOVER = ".monaco-hover.workbench-hover";
const CONTEXT_MENU = ".context-view .monaco-menu";
const STATUS_ITEM = ".part.statusbar .statusbar-item";
const WELCOME = ".welcome-view-content";
const VIEW_ACTION =
  ".part.sidebar .title-actions .action-label, .part.sidebar .pane-header .actions .action-label";
// VS Code 1.142 labels a pane header's `⋯` `More Actions...` and Source Control's title bar's
// `Views and More Actions...`.
const VIEW_OVERFLOW = /^(?:Views and )?More Actions\.{3}$/;

/** A button's tooltip as VS Code labels it: its aria-label, else its title. */
const tooltipOf = async (button) =>
  (await button.getAttribute("aria-label")) ?? (await button.getAttribute("title"));

/** A quick input row as a person reads it; separators (the group labels) are left out. */
const quickInputRow = (row) => {
  const [main, meta] = row.querySelectorAll(".quick-input-list-row");
  const name = main?.querySelector(".label-name");
  const icon = (element) =>
    [...element.classList]
      .find((cls) => cls.startsWith("codicon-") && !/^codicon-(colored|modifier-)/.test(cls))
      ?.slice("codicon-".length);
  return {
    label: (name?.textContent ?? "").trim(),
    icons: [...(name?.querySelectorAll(".codicon") ?? [])].map(icon).filter(Boolean),
    description: (main?.querySelector(".label-description")?.textContent ?? "").trim(),
    detail: (meta?.textContent ?? "").trim(),
    buttons: [...row.querySelectorAll(".quick-input-list-entry-action-bar .action-label")].map(
      (button) => button.getAttribute("aria-label") ?? button.getAttribute("title") ?? "",
    ),
    focused: row.classList.contains("focused"),
  };
};

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

/**
 * The panel's terminal tabs: their names (the tab list when it shows, the single tab's title when
 * not), the active one's name (from its xterm's accessible name, `Terminal <n>, <name>`), and
 * whether the keyboard is in a terminal.
 */
const terminalTabs = () => {
  const listed = [...document.querySelectorAll(".terminal-tabs-entry")].map((entry) =>
    (entry.textContent ?? "").trim(),
  );
  const single = [...document.querySelectorAll(".single-terminal-tab")].map((entry) =>
    (entry.textContent ?? "").trim(),
  );
  const accessible =
    document
      .querySelector(".terminal-wrapper.active textarea.xterm-helper-textarea")
      ?.getAttribute("aria-label") ?? "";
  const active = /^Terminal \d+, ([^\n]+)/.exec(accessible)?.[1]?.trim() ?? null;
  return {
    names: (listed.length > 0 ? listed : single).filter((name) => name !== ""),
    active,
    focused: document.activeElement?.closest(".xterm") != null,
  };
};

/**
 * Watches the page from now: every toast, modal dialog, quick input title and status bar text that
 * appears, in order, each distinct text once. What already shows when the watch starts is not
 * counted. Kept on `window` for `stop` to collect.
 */
const startWatch = ({ toast, dialog, quickInput, status }) => {
  const seen = { toasts: [], dialogs: [], quickInputs: [], statusBar: [] };
  const keys = new Set();
  let baseline = true;
  const note = (kind, text) => {
    const clean = (text ?? "").replace(/\s+/g, " ").trim();
    if (clean === "" || keys.has(`${kind}\u0000${clean}`)) return;
    keys.add(`${kind}\u0000${clean}`);
    if (!baseline) seen[kind].push(clean);
  };
  const sample = () => {
    for (const element of document.querySelectorAll(toast)) note("toasts", element.innerText);
    for (const element of document.querySelectorAll(dialog))
      if (element.offsetParent !== null) note("dialogs", element.innerText);
    const widget = document.querySelector(quickInput);
    if (widget !== null && widget.style.display !== "none" && widget.offsetParent !== null)
      note(
        "quickInputs",
        widget.querySelector(".quick-input-title")?.textContent ||
          widget.querySelector(".quick-input-box input")?.getAttribute("placeholder") ||
          "(untitled)",
      );
    for (const element of document.querySelectorAll(status))
      if (element.offsetParent !== null) note("statusBar", element.innerText);
  };
  sample();
  baseline = false;
  const observer = new MutationObserver(sample);
  observer.observe(document.body, {
    attributes: true,
    childList: true,
    subtree: true,
    characterData: true,
  });
  window.mendVerifyWatch = { seen, stop: () => observer.disconnect() };
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

  /**
   * Remote-SSH window opens and reloads so far (`resolves`), once the count has held still for
   * 5 s: the resolver logs a moment after its window appears.
   */
  const opens = async () => {
    let last = resolves(state.userData);
    let since = Date.now();
    const settled = await waitUntil(
      "the opens count to hold still for 5 s",
      async () => {
        const now = resolves(state.userData);
        if (now !== last) [last, since] = [now, Date.now()];
        return Date.now() - since >= 5_000 ? { now } : null;
      },
      60_000,
    );
    return settled.now;
  };

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
    // (`Mend: New session in this worktree…` beside `Mend: New session`), and not a position
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

  /**
   * What the command palette lists for `query` as a person sees it before choosing (F1, the text
   * typed, the list left to settle), then Escape: each row's label and whether it reads disabled.
   */
  const paletteRows = async (query) => {
    const target = page();
    await target.bringToFront();
    if (await target.locator(QUICK_INPUT).isVisible()) await target.keyboard.press("Escape");
    await target.keyboard.press("F1");
    const box = target.locator(QUICK_INPUT_BOX);
    await box.waitFor({ timeout });
    await box.fill(`>${query}`);
    let last = null;
    const rows = await waitUntil(
      "the palette's list to settle",
      async () => {
        await sleep(500);
        const now = await target.locator(QUICK_INPUT_ROW).evaluateAll((found) =>
          found.map((row) => ({
            label: (row.querySelector(".label-name")?.textContent ?? "").trim(),
            disabled:
              row.classList.contains("disabled") || row.getAttribute("aria-disabled") === "true",
          })),
        );
        const key = JSON.stringify(now);
        if (key === last) return now;
        last = key;
        return null;
      },
      timeout,
    );
    await target.keyboard.press("Escape");
    await waitUntil(
      "the palette to close",
      async () => ((await target.locator(QUICK_INPUT).isVisible()) ? null : true),
      5_000,
    );
    return rows;
  };

  /**
   * Rests the pointer on a view's pane header: once the container holds two views (Sessions and
   * Change), each view's buttons sit in its own header and VS Code draws them only under the
   * pointer. The first view's by default; a container of one view has no header to rest on.
   */
  const restOnHeader = async (index = 0) => {
    const header = page()
      .locator(".part.sidebar .pane-header")
      .filter({ visible: true })
      .nth(index);
    if ((await header.count()) === 0) return false;
    await header.hover();
    return true;
  };

  /** The sidebar view's title bar buttons, left to right: `{ title, disabled }`. */
  const viewActions = async () => {
    await restOnHeader();
    return page()
      .locator(VIEW_ACTION)
      .evaluateAll((found) =>
        found
          .filter((action) => action.offsetParent !== null)
          .map((action) => ({
            title: action.getAttribute("aria-label") ?? "",
            disabled:
              action.classList.contains("disabled") ||
              action.getAttribute("aria-disabled") === "true" ||
              action.closest(".action-item")?.classList.contains("disabled") === true,
          })),
      );
  };

  /** One of the view's title bar buttons, by its title (a prefix) or a pattern it matches. */
  const viewAction = (title) => {
    const matches = (label) =>
      typeof title === "string" ? label.startsWith(title) : title.test(label);
    const found = async () => {
      for (let header = 0; ; header += 1) {
        const rested = await restOnHeader(header);
        for (const candidate of await page().locator(VIEW_ACTION).filter({ visible: true }).all())
          if (matches((await candidate.getAttribute("aria-label")) ?? "")) return candidate;
        if (!rested) break;
      }
      throw new Error(
        `no view title button ${title} among ${JSON.stringify((await viewActions()).map((one) => one.title))}`,
      );
    };
    return {
      waitFor: async (limit = timeout) =>
        waitUntil(`the view's button ${title}`, async () => (await found()).isVisible(), limit),
      title: async () => (await found()).getAttribute("aria-label"),
      disabled: async () =>
        (await found()).evaluate(
          (element) =>
            element.classList.contains("disabled") ||
            element.getAttribute("aria-disabled") === "true" ||
            element.closest(".action-item")?.classList.contains("disabled") === true,
        ),
      click: async () => (await found()).click(),
      /** Its tooltip: the pointer rests on it until VS Code's hover shows. */
      tooltip: async () => {
        const hover = page().locator(HOVER).first();
        return waitUntil("the button's tooltip", async () => {
          await page().mouse.move(1, 1);
          await sleep(300);
          await (await found()).hover({ force: true });
          const shown = await hover
            .waitFor({ timeout: 5_000 })
            .then(() => true)
            .catch(() => false);
          return shown ? (await hover.innerText()).trim() : null;
        });
      },
    };
  };

  const openViewOverflow = async () => {
    await closeMenu();
    const rested = await restOnHeader();
    const scope = rested
      ? page().locator(".part.sidebar .pane-header").filter({ visible: true }).first()
      : page().locator(".part.sidebar .composite.title");
    let button = null;
    for (const candidate of await scope.locator(".action-label").filter({ visible: true }).all())
      if (VIEW_OVERFLOW.test((await candidate.getAttribute("aria-label")) ?? "")) {
        button = candidate;
        break;
      }
    if (button === null)
      throw new Error(
        `the view has no ⋯ button among ${JSON.stringify((await viewActions()).map((one) => one.title))}`,
      );
    await button.click();
    const menu = page().locator(CONTEXT_MENU).first();
    await menu.waitFor({ timeout });
    return menu.evaluate((root) =>
      [...root.querySelectorAll(".action-item")]
        .filter((item) => item.closest(".monaco-menu") === root)
        .map((item) => ({
          label: (item.querySelector(".action-label")?.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim(),
          disabled: item.classList.contains("disabled"),
        }))
        .filter((item) => item.label !== ""),
    );
  };

  const waitMenuClosed = (after) =>
    waitUntil(
      `the menu to close after ${after}`,
      async () => ((await page().locator(CONTEXT_MENU).isVisible()) ? null : true),
      5_000,
    );

  const viewOverflowItems = async () => {
    const items = await openViewOverflow();
    await page().keyboard.press("Escape");
    await waitMenuClosed("Escape");
    return items;
  };

  const viewOverflowItem = async (label) => {
    const items = await openViewOverflow();
    let found;
    try {
      found = menuItem(items, label);
    } catch (cause) {
      await page().keyboard.press("Escape");
      await waitMenuClosed("Escape");
      throw cause;
    }
    const entry = page()
      .locator(CONTEXT_MENU_ITEM, { hasText: new RegExp(`^${escapeRegExp(found.label)}$`) })
      .first();
    // VS Code's menu ignores a click that lands right after it opens.
    await entry.hover();
    await sleep(300);
    await entry.click();
    await waitMenuClosed(`"${found.label}"`);
    return found.label;
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
    /** The row whose text holds `label`; with `{ exact: true }`, whose label is `label` itself. */
    pick: async (label, { exact = false } = {}) => {
      const row = exact
        ? page()
            .locator(QUICK_INPUT_ROW)
            .filter({
              has: page().locator(".quick-input-list-label .label-name", {
                hasText: new RegExp(`^\\s*${escapeRegExp(label)}\\s*$`),
              }),
            })
            .first()
        : page().locator(QUICK_INPUT_ROW, { hasText: label }).first();
      await row.waitFor({ timeout });
      await row.click();
    },
    accept: () => page().keyboard.press("Enter"),
    cancel: () => page().keyboard.press("Escape"),
    /** The title with its step counter split off (`{ title, step, total }`), or null while none shows. */
    step: async () => {
      const shown = await quickInput.title();
      return shown === null ? null : quickInputStep(shown);
    },
    value: () => page().locator(QUICK_INPUT_BOX).inputValue(),
    /** Keys typed where the cursor is, as she types: a selected value is replaced, else added to. */
    keys: (text) => page().keyboard.type(text),
    /** The input box's selection as `[start, end]`: equal when only the cursor shows. */
    selection: () =>
      page()
        .locator(QUICK_INPUT_BOX)
        .evaluate((box) => [box.selectionStart, box.selectionEnd]),
    /**
     * The input's validation as drawn: `{ message, severity }` (`info`, `warning` or `error`, the
     * class VS Code puts on the input box), or null while the line under it is only the prompt.
     */
    validation: async () =>
      page().evaluate((widgetSelector) => {
        const widget = document.querySelector(widgetSelector);
        const box = widget?.querySelector(".monaco-inputbox");
        const severity = ["error", "warning", "info"].find((kind) => box?.classList.contains(kind));
        if (severity === undefined) return null;
        const message = widget.querySelector(".quick-input-message");
        return { message: (message?.textContent ?? "").replace(/\s+/g, " ").trim(), severity };
      }, QUICK_INPUT),
    placeholder: async () =>
      (await page().locator(QUICK_INPUT_BOX).getAttribute("placeholder")) ?? "",
    /** Whether the widget's progress bar runs (the input is busy). */
    busy: () =>
      page()
        .locator(`${QUICK_INPUT} .quick-input-progress`)
        .evaluate((bar) => !bar.classList.contains("done") && bar.offsetParent !== null),
    /**
     * The line under the input box (an InputBox's `prompt`, or its validation message in its
     * place): `{ text, hint, severity }`. `hint` is what VS Code adds after a prompt,
     * `(Press 'Enter' to confirm or 'Escape' to cancel)`, split off `text`, else null; severity is
     * `warning`, `error` or `info` as the box is decorated, else `none`. Null while none shows.
     */
    message: async () =>
      page()
        .locator(QUICK_INPUT)
        .evaluate((widget) => {
          const line = widget.querySelector(".quick-input-message");
          if (line === null || line.offsetParent === null) return null;
          const box = widget.querySelector(".quick-input-box .monaco-inputbox");
          const severity =
            ["error", "warning", "info"].find((name) => box?.classList.contains(name)) ?? "none";
          const shown = (line.textContent ?? "").trim();
          const hinted = /^(.*?)\s*(\(Press 'Enter' to confirm or 'Escape' to cancel\))$/s.exec(
            shown,
          );
          return hinted === null
            ? { text: shown, hint: null, severity }
            : { text: hinted[1], hint: hinted[2], severity };
        }),
    /** Every row: `{ label, icons, description, detail, buttons, focused }`, icons by codicon name. */
    rows: async () => {
      // A row listed can be gone a moment later (the list re-rendered, or an input box replaced
      // it), and Playwright would wait the whole timeout for it: read the list again instead.
      for (let attempt = 1; ; attempt += 1) {
        const listed = await page().locator(QUICK_INPUT_ROW).all();
        try {
          return await Promise.all(
            listed.map((row) => row.evaluate(quickInputRow, undefined, { timeout: 1_000 })),
          );
        } catch (cause) {
          if (attempt === 5 || !(cause instanceof Error && cause.name === "TimeoutError"))
            throw cause;
        }
      }
    },
    /**
     * Every button the widget shows, by tooltip: the title bar's (`where: "title bar"`, Back
     * included), the input box's, and each row's (`where: "row <label>"`, shown on hover).
     */
    buttons: async () =>
      page()
        .locator(QUICK_INPUT)
        .evaluate((widget) => {
          const tooltip = (button) =>
            button.getAttribute("aria-label") ?? button.getAttribute("title") ?? "";
          const enabled = (button) =>
            !button.classList.contains("disabled") &&
            button.getAttribute("aria-disabled") !== "true";
          const found = [];
          for (const [scope, where] of [
            [".quick-input-titlebar", "title bar"],
            [".quick-input-inline-action-bar", "input box"],
          ])
            for (const button of widget.querySelectorAll(`${scope} .action-label`))
              if (button.offsetParent !== null)
                found.push({ tooltip: tooltip(button), where, enabled: enabled(button) });
          for (const row of widget.querySelectorAll(".quick-input-list .monaco-list-row")) {
            const label = (row.querySelector(".label-name")?.textContent ?? "").trim();
            for (const button of row.querySelectorAll(
              ".quick-input-list-entry-action-bar .action-label",
            ))
              found.push({
                tooltip: tooltip(button),
                where: `row ${label}`,
                enabled: enabled(button),
              });
          }
          return found;
        }),
    /**
     * A button clicked by its tooltip (a string, whole, or a pattern): the title bar's or the input
     * box's first, else a row's, the pointer resting on its row first (a row shows its buttons on
     * hover). Returns where it was.
     */
    button: async (tooltip) => {
      const matches = (label) =>
        typeof tooltip === "string" ? label === tooltip : tooltip.test(label ?? "");
      const found = await waitUntil(`a quick input button "${tooltip}"`, async () => {
        const widget = page().locator(QUICK_INPUT);
        for (const [scope, where] of [
          [".quick-input-titlebar", "title bar"],
          [".quick-input-inline-action-bar", "input box"],
        ])
          for (const button of await widget.locator(`${scope} .action-label`).all())
            if ((await button.isVisible()) && matches(await tooltipOf(button)))
              return { button, row: null, where };
        for (const row of await page().locator(QUICK_INPUT_ROW).all())
          for (const button of await row
            .locator(".quick-input-list-entry-action-bar .action-label")
            .all())
            if (matches(await tooltipOf(button)))
              return {
                button,
                row,
                where: `row "${(await row.locator(".label-name").first().innerText()).trim()}"`,
              };
        return null;
      });
      if (found.row !== null) await found.row.hover();
      await found.button.click();
      return found.where;
    },
    /** The title bar's Back (VS Code puts it alone at the bar's left); returns its tooltip. */
    back: async () => {
      const back = page()
        .locator(`${QUICK_INPUT} .quick-input-left-action-bar .action-label`)
        .filter({ visible: true })
        .first();
      await back.waitFor({ timeout });
      const tooltip = await back.getAttribute("aria-label");
      await back.click();
      return tooltip;
    },
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
    // The whole item, not its icon: a badge sits over the icon's centre, where a click lands.
    const entry = page().locator(".activitybar .action-item", {
      has: page().locator(`.action-label[aria-label^="${name}"]`),
    });
    await entry.first().waitFor({ timeout });
    const header = page().locator(".part.sidebar .pane-header");
    if ((await header.count()) === 0 || !(await page().locator(".part.sidebar").isVisible()))
      await entry.first().click();
    else if (
      !(await page().locator(".part.sidebar .composite.title", { hasText: name }).isVisible())
    )
      await entry.first().click();
    // A view with an empty tree draws its welcome instead of the list.
    await page()
      .locator(`.part.sidebar .monaco-list:visible, .part.sidebar ${WELCOME}:visible`)
      .first()
      .waitFor({ timeout });
  };

  /** The view's welcome as VS Code draws it over an empty tree; null while the tree shows. */
  const welcome = async () =>
    page().evaluate((selector) => {
      const content = [...document.querySelectorAll(`.part.sidebar ${selector}`)].find(
        (element) => element.offsetParent !== null && element.childElementCount > 0,
      );
      if (content === undefined) return null;
      const clean = (element) => (element.textContent ?? "").replace(/\s+/g, " ").trim();
      return {
        lines: [...content.querySelectorAll("p")].map(clean),
        buttons: [...content.querySelectorAll(".monaco-button")].map(clean),
        links: [...content.querySelectorAll("p a")].map(clean),
      };
    }, WELCOME);

  /** A welcome button or link, by its label. */
  const welcomeAction = (label) => {
    const found = () =>
      page()
        .locator(`.part.sidebar ${WELCOME} .monaco-button, .part.sidebar ${WELCOME} p a`, {
          hasText: label,
        })
        .first();
    return {
      waitFor: (limit = timeout) => found().waitFor({ timeout: limit }),
      click: async () => {
        await found().waitFor({ timeout });
        await found().click();
      },
    };
  };

  /**
   * The Accounts menu of the Activity Bar, as a person opens it: every entry's label, then Escape.
   * With `signOut`, the entry whose label holds it is hovered and its Sign Out clicked instead;
   * with `shot`, the open menu is shot under that slug first.
   */
  const accounts = async ({ signOut, shot: slug } = {}) => {
    const entry = page()
      .locator(".activitybar .global-activity .action-item, .activitybar .action-item", {
        has: page().locator('.action-label[aria-label^="Accounts"]'),
      })
      .first();
    await entry.waitFor({ timeout });
    await entry.click();
    await page().locator(CONTEXT_MENU).first().waitFor({ timeout });
    const items = await page()
      .locator(`${CONTEXT_MENU} .action-item .action-label`)
      .evaluateAll((labels) =>
        labels.map((label) => (label.textContent ?? "").replace(/\s+/g, " ").trim()),
      );
    if (slug !== undefined) await shot(slug);
    if (signOut === undefined) {
      await page().keyboard.press("Escape");
      return items.filter((item) => item !== "");
    }
    await page().locator(`${CONTEXT_MENU} .action-item`, { hasText: signOut }).first().hover();
    // The submenu's item, by its own text: the account's entry holds its submenu's text too.
    const button = page()
      .locator(`${CONTEXT_MENU} .action-item`, { hasText: /^Sign Out$/ })
      .last()
      .locator(".action-menu-item, .action-label")
      .first();
    await button.waitFor({ timeout });
    // A click while the submenu still opens lands on nothing (runs fr1a try4 and try5).
    await sleep(1_000);
    await button.click();
    return items.filter((item) => item !== "");
  };

  /** Every URL the editor handed its external browser, in order (`up` records instead of opening). */
  const browserOpened = () => {
    try {
      return readFileSync(state.browserLog, "utf8")
        .split("\n")
        .filter((line) => line !== "");
    } catch {
      return [];
    }
  };

  /**
   * A browser of her own, Playwright's chromium apart from the editor's Electron: the web as she
   * uses it. `signIn()` fills the web's sign-in page as the run's account; `shot(slug)` numbers
   * its screenshots among the editor's.
   */
  const browser = async () => {
    const launched = await options.launchBrowser();
    const web = await (
      await launched.newContext({ viewport: { width: 1100, height: 760 } })
    ).newPage();
    return {
      page: web,
      goto: (url) => web.goto(url, { waitUntil: "domcontentloaded" }),
      text: () => text(web),
      signIn: async () => {
        await web.locator('input[type="email"]').waitFor({ timeout });
        await web.locator('input[type="email"]').fill(options.account.email);
        await web.locator("#login-password").fill(options.account.password);
        await web.getByRole("button", { name: "Sign in", exact: true }).click();
      },
      click: async (name) => {
        const button = web.getByRole("button", { name, exact: true });
        await button.waitFor({ timeout });
        await button.click();
      },
      waitForText: (pattern, limit = timeout) =>
        waitForText(pattern, { page: web, timeout: limit }),
      shot: (slug) => shot(slug, web),
      close: () => launched.close(),
    };
  };

  /** A context menu left open covers the workbench: Escape closes it. */
  const closeMenu = async () => {
    if (await page().locator(CONTEXT_MENU).isVisible()) await page().keyboard.press("Escape");
  };

  /** A row of the sidebar's tree, by a substring or pattern of its text; `pane` names its view. */
  const treeItem = (label, { pane } = {}) => {
    const scope = () =>
      pane === undefined
        ? page().locator(".part.sidebar")
        : page().locator(".part.sidebar .pane", {
            has: page().locator(".pane-header .title", {
              hasText: new RegExp(`^${escapeRegExp(pane)}$`, "i"),
            }),
          });
    const row = () => scope().locator(".monaco-list-row", { hasText: label }).first();
    /**
     * VS Code draws only the rows its tree has on screen: a row below the fold (the Change section
     * takes half the sidebar) is not in the page until she scrolls to it, wheel over the tree, and
     * a row drawn under a group's sticky header takes no click until the tree scrolls back up.
     */
    const onScreen = async () =>
      (await row().count()) > 0 &&
      row().evaluate((element) => {
        const box = element.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return hit !== null && element.contains(hit);
      });
    const reveal = async () => {
      if (await onScreen()) return;
      for (const list of await scope().locator(".monaco-list").all()) {
        if (!(await list.isVisible())) continue;
        await list.hover();
        await page().mouse.wheel(0, -100_000);
        let top = null;
        for (let turn = 0; turn < 200; turn += 1) {
          await sleep(60);
          if (await onScreen()) return;
          const now = await list
            .locator(".monaco-list-rows")
            .evaluate((rows) => rows.getBoundingClientRect().top);
          if (now === top) break;
          top = now;
          await page().mouse.wheel(0, 200);
        }
      }
    };
    const shown = async () => {
      await reveal();
      return row();
    };
    return {
      waitFor: (limit = timeout) =>
        waitUntil(
          `the row ${label}`,
          async () => {
            await reveal();
            return (await row().count()) > 0;
          },
          limit,
        ),
      text: async () => (await (await shown()).innerText()).replace(/\s+/g, " ").trim(),
      description: async () => {
        const description = (await shown()).locator(".label-description");
        return (await description.count()) > 0
          ? (await description.first().innerText()).trim()
          : "";
      },
      click: async () => (await shown()).click(),
      dblclick: async () => (await shown()).dblclick(),
      hover: async () => (await shown()).hover(),
      /** Whether the row is selected, as the tree marks it. */
      selected: async () =>
        (await shown()).evaluate(
          (element) =>
            element.classList.contains("selected") ||
            element.getAttribute("aria-selected") === "true",
        ),
      /** The titles of the inline actions the row shows on hover. */
      actions: async () => {
        await (await shown()).hover();
        await sleep(400);
        return row()
          .locator(".actions .action-label")
          .evaluateAll((found) => found.map((action) => action.getAttribute("aria-label") ?? ""));
      },
      /**
       * The inline action that appears on hover, by its title, or by a pattern its title matches
       * (one recipe across two manifests). `clicks: 2` clicks it again at once, the way an
       * impatient person does; a later click that finds no button is not made. Returns the title
       * found and the clicks that landed.
       */
      inline: async (title, { clicks = 1 } = {}) => {
        await (await shown()).hover();
        const found =
          typeof title === "string"
            ? title
            : await waitUntil(`an inline action matching ${title}`, async () => {
                const titles = await row()
                  .locator(".actions .action-label")
                  .evaluateAll((labels) => labels.map((item) => item.getAttribute("aria-label")));
                return titles.find((candidate) => candidate !== null && title.test(candidate));
              });
        const action = row().locator(`.actions .action-label[aria-label="${found}"]`);
        await action.first().waitFor({ timeout });
        await action.first().click();
        let landed = 1;
        for (; landed < clicks; landed += 1) {
          const again = await action
            .first()
            .click({ timeout: 2_000 })
            .then(() => true)
            .catch(() => false);
          if (!again) break;
        }
        return { title: found, landed };
      },
      /**
       * The row's context menu item, by its whole label (a pattern matches as given). VS Code's menu
       * ignores a click that lands right after it opens, so the pointer rests on the item first.
       */
      contextMenu: async (item) => {
        await closeMenu();
        await (await shown()).click({ button: "right" });
        const hasText = typeof item === "string" ? new RegExp(`^${escapeRegExp(item)}$`) : item;
        const entry = page().locator(CONTEXT_MENU_ITEM, { hasText }).first();
        await entry.waitFor({ timeout });
        await entry.hover();
        await sleep(300);
        await entry.click();
        await waitUntil(
          `the context menu to close after "${item}"`,
          async () => ((await page().locator(CONTEXT_MENU).isVisible()) ? null : true),
          5_000,
        );
      },
      /** Every enabled item of the row's context menu, then Escape. */
      menu: async () => {
        await closeMenu();
        await (await shown()).click({ button: "right" });
        await page().locator(CONTEXT_MENU_ITEM).first().waitFor({ timeout });
        const items = await page()
          .locator(CONTEXT_MENU_ITEM)
          .evaluateAll((found) =>
            found.map((entry) => (entry.textContent ?? "").trim()).filter(Boolean),
          );
        await page().keyboard.press("Escape");
        return items;
      },
      /**
       * The row's tooltip: the mouse rests on the row's label (the hover is bound there, not to the
       * whole row) until VS Code's hover shows; moved away and back when it does not.
       */
      tooltip: async () => {
        await reveal();
        const hover = page().locator(HOVER).first();
        return waitUntil("the row's tooltip", async () => {
          await page().mouse.move(1, 1);
          await sleep(300);
          await row().locator(".label-name").first().hover();
          const shown = await hover
            .waitFor({ timeout: 5_000 })
            .then(() => true)
            .catch(() => false);
          return shown ? (await hover.innerText()).trim() : null;
        });
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

  /**
   * Every row of one sidebar view as a person reads it: its depth, label, description and whether
   * it is open; and the view's message above the rows. `pane` names the view by its header
   * (`Change`); without it, the container's first view. What scrolled out is not read.
   */
  const viewRows = async (pane) =>
    page().evaluate((name) => {
      const sidebar = document.querySelector(".part.sidebar");
      const panes = [...(sidebar?.querySelectorAll(".pane") ?? [])];
      const titled = (candidate) =>
        (candidate.querySelector(".pane-header .title")?.textContent ?? "").trim().toLowerCase() ===
        String(name).toLowerCase();
      const scope =
        name === undefined
          ? (panes[0] ?? sidebar)
          : (panes.find((candidate) => titled(candidate)) ?? null);
      const rows = [...(scope?.querySelectorAll(".monaco-list-row") ?? [])].map((row) => ({
        level: Number(row.getAttribute("aria-level") ?? "0"),
        label: (row.querySelector(".label-name")?.textContent ?? "").trim(),
        description: (row.querySelector(".label-description")?.textContent ?? "").trim(),
        expanded: row.getAttribute("aria-expanded"),
        selected: row.getAttribute("aria-selected") === "true",
      }));
      const message = (
        scope?.querySelector(".tree-explorer-viewlet-tree-view > .message:not(.hide)")
          ?.textContent ?? ""
      ).trim();
      return { message, rows };
    }, pane);

  /** The number on an Activity Bar entry's badge (`Mend`), or "" when it shows none. */
  const badge = async (name) =>
    page().evaluate((label) => {
      for (const entry of document.querySelectorAll(".activitybar .action-item")) {
        const title = entry.querySelector(".action-label")?.getAttribute("aria-label") ?? "";
        if (!title.startsWith(label)) continue;
        const content = entry.querySelector(".badge:not(.hidden) .badge-content");
        const shown = content !== null && getComputedStyle(content).display !== "none";
        return shown ? (content.textContent ?? "").trim() : "";
      }
      return "";
    }, name);

  /** Every status bar item's text, left to right, as shown. */
  const statusBarItems = async () =>
    page()
      .locator(STATUS_ITEM)
      .evaluateAll((items) =>
        items
          .filter((item) => item.offsetParent !== null)
          .map((item) => (item.textContent ?? "").replace(/\s+/g, " ").trim())
          .filter((text) => text !== ""),
      );

  const statusBar = (pattern) => {
    const item = () => page().locator(STATUS_ITEM, { hasText: pattern }).first();
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
    /** `{ names, active, focused }`: the panel's terminal tabs and where the keyboard is. */
    tabs: () => page().evaluate(terminalTabs),
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
  const shot = async (slug, target = page()) => {
    shots += 1;
    const name = `${String(shots).padStart(2, "0")}-${slug.replace(/[^A-Za-z0-9._-]+/g, "-")}`;
    const body = await text(target).catch(() => "");
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
    const png = await target.screenshot();
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

  /**
   * Everything transient a gesture shows in the current window, from now until `stop()`: toasts,
   * modal dialogs, quick input titles and status bar texts, each once, in order. `stop()` returns
   * null when the window navigated meanwhile (its page was replaced).
   */
  const watch = async () => {
    const target = page();
    await target.evaluate(startWatch, {
      toast: TOAST,
      dialog: DIALOG,
      quickInput: QUICK_INPUT,
      status: STATUS_ITEM,
    });
    return {
      stop: () =>
        target
          .evaluate(() => {
            const watching = window.mendVerifyWatch;
            if (watching === undefined) return null;
            watching.stop();
            delete window.mendVerifyWatch;
            return watching.seen;
          })
          .catch(() => null),
    };
  };

  /**
   * The run's user settings changed as a person edits settings.json: `patch` merged in, a key set
   * to undefined removed. VS Code reloads the file live. Returns the file as written.
   */
  const userSettings = (patch) => {
    const file = join(state.userData, "User", "settings.json");
    const settings = { ...JSON.parse(readFileSync(file, "utf8")), ...patch };
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete settings[key];
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
    return settings;
  };

  /** The `code` launcher with the run's user data: it hands its arguments to the running editor and exits. */
  const codeCli = async (args) => {
    const env = {
      ...process.env,
      HOME: state.home,
      XDG_CONFIG_HOME: state.configHome,
      DISPLAY: state.display,
    };
    // On a Wayland desktop XDG_SESSION_TYPE alone starts the CLI as a Wayland instance of its own
    // instead of reaching the editor on the run's X display.
    for (const key of [
      "WAYLAND_DISPLAY",
      "NIXOS_OZONE_WL",
      "ELECTRON_RUN_AS_NODE",
      "XDG_SESSION_TYPE",
    ])
      delete env[key];
    const { status, stderr } = await new Promise((done) => {
      const child = spawn(
        state.editor.cli,
        [...args, "--user-data-dir", state.userData, "--extensions-dir", state.extensions],
        { env, stdio: ["ignore", "ignore", "pipe"], timeout: 60_000 },
      );
      let err = "";
      child.stderr.on("data", (chunk) => (err += chunk));
      child.on("close", (code) => done({ status: code, stderr: err }));
      child.on("error", (error) => done({ status: -1, stderr: String(error) }));
    });
    if (status !== 0) throw new Error(`code ${args[0]} exited ${status}: ${scrub(stderr).trim()}`);
  };

  /** A `vscode://` link followed the way the OS URL handler follows one: `code --open-url`. */
  const openUrl = (url) => codeCli(["--open-url", url]);

  /**
   * A folder opened the way a person opens one from a terminal: `code --new-window <folder>`, with
   * `--skip-welcome` as `up` started the editor (the welcome a fresh user data shows once would
   * cover the window). The window comes as a new page: `waitForWindow(known)` finds it.
   */
  const openFolder = (folder) => codeCli(["--new-window", "--skip-welcome", folder]);

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
    opens,
    remoteSshLogs: () => remoteSshLogFiles(state.userData).length,
    palette,
    paletteRows,
    quickInput,
    view,
    viewActions,
    viewAction,
    viewOverflowItems,
    viewOverflowItem,
    welcome,
    welcomeAction,
    accounts,
    browser,
    browserOpened,
    treeItem,
    notification,
    notifications,
    dialog,
    dialogs,
    statusBar,
    statusBarItems,
    viewRows,
    badge,
    terminal,
    watch,
    userSettings,
    openUrl,
    openFolder,
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
