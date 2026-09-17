// The pairing code and the QR payload, as pure string handling. Kept apart
// from pairing.ts so it carries no expo or react-native import and can be
// tested directly.

export const CODE_LENGTH = 8;

export interface PairPayload {
  /** A base URL this phone can reach, no trailing slash. */
  readonly url: string;
  /** Normalized: uppercase, dashes stripped. */
  readonly code: string;
}

/** Uppercase, dashes and spaces dropped — how the machine compares it. */
export const normalizeCode = (raw: string): string =>
  raw
    .toUpperCase()
    .replaceAll(/[^0-9A-Z]/g, "")
    .slice(0, CODE_LENGTH);

/** How the machine shows it: ABCD-EFGH. */
export const formatCode = (raw: string): string => {
  const code = normalizeCode(raw);
  return code.length > 4 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
};

export const codeIsComplete = (raw: string): boolean => normalizeCode(raw).length === CODE_LENGTH;

/** Trailing slash off, bare host assumed http — the machine serves plain. */
export const normalizeBaseUrl = (raw: string): string => {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed === "") return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
};

/**
 * The QR payload: mend://pair?u=<encoded base url>&c=<code>. Anything else
 * is somebody's Wi-Fi or a URL — rejected, not guessed at.
 */
export const parsePairUrl = (raw: string): PairPayload | null => {
  const trimmed = raw.trim();
  const prefix = "mend://pair?";
  if (!trimmed.toLowerCase().startsWith(prefix)) return null;
  let url = "";
  let code = "";
  for (const part of trimmed.slice(prefix.length).split("&")) {
    const split = part.indexOf("=");
    if (split === -1) continue;
    const key = part.slice(0, split);
    let value: string;
    try {
      value = decodeURIComponent(part.slice(split + 1));
    } catch {
      return null;
    }
    if (key === "u") url = value;
    if (key === "c") code = value;
  }
  const base = normalizeBaseUrl(url);
  const normalized = normalizeCode(code);
  if (base === "" || normalized.length !== CODE_LENGTH) return null;
  return { url: base, code: normalized };
};

/**
 * What a scan turned out to be. The installer prints a QR of the server URL
 * alone — before an account exists there is no code to encode — so a bare
 * http(s) URL is read as the address, not thrown away.
 */
export type ScannedQr =
  | { readonly kind: "pairing"; readonly payload: PairPayload }
  | { readonly kind: "server"; readonly url: string };

/**
 * The same payload, arriving as route params. `app.json` registers the `mend`
 * scheme, so the phone's own camera can open `mend://pair?u=…&c=…` and the
 * router hands `u` and `c` straight to the pairing screen — a scan from inside
 * the app and a scan from the camera app must mean the same thing.
 */
export const parsePairParams = (u: string | undefined, c: string | undefined): ScannedQr | null => {
  const url = normalizeBaseUrl(u ?? "");
  if (url === "") return null;
  const code = normalizeCode(c ?? "");
  return code.length === CODE_LENGTH
    ? { kind: "pairing", payload: { url, code } }
    : { kind: "server", url };
};

export const parseScanned = (raw: string): ScannedQr | null => {
  const payload = parsePairUrl(raw);
  if (payload !== null) return { kind: "pairing", payload };
  const trimmed = raw.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(trimmed)) return null;
  const url = normalizeBaseUrl(trimmed);
  return url === "" ? null : { kind: "server", url };
};
