import { homedir } from "node:os";

import {
  applySdkMetadata,
  createStackParser,
  createTransport,
  dedupeIntegration,
  linkedErrorsIntegration,
  Scope,
  type BaseTransportOptions,
  type DataCollection,
  type Transport,
} from "@sentry/core";
import {
  nodeStackLineParser,
  ServerRuntimeClient,
  type ServerRuntimeClientOptions,
} from "@sentry/core/server";

import type { ErrorReporter, NodeReporterOptions } from "./node.ts";
import { scrubEvent, type PathRules } from "./scrub.ts";

/** Nothing about a request, a user or a frame's variables is collected (CONTRACT.md, Privacy). */
const NO_DATA: DataCollection = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  stackFrameVariables: false,
  frameContextLines: 0,
  databaseQueryData: false,
  queues: false,
  genAI: { inputs: false, outputs: false },
  mcp: { inputs: false, outputs: false },
  graphQL: { document: false, variables: false },
};

/** One report waits this long for Sentry before it is dropped. */
const SEND_TIMEOUT_MS = 5_000;
/** Reports in flight at once; more are dropped, so a failure loop never queues without end. */
const IN_FLIGHT = 30;

/**
 * Sends each envelope with the runtime's fetch, once. A refusal or a network failure drops it:
 * reporting must never slow the app or retry behind its back.
 */
const fetchTransport = (options: BaseTransportOptions): Transport =>
  createTransport({ ...options, bufferSize: IN_FLIGHT }, async (request) => {
    const response = await fetch(options.url, {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope", ...options.headers },
      // A binary envelope is copied into its own ArrayBuffer, the only kind fetch's types take.
      body: typeof request.body === "string" ? request.body : new Uint8Array(request.body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return {
      statusCode: response.status,
      headers: {
        "x-sentry-rate-limits": response.headers.get("x-sentry-rate-limits"),
        "retry-after": response.headers.get("retry-after"),
      },
    };
  });

export const makeNodeErrorReporter = (options: NodeReporterOptions): ErrorReporter => {
  const rules: PathRules = { appRoot: options.appRoot, homeDir: homedir() };
  const clientOptions: ServerRuntimeClientOptions = {
    dsn: options.settings.dsn,
    release: options.settings.release,
    environment: options.settings.environment,
    transport: fetchTransport,
    stackParser: createStackParser(nodeStackLineParser()),
    // The cause chain, and one report for an error handed over twice. Nothing that patches a
    // global: no console, http or process integration.
    integrations: [linkedErrorsIntegration(), dedupeIntegration()],
    platform: "node",
    runtime: { name: "node", version: process.version },
    dataCollection: NO_DATA,
    maxBreadcrumbs: 0,
    sendClientReports: false,
    // Errors only: these clients send no spans (tracing in them is a later ticket).
    traceLifecycle: "static",
    beforeBreadcrumb: () => null,
    beforeSend: (event) => scrubEvent(event, rules),
  };
  // Without it an event arrives with no SDK name or version, which Sentry reports as an error.
  applySdkMetadata(clientOptions, "node");
  const client = new ServerRuntimeClient(clientOptions);
  client.init();
  const scope = new Scope();
  scope.setClient(client);
  scope.setTags({ ...options.tags, "os.platform": process.platform, "os.arch": process.arch });
  return {
    report: (error) => {
      try {
        scope.captureException(error);
      } catch {
        // A report that cannot be made is not the app's failure.
      }
    },
    flush: async (timeoutMs) => {
      try {
        return await client.flush(timeoutMs);
      } catch {
        return false;
      }
    },
  };
};
