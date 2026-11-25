import type { AnyRouter } from "@tanstack/react-router";

import { type BrowserTelemetry, pageTelemetry } from "./telemetry-config.ts";

/**
 * What the app reports to Sentry, and the one door to it (SLNT-1349). The SDK is its own chunk,
 * fetched only on a page served with a DSN (`telemetry-config.ts`): a page without one loads none
 * of it and sends nothing. Everything here is a no-op on the server and when telemetry is off.
 */

type Reporter = typeof import("./telemetry-sentry.ts");

let reporter: Reporter | null = null;
let started = false;

/** Errors caught before the SDK arrived: reported when it does, the first few only. */
const early: Array<unknown> = [];
const EARLY_LIMIT = 10;

const load = async (telemetry: BrowserTelemetry, router: AnyRouter): Promise<void> => {
  try {
    const loaded = await import("./telemetry-sentry.ts");
    loaded.start(telemetry, router);
    reporter = loaded;
    for (const error of early.splice(0)) loaded.reportCaught(error);
  } catch {
    // A chunk that does not load leaves the page as it was: reporting is never in the way.
    early.length = 0;
  }
};

/** Start reporting for this page, once, if it was served with a DSN. */
export const startTelemetry = (router: AnyRouter): void => {
  const telemetry = pageTelemetry();
  if (telemetry === null || started) return;
  started = true;
  void load(telemetry, router);
};

/**
 * Report an error a boundary caught (a route's error screen, a tab's or a session's), which
 * React hands to no page-wide handler. A refusal or failure Mend's server answered with is
 * reported there, with its cause, and not again here.
 */
export const reportCaught = (error: unknown): void => {
  if (reporter !== null) reporter.reportCaught(error);
  else if (started && early.length < EARLY_LIMIT) early.push(error);
};
