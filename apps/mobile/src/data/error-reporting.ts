import { scrubEvent, type PathRules } from "@mend/client-errors";
import * as Sentry from "@sentry/react-native";
import Constants from "expo-constants";
import * as Updates from "expo-updates";

/**
 * The app's errors-only Sentry reporting (SLNT-1357), on only in a build given
 * `EXPO_PUBLIC_MEND_SENTRY_DSN` when it was bundled: no build carries a DSN by default, so an app
 * someone builds for their own Mend never reports to us.
 *
 * What it reports is what no code caught: a JavaScript error that reaches React Native's global
 * handler, and a native crash; an unhandled rejection is not (see `integrations`). Every JavaScript
 * report is scrubbed by `@mend/client-errors` before it leaves the phone; nothing about a request, a
 * person, the screen or what a session said is collected, and no session or performance data is
 * sent.
 */
const DSN = process.env["EXPO_PUBLIC_MEND_SENTRY_DSN"]?.trim() ?? "";
const ENVIRONMENT = process.env["EXPO_PUBLIC_MEND_SENTRY_ENVIRONMENT"]?.trim() ?? "";

/** The bundle's frames are already `app:///index.android.bundle`; only a path elsewhere is scrubbed. */
const PATHS: PathRules = { appRoot: null, homeDir: null };

/** Starts reporting, once, before the first screen. A no-op in a build with no DSN. */
export const startErrorReporting = (): void => {
  if (DSN === "") return;
  Sentry.init({
    dsn: DSN,
    environment: ENVIRONMENT === "" ? "development" : ENVIRONMENT,
    // The app's own version, as mend-cli@… names the CLI's. A release with `/` is refused.
    release: `mend-mobile@${Constants.expoConfig?.version ?? "unknown"}`,
    sendDefaultPii: false,
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    // Errors only: no release-health sessions, no tracing, no screenshots or view hierarchy.
    enableAutoSessionTracking: false,
    enableAutoPerformanceTracing: false,
    attachScreenshot: false,
    attachViewHierarchy: false,
    sendClientReports: false,
    // Uncaught errors only. With @sentry/react-native 7.11 on React Native 0.86, its tracker for
    // unhandled rejections crashed Hermes (SIGSEGV in a timer callback) on the first rejection, where
    // React Native's own tracker only warns; the app keeps React Native's.
    integrations: (defaults) =>
      defaults.map((integration) =>
        integration.name === "ReactNativeErrorHandlers"
          ? Sentry.reactNativeErrorHandlersIntegration({ onunhandledrejection: false })
          : integration,
      ),
    beforeSend: (event) => scrubEvent(event, PATHS),
  });
  // Which over-the-air update was running: the same version ships many bundles.
  Sentry.setTags({
    client: "mobile",
    "expo.update_id": Updates.updateId || "embedded",
    "expo.channel": Updates.channel || "none",
    "expo.runtime_version": Updates.runtimeVersion || "unknown",
  });
};
