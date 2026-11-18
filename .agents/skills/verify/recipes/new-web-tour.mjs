// Mend's description of a change and its tour in the new web app's Change view (route PR 25,
// SLNT-1151). Driven by review-change.md's `review-machine-pass` (the description and tour) and
// mobile.md's tour on the phone. Run the Change view's CLI batch first, once per stack:
//
//   pnpm verify drive cli --recipe .agents/skills/verify/recipes/new-web-change-sessions.json
//   pnpm verify drive new-web --recipe new-web-tour
//
// A local stack has no real agent login, so Mend's own pass can't write a description there: the
// recipe asks for one for real ("Write description and tour"), shows it being written and the
// failure the stack really gives, with Try again. The written description and its tour are a
// fixture laid over the real change in the browser (`changes.tour` and `changes.passes`): four
// stops on change-small's own lines, one the session backs on lines, one that is Mend's reading,
// one on a whole file, and one with no file. With it: the first look, the whole tour forwards and
// back, a link into the session opening its conversation, End tour back where the person was,
// a later look folded with Show more, out of date with Write again, and a login failure's words.
// Then the narrow tile beside the conversation and the phone. Light and dark, 1280px and 390px.
import { existsSync } from "node:fs";
import { join } from "node:path";

import { superjson } from "./new-web-session-fixtures.lib.mjs";

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

/** The first of `locator`'s matches a person can see: under 1024px every tab is in the page twice. */
const visible = (locator) => locator.filter({ visible: true }).first();

const boxOf = async (locator) => {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("an element the recipe needs isn't on screen");
  return box;
};

/** The fixture tour, on change-small's own files (new-web-change-sessions.json writes them). */
const STOPS = [
  {
    title: "The retry sends the same key every time",
    file: "src/payments/retry.ts",
    line: 18,
    endLine: 22,
    narration:
      "The key comes from the order id and is built once, before the loop. Every attempt sends that same `idempotencyKey`, so the provider treats a retry as the first charge instead of a new one.",
    evidence: [
      {
        sealantRunId: "run-fixture",
        sequence: "41",
        excerpt: "Reproduced the double charge in a test",
      },
      {
        sealantRunId: "run-fixture",
        sequence: "57",
        excerpt: "Ran the payment tests: 200 of 200 passed",
      },
    ],
    grounded: true,
  },
  {
    title: "Waits grow, with random jitter",
    file: "src/payments/retry.ts",
    line: 12,
    endLine: 15,
    narration:
      "`backoff()` doubles the wait after each attempt, starting at 200 ms, and adds up to a fifth more at random. Retries from many checkouts then don't all arrive at the same moment.",
    evidence: [],
    grounded: false,
  },
  {
    title: "The test that drops the connection",
    file: "src/payments/charge.test.ts",
    line: null,
    endLine: null,
    narration:
      "The tests check that every attempt sends the same key and that each wait is longer than the one before.",
    evidence: [
      {
        sealantRunId: "run-fixture",
        sequence: "33",
        excerpt: "Saw this test fail before the key was added",
      },
    ],
    grounded: true,
  },
  {
    title: "Other callers of chargeWithRetry",
    file: null,
    line: null,
    endLine: null,
    narration:
      "`chargeWithRetry` keeps its signature, so nothing that calls it has to change. Its one other caller, in the orders service, gets the key without an edit.",
    evidence: [
      {
        sealantRunId: "run-fixture",
        sequence: "62",
        excerpt: "Searched for callers of chargeWithRetry: 1, in the orders service",
      },
    ],
    grounded: true,
  },
];

const SUMMARY =
  "Checkout could charge a customer twice. After a 503, the retry wrapper sent the charge again without an idempotency key, so a slow first attempt and the retry could both go through.\n\nThis change builds a key from the order id and sends it with every attempt. It also waits longer between attempts, with some random jitter, and adds tests for both.";
const APPROACH =
  "The session first wrote the retry wrapper with one key per order, then added the waits and the tests. The payment tests ran 200 times and all 200 passed. The longer waits came after that run, and no test has run them yet.";

const tourAnswer = ({ changeId, sessionId, diffDigest }) =>
  superjson(
    {
      id: "fixture-tour",
      changeId,
      sessionId,
      summary: SUMMARY,
      approach: APPROACH,
      stops: STOPS,
      diffDigest,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    },
    [
      "createdAt",
      ...STOPS.flatMap((stop, index) =>
        stop.evidence.map((_, at) => `stops.${index}.evidence.${at}.sequence`),
      ),
    ],
  );

/** superjson's meta marks the evidence sequences as bigint, not Date. */
const withBigints = (answer) => ({
  ...answer,
  meta: {
    ...answer.meta,
    values: Object.fromEntries(
      Object.keys(answer.meta.values).map((path) => [
        path,
        path.endsWith(".sequence") ? ["bigint"] : ["Date"],
      ]),
    ),
  },
});

const passAnswer = (changeId, status, detail = null) =>
  superjson(
    [
      {
        changeId,
        kind: "tour",
        status,
        detail,
        findings: null,
        startedAt: new Date(Date.now() - 120_000).toISOString(),
        finishedAt: status === "failed" || status === "completed" ? new Date().toISOString() : null,
      },
    ],
    status === "failed" || status === "completed"
      ? ["0.startedAt", "0.finishedAt"]
      : ["0.startedAt"],
  );

export default async ({ page, web, capture: captureOnce, note }) => {
  const out = process.argv[process.argv.indexOf("--out") + 1] ?? "";
  const settled = () => page.waitForTimeout(500);
  const setTheme = async (theme) => {
    await page.evaluate(
      (on) => document.documentElement.classList.toggle("dark", on),
      theme === "dark",
    );
    await settled();
  };
  const changesInASecond = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          let changes = 0;
          const observer = new MutationObserver((records) => {
            changes += records.length;
          });
          observer.observe(document.body, { childList: true, subtree: true });
          setTimeout(() => {
            observer.disconnect();
            resolve(changes);
          }, 1_000);
        }),
    );
  const still = async () => {
    for (let second = 0; second < 10; second += 1) if ((await changesInASecond()) === 0) return;
  };
  const capture = async (name) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await still();
      await captureOnce(name);
      if (existsSync(join(out, `${name}.png`))) return;
      await page.waitForTimeout(600);
    }
  };
  const both = async (name) => {
    await page.addStyleTag({
      content: "[data-slot=sidebar-wrapper]{max-height:100dvh;overflow:hidden}",
    });
    await page.evaluate(() =>
      document.querySelectorAll("vite-error-overlay").forEach((each) => each.remove()),
    );
    await page.mouse.move(1, 1);
    for (const theme of ["light", "dark"]) {
      await setTheme(theme);
      await capture(`${name}-${theme}`);
    }
    await setTheme("light");
  };
  const hydrated = async () => {
    await page.waitForFunction(() => window["__TSR_ROUTER__"] !== undefined, null, {
      timeout: 90_000,
    });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("a[href], button")].some((element) =>
          Object.keys(element).some((key) => key.startsWith("__reactProps")),
        ),
      null,
      { timeout: 90_000 },
    );
  };
  const open = async (path) => {
    await page.goto(`${web}${path}`);
    await hydrated();
    await page.waitForTimeout(1_500);
    await hydrated();
  };
  const go = (to) => page.evaluate((path) => window["__TSR_ROUTER__"].navigate({ to: path }), to);
  const client = (fn, arg) =>
    page.evaluate(
      async ([source, value]) => {
        const trpc = window["__TSR_ROUTER__"].options.context.trpcClient;
        // eslint-disable-next-line no-new-func
        return new Function("trpc", "value", `return (${source})(trpc, value)`)(trpc, value);
      },
      [fn.toString(), arg],
    );
  const button = (name, exact = true) => visible(page.getByRole("button", { name, exact }));
  const section = (file) => visible(page.locator(`section[data-file="${file}"]`));
  const tourNote = () => visible(page.locator("[data-tour-note]"));
  const scrollTop = () =>
    page.evaluate(() => {
      const content = document.querySelector("section[data-file]")?.parentElement;
      return content?.parentElement?.parentElement?.scrollTop ?? -1;
    });
  /** The note's top, against the top of the diffs' scroll. */
  const noteOffset = () =>
    page.evaluate(() => {
      const shown = [...document.querySelectorAll("[data-tour-note]")].find(
        (each) => each.getBoundingClientRect().height > 0,
      );
      const scroller =
        document.querySelector("section[data-file]")?.parentElement?.parentElement?.parentElement;
      if (shown === undefined || scroller == null) return null;
      return Math.round(shown.getBoundingClientRect().top - scroller.getBoundingClientRect().top);
    });
  /** Whether the bar is on `line` of `file`: its number cell's inset shadow. */
  const barOn = (file, line) =>
    page.evaluate(
      ([path, number]) => {
        const host = document.querySelector(`section[data-file="${path}"] diffs-container`);
        const cell = host?.shadowRoot?.querySelector(
          `[data-column-number="${number}"]:not([data-line-type="change-deletion"])`,
        );
        return cell == null ? null : getComputedStyle(cell).boxShadow.includes("inset");
      },
      [file, line],
    );

  await page.setViewportSize(DESKTOP);
  await open("/no-such-page");
  await page.evaluate(() => localStorage.setItem("mend-theme", "light"));

  const rows = await page.evaluate(async () => {
    const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
    await queryClient.refetchQueries({ queryKey: [["sessions", "inbox"]] });
    return queryClient.getQueryCache().findAll({ queryKey: [["sessions", "inbox"]] })[0]?.state
      .data;
  });
  if (!Array.isArray(rows)) throw new Error("the page holds no inbox read");
  const [small] = rows
    .filter((row) => row.worktreeName === "change-small")
    .toSorted((a, b) => String(a.session.createdAt).localeCompare(String(b.session.createdAt)))
    .map((row) => row.session);
  if (small === undefined) throw new Error("run new-web-change-sessions.json first");
  const changeId = await client(
    async (trpc, id) => (await trpc.sessions.detail.query({ id })).change?.id ?? null,
    small.id,
  );
  if (changeId === null) throw new Error("change-small has no change");
  await page.context().clearCookies({ name: "mend-tiles" });
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage))
      if (key.startsWith("mend-viewed-files-")) localStorage.removeItem(key);
    sessionStorage.clear();
  });

  // What the fixture answers for `changes.tour` and `changes.passes`; null passes the real ones.
  let fixture = null;
  await page.route("**/trpc/**", async (route) => {
    if (fixture === null) return route.continue();
    const url = new URL(route.request().url());
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, "")).split(",");
    const mine = paths.map((path) =>
      path === "changes.tour" || path === "changes.passes" ? path : null,
    );
    if (mine.every((each) => each === null)) return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const answers = Array.isArray(body) ? body : [body];
    mine.forEach((path, index) => {
      if (path === "changes.tour") answers[index] = { result: { data: fixture.tour } };
      if (path === "changes.passes") answers[index] = { result: { data: fixture.passes } };
    });
    return route.fulfill({ response, json: Array.isArray(body) ? answers : answers[0] });
  });
  /** Lay a fixture over the reads, and have the page read them again. */
  const useFixture = async (next) => {
    fixture = next;
    await page.evaluate(async () => {
      const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
      await queryClient.refetchQueries({ queryKey: [["changes", "tour"]] });
      await queryClient.refetchQueries({ queryKey: [["changes", "passes"]] });
    });
    await settled();
  };

  // Mend's own pass, for real. Mend asks for a description when a session settles (the
  // automation setting is on). On a local stack the fake agent login is refused, so the pass fails;
  // where the login is real (the box) it writes the description. With no pass yet, ask for one.
  await open(`/sessions/${small.id}/change`);
  await section("src/payments/retry.ts").waitFor({ timeout: 60_000 });
  const failed = visible(page.getByText("Mend couldn't write the description."));
  const none = visible(page.getByText("No description yet.", { exact: true }));
  const written = visible(page.getByText(/^Mend wrote this from /));
  const writing = visible(page.getByText("Mend is writing the description and tour."));
  await failed.or(none).or(written).or(writing).waitFor({ timeout: 60_000 });
  if (await none.isVisible()) {
    note("no pass had run: 'No description yet.' with 'Write description and tour'");
    await both("none-real-desktop");
    await button("Write description and tour").click();
    await writing.waitFor({ timeout: 30_000 });
    note("Write description and tour queues the pass: 'Mend is writing the description and tour.'");
    await capture("writing-real-desktop-light");
  }
  await failed.or(written).waitFor({ timeout: 360_000 });
  if (await written.isVisible()) {
    const stopsLine = await visible(page.getByText(/stops?$/))
      .innerText()
      .catch(() => "no tour line");
    note(
      `Mend wrote the description for real: "${await written.innerText()}"; tour line: "${stopsLine}"`,
    );
    await both("written-real-desktop");
  } else {
    const reason = (await visible(page.locator('[data-slot="inline-alert"]')).innerText()).replace(
      /\s+/g,
      " ",
    );
    note(`the pass failed for real; the block reads: "${reason}"`);
    await both("failed-desktop");
    await button("Try again").click();
    await writing.waitFor({ timeout: 30_000 });
    note("Try again queues the pass again, for real: 'Mend is writing the description and tour.'");
    await capture("writing-real-desktop-light");
    await failed.or(written).waitFor({ timeout: 360_000 });
    note(
      `after Try again the pass ${(await written.isVisible()) ? "wrote the description" : "failed the same way"}`,
    );
  }

  // The written description, from a fixture whose digest is this change's.
  const review = await page.evaluate(() => {
    const queryClient = window["__TSR_ROUTER__"].options.context.queryClient;
    const read = queryClient
      .getQueryCache()
      .findAll({ queryKey: [["changes", "reviewDiff"]] })
      .find((query) => query.state.data !== undefined);
    return read?.state.data ?? null;
  });
  if (review === null) throw new Error("the page holds no review read");
  const digest = review.slice.diffDigest;
  const ready = {
    tour: withBigints(tourAnswer({ changeId, sessionId: small.id, diffDigest: digest })),
    passes: passAnswer(changeId, "completed"),
  };
  await useFixture(ready);
  await visible(page.getByText(/^Mend wrote this from checkpoint \d+$/)).waitFor({
    timeout: 30_000,
  });
  await visible(page.getByText("How the session got there")).waitFor();
  await visible(page.getByText(/· 4 stops/)).waitFor();
  note(
    "first look: the description open, 'How the session got there', and 'Tour · 4 stops' with Start tour",
  );
  await both("first-look-desktop");

  // The tour, forwards.
  await page.evaluate(() => {
    const content = document.querySelector("section[data-file]")?.parentElement;
    const scroller = content?.parentElement?.parentElement;
    if (scroller != null) scroller.scrollTop = 120;
  });
  await settled();
  const startedAt = await scrollTop();
  await button("Start tour").click();
  await visible(page.getByRole("heading", { name: "Tour" })).waitFor();
  await tourNote().waitFor();
  await page.waitForTimeout(800);
  const rail = await visible(page.getByRole("list").filter({ hasText: "Waits grow" })).innerText();
  note(
    `Start tour: the Tour section sits above Files and lists ${rail.split("\n").filter((line) => /^\d$/.test(line)).length || 4} stops`,
  );
  if ((await tourNote().getAttribute("data-place")) !== "line")
    throw new Error("stop 1 isn't between lines");
  if ((await barOn("src/payments/retry.ts", 18)) !== true)
    throw new Error("stop 1's lines carry no bar");
  if ((await barOn("src/payments/retry.ts", 23)) === true)
    throw new Error("the bar runs past stop 1");
  note(
    `stop 1 of 4: the note sits ${await noteOffset()}px under the top of the diffs, between retry.ts's rows above line 18; lines 18 to 22 carry the bar, 23 doesn't`,
  );
  if (!(await button("Previous").isDisabled())) throw new Error("Previous isn't off on stop 1");
  await both("stop-1-desktop");

  await button("Next").click();
  await page.waitForTimeout(800);
  await visible(
    page.getByText("Mend's reading of the code. Nothing in the session backs this up."),
  ).waitFor();
  note(
    "stop 2 of 4: Mend's reading, with 'Nothing in the session backs this up.' in place of links",
  );
  await both("stop-2-desktop");

  await button("Next").click();
  await page.waitForTimeout(800);
  if ((await tourNote().getAttribute("data-place")) !== "file")
    throw new Error("stop 3 isn't under its file's header");
  note("stop 3 of 4: a whole file: the note under charge.test.ts's header, the bar on the header");
  await both("stop-3-desktop");

  await button("Next").click();
  await page.waitForTimeout(800);
  if ((await tourNote().getAttribute("data-place")) !== "change")
    throw new Error("stop 4 isn't under the description");
  await button("Finish tour").waitFor();
  note("stop 4 of 4: no file: the note under the description, and Next reads 'Finish tour'");
  await both("stop-4-desktop");

  // And back, and from the rail.
  await button("Previous").click();
  await page.waitForTimeout(600);
  await visible(page.getByText(/^Tour · 3 of 4$/)).waitFor();
  await visible(page.getByRole("button", { name: /^The retry sends the same key/ })).click();
  await page.waitForTimeout(600);
  await visible(page.getByText(/^Tour · 1 of 4$/)).waitFor();
  note("Previous goes back to stop 3; picking stop 1 in the rail goes to it");

  // End tour: back where the person was.
  await button("End tour").click();
  await page.waitForTimeout(800);
  if ((await page.locator("[data-tour-note]").count()) !== 0)
    throw new Error("the note stayed after End tour");
  if (
    await visible(page.getByRole("heading", { name: "Tour" }))
      .isVisible()
      .catch(() => false)
  )
    throw new Error("the rail's Tour section stayed after End tour");
  const endedAt = await scrollTop();
  note(
    `End tour: the note and the rail's Tour section go; the diffs scroll back to ${endedAt}px (they were at ${startedAt}px)`,
  );
  await both("ended-desktop");

  // Finish tour from the last stop ends it too.
  await button("Start tour").click();
  for (let step = 0; step < 3; step += 1) {
    await button("Next").click();
    await page.waitForTimeout(400);
  }
  await button("Finish tour").click();
  await page.waitForTimeout(600);
  if ((await page.locator("[data-tour-note]").count()) !== 0)
    throw new Error("Finish tour left the note");
  note("Finish tour on stop 4 ends the tour the same way");

  // A link into the session opens its conversation.
  await button("Start tour").click();
  await visible(
    page.getByRole("link", { name: "Ran the payment tests: 200 of 200 passed" }),
  ).click();
  await page.waitForURL((url) => url.pathname === `/sessions/${small.id}`, { timeout: 30_000 });
  await page.waitForTimeout(800);
  const focused = await visible(page.locator(`[data-tab="session:${small.id}"]`))
    .getByRole("tab")
    .getAttribute("aria-selected");
  note(
    `a link into the session ('Ran the payment tests…') opens ${new URL(page.url()).pathname}; the session's conversation tab is focused: ${focused}`,
  );
  if (focused !== "true") throw new Error("the conversation tab isn't focused after a record link");

  // A later look: a file already viewed folds the description.
  await open(`/sessions/${small.id}/change`);
  await section("src/payments/retry.ts").waitFor({ timeout: 60_000 });
  await page.getByRole("checkbox", { name: "Viewed: README.md" }).first().click();
  await settled();
  await page.reload();
  await hydrated();
  await section("src/payments/retry.ts").waitFor({ timeout: 60_000 });
  await useFixture(ready);
  await button("Show more").waitFor({ timeout: 30_000 });
  note(
    "a later look (a file already viewed): the description folds to its first lines with Show more",
  );
  await both("later-look-desktop");
  await button("Show more").click();
  await visible(page.getByText("How the session got there")).waitFor();
  note("Show more unfolds it");
  await page.getByRole("checkbox", { name: "Viewed: README.md" }).first().click();
  await settled();

  // The other states, from fixtures.
  await useFixture({
    ...ready,
    tour: withBigints(tourAnswer({ changeId, sessionId: small.id, diffDigest: "0".repeat(64) })),
  });
  await visible(
    page.getByText(
      /^Mend wrote this from an earlier checkpoint\. The change is now at checkpoint \d+\.$/,
    ),
  ).waitFor({ timeout: 30_000 });
  await visible(page.getByText(/4 stops, from an earlier checkpoint/)).waitFor();
  note(
    "out of date (the tour's digest isn't this change's): 'Mend wrote this from an earlier checkpoint. The change is now at checkpoint N.' with Write again",
  );
  await both("out-of-date-desktop");

  await useFixture({ tour: { json: null, meta: { values: {}, v: 1 } }, passes: superjson([], []) });
  await button("Write description and tour").waitFor();
  note(
    "no description (the automation setting off, no pass yet): 'No description yet.' with Write description and tour",
  );
  await both("none-desktop");

  await useFixture({
    tour: { json: null, meta: { values: {}, v: 1 } },
    passes: passAnswer(changeId, "running"),
  });
  await visible(page.getByText("Mend is writing the description and tour.")).waitFor();
  await both("writing-desktop");

  await useFixture({
    tour: { json: null, meta: { values: {}, v: 1 } },
    passes: passAnswer(
      changeId,
      "failed",
      "No claude connected account matches this person; reconnect it.",
    ),
  });
  await visible(page.getByText(/Your Claude Code login needs connecting again\./)).waitFor();
  note(
    "a login failure reads: 'Mend couldn't write the description. Your Claude Code login needs connecting again. Run mend connect claude on your computer, then try again.' with Try again",
  );
  await both("failed-login-desktop");

  // The narrow tile beside the conversation.
  await useFixture(ready);
  await page.context().clearCookies({ name: "mend-tiles" });
  await open(`/sessions/${small.id}`);
  await visible(page.locator(`[data-tab="session:${small.id}"]`)).waitFor();
  await go(`/sessions/${small.id}/change`);
  await section("src/payments/retry.ts").waitFor({ timeout: 60_000 });
  await useFixture(ready);
  const tile = await boxOf(visible(page.locator("[data-tile]")));
  const tab = await boxOf(visible(page.locator('[data-tab="view:change"]')));
  await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2);
  await page.mouse.down();
  await page.mouse.move(tile.x + tile.width * 0.92, tile.y + tile.height * 0.5, { steps: 14 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(800);
  await visible(page.getByRole("button", { name: /^File \d+ of \d+: / })).waitFor();
  await button("Show more").waitFor({ timeout: 30_000 });
  note("narrow tile: the description folded with Show more, and the tour line");
  await both("narrow-first-look-desktop");
  await button("Start tour").click();
  await tourNote().waitFor();
  await page.waitForTimeout(800);
  if (
    await visible(page.getByRole("heading", { name: "Tour" }))
      .isVisible()
      .catch(() => false)
  )
    throw new Error("the narrow tile shows the rail");
  const picked = await visible(
    page.getByRole("button", { name: /^File \d+ of \d+: / }),
  ).getAttribute("aria-label");
  note(
    `narrow tile, stop 1: no rail, the note carries 'Tour · 1 of 4' and the buttons; the picker reads '${picked}'`,
  );
  await both("narrow-stop-1-desktop");
  await button("Next").click();
  await button("Next").click();
  await page.waitForTimeout(800);
  const pickedThird = await visible(
    page.getByRole("button", { name: /^File \d+ of \d+: / }),
  ).getAttribute("aria-label");
  note(`narrow tile, stop 3: the picker moved to the stop's file: '${pickedThird}'`);
  await both("narrow-stop-3-desktop");
  await button("End tour").click();
  await settled();

  // The phone.
  await page.setViewportSize(PHONE);
  await page.context().clearCookies({ name: "mend-tiles" });
  await open(`/sessions/${small.id}/change`);
  await section("src/payments/retry.ts").waitFor({ timeout: 60_000 });
  await useFixture(ready);
  await button("Show more").waitFor({ timeout: 30_000 });
  note("phone: the description folded with Show more, and Start tour at touch size");
  await both("first-look-phone");
  await button("Start tour").click();
  await tourNote().waitFor();
  await page.waitForTimeout(800);
  const nextHeight = (await boxOf(button("Next"))).height;
  note(
    `phone, stop 1: the note above its lines; Previous and Next are ${Math.round(nextHeight)}px tall`,
  );
  await both("stop-1-phone");
  await button("Next").click();
  await button("Next").click();
  await button("Next").click();
  await page.waitForTimeout(800);
  await both("stop-4-phone");
  await button("Finish tour").click();
  await settled();
  await useFixture({
    ...ready,
    tour: withBigints(tourAnswer({ changeId, sessionId: small.id, diffDigest: "0".repeat(64) })),
  });
  await button("Write again").waitFor({ timeout: 30_000 });
  await both("out-of-date-phone");
  await useFixture({
    tour: { json: null, meta: { values: {}, v: 1 } },
    passes: passAnswer(
      changeId,
      "failed",
      "No claude connected account matches this person; reconnect it.",
    ),
  });
  await visible(page.getByText(/Your Claude Code login needs connecting again\./)).waitFor();
  await both("failed-phone");
  await useFixture({ tour: { json: null, meta: { values: {}, v: 1 } }, passes: superjson([], []) });
  await button("Write description and tour").waitFor();
  await both("none-phone");
  await useFixture({
    tour: { json: null, meta: { values: {}, v: 1 } },
    passes: passAnswer(changeId, "queued"),
  });
  await visible(page.getByText("Mend is writing the description and tour.")).waitFor();
  await both("writing-phone");
  await page.setViewportSize(DESKTOP);
  fixture = null;
};
