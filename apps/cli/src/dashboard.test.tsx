/**
 * The dashboard drawn for real, against the fixture machine: the numbered panes, the keys that
 * move between them, which pane wears the accent, the `?` overlay and the game keeping its keys.
 * opentui's renderer loads through node:ffi, so vitest runs this file with --experimental-ffi
 * (vitest.config.ts), as main.ts does for the dashboard itself.
 */
import { RGBA } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { helpSections, KEY_BINDINGS } from "./dashboard-model.ts";
import { fixtureContext } from "./dashboard.fixture.ts";
import { App, type DashboardContext } from "./dashboard.tsx";
import { ACCENT, INK } from "./tui-theme.ts";

// React's act() checks this flag before it flushes; the dashboard is a React tree like any other.
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

interface Drawn {
  readonly setup: TestRendererSetup;
  readonly frame: () => string;
  readonly press: (
    key: string,
    modifiers?: { readonly shift?: boolean; readonly ctrl?: boolean },
  ) => Promise<void>;
  readonly type: (text: string) => Promise<void>;
  readonly onQuit: () => void;
}

let open: Drawn | null = null;

afterEach(() => {
  open?.setup.renderer.destroy();
  open = null;
});

const draw = async (
  options: {
    readonly width?: number;
    readonly height?: number;
    readonly kittyKeyboard?: boolean;
    readonly ctx?: Partial<DashboardContext>;
  } = {},
): Promise<Drawn> => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onQuit = vi.fn();
  const setup = await testRender(
    <QueryClientProvider client={client}>
      <App ctx={fixtureContext(options.ctx)} onQuit={onQuit} />
    </QueryClientProvider>,
    {
      width: options.width ?? 140,
      height: options.height ?? 40,
      kittyKeyboard: options.kittyKeyboard ?? false,
    },
  );
  const settle = async (): Promise<void> => {
    // Queries resolve on microtasks, and a lone esc is only a key once the parser's 20 ms wait for
    // the rest of a sequence runs out: let both land and React commit, then paint.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await setup.renderOnce();
  };
  await settle();
  await setup.waitForFrame((frame) => frame.includes("tui-numbered-panels"));
  const drawn: Drawn = {
    setup,
    frame: () => setup.captureCharFrame(),
    press: async (key, modifiers) => {
      await act(async () => {
        setup.mockInput.pressKey(key, modifiers);
      });
      await settle();
    },
    type: async (text) => {
      await act(async () => {
        await setup.mockInput.typeText(text);
      });
      await settle();
    },
    onQuit,
  };
  open = drawn;
  return drawn;
};

/** The colour a pane's numbered title is drawn in: the accent says the keyboard is there. */
const titleColor = (drawn: Drawn, title: string): RGBA | null => {
  for (const line of drawn.setup.captureSpans().lines) {
    for (const span of line.spans) if (span.text.includes(title)) return span.fg;
  }
  return null;
};

const accent = RGBA.fromHex(ACCENT);
const ink = RGBA.fromHex(INK);

/** Which numbered pane wears the accent; exactly one may. */
const focusedPane = (drawn: Drawn): string => {
  const lit = ["[1] projects", "[2] worktrees", "[3] sessions", "[0] session"].filter((title) =>
    titleColor(drawn, title)?.equals(accent),
  );
  expect(lit, `one focused pane, saw ${lit.join(", ")}`).toHaveLength(1);
  return lit[0] ?? "";
};

describe("the numbered panes", () => {
  it("numbers every pane in its title, lazygit's way", async () => {
    const drawn = await draw();
    const frame = drawn.frame();
    expect(frame).toContain("[1] projects");
    expect(frame).toContain("[2] worktrees");
    expect(frame).toContain("[3] sessions");
    expect(frame).toContain("[0] session");
    // The selected session's Service, read from GET /services as the server answers it.
    expect(frame).toContain("web :5173→41873 reachable");
  });

  it("wears the accent on the focused pane alone, and the ink everywhere else", async () => {
    const drawn = await draw();
    expect(focusedPane(drawn)).toBe("[3] sessions");
    expect(titleColor(drawn, "[1] projects")?.equals(ink)).toBe(true);
    expect(titleColor(drawn, "[0] session")?.equals(ink)).toBe(true);
  });

  it("jumps to the pane a digit names, from anywhere", async () => {
    const drawn = await draw();
    for (const [digit, pane] of [
      ["1", "[1] projects"],
      ["0", "[0] session"],
      ["2", "[2] worktrees"],
      ["3", "[3] sessions"],
      ["1", "[1] projects"],
    ] as const) {
      await drawn.press(digit);
      expect(focusedPane(drawn), digit).toBe(pane);
    }
  });

  it("ignores a digit no pane carries", async () => {
    const drawn = await draw();
    await drawn.press("5");
    expect(focusedPane(drawn)).toBe("[3] sessions");
  });

  it("cycles with tab and wraps at both ends; shift+tab walks back", async () => {
    const drawn = await draw();
    const forward = ["[0] session", "[1] projects", "[2] worktrees", "[3] sessions"];
    for (const pane of forward) {
      await drawn.press("TAB");
      expect(focusedPane(drawn)).toBe(pane);
    }
    for (const pane of ["[2] worktrees", "[1] projects", "[0] session"]) {
      await drawn.press("TAB", { shift: true });
      expect(focusedPane(drawn)).toBe(pane);
    }
  });

  it("keeps the arrows on the hierarchy: right drills in, left steps back, both stop at the ends", async () => {
    const drawn = await draw();
    await drawn.press("1");
    await drawn.press("ARROW_LEFT");
    expect(focusedPane(drawn)).toBe("[1] projects");
    await drawn.press("RETURN");
    expect(focusedPane(drawn)).toBe("[2] worktrees");
    await drawn.press("l");
    await drawn.press("ARROW_RIGHT");
    expect(focusedPane(drawn)).toBe("[0] session");
    await drawn.press("ARROW_RIGHT");
    expect(focusedPane(drawn)).toBe("[0] session");
  });

  it("goes back with esc to the list the session pane was opened from", async () => {
    const drawn = await draw();
    await drawn.press("2");
    await drawn.press("0");
    await drawn.press("ESCAPE");
    expect(focusedPane(drawn)).toBe("[2] worktrees");
    await drawn.press("ESCAPE");
    expect(focusedPane(drawn)).toBe("[1] projects");
  });

  it("gives the focused side the whole screen in full mode, and comes back round", async () => {
    const drawn = await draw();
    await drawn.press("0");
    await drawn.press("+");
    await drawn.press("+");
    expect(drawn.frame()).toContain("full screen");
    expect(drawn.frame()).not.toContain("[1] projects");
    await drawn.press("+");
    expect(drawn.frame()).toContain("[1] projects");
    expect(drawn.frame()).not.toContain("full screen");
    await drawn.press("_");
    expect(drawn.frame()).toContain("full screen");
  });
});

describe("the footer and ?", () => {
  it("ends the footer with ? keys", async () => {
    const drawn = await draw({ width: 80 });
    const rows = drawn.frame().trimEnd().split("\n");
    expect(rows.at(-1)?.trimEnd().endsWith("? keys")).toBe(true);
  });

  it.each([false, true])(
    "opens the overlay on ? (kitty keyboard: %s) and lists every binding in the keymap",
    async (kittyKeyboard) => {
      const drawn = await draw({ height: 60, kittyKeyboard });
      await drawn.press("?");
      const frame = drawn.frame();
      expect(frame).toContain("keys · [3] sessions");
      const rows = helpSections("sessions").flatMap((section) => section.rows);
      // Every verb the keymap binds has a row, and the row is on screen.
      expect(new Set(rows.map((row) => row.verb))).toEqual(
        new Set(KEY_BINDINGS.map((binding) => binding.verb)),
      );
      for (const row of rows) expect(frame, row.verb).toContain(row.help.slice(0, 30));
      await drawn.press("ESCAPE");
      expect(drawn.frame()).not.toContain("keys · [3] sessions");
      // The overlay is closed, and nothing moved under it.
      expect(focusedPane(drawn)).toBe("[3] sessions");
    },
  );
});

describe("the / filter", () => {
  it("narrows the focused list, keeps it on enter, and clears it on esc", async () => {
    const drawn = await draw();
    await drawn.press("2");
    await drawn.press("/");
    await drawn.type("snake");
    await drawn.press("RETURN");
    let frame = drawn.frame();
    expect(frame).toContain("[2] worktrees /snake · 1");
    expect(frame).toContain("tui-snake-countdown");
    expect(frame).not.toContain("docs-pass");
    // Enter left the input: the list's keys work again.
    expect(focusedPane(drawn)).toBe("[2] worktrees");
    await drawn.press("ESCAPE");
    frame = drawn.frame();
    expect(frame).toContain("docs-pass");
    expect(frame).not.toContain("/snake");
    expect(focusedPane(drawn)).toBe("[2] worktrees");
  });
});

/** The footer while a game has the keyboard (snake-play.ts `snakeHints`, playing). */
const SNAKE_KEYS = "←↑↓→/hjkl steer · space/p pause · esc/q leave";

const footerOf = (drawn: Drawn): string => drawn.frame().trimEnd().split("\n").at(-1)?.trim() ?? "";

/**
 * Select sealant's starting session from [2] worktrees, filtered to it, then jump to [0]: a
 * jump into the pane of a starting session is into its game, as an arrow into it is.
 */
const toStartingSession = async (drawn: Drawn): Promise<void> => {
  await drawn.press("1");
  await drawn.press("j");
  await drawn.press("2");
  await drawn.press("/");
  await drawn.type("boot");
  await drawn.press("RETURN");
  await drawn.press("0");
};

describe("the game keeps its keys", () => {
  it("takes the keyboard when a digit jumps into a starting session's pane", async () => {
    const drawn = await draw();
    await toStartingSession(drawn);
    expect(drawn.frame()).toContain("play snake while you wait");
    expect(focusedPane(drawn)).toBe("[0] session");
    expect(footerOf(drawn)).toBe(SNAKE_KEYS);
  });

  it("swallows every dashboard key while it plays: digits, tab, ?, / and the screen modes", async () => {
    const drawn = await draw();
    await toStartingSession(drawn);
    for (const key of ["1", "2", "3", "TAB", "?", "/", "+", "_", "n", "w"]) {
      await drawn.press(key);
      expect(focusedPane(drawn), key).toBe("[0] session");
      expect(footerOf(drawn), key).toBe(SNAKE_KEYS);
      expect(drawn.frame(), key).not.toContain("keys · ");
      expect(drawn.frame(), key).not.toContain("pick a harness");
    }
  });

  it.each(["ESCAPE", "q"])(
    "hands the keyboard back on %s to the pane the jump came from",
    async (key) => {
      const drawn = await draw();
      await toStartingSession(drawn);
      await drawn.press(key);
      expect(drawn.onQuit).not.toHaveBeenCalled();
      expect(focusedPane(drawn)).toBe("[2] worktrees");
      expect(footerOf(drawn)).not.toBe(SNAKE_KEYS);
      // The dashboard's keys are the dashboard's again.
      await drawn.press("1");
      expect(focusedPane(drawn)).toBe("[1] projects");
    },
  );

  it("leaves a game the terminal cannot show whole out of a jump", async () => {
    const drawn = await draw({ width: 100, height: 12 });
    await toStartingSession(drawn);
    expect(focusedPane(drawn)).toBe("[0] session");
    expect(footerOf(drawn)).not.toBe(SNAKE_KEYS);
    await drawn.press("1");
    expect(focusedPane(drawn)).toBe("[1] projects");
  });

  it("never jumps a pane under the mend snake overlay", async () => {
    const drawn = await draw({ ctx: { openSnake: true } });
    for (const key of ["1", "0", "TAB", "?", "/"]) {
      await drawn.press(key);
      expect(footerOf(drawn), key).toBe(SNAKE_KEYS);
      expect(drawn.frame(), key).not.toContain("keys · ");
    }
    await drawn.press("ESCAPE");
    expect(focusedPane(drawn)).toBe("[3] sessions");
  });
});

describe("the verbs that were here before", () => {
  it("still opens the label input on e and closes it on esc", async () => {
    const drawn = await draw();
    await drawn.press("e");
    expect(drawn.frame()).toContain("label · claude");
    await drawn.press("ESCAPE");
    expect(drawn.frame()).not.toContain("label · claude");
  });

  it("still opens the harness picker on n in a worktree, and says it joins that worktree", async () => {
    const drawn = await draw();
    await drawn.press("n");
    expect(drawn.frame()).toContain("pick a harness");
    expect(drawn.frame()).toContain("mend claude · joins tui-numbered-panels, recorded session");
    expect(drawn.frame()).not.toContain("new worktree, recorded");
    // The longest hint names the worktree too, and is cut before the picker's border.
    const rows = drawn.frame().split("\n");
    const top = rows.find((row) => row.includes("pick a harness"));
    const shell = rows.find((row) => row.includes("a plain bash session"));
    const right = [...(top ?? "")].lastIndexOf("╮");
    expect([...(shell ?? "")][right], shell).toBe("│");
    await drawn.press("ESCAPE");
    expect(drawn.frame()).not.toContain("pick a harness");
  });

  it.each([140, 70])(
    "keeps the new-worktree form inside its border at %i columns",
    async (width) => {
      const drawn = await draw({ width });
      await drawn.press("w");
      await drawn.press("RETURN");
      const frame = drawn.frame();
      expect(frame).toContain("main");
      // The form's frame: its top edge says where its right border is, and the base row (an
      // input with a long placeholder) must end on that border, not draw over it.
      const rows = frame.split("\n");
      const top = rows.find((row) => row.includes("╭─ new worktree"));
      const base = rows.find((row) => row.includes("▌ base"));
      const right = [...(top ?? "")].lastIndexOf("╮");
      expect(right).toBeGreaterThan(0);
      expect([...(base ?? "")][right], base).toBe("│");
      expect(frame).toContain("filter · enter takes the highlighted");
      expect(frame).not.toContain("or the default when empty");
    },
  );

  it("still asks for a session first when a session verb is pressed in projects", async () => {
    const drawn = await draw();
    await drawn.press("1");
    await drawn.press("a");
    expect(drawn.frame()).toContain("select a session first");
  });

  it("still quits on q", async () => {
    const drawn = await draw();
    await drawn.press("q");
    expect(drawn.onQuit).toHaveBeenCalledTimes(1);
  });
});
