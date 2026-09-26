// THE PAGE — an editorial grid: oversized display type, ink rules, and a
// bounded column. One aesthetic throughout: square corners, no shadows, no
// product mockups, nothing borrowed from the app's rounded panel language.
// The words live in content.tsx.

import { ArrowUpRight, Check, Copy, SunMoon } from "lucide-react";
import { type ReactNode, useState } from "react";

import {
  Cmd,
  DOCS_URL,
  FAQ,
  FEATURES,
  INSTALL_COMMAND,
  INTEGRATION_GROUPS,
  DISCORD_URL,
  REPO_URL,
  REQUIREMENTS_LINE,
  SUBLINE,
  START_STEPS,
} from "#/components/content";
import { MendMark } from "#/components/logo";

const RULE = "border-[var(--sw-ink)]";

// The page is a bounded column, framed by ink rules once the viewport is wider
// than it; every horizontal rule stops at the frame.
const FRAME = "mx-auto w-full max-w-[1240px] border-[var(--sw-ink)] min-[1280px]:border-x-2";

// Columns per integration group size. An odd count at two columns lets its
// last cell span the row, so the ink gap never shows through an empty slot.
const GRID_COLS: Readonly<Record<number, string>> = {
  4: "md:grid-cols-2 xl:grid-cols-4",
  5: "md:grid-cols-2 xl:grid-cols-5 md:[&>*:last-child]:col-span-2 xl:[&>*:last-child]:col-span-1",
};

const NAV: ReadonlyArray<{ label: string; href: string }> = [
  { label: "Features", href: "#features" },
  { label: "Integrations", href: "#integrations" },
  { label: "FAQ", href: "#faq" },
  { label: "Docs", href: DOCS_URL },
  { label: "GitHub", href: REPO_URL },
  { label: "Discord", href: DISCORD_URL },
];

export function MarketingPage() {
  return (
    <div className="mend-grain mend-grain-surface min-h-dvh overflow-x-clip text-foreground">
      <header className="mend-grain-surface sticky top-0 z-40">
        <div
          className={`${FRAME} flex min-h-16 items-center justify-between gap-4 border-b-2 px-5 sm:px-8`}
        >
          <a href="/" className="flex items-center gap-3 text-foreground no-underline">
            <MendMark className="size-8" aria-hidden="true" />
            <span className="font-mono text-[12px] leading-[1.25] font-medium tracking-[0.08em] uppercase max-sm:hidden">
              Mend
              <br />
              <span className="text-muted-foreground">by Sealant</span>
            </span>
          </a>
          <nav className="flex items-center">
            {NAV.map((item) => (
              <a
                key={item.label}
                href={item.href}
                className={`border-l-2 ${RULE} px-2.5 font-mono sm:px-3.5 text-[12px] font-medium tracking-[0.08em] text-foreground uppercase no-underline transition-colors hover:text-primary ${
                  item.label === "Docs" || item.label === "GitHub" || item.label === "Discord"
                    ? ""
                    : "max-md:hidden"
                }`}
              >
                {item.label}
              </a>
            ))}
            <span className="ml-2 sm:ml-3.5">
              <SquareThemeSwitcher />
            </span>
          </nav>
        </div>
      </header>

      <main className={FRAME}>
        {/* Masthead: the wordmark at the width of the page, then the statement and the install line. */}
        <section className="px-5 sm:px-8">
          <div className={`relative border-b-2 ${RULE} pt-4 sm:pt-12`}>
            <p
              className="absolute top-1/2 -left-1 hidden origin-center -translate-x-1/2 -translate-y-1/2 -rotate-90 font-mono text-[11px] font-medium tracking-[0.12em] whitespace-nowrap uppercase sm:block"
              aria-hidden="true"
            >
              Apache-2.0 · self-hosted
            </p>
            <h1 className="py-3 text-center font-display text-[34vw] leading-[0.78] font-bold tracking-[-0.055em] select-none sm:py-6 sm:text-[min(31vw,28rem)]">
              mend
            </h1>
            <p className="pb-6 font-mono text-[13px] tracking-[0.08em] uppercase sm:pb-8 sm:text-[17px]">
              Run your TUI agents anywhere you want.
            </p>
          </div>
          <div className="grid gap-8 py-10 sm:gap-10 sm:py-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:items-end">
            <div className={`min-w-0 ${RULE} sm:border-l-2 sm:pl-6`}>
              <p className="max-w-[40rem] text-[15px] leading-relaxed text-ink-2 sm:text-[16px]">
                {SUBLINE}
              </p>
            </div>
            <div className="flex min-w-0 flex-col gap-3">
              <InstallLine />
              <p className="font-mono text-[11.5px] text-muted-foreground">{REQUIREMENTS_LINE}</p>
            </div>
          </div>
          <ol className="grid border-t-2 border-[var(--sw-ink)] md:grid-cols-3">
            {START_STEPS.map((step, i) => (
              <li
                key={step.command}
                className={`py-8 md:px-6 ${i === 0 ? "md:pl-0" : `border-t ${RULE} md:border-t-0 md:border-l`}`}
              >
                <p className="font-display text-4xl leading-none font-bold tracking-[-0.04em]">
                  0{i + 1}
                </p>
                <p className="mt-5 font-mono text-[14px] break-words">
                  <span className="text-primary select-none">$ </span>
                  {step.command === "mend claude" ? (
                    <>
                      <span className="sr-only">mend claude</span>
                      <span aria-hidden="true">
                        mend <CyclingHarness tight={false} />
                      </span>
                    </>
                  ) : (
                    step.command
                  )}
                </p>
                <p className="mt-2 text-[14px] leading-relaxed text-ink-2">{step.text}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Capabilities: one row each, the title beside the explanation. */}
        <section id="features" className={`border-t-2 ${RULE}`}>
          <BigHead title="How it works" note="One machine, your hardware, isolated sessions." />
          {FEATURES.map((feature) => (
            <article
              key={feature.title}
              className={`grid border-t ${RULE} lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]`}
            >
              <div className={`px-5 pt-8 sm:px-8 lg:border-r ${RULE} lg:py-10`}>
                <p className="font-mono text-[11.5px] tracking-[0.08em] text-muted-foreground uppercase">
                  {feature.kicker}
                </p>
                <h3 className="mt-3 max-w-[14ch] font-display text-[2.5rem] leading-[0.98] font-bold tracking-[-0.035em] text-balance lg:text-[3rem]">
                  {feature.title}
                </h3>
              </div>
              <div className="px-5 py-8 sm:px-8 lg:py-10">
                <div className="max-w-[40rem] space-y-3.5 text-[15.5px] leading-relaxed text-ink-2">
                  {feature.body}
                </div>
              </div>
            </article>
          ))}
        </section>

        {/* Integrations: a ruled table, a row per group. */}
        <section id="integrations" className={`border-t-2 ${RULE}`}>
          <BigHead title="Integrations" />
          {INTEGRATION_GROUPS.map((group) => (
            <div
              key={group.label}
              className={`grid border-t ${RULE} lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]`}
            >
              <div className={`px-5 py-6 sm:px-8 lg:border-r ${RULE}`}>
                <h3 className="font-mono text-[12px] font-medium tracking-[0.08em] uppercase">
                  {group.label}
                </h3>
                <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
                  {group.note}
                </p>
              </div>
              <div
                className={`grid gap-px bg-[var(--sw-ink)] max-lg:border-t max-lg:border-[var(--sw-ink)] ${
                  GRID_COLS[group.items.length] ?? "md:grid-cols-3"
                }`}
              >
                {group.items.map((item) => (
                  <div
                    key={item.name}
                    className="group flex flex-col bg-[var(--sw-canvas)] px-5 py-6 transition-colors hover:bg-[var(--sw-bg)] sm:px-6"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="text-foreground transition-colors group-hover:text-primary">
                        {item.icon}
                      </span>
                      <span className="font-display text-[19px] font-bold tracking-[-0.02em]">
                        {item.name}
                      </span>
                    </div>
                    <p className="mt-3 grow text-[14px] leading-relaxed text-ink-2">{item.body}</p>
                    <p className="mt-4 font-mono text-[11.5px] text-muted-foreground">
                      {item.fact}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>

        {/* FAQ: ruled rows, the answer opens under its question. */}
        <section id="faq" className={`border-t-2 ${RULE}`}>
          <BigHead title="FAQ" note="What people usually ask first." />
          <div className={`border-t ${RULE}`}>
            {FAQ.map((entry, i) => (
              <details
                key={entry.q}
                open={i === 0}
                className={`group ${i === 0 ? "" : `border-t ${RULE}`}`}
              >
                <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_2rem] items-baseline gap-2 px-5 py-6 sm:grid-cols-[minmax(0,1fr)_3rem] sm:px-8 [&::-webkit-details-marker]:hidden">
                  <span className="font-display text-[1.35rem] leading-snug font-bold tracking-[-0.02em] sm:text-[1.6rem]">
                    {entry.q}
                  </span>
                  <span
                    className="justify-self-end font-mono text-xl transition-transform duration-200 group-open:rotate-45"
                    aria-hidden="true"
                  >
                    +
                  </span>
                </summary>
                <div className="px-5 pb-8 sm:px-8">
                  <div className="max-w-[46rem] text-[15.5px] leading-relaxed text-ink-2 [&_a]:text-foreground [&_a]:underline [&_a]:underline-offset-4 [&_code]:font-mono [&_code]:text-[0.9em] [&_code]:text-foreground [&_p+p]:mt-3">
                    {entry.a}
                  </div>
                </div>
              </details>
            ))}
          </div>
        </section>

        {/* Closer: the command, big. */}
        <section className={`border-t-2 ${RULE} px-5 pt-16 pb-10 sm:px-8 sm:pt-24`}>
          <p className="font-mono text-[12px] tracking-[0.08em] text-muted-foreground uppercase">
            In any repository with a remote
          </p>
          <p className="mt-4 font-mono text-[10.5vw] leading-[0.9] font-medium tracking-[-0.06em] whitespace-nowrap lg:text-[8rem]">
            <span className="sr-only">mend claude</span>
            <span aria-hidden="true">
              <span className="text-primary">$</span> mend <CyclingHarness tight />
            </span>
          </p>
          <div
            className={`mt-12 flex flex-wrap items-end justify-between gap-6 border-t-2 ${RULE} pt-8`}
          >
            <div className="flex min-w-0 flex-col gap-3">
              <InstallLine />
              <p className="text-[14px] text-muted-foreground">
                Install the CLI and run <Cmd>mend server setup</Cmd> once. The{" "}
                <a
                  href={`${DOCS_URL}/getting-started/install/`}
                  className="text-foreground underline underline-offset-4"
                >
                  install guide
                </a>{" "}
                has the rest.
              </p>
            </div>
            <div className="flex flex-wrap gap-6">
              <ArrowLink href={DOCS_URL}>Docs</ArrowLink>
              <ArrowLink href={REPO_URL}>GitHub</ArrowLink>
              <ArrowLink href={DISCORD_URL}>Discord</ArrowLink>
            </div>
          </div>
        </section>
      </main>

      <footer className="min-[1280px]:pb-12">
        <div
          className={`${FRAME} flex flex-wrap items-center justify-between gap-4 border-t-2 px-5 py-6 font-mono text-[11.5px] tracking-[0.06em] uppercase sm:px-8 min-[1280px]:border-b-2`}
        >
          <span className="inline-flex items-center gap-2.5">
            <MendMark className="size-5" aria-hidden="true" />
            Mend · by Sealant
          </span>
          <span className="text-muted-foreground">Open source · Apache-2.0</span>
        </div>
      </footer>
    </div>
  );
}

/** A section's opening: a giant title on the left, an optional note on the right. */
function BigHead({ title, note }: { title: string; note?: string }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4 px-5 pt-14 pb-8 sm:px-8 sm:pt-20">
      <h2 className="font-display text-[15vw] leading-[0.8] font-bold tracking-[-0.055em] lg:text-[9rem]">
        {title}
      </h2>
      {note === undefined ? null : (
        <p className="max-w-[20rem] pb-2 font-mono text-[12px] leading-relaxed tracking-[0.06em] uppercase">
          {note}
        </p>
      )}
    </div>
  );
}

// The harness words `mend <harness>` cycles through. Each carries its typing
// variables as static classes so Tailwind sees them: one step per character,
// and a width in ch, less the -0.06em tracking when the text is set tight.
const HARNESSES: ReadonlyArray<{ word: string; tight: string; plain: string }> = [
  {
    word: "claude",
    tight: "[--type-w:calc(6ch-0.36em)] [--type-steps:6] [--type-dur:540ms]",
    plain: "[--type-w:6ch] [--type-steps:6] [--type-dur:540ms]",
  },
  {
    word: "codex",
    tight: "[--type-w:calc(5ch-0.3em)] [--type-steps:5] [--type-dur:450ms]",
    plain: "[--type-w:5ch] [--type-steps:5] [--type-dur:450ms]",
  },
  {
    word: "opencode",
    tight: "[--type-w:calc(8ch-0.48em)] [--type-steps:8] [--type-dur:720ms]",
    plain: "[--type-w:8ch] [--type-steps:8] [--type-dur:720ms]",
  },
  {
    word: "pi",
    tight: "[--type-w:calc(2ch-0.12em)] [--type-steps:2] [--type-dur:180ms]",
    plain: "[--type-w:2ch] [--type-steps:2] [--type-dur:180ms]",
  },
];

/**
 * `mend <harness>`: the word types itself, holds, and gives way to the next.
 * CSS animations do the timing and animationend advances the state, so there
 * are no timers.
 */
function CyclingHarness({ tight }: { tight: boolean }) {
  const [index, setIndex] = useState(0);
  const [typed, setTyped] = useState(false);
  const harness = HARNESSES[index] ?? HARNESSES[0];
  if (harness === undefined) return null;
  return (
    <>
      <span
        key={`type-${index}`}
        className={`mend-type ${tight ? harness.tight : harness.plain}`}
        onAnimationEnd={() => setTyped(true)}
      >
        {harness.word}
      </span>
      <span className="mend-caret">▍</span>
      {typed ? (
        <span
          key={`hold-${index}`}
          className="mend-timer inline-block [--timer:2400ms]"
          onAnimationEnd={() => {
            setTyped(false);
            setIndex((index + 1) % HARNESSES.length);
          }}
        />
      ) : null}
    </>
  );
}

function ArrowLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className={`inline-flex items-center gap-1.5 border-b-2 ${RULE} pb-1 font-mono text-[13px] font-medium tracking-[0.08em] text-foreground uppercase no-underline transition-colors hover:border-primary hover:text-primary`}
    >
      {children}
      <ArrowUpRight className="size-4" aria-hidden="true" />
    </a>
  );
}

function InstallLine() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(INSTALL_COMMAND);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div
      className={`flex min-h-12 max-w-full items-center gap-3 border-2 ${RULE} bg-panel py-1.5 pr-1.5 pl-3 sm:pl-4`}
    >
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[0.78rem] whitespace-nowrap sm:text-[0.84rem]">
        <span className="text-primary select-none">$ </span>
        {INSTALL_COMMAND}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy install command"}
        className="inline-flex size-9 shrink-0 items-center justify-center text-foreground transition-colors hover:bg-[var(--sw-ink)] hover:text-[var(--sw-bg)]"
      >
        {copied ? (
          <Check className="size-4 text-success" aria-hidden="true" />
        ) : (
          <Copy className="size-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

function SquareThemeSwitcher() {
  return (
    <button
      type="button"
      className={`inline-flex size-9 items-center justify-center border-2 ${RULE} text-foreground transition-colors hover:bg-[var(--sw-ink)] hover:text-[var(--sw-bg)]`}
      aria-label="Toggle color theme"
      title="Toggle theme"
      onClick={() => {
        document.documentElement.classList.toggle("dark");
      }}
    >
      <SunMoon className="size-4" aria-hidden="true" />
    </button>
  );
}
