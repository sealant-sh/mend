import { redactDetail } from "@mend/network";

/**
 * What a client's error event may carry when it leaves the device (SLNT-1349's privacy rules): the
 * exception's type, its message with secrets and paths taken out, a stack trace whose frames name
 * files only inside the app, the release, and the trace the error happened in. Everything else the
 * SDK would gather goes: the request, the user, the machine's name, breadcrumbs, extra data,
 * modules, source lines read off disk.
 *
 * The event is scrubbed in place, as Sentry's `beforeSend` expects, and only the fields it can
 * hold are typed here, so each SDK's own event type passes through unchanged.
 */
export interface ScrubbedEvent {
  exception?: { values?: ExceptionValue[] | undefined } | undefined;
  message?: string | undefined;
  contexts?: Record<string, unknown> | undefined;
  debug_meta?: { images?: DebugImage[] | undefined } | undefined;
}

interface ExceptionValue {
  value?: string | undefined;
  mechanism?: object | undefined;
  stacktrace?: { frames?: StackFrame[] | undefined } | undefined;
}

interface StackFrame {
  filename?: string | undefined;
  abs_path?: string | undefined;
}

interface DebugImage {
  code_file?: string | undefined;
}

/** Where a stack frame's file is, told apart so only the app's own files keep a name. */
export interface PathRules {
  /** The directory the app runs from, absolute. A frame under it reads `app:///<path inside>`. */
  readonly appRoot: string | null;
  /** The person's home directory. Any other frame under it reads `~/…`. */
  readonly homeDir: string | null;
}

const EVENT_FIELDS: ReadonlySet<string> = new Set([
  "event_id",
  "timestamp",
  "platform",
  "level",
  "logger",
  "release",
  "dist",
  "environment",
  "exception",
  "message",
  "contexts",
  "tags",
  "sdk",
  "fingerprint",
  "debug_meta",
]);
const CONTEXTS: ReadonlySet<string> = new Set(["trace", "runtime", "os", "app"]);
const TRACE_FIELDS: ReadonlySet<string> = new Set(["trace_id", "span_id", "parent_span_id"]);
const EXCEPTION_FIELDS: ReadonlySet<string> = new Set(["type", "value", "mechanism", "stacktrace"]);
const MECHANISM_FIELDS: ReadonlySet<string> = new Set([
  "type",
  "handled",
  "synthetic",
  "source",
  "exception_id",
  "parent_id",
  "is_exception_group",
]);
const FRAME_FIELDS: ReadonlySet<string> = new Set([
  "filename",
  "abs_path",
  "function",
  "lineno",
  "colno",
  "in_app",
  "platform",
  "instruction_addr",
  "addr_mode",
]);
const IMAGE_FIELDS: ReadonlySet<string> = new Set(["type", "code_file", "debug_id"]);

/** Removes every own key of `value` that `kept` does not name. */
const keepOnly = (value: object, kept: ReadonlySet<string>): void => {
  for (const key of Object.keys(value)) if (!kept.has(key)) Reflect.deleteProperty(value, key);
};

/** A home directory named by the platform's convention, when the real one is not known. */
const ANY_HOME = /^(?:\/(?:home|Users)\/[^/]+|\/root|[A-Za-z]:\\Users\\[^\\]+)(?=[\\/]|$)/;

const withoutFileScheme = (path: string): string => {
  if (!path.startsWith("file://")) return path;
  const rest = path.slice("file://".length);
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
};

const under = (path: string, directory: string): string | null => {
  const root = directory.replace(/[\\/]+$/, "");
  if (root === "" || !path.startsWith(root)) return null;
  const rest = path.slice(root.length);
  if (rest !== "" && rest[0] !== "/" && rest[0] !== "\\") return null;
  return rest.replace(/^[\\/]+/, "").replaceAll("\\", "/");
};

/**
 * A stack frame's file as it may leave the device: inside the app it is `app:///<path>`, the name
 * the release's source maps are uploaded under; in a home directory it starts `~`; anything else
 * (`node:internal/…`, a system path) is unchanged.
 */
export const scrubPath = (path: string, rules: PathRules): string => {
  const plain = withoutFileScheme(path);
  const inApp = rules.appRoot === null ? null : under(plain, rules.appRoot);
  if (inApp !== null) return `app:///${inApp}`;
  const inHome = rules.homeDir === null ? null : under(plain, rules.homeDir);
  if (inHome !== null) return inHome === "" ? "~" : `~/${inHome}`;
  return plain.replace(ANY_HOME, "~");
};

const scrubFrames = (frames: readonly StackFrame[], rules: PathRules): void => {
  for (const frame of frames) {
    keepOnly(frame, FRAME_FIELDS);
    if (frame.filename !== undefined) frame.filename = scrubPath(frame.filename, rules);
    if (frame.abs_path !== undefined) frame.abs_path = scrubPath(frame.abs_path, rules);
  }
};

const scrubContexts = (contexts: Record<string, unknown>): void => {
  keepOnly(contexts, CONTEXTS);
  const trace = contexts["trace"];
  if (typeof trace === "object" && trace !== null) keepOnly(trace, TRACE_FIELDS);
};

/** Scrubs `event` in place and returns it, for `beforeSend`. */
export const scrubEvent = <E extends ScrubbedEvent>(event: E, rules: PathRules): E => {
  keepOnly(event, EVENT_FIELDS);
  for (const exception of event.exception?.values ?? []) {
    keepOnly(exception, EXCEPTION_FIELDS);
    // An exception's words are written for whoever reads the terminal, and quote what they were
    // given: URLs, paths, tokens. Trace and span IDs never pass through here (CONTRACT.md).
    if (exception.value !== undefined) exception.value = redactDetail(exception.value);
    if (exception.mechanism !== undefined) keepOnly(exception.mechanism, MECHANISM_FIELDS);
    if (exception.stacktrace !== undefined) {
      keepOnly(exception.stacktrace, new Set(["frames"]));
      scrubFrames(exception.stacktrace.frames ?? [], rules);
    }
  }
  if (event.message !== undefined) event.message = redactDetail(event.message);
  if (event.contexts !== undefined) scrubContexts(event.contexts);
  if (event.debug_meta !== undefined) keepOnly(event.debug_meta, new Set(["images"]));
  for (const image of event.debug_meta?.images ?? []) {
    keepOnly(image, IMAGE_FIELDS);
    if (image.code_file !== undefined) image.code_file = scrubPath(image.code_file, rules);
  }
  return event;
};
