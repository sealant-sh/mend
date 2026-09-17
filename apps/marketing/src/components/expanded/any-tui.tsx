// Expanded 01 — Any TUI: one recorded byte stream, two switchable renderers,
// a wire ticker underneath, the frame grammar beside it, and the phone as the
// third simultaneous attachment. Every CLI string is the real one.

import { useState } from "react";

import {
  am,
  cb,
  Cell,
  CellLabel,
  CopyBlock,
  d,
  FactsBar,
  g,
  o,
  PhoneShell,
  type Step,
  TermFrame,
  TermSurface,
  useTermPlayer,
} from "#/components/expanded/shared";

const SID = "8f3a2c1e-9d41-4c6b-a2e5-0b7d63f1c48a";
const SID8 = "8f3a2c1e";

const SCRIPT: ReadonlyArray<Step> = [
  { kind: "chapter", label: "launch" },
  { kind: "cmd", text: "mend claude" },
  {
    kind: "lines",
    delay: 320,
    lines: [
      [g("✓ worktree "), d(`session-${SID}`), d(" · branch "), d(`mend/session/${SID}`)],
      [g("✓ base "), d("4c9cddc71f0a"), d(" · session "), d(SID8)],
      [cb(`  watch · http://localhost:3105/sessions/${SID}`)],
    ],
  },
  {
    kind: "spinner",
    label: "provisioning workspace — a first launch builds the harness image (can take minutes)…",
    secs: 5,
    resolve: [[g("✓ recording"), o(" · workspace mounts the worktree · detach: "), d("Ctrl+]")]],
    ticker: "ws OPEN /api/tty?session=8f3a2c1e…&from=0 · authorized at upgrade",
  },
  {
    kind: "raw",
    tui: { name: "Claude Code", banner: ["/workspace/repo · the harness's own TUI, recorded"] },
  },
  {
    kind: "cmd",
    tui: true,
    text: "tighten the retry backoff in fetchQueue and add a test",
    ticker: "↑ bin 1B — one binary frame per keystroke",
  },
  {
    kind: "lines",
    delay: 550,
    lines: [
      [o("I'll adjust the backoff curve and pin it with a test.")],
      [d("  ● Read src/queue/fetchQueue.ts")],
      [d("  ● Edit src/queue/fetchQueue.ts  +9 −4")],
      [d("  ● Bash pnpm test --filter queue")],
    ],
    ticker: "↓ bin 4.1KB",
  },
  { kind: "lines", delay: 900, lines: [[g("  ✓ 11 tests passing · 1.8s")]] },
  { kind: "pause", ms: 900 },
  { kind: "chapter", label: "detach" },
  { kind: "raw", tui: null },
  {
    kind: "key",
    chip: "Ctrl+]",
    lines: [[am("detached"), o(" — the session keeps running; reattach: mend attach "), o(SID8)]],
    ticker: "ws CLOSE (client) · attachment dropped",
  },
  { kind: "pause", ms: 900 },
  { kind: "cmd", text: "mend status" },
  {
    kind: "lines",
    delay: 260,
    lines: [[o("claude  "), d(SID8), o("  running  "), d(`mend/session/${SID}`)]],
  },
  { kind: "pause", ms: 900 },
  { kind: "chapter", label: "reattach" },
  { kind: "cmd", text: `mend attach ${SID8}` },
  {
    kind: "lines",
    delay: 240,
    lines: [[g("✓ attaching to claude"), o(" · "), d(SID8), o(" · detach: "), d("Ctrl+]")]],
    ticker: "ws OPEN · from=0 · replay, then live on the same socket",
  },
  {
    kind: "lines",
    delay: 90, // replay is a single burst, never a slow scroll
    lines: [
      [d("  (scrollback replayed from seq 0 — one burst)")],
      [o("I'll adjust the backoff curve and pin it with a test.")],
      [g("  ✓ 11 tests passing · 1.8s")],
    ],
  },
  { kind: "pause", ms: 1400 },
  {
    kind: "lines",
    delay: 500,
    lines: [[g("✓ session settled")]],
    ticker: '↓ {"t":"end"} · close 1000 "session settled"',
  },
  { kind: "pause", ms: 3000 },
];

export function ExpandedAnyTui() {
  const { state, advance, jump, chapters, ticker } = useTermPlayer(SCRIPT);
  const [view, setView] = useState<"terminal" | "browser">("terminal");

  const pane = (
    <TermSurface
      steps={SCRIPT}
      state={state}
      advance={advance}
      className="h-full overflow-hidden"
    />
  );

  return (
    <div className="grid h-full gap-px overflow-hidden bg-[var(--sw-soft-rule)] max-lg:grid-cols-1 lg:grid-cols-12 lg:grid-rows-[minmax(0,4fr)_minmax(0,3fr)_auto]">
      <Cell className="flex flex-col justify-center p-7 sm:p-8 lg:col-span-3">
        <CopyBlock index={0} title="Any TUI — terminal, browser, phone">
          <p>
            Your agent runs in a terminal session on your own server — not in the window that
            launched it. Close the laptop, walk away, and open the exact same live screen from a
            browser tab or your phone: same scrollback, same cursor, and anything you type lands in
            the same process. <code>mend claude</code>, <code>mend codex</code>, and{" "}
            <code>mend opencode</code> all work this way, running each tool's own full-screen TUI
            unmodified.
          </p>
          <p>
            Each screen holds one WebSocket to the session's terminal. You authenticate once, when
            the connection opens; after that keystrokes and output travel as raw bytes, and
            reattaching replays the whole scrollback before going live. <code>Ctrl+]</code>{" "}
            disconnects your window without stopping the agent.
          </p>
        </CopyBlock>
      </Cell>

      {/* the demo — dominant */}
      <Cell className="flex flex-col p-5 max-lg:hidden lg:col-span-6 lg:row-span-2">
        <div className="flex shrink-0 items-center justify-between">
          <div className="flex gap-1" role="tablist" aria-label="Renderer">
            {(["terminal", "browser"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={view === tab}
                onClick={() => setView(tab)}
                className={`cursor-pointer border-b-2 px-2.5 pb-1 font-mono text-[11px] transition-colors ${
                  view === tab
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                [{tab}]
              </button>
            ))}
          </div>
          <div className="flex gap-1.5">
            {chapters.map((chapter) => (
              <button
                key={chapter.label}
                type="button"
                onClick={() => jump(chapter.idx)}
                className={`cursor-pointer rounded px-1.5 py-0.5 font-mono text-[9.5px] transition-colors ${
                  state.idx >= chapter.idx ? "text-info" : "text-faint hover:text-muted-foreground"
                }`}
              >
                {chapter.label}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-2 min-h-0 flex-1">
          {view === "terminal" ? (
            <TermFrame title="~/code/newsroom-api" className="h-full" footer={ticker ?? "—"}>
              {pane}
            </TermFrame>
          ) : (
            <div className="flex h-full flex-col overflow-hidden rounded-xl border border-rule bg-[var(--sw-bg)] shadow-[var(--shadow-lg)]">
              <div className="shrink-0 border-b border-[var(--sw-soft-rule)] bg-[var(--sw-sunken)] px-3.5 py-1.5">
                <p className="truncate font-mono text-[10px] text-muted-foreground">
                  mend · localhost:3105/sessions/{SID8}…
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2 border-b border-[var(--sw-faint-rule)] bg-[var(--sw-sunken)] px-3.5 py-1.5">
                <span
                  className="size-1.5 animate-pulse rounded-full bg-[var(--sw-red)]"
                  aria-hidden="true"
                />
                <p className="truncate font-mono text-[10px] text-muted-foreground">
                  run 9b3e51d7 · live — the same session your terminal holds
                </p>
              </div>
              <div className="min-h-0 flex-1 overflow-hidden bg-[#16161a] px-3.5 py-2.5">
                {pane}
              </div>
              <div className="shrink-0 border-t border-[var(--sw-faint-rule)] px-3.5 py-1.5 font-mono text-[10px] text-faint">
                {ticker ?? "its own socket — detaching the CLI changes nothing here"}
              </div>
            </div>
          )}
        </div>
      </Cell>

      {/* the phone — the third renderer */}
      <Cell className="flex flex-col items-center justify-center gap-3 p-6 max-lg:hidden lg:col-span-3 lg:row-span-2">
        <PhoneShell dark>
          <div className="flex shrink-0 items-center justify-between border-b border-[#26262c] px-3 pb-1.5">
            <span className="font-mono text-[10px] text-[#b9b9c0]">claude · {SID8}</span>
            <span
              className="size-1.5 animate-pulse rounded-full bg-[var(--sw-red)]"
              aria-hidden="true"
            />
          </div>
          <div className="min-h-0 flex-1 px-3 py-2 font-mono text-[0.6rem] leading-[1.9]">
            <p className="text-[#b9b9c0]">I'll adjust the backoff curve</p>
            <p className="text-[#b9b9c0]">and pin it with a test.</p>
            <p className="text-[#5c5c66]"> ● Bash pnpm test --filter queue</p>
            <p className="text-[#7fbf95]"> ✓ 11 tests passing · 1.8s</p>
            <p className="text-[#e8e8ec]">
              ▍<span className="mend-caret">&nbsp;</span>
            </p>
          </div>
          <div className="mt-auto flex shrink-0 items-center gap-1 overflow-hidden border-t border-[#26262c] bg-[#1a1a1f] px-2 pt-1.5 pb-3">
            {["ctrl", "esc", "tab", "^C", "↑", "↓", "~", "|"].map((key, i) => (
              <span
                key={key}
                className={`rounded border px-1 font-mono text-[8.5px] ${
                  i === 0 ? "border-[#7a9ce8] text-[#e8e8ec]" : "border-[#3a3a42] text-[#8a8a92]"
                }`}
              >
                {key}
              </span>
            ))}
          </div>
        </PhoneShell>
        <p className="max-w-[15rem] text-center font-mono text-[10px] leading-relaxed text-faint">
          native libghostty · same /api/tty socket as the laptop · the surface tracks keyboard
          height, so the PTY resizes and the prompt stays visible
        </p>
      </Cell>

      {/* the wire */}
      <Cell className="p-6 max-lg:hidden lg:col-span-3">
        <CellLabel>the protocol</CellLabel>
        <div className="space-y-1.5 font-mono text-[10.5px] leading-relaxed text-muted-foreground">
          <p className="text-ink-2">GET /api/tty?session=&lt;id&gt;&amp;from=&lt;seq&gt;</p>
          <p className="text-faint">
            cookie (browser) · ?ticket= single use, 30 s, this terminal only (CLI, phone)
          </p>
          <p className="pt-1.5">↓ binary — PTY output · replay from seq, then live</p>
          <p>↓ text — {'{"t":"end"}'}, then close 1000 "session settled"</p>
          <p>↑ binary — PTY input bytes</p>
          <p>
            ↑ text — {'{"t":"resize","cols":n,"rows":n}'} · {'{"t":"input","data":…}'}
          </p>
          <p className="pt-1.5 text-faint">
            mirrors sealant.attach.v1 — one held socket per attach
          </p>
        </div>
      </Cell>

      <FactsBar
        items={[
          "GET /api/tty?session=<id>&from=<seq> · auth once at the upgrade",
          '↓ binary = PTY bytes · ↑ {"t":"resize","cols":118,"rows":32}',
          "Ctrl+] = byte 0x1d, detected client-side · the session keeps running",
          "mend attach <id8> · replay from=0, then live on the same socket",
          'close(1000, "session settled") · mirrors sealant.attach.v1',
        ]}
      />
    </div>
  );
}
