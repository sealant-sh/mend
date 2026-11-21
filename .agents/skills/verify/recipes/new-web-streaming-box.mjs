// How a streamed reply appears in the conversation, measured on the box with real Codex turns
// (SLNT-1231). Run it as the verify skill's section 9 says, under your own hold, and stop the
// session it starts before release:
//
//   STREAM_OUT=<an empty scratch folder> pnpm verify drive new-web --box --recipe new-web-streaming-box
//
// The drive signs in as the box's checker account. The recipe starts one Codex session in
// verify-fixture from the New session composer, warms it with a one-word turn, then records long
// replies as they stream:
//
// - every animation frame, how much of the reply's text is on screen, where the thread is
//   scrolled, how many nodes the frame added or removed, and every long animation frame;
// - when each read of the session's items answered;
// - a screencast of the page, frame by frame, to make a recording from.
//
// Turn 2 streams as this machine sees it; turn 3 with 100ms more latency on every request, as
// for someone reading from far away; in turn 4 the reader scrolls up mid-reply, stays where they
// scrolled, then scrolls back to the end and follows again. The samples, the reads and the frames
// go to STREAM_OUT (a fresh temporary folder when unset), never into the drive's evidence; the
// notes say what each turn showed.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DESKTOP = { width: 1280, height: 900 };
const TURN_MS = 600_000;
const LONG = (topic) =>
  `Without running any commands or reading any files, write a reply of about 500 words explaining ${topic}. Use two headings, a bulleted list of five items, one fenced TypeScript code block of about 15 lines, and finish with a short paragraph.`;

/** The one of a locator's matches a person sees: the desktop and phone layouts are both in the page. */
const visible = (locator) => locator.filter({ visible: true }).first();

/** Starts sampling, in the page, the reply of turn `ordinal` (counted from 1, as the header reads). */
const startSampling = (ordinal) => {
  const viewport = [...document.querySelectorAll('[data-slot="message-scroller-viewport"]')].find(
    (each) => each.getClientRects().length > 0,
  );
  const state = { samples: [], frames: [], adds: 0, removes: 0, chars: 0, running: true };
  window.__stream = state;
  const header = `Codex · turn ${ordinal}`;
  const reply = () => {
    for (const each of viewport.querySelectorAll('[data-slot="message-header"]'))
      if (each.textContent?.startsWith(header))
        return each.closest('[data-slot="message-content"]');
    return null;
  };
  const watch = new MutationObserver((records) => {
    for (const record of records) {
      state.adds += record.addedNodes.length;
      state.removes += record.removedNodes.length;
      if (record.type === "characterData") state.chars += 1;
    }
  });
  watch.observe(viewport, { childList: true, characterData: true, subtree: true });
  if (PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) {
    const long = new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        state.frames.push({
          at: Math.round(entry.startTime),
          ms: Math.round(entry.duration),
          blocking: Math.round(entry.blockingDuration ?? 0),
        });
    });
    long.observe({ type: "long-animation-frame" });
    state.stopLong = () => long.disconnect();
  }
  const tick = (now) => {
    if (!state.running) return;
    const message = reply();
    const text = message?.textContent ?? "";
    state.samples.push({
      t: Math.round(now * 10) / 10,
      len: Math.max(0, text.length - header.length),
      top: Math.round(viewport.scrollTop),
      fromEnd: Math.round(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop),
      height: Math.round(message?.getBoundingClientRect().height ?? 0),
      adds: state.adds,
      removes: state.removes,
      chars: state.chars,
    });
    state.adds = 0;
    state.removes = 0;
    state.chars = 0;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  state.stop = () => {
    state.running = false;
    watch.disconnect();
    state.stopLong?.();
  };
};

const stopSampling = () => {
  const state = window.__stream;
  state.stop();
  return { samples: state.samples, frames: state.frames, origin: performance.timeOrigin };
};

/** What a turn's samples say, in numbers a note can carry. */
const summary = (samples) => {
  const grew = [];
  for (let at = 1; at < samples.length; at += 1) {
    const step = samples[at].len - samples[at - 1].len;
    if (step > 0) grew.push({ t: samples[at].t, step });
  }
  if (grew.length < 2) return { updates: grew.length };
  const steps = grew.map((each) => each.step).sort((a, b) => a - b);
  const gaps = grew
    .slice(1)
    .map((each, at) => each.t - grew[at].t)
    .sort((a, b) => a - b);
  const pick = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  const span = grew.at(-1).t - grew[0].t;
  return {
    chars: samples.at(-1).len,
    updates: grew.length,
    framesInSpan: samples.filter((each) => each.t >= grew[0].t && each.t <= grew.at(-1).t).length,
    spanMs: Math.round(span),
    stepChars: { median: pick(steps, 0.5), p90: pick(steps, 0.9), max: steps.at(-1) },
    gapMs: {
      median: Math.round(pick(gaps, 0.5)),
      p90: Math.round(pick(gaps, 0.9)),
      max: Math.round(gaps.at(-1)),
    },
  };
};

export default async ({ page, web, note }) => {
  const out = process.env.STREAM_OUT ?? mkdtempSync(join(tmpdir(), "mend-streaming-"));
  mkdirSync(out, { recursive: true });
  note(`samples, reads and screencast frames go outside the evidence, to ${out}`);
  const field = () => visible(page.getByRole("textbox", { name: "Message Codex" }));
  const stopTurn = () => visible(page.getByRole("button", { name: "Stop turn" }));
  const turnOver = () => stopTurn().waitFor({ state: "hidden", timeout: TURN_MS });
  const cdp = await page.context().newCDPSession(page);

  await page.setViewportSize(DESKTOP);
  await page.goto(`${web}/`);
  await visible(page.getByRole("heading", { name: "New session", exact: true })).waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some((button) =>
      Object.keys(button).some((key) => key.startsWith("__reactProps")),
    ),
  );
  const pick = (name) => visible(page.getByRole("button", { name }));
  await pick(/^Project: /).click();
  await page.getByPlaceholder("Find a project").fill("verify-fixture");
  await page
    .getByRole("option", { name: /^verify-fixture/ })
    .first()
    .click();
  await pick(/^Agent and model: /).click();
  await page.getByRole("menuitemradio", { name: /^Codex/ }).click();
  await page.keyboard.press("Escape").catch(() => undefined);
  await visible(page.getByRole("textbox", { name: "Task" })).fill(
    "Reply with the single word ready.",
  );
  await visible(page.getByRole("button", { name: "Start session" })).click();
  await page.waitForURL(/\/sessions\/[0-9a-f-]+$/, { timeout: 120_000 });
  const id = new URL(page.url()).pathname.split("/").at(-1);
  note(`started session ${id}; stop it with the checker CLI before release`);
  await visible(page.getByText("Codex · turn 1", { exact: true })).waitFor({ timeout: TURN_MS });
  await field().waitFor({ timeout: TURN_MS });
  await stopTurn()
    .waitFor({ timeout: 60_000 })
    .catch(() => undefined);
  await turnOver();
  await page.waitForTimeout(1_000);

  /** One long turn, recorded: samples, reads and screencast frames under `label`. */
  const record = async (ordinal, label, { during } = {}) => {
    const frames = join(out, label);
    mkdirSync(frames, { recursive: true });
    const shots = [];
    const onFrame = ({ data, metadata, sessionId }) => {
      const name = `${String(shots.length).padStart(5, "0")}.jpg`;
      writeFileSync(join(frames, name), Buffer.from(data, "base64"));
      shots.push({ name, at: metadata.timestamp });
      void cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
    };
    cdp.on("Page.screencastFrame", onFrame);
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 });
    const reads = [];
    const onResponse = (response) => {
      if (response.url().includes("sessions.items")) reads.push(Date.now());
    };
    page.on("response", onResponse);
    await page.evaluate(startSampling, ordinal);
    await field().fill(
      LONG(label === "remote" ? "how a B-tree index works" : "how a hash map works"),
    );
    await page.keyboard.press("Enter");
    await visible(page.getByText(`Codex · turn ${ordinal}`, { exact: true })).waitFor({
      timeout: TURN_MS,
    });
    await stopTurn().waitFor({ timeout: TURN_MS });
    const viewport = visible(page.locator('[data-slot="message-scroller-viewport"]'));
    const box = await viewport.boundingBox();
    const scrolling = during === undefined ? null : during(viewport);
    await page.waitForTimeout(2_000);
    await turnOver();
    // The reveal may still be catching up with the last words after the turn ends.
    await page.waitForTimeout(4_000);
    const scrolled = scrolling === null ? null : await scrolling;
    const taken = await page.evaluate(stopSampling);
    page.off("response", onResponse);
    await cdp.send("Page.stopScreencast");
    cdp.off("Page.screencastFrame", onFrame);
    const result = {
      ...taken,
      reads: reads.map((at) => Math.round(at - taken.origin)),
      shots,
      viewport: box,
      scrolled,
    };
    writeFileSync(join(out, `${label}.json`), JSON.stringify(result));
    const long = taken.frames.filter((each) => each.ms >= 50);
    note(
      `turn ${ordinal} (${label}): ${JSON.stringify(summary(taken.samples))}; ${reads.length} item reads; ${long.length} animation frames of 50ms or more (worst ${Math.max(0, ...long.map((each) => each.ms))}ms); ${shots.length} screencast frames`,
    );
    return result;
  };

  await record(2, "local");

  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 100,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await record(3, "remote");
  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });

  // The reader scrolls up mid-reply: the thread stays where they put it while the reply grows,
  // then follows again once they are back at the end.
  const scrollTest = async (viewport) => {
    await page.waitForFunction(() => (window.__stream?.samples.at(-1)?.len ?? 0) > 600, null, {
      timeout: TURN_MS,
    });
    const box = await viewport.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(400);
    const read = () =>
      viewport.evaluate((each) => ({
        top: Math.round(each.scrollTop),
        fromEnd: Math.round(each.scrollHeight - each.clientHeight - each.scrollTop),
      }));
    const up = await read();
    await page.waitForTimeout(3_000);
    const later = await read();
    await page.mouse.wheel(0, 100_000);
    await page.waitForTimeout(600);
    const back = await read();
    await page.waitForTimeout(3_000);
    const following = await read();
    return { up, later, back, following };
  };
  const turn4 = await record(4, "scroll", { during: scrollTest });
  const s = turn4.scrolled;
  note(
    `turn 4: scrolled up to ${s.up.top} (${s.up.fromEnd}px from the end); 3s later at ${s.later.top} (${s.later.fromEnd}px from the end); back at the end ${s.back.fromEnd}px from it, and 3s later ${s.following.fromEnd}px from it`,
  );
};
