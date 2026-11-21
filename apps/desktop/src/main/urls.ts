/**
 * URL validation, origin matching, and external-link allowlisting for the Electron shell.
 */

export type NormalizedServerUrl =
  | { readonly ok: true; readonly url: string; readonly origin: string }
  | { readonly ok: false; readonly reason: string };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const ALLOWED_EXTERNAL_PROTOCOLS = new Set([
  "http:",
  "https:",
  "vscode:",
  "vscode-insiders:",
  "cursor:",
  "mailto:",
]);

// Matches an explicit URI scheme (`http://…`, `file:///…`, `javascript:…`), but treats
// `host:3115` / `localhost:3115/path` as a bare host + port rather than a scheme.
const hasExplicitScheme = (value: string): boolean => {
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:(.*)$/.exec(value);
  if (match === null) return false;
  const rest = match[1] ?? "";
  return !/^\d{1,5}($|\/)/.test(rest);
};

const isLoopbackHost = (candidate: string): boolean => {
  const hostPart = candidate.split("/")[0] ?? "";
  const hostname = hostPart.startsWith("[")
    ? hostPart.slice(0, hostPart.indexOf("]") + 1)
    : (hostPart.split(":")[0] ?? "");
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
};

/**
 * Parse and normalize a Mend server address typed by a person or read from config. Bare hostnames
 * default to `http://` for loopback and `https://` otherwise; non-HTTP(S) schemes are refused.
 */
export const normalizeServerUrl = (raw: string): NormalizedServerUrl => {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: false, reason: "Enter a Mend server address." };
  }

  let candidate = trimmed;
  if (!hasExplicitScheme(candidate)) {
    candidate = `${isLoopbackHost(candidate) ? "http" : "https"}://${candidate}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return {
      ok: false,
      reason: "That doesn't look like a valid server address. Example: https://mend.example.com",
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: "Mend server addresses must start with http:// or https://.",
    };
  }

  if (parsed.hostname === "") {
    return {
      ok: false,
      reason: "Enter a hostname for your Mend server.",
    };
  }

  if (parsed.username !== "" || parsed.password !== "") {
    return {
      ok: false,
      reason: "Leave credentials out of the server address. You'll sign in on the server.",
    };
  }

  const pathname = parsed.pathname.replace(/\/+$/, "");
  const normalized = pathname === "" ? parsed.origin : `${parsed.origin}${pathname}`;
  return { ok: true, url: normalized, origin: parsed.origin };
};

/** True when `candidate` parses as an HTTP(S) URL with the exact same origin as `targetOrigin`. */
export const isSameOrigin = (candidate: string, targetOrigin: string): boolean => {
  try {
    const parsed = new URL(candidate);
    const target = new URL(targetOrigin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.origin === target.origin
    );
  } catch {
    return false;
  }
};

/**
 * Allowlist for URLs leaving Electron into the OS via `shell.openExternal`. Covers web links,
 * VS Code / Cursor workspace URIs (`vscode://sealant-sh.mend/open?session=…`), and `mailto:`.
 */
export const isAllowedExternalUrl = (raw: string): boolean => {
  try {
    const parsed = new URL(raw);
    return ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
};

/**
 * True when `frameUrl` is the local shell document (either Vite's dev URL or the packaged
 * `file://` renderer directory).
 */
export const isLocalShellUrl = (
  frameUrl: string,
  options: { readonly devRendererUrl: string | undefined; readonly prodRendererDirUrl: string },
): boolean => {
  if (options.devRendererUrl !== undefined) {
    return isSameOrigin(frameUrl, options.devRendererUrl);
  }
  return frameUrl.startsWith(options.prodRendererDirUrl);
};
