// What the three review recipes (story d) share: a claude session whose worktree holds a change of
// several files across several checkpoints, written through a shell beside the agent, and reads of
// the Change section, the diff editor, the multi-diff editor and the view's overflow menu.

import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { FAKES } from "../scripts/fakes.mjs";

export const world = await import(
  pathToFileURL(join(import.meta.dirname, "../../../../scripts/vscode-remote-world.mjs")).href
);

export const expect = (holds, message) => {
  if (!holds) throw new Error(message);
};

export const fail = (reason) => {
  throw new Error(reason);
};

/** The change's files, written in two rounds with a checkpoint marked after each. */
export const ROUNDS = [
  {
    files: {
      "src/auth/limit.ts": [
        'import { Request } from "express";',
        "",
        "export function rateLimit(req: Request) {",
        "  return true; // TODO",
        "}",
        "",
      ].join("\n"),
      "src/auth/throttle.ts": [
        "export function throttle(ms: number) {",
        "  // replaced by rateLimit in limit.ts",
        "  let last = 0;",
        "  return () => Date.now() - last > ms;",
        "}",
        "",
      ].join("\n"),
      "docs/rate-limit.md": "# Rate limit\n\nFive requests a minute per address.\n",
    },
    remove: [],
  },
  {
    files: {
      "src/auth/limit.ts": [
        'import { Request } from "express";',
        'import { tooMany } from "../http";',
        "",
        "const WINDOW_MS = 60_000;",
        "const MAX = 5;",
        "const hits = new Map<string, number[]>();",
        "",
        "export function rateLimit(req: Request) {",
        '  const key = req.ip ?? "anon";',
        "  const now = Date.now();",
        "  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);",
        "  if (recent.length >= MAX) return tooMany(req);",
        "  hits.set(key, [...recent, now]);",
        "  return true;",
        "}",
        "",
      ].join("\n"),
      "src/auth/limit.test.ts": [
        'import { describe, it, expect } from "vitest";',
        'import { rateLimit } from "./limit";',
        "",
        'describe("rateLimit", () => {',
        '  it("allows the first five", () => {',
        "    expect(rateLimit({ ip: '1' } as never)).toBe(true);",
        "  });",
        "});",
        "",
      ].join("\n"),
    },
    remove: ["src/auth/throttle.ts", "README"],
  },
];

/** The agent's next round, after her review: the shared limiter in place of its own Map. */
export const ADDRESSED = {
  files: {
    "src/auth/limit.ts": [
      'import { Request } from "express";',
      'import { tooMany } from "../http";',
      'import { sharedLimiter } from "./guard";',
      "",
      "const limiter = sharedLimiter({ windowMs: 60_000, max: 5 });",
      "",
      "export function rateLimit(req: Request) {",
      '  if (!limiter.take(req.ip ?? "anon")) return tooMany(req);',
      "  return true;",
      "}",
      "",
    ].join("\n"),
    "src/auth/guard.ts": [
      "export function sharedLimiter(options: { windowMs: number; max: number }) {",
      "  const hits = new Map<string, number[]>();",
      "  return {",
      "    take(key: string) {",
      "      const now = Date.now();",
      "      const recent = (hits.get(key) ?? []).filter((t) => now - t < options.windowMs);",
      "      hits.set(key, [...recent, now]);",
      "      return recent.length < options.max;",
      "    },",
      "  };",
      "}",
      "",
    ].join("\n"),
  },
  remove: [],
};

const heredoc = (target, text) => [
  `mkdir -p "$(dirname '${target}')" && base64 -d > '${target}' <<'MEND_REVIEW_EOF'`,
  ...(Buffer.from(text)
    .toString("base64")
    .match(/.{1,76}/g) ?? []),
  "MEND_REVIEW_EOF",
];

export const cliEnv = (state) => ({
  ...process.env,
  HOME: state.home,
  XDG_CONFIG_HOME: state.configHome,
});

export const reviewWorld = (h) => {
  const { api, state, sleep, waitUntil, step, note, page, palette, view } = h;
  const project = state.project ?? fail("the run's ledger has no project: did up finish?");
  const origin = state.server?.origin ?? fail("the run's ledger has no server origin");

  const connectClaude = () =>
    step(
      "Claude connected with the skill's fake setup token: mend connect claude --from-stdin",
      async () => {
        const ran = await world.cli(["connect", "claude", "--from-stdin"], cliEnv(state), {
          input: FAKES.claude,
          allowFailure: true,
        });
        expect(ran.status === 0, `mend connect claude exited ${ran.status}: ${ran.stderr.trim()}`);
        return ran.stdout.trim();
      },
      { via: "setup" },
    );

  const sessionRead = (id, call = api) => call(`/sessions/${id}`);

  /** A claude terminal agent in its own worktree, running at its prompt. */
  const startClaude = async (label, call = api) => {
    const created = await call(`/projects/${project.id}/sessions`, {
      method: "POST",
      body: JSON.stringify({ harness: "claude", label, base: null, name: label }),
    });
    await call(`/sessions/${created.id}/launch`, {
      method: "POST",
      body: JSON.stringify({ permissionMode: "ask" }),
    });
    const agent = await waitUntil(
      `${label} running with a live agent-pty`,
      async () => {
        const now = await sessionRead(created.id, call);
        return now.session.status === "running"
          ? (now.processes.find((row) => row.kind === "agent-pty" && row.exitedAt === null) ?? null)
          : null;
      },
      600_000,
    );
    return { id: created.id, name: label, agent: agent.id };
  };

  /** One of a session's terminals over `/api/tty`, read and typed into as raw bytes. */
  const tty = async (processId, call = api) => {
    const { ticket } = await call("/upgrade-tickets", {
      method: "POST",
      body: JSON.stringify({ target: "tty", process: processId }),
    });
    const url = new URL(`${origin}/api/tty`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("process", processId);
    url.searchParams.set("ticket", ticket);
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const decoder = new TextDecoder();
    const attached = { text: "", closed: null };
    socket.addEventListener("message", (event) => {
      attached.text +=
        typeof event.data === "string"
          ? event.data
          : decoder.decode(new Uint8Array(event.data), { stream: true });
    });
    socket.addEventListener("close", (event) => (attached.closed = event.code));
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("the tty did not open")), {
        once: true,
      });
    });
    socket.send(JSON.stringify({ t: "resize", cols: 200, rows: 50 }));
    const encoder = new TextEncoder();
    return {
      attached,
      lines: async (lines) => {
        for (const line of lines) {
          socket.send(encoder.encode(`${line}\r`));
          await sleep(10);
        }
      },
      marker: (prefix, limit = 60_000) =>
        waitUntil(
          `${prefix} in the shell`,
          () => (attached.text.includes(`${prefix}-DONE`) ? true : null),
          limit,
        ),
      close: () => socket.close(),
    };
  };

  /** A shell beside the agent in the session's worktree (`/workspace/repo`). */
  const shellBeside = async (session, call = api) => {
    const opened = await call(`/sessions/${session.id}/shell`, { method: "POST", body: "{}" });
    const shell = await tty(opened.id, call);
    await waitUntil("the shell's prompt", () => shell.attached.text.trim() !== "", 60_000);
    await sleep(1_000);
    await shell.lines(["cd /workspace/repo"]);
    let written = 0;
    return {
      /** One round of the change, written by the shell, then a checkpoint marked. */
      write: async (round, { mark = true } = {}) => {
        written += 1;
        const marker = `MEND-REVIEW-${written}`;
        await shell.lines([
          ...Object.entries(round.files).flatMap(([target, text]) => heredoc(target, text)),
          ...round.remove.map((target) => `rm -f '${target}'`),
          // Quoted apart, so the typed line does not already read as the marker.
          `echo ${marker}-DO''NE`,
        ]);
        await shell.marker(marker);
        if (!mark) return null;
        return call(`/sessions/${session.id}/checkpoints`, {
          method: "POST",
          body: JSON.stringify({ trigger: "user-mark" }),
        });
      },
      lines: (lines) => shell.lines(lines),
      close: async () => {
        await shell.lines(["exit"]);
        await sleep(500);
        shell.close();
      },
    };
  };

  /** A new window may open on VS Code's own sign-in welcome, over the workbench. */
  const dismissWelcome = async () => {
    const skip = page().getByText("Continue without Signing In");
    if (await skip.isVisible().catch(() => false)) await skip.click();
  };

  /** `Developer: Reload Window`, then the Mend view, as VS Code starting again shows it. */
  const reload = async () => {
    await palette("Developer: Reload Window").catch((error) => {
      if (!String(error?.message).includes("the palette to close")) throw error;
      note(`the reload outran the palette's close check: ${String(error.message).split("\n")[0]}`);
    });
    await page().locator(".monaco-workbench").first().waitFor({ timeout: 120_000 });
    await sleep(3_000);
    await waitUntil(
      "the Mend view after the reload",
      async () => {
        await dismissWelcome();
        await view("Mend");
        return true;
      },
      90_000,
    );
  };

  /**
   * The session's row on screen: a session she has looked at leaves Since you last looked for
   * Projects, which draws collapsed, so Projects and the project open first when it shows nowhere.
   */
  const revealSession = async (label) => {
    const shown = async () =>
      (await h.viewRows("Sessions")).rows.some((row) => row.label === label);
    if (await shown()) return;
    for (const group of ["Projects", project.name]) {
      const row = (await h.viewRows("Sessions")).rows.find((one) => one.label === group);
      if (row?.expanded === "false") await h.treeItem(group, { pane: "Sessions" }).click();
      await sleep(500);
    }
    // The list draws only the rows in view: a long one scrolls until the row shows.
    const list = h
      .page()
      .locator(".part.sidebar .pane", {
        has: h.page().locator(".pane-header .title", { hasText: /^sessions$/i }),
      })
      .locator(".monaco-list")
      .first();
    for (let scrolled = 0; scrolled < 8 && !(await shown()); scrolled += 1) {
      await list.hover();
      await h.page().mouse.wheel(0, 300);
      await sleep(300);
    }
    await waitUntil(`${label}'s row`, async () => ((await shown()) ? true : null), 15_000);
  };

  /** The Mend server's container stopped or started; Postgres keeps running beside it. */
  const server = (verb) =>
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
      { timeout: 120_000, env: cliEnv(state) },
    );

  /** One query against the world's Postgres, its rows as `a|b|c` lines. */
  const psql = async (sql) => {
    const env = cliEnv(state);
    const found = await world.run(
      "docker",
      [
        "--context",
        state.context,
        "ps",
        "-q",
        "--filter",
        "label=com.docker.compose.project=mend",
        "--filter",
        "label=com.docker.compose.service=postgres",
      ],
      { env },
    );
    const container = found.stdout.trim().split("\n")[0];
    expect(container !== undefined && container !== "", "no Postgres container in the world");
    const ran = await world.run(
      "docker",
      [
        "--context",
        state.context,
        "exec",
        container,
        "psql",
        "-U",
        "postgres",
        "-d",
        "mend",
        "-tAc",
        sql,
      ],
      { env },
    );
    return ran.stdout.trim() === "" ? [] : ran.stdout.trim().split("\n");
  };

  /** The follow-up rows Mend recorded for a session, read from its database: `key|status`. */
  const followUpRows = async (sessionId) => {
    if (!/^[0-9a-f-]+$/.test(sessionId)) throw new Error(`not a session id: ${sessionId}`);
    return psql(
      `select idempotency_key || '|' || status from follow_ups where session_id = '${sessionId}' order by created_at`,
    );
  };

  /** What Mend's connections are doing that is not idle: `state|wait|seconds|query`. */
  const serverActivity = () =>
    psql(
      "select state || '|' || coalesce(wait_event_type || ':' || wait_event, '-') || '|' || " +
        "coalesce(extract(epoch from now() - xact_start)::int::text, '-') || '|' || " +
        "left(regexp_replace(query, '\\s+', ' ', 'g'), 120) from pg_stat_activity " +
        "where datname = 'mend' and pid <> pg_backend_pid() and state <> 'idle' " +
        "and query not ilike '%LISTEN%' order by xact_start",
    );

  return {
    project,
    origin,
    connectClaude,
    sessionRead,
    startClaude,
    shellBeside,
    reload,
    revealSession,
    server,
    followUpRows,
    serverActivity,
  };
};

/** The Change section's rows, each with the letter its file decoration draws. */
export const changeRows = (h) =>
  h.page().evaluate(() => {
    const pane = [...document.querySelectorAll(".part.sidebar .pane")].find(
      (candidate) =>
        (candidate.querySelector(".pane-header .title")?.textContent ?? "").trim().toLowerCase() ===
        "change",
    );
    if (pane === undefined) return { found: false, title: "", message: "", rows: [] };
    const label = (row) => row.querySelector(".monaco-icon-label");
    const letter = (row) => {
      const found = label(row);
      if (found === null) return "";
      const after = getComputedStyle(found, "::after").content;
      return after === "none" || after === "normal" ? "" : after.replace(/^"|"$/g, "");
    };
    return {
      found: true,
      title: [
        (pane.querySelector(".pane-header .title")?.textContent ?? "").trim(),
        (pane.querySelector(".pane-header .description")?.textContent ?? "").trim(),
      ]
        .filter(Boolean)
        .join(" · "),
      message: (
        pane.querySelector(".tree-explorer-viewlet-tree-view > .message:not(.hide)")?.textContent ??
        ""
      ).trim(),
      rows: [...pane.querySelectorAll(".monaco-list-row")].map((row) => ({
        level: Number(row.getAttribute("aria-level") ?? "0"),
        label: (row.querySelector(".label-name")?.textContent ?? "").trim(),
        description: (row.querySelector(".label-description")?.textContent ?? "").trim(),
        letter: letter(row),
        expanded: row.getAttribute("aria-expanded"),
      })),
    };
  });

/** `label · description [letter]`, one per row, indented by depth: the section as she reads it. */
export const said = (section) =>
  section.rows
    .map(
      (row) =>
        `${"  ".repeat(Math.max(0, row.level - 1))}${row.label}${row.description === "" ? "" : ` · ${row.description}`}${row.letter === "" ? "" : ` [${row.letter}]`}`,
    )
    .join(" | ");

/** The editor tabs of the active group: their labels, and which is active. */
export const editorTabs = (h) =>
  h.page().evaluate(() =>
    [...document.querySelectorAll(".part.editor .tabs-container .tab")].map((tab) => ({
      label: (tab.querySelector(".label-name")?.textContent ?? "").trim(),
      title: tab.getAttribute("aria-label") ?? "",
      active: tab.classList.contains("active"),
    })),
  );

/** The active diff editor's two sides, as their visible lines read (spaces as spaces). */
export const diffSides = (h) =>
  h.page().evaluate(() => {
    const editor = document.querySelector(".editor-group-container.active .monaco-diff-editor");
    const lines = (side) =>
      [...(editor?.querySelectorAll(`.${side} .view-lines .view-line`) ?? [])]
        .map((line) => ({
          top: Number.parseFloat(line.style.top || "0"),
          text: (line.textContent ?? "").replace(/ /g, " "),
        }))
        .toSorted((left, right) => left.top - right.top)
        .map((line) => line.text);
    return {
      found: editor !== null,
      left: lines("original-in-monaco-diff-editor"),
      right: lines("modified-in-monaco-diff-editor"),
    };
  });

/** The Change section's overflow menu (its `...`): every item it offers, then Escape. */
export const overflowItems = async (h) => {
  const { page, sleep } = h;
  const pane = page().locator(".part.sidebar .pane", {
    has: page().locator(".pane-header .title", { hasText: /^change$/i }),
  });
  await pane.locator(".pane-header").hover();
  await sleep(300);
  const more = pane.locator('.pane-header .actions .action-label[aria-label^="More Actions"]');
  await more.first().click();
  const items = page().locator(".context-view .monaco-menu .action-item .action-label");
  await items.first().waitFor({ timeout: 10_000 });
  const texts = await items.evaluateAll((found) =>
    found.map((item) => (item.textContent ?? "").trim()).filter(Boolean),
  );
  await page().keyboard.press("Escape");
  return texts;
};

/** The Change section's title buttons (Open all changes, Read this change, Send review). */
export const changeActions = async (h) => {
  const { page, sleep } = h;
  const pane = page().locator(".part.sidebar .pane", {
    has: page().locator(".pane-header .title", { hasText: /^change$/i }),
  });
  await pane.locator(".pane-header").hover();
  await sleep(300);
  return pane.locator(".pane-header .actions .action-label").evaluateAll((found) =>
    found
      .map((action) => ({
        title: action.getAttribute("aria-label") ?? "",
        disabled:
          action.classList.contains("disabled") ||
          action.closest(".action-item")?.classList.contains("disabled") === true,
      }))
      .filter((action) => action.title !== "" && !action.title.startsWith("More Actions")),
  );
};

/** The overflow menu's item, by its label. */
export const clickOverflow = async (h, label) => {
  const { page, sleep } = h;
  const pane = page().locator(".part.sidebar .pane", {
    has: page().locator(".pane-header .title", { hasText: /^change$/i }),
  });
  await pane.locator(".pane-header").hover();
  await sleep(300);
  await pane
    .locator('.pane-header .actions .action-label[aria-label^="More Actions"]')
    .first()
    .click();
  const item = page().locator(".context-view .monaco-menu .action-item .action-label", {
    hasText: label,
  });
  await item.first().waitFor({ timeout: 10_000 });
  await item.first().hover();
  await sleep(300);
  await item.first().click();
};

const MODIFIED =
  ".editor-group-container.active .monaco-diff-editor .modified-in-monaco-diff-editor";

/**
 * The `+` on a line of the active diff editor's new side: the pointer rests on the line's margin
 * until VS Code draws the comment glyph there, then clicks it. Null when the line shows no `+`.
 */
export const commentGlyph = async (h, line) => {
  const { page, sleep } = h;
  const top = await page().evaluate(
    ({ selector, wanted }) => {
      const editor = document.querySelector(selector);
      const numbers = [...(editor?.querySelectorAll(".margin-view-overlays .line-numbers") ?? [])];
      const found = numbers.find((cell) => (cell.textContent ?? "").trim() === String(wanted));
      const box = found?.getBoundingClientRect();
      return box === undefined
        ? null
        : { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    },
    { selector: MODIFIED, wanted: line },
  );
  if (top === null) return null;
  await page().mouse.move(top.x, top.y);
  await sleep(600);
  // The glyph VS Code draws under the pointer: one per commentable line, marked `line-hover`.
  const glyph = page().locator(`${MODIFIED} .comment-range-glyph.line-hover`);
  if ((await glyph.count()) === 0) return { at: top, found: false };
  const box = await glyph.first().boundingBox();
  const onLine = box !== null && Math.abs(box.y + box.height / 2 - top.y) < box.height;
  return { at: top, found: onLine, click: () => glyph.first().click() };
};

/** Every comment thread widget open in the active editor group, as she reads it. */
export const commentThreads = (h) =>
  h.page().evaluate(() =>
    [...document.querySelectorAll(".editor-group-container.active .review-widget")].map(
      (widget) => ({
        title: (widget.querySelector(".head .review-title")?.textContent ?? "").trim(),
        comments: [...widget.querySelectorAll(".review-comment")].map((comment) => ({
          author: (comment.querySelector(".author")?.textContent ?? "").trim(),
          label: (
            comment.querySelector(".isPending, .comment-label, .action-label.label")?.textContent ??
            ""
          ).trim(),
          text: (comment.querySelector(".comment-body")?.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim(),
          header: (comment.querySelector(".comment-title")?.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim(),
          actions: [...comment.querySelectorAll(".comment-title .action-label")].map(
            (action) => action.getAttribute("aria-label") ?? "",
          ),
        })),
        buttons: [...widget.querySelectorAll(".form-actions .monaco-text-button")].map((button) =>
          (button.textContent ?? "").trim(),
        ),
      }),
    ),
  );

/** Types into the comment form open in the active group, then presses its button. */
export const writeComment = async (h, text, button) => {
  const { page, sleep } = h;
  const form = page()
    .locator(".editor-group-container.active .review-widget .comment-form-container .monaco-editor")
    .last();
  await form.waitFor({ timeout: 10_000 });
  await form.click();
  await page().keyboard.type(text);
  await sleep(300);
  await page()
    .locator(".editor-group-container.active .review-widget .form-actions .monaco-text-button", {
      hasText: button,
    })
    .last()
    .click();
};

/** The `+` on a line of the open diff's new side, her words, Add comment: one pending comment. */
export const commentOnLine = async (h, line, text) => {
  const glyph = await h.waitUntil(`the + on line ${line}`, async () => {
    const found = await commentGlyph(h, line);
    return found?.found === true ? found : null;
  });
  await glyph.click();
  await writeComment(h, text, "Add comment");
  return h.waitUntil(
    `the thread of "${text}"`,
    async () => {
      const seen = await commentThreads(h);
      return seen.some((thread) => thread.comments.some((one) => one.text.includes(text)))
        ? seen
        : null;
    },
    30_000,
  );
};

/** The Comments panel's rows: each file and each thread as the panel lists them. */
export const commentsPanel = (h) =>
  h
    .page()
    .evaluate(() =>
      [...document.querySelectorAll(".part.panel .comments-panel .monaco-list-row")].map((row) =>
        (row.textContent ?? "").replace(/\s+/g, " ").trim(),
      ),
    );

/** The active editor's lines as they read on screen (Monaco draws only what is in view). */
export const editorLines = (h) =>
  h.page().evaluate(() => {
    const editor = document.querySelector(
      ".editor-group-container.active .editor-container .monaco-editor:not(.original-in-monaco-diff-editor)",
    );
    return [...(editor?.querySelectorAll(".view-lines .view-line") ?? [])]
      .map((line) => ({
        top: Number.parseFloat(line.style.top || "0"),
        text: (line.textContent ?? "").replace(/ /g, " "),
      }))
      .toSorted((left, right) => left.top - right.top)
      .map((line) => line.text);
  });

/** A button in the active editor's title bar, by its title (a prefix). */
export const clickEditorTitle = async (h, title) => {
  const button = h
    .page()
    .locator(".editor-group-container.active .title .editor-actions .action-label", {
      hasText: title,
    })
    .or(
      h
        .page()
        .locator(
          `.editor-group-container.active .title .editor-actions .action-label[aria-label^="${title}"]`,
        ),
    )
    .first();
  await button.waitFor({ timeout: 10_000 });
  await button.click();
};

export const clickChangeAction = async (h, title) => {
  const { page, sleep } = h;
  const pane = page().locator(".part.sidebar .pane", {
    has: page().locator(".pane-header .title", { hasText: /^change$/i }),
  });
  await pane.locator(".pane-header").hover();
  await sleep(300);
  await pane.locator(`.pane-header .actions .action-label[aria-label^="${title}"]`).first().click();
};
