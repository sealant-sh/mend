import type { PairingDto } from "#/lib/api";

/**
 * Pairing a phone: the machine mints a short-lived code, the phone reads it —
 * from the QR, or typed by hand — and trades it for a token of its own. The
 * code and the URL sit beside the QR because a camera is a convenience, not a
 * requirement.
 *
 * The calls themselves live in #/lib/api, and the device list is the
 * devices.list query — settings and the first-run checklist read the same cache.
 */

/** What the QR encodes. The phone opens it; nothing else reads it. */
export const pairingPayload = (baseUrl: string, code: string): string =>
  `mend://pair?u=${encodeURIComponent(baseUrl)}&c=${code}`;

/** Configured public URLs for the phone, in the server's preferred order. */
export const pairingUrls = (pairing: PairingDto): ReadonlyArray<string> => [
  ...new Set(pairing.urls),
];

/** "ABCDEFGH" → "ABCD-EFGH", the shape the code is read aloud in. */
export const groupCode = (code: string): string =>
  code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;

/**
 * The QR as inline SVG so it inherits the surrounding ink: the renderer's black
 * becomes `currentColor`, and the light module is fully transparent.
 */
export const renderPairingSvg = async (payload: string): Promise<string> => {
  const { toString: toQrString } = await import("qrcode");
  const svg = await toQrString(payload, {
    type: "svg",
    margin: 0,
    errorCorrectionLevel: "M",
    color: { dark: "#000000", light: "#0000" },
  });
  return svg.replaceAll('stroke="#000000"', 'stroke="currentColor"');
};

/** "9:41" while the moment is ahead, null once it has passed. */
export const countdown = (expiresAt: string, nowSeconds: number): string | null => {
  const remaining = Math.floor(new Date(expiresAt).getTime() / 1000) - nowSeconds;
  if (remaining <= 0) return null;
  return `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
};

/** "12 Aug 2026" — the day a device was paired. */
export const formatDay = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const RELATIVE_UNITS = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
] as const;

/** "4 minutes ago", or "never" for a device that has not called back yet. */
export const formatLastUsed = (iso: string | null, nowSeconds: number): string => {
  if (iso === null) return "never";
  const seconds = nowSeconds - Math.floor(new Date(iso).getTime() / 1000);
  for (const [unit, size] of RELATIVE_UNITS) {
    if (seconds >= size) return relativeTime.format(-Math.floor(seconds / size), unit);
  }
  return "just now";
};
