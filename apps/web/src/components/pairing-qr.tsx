import { useState, useSyncExternalStore } from "react";

import type { MintedDeviceDto, PairingDto } from "#/lib/api";

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

const subscribeToSeconds = (onStoreChange: () => void) => {
  const timer = setInterval(onStoreChange, 1000);
  return () => clearInterval(timer);
};

const secondsNow = () => Math.floor(Date.now() / 1000);

/** One shared once-a-second tick — the only thing a countdown needs. */
export const useSecondTick = (): number =>
  useSyncExternalStore(subscribeToSeconds, secondsNow, secondsNow);

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

export function PairingQr({
  pairing,
  initialSvg,
  onDismiss,
}: {
  readonly pairing: PairingDto;
  readonly initialSvg: string;
  readonly onDismiss: () => void;
}) {
  const urls = pairingUrls(pairing);
  const [choice, setChoice] = useState({ url: urls[0] ?? "", svg: initialSvg });
  const [error, setError] = useState<string | null>(null);
  const remaining = countdown(pairing.expiresAt, useSecondTick());

  const pick = (url: string) => {
    setError(null);
    void renderPairingSvg(pairingPayload(url, pairing.code))
      .then((svg) => setChoice({ url, svg }))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  return (
    <div className="mt-5 border-t border-[var(--sw-faint-rule)] pt-5">
      <div className="flex flex-wrap items-start gap-6">
        <div
          className="w-[200px] shrink-0 rounded-lg bg-sunken p-4 text-foreground [&>svg]:h-auto [&>svg]:w-full"
          aria-hidden="true"
          // The markup is this page's own render of the payload below it.
          dangerouslySetInnerHTML={{ __html: choice.svg }}
        />
        <div className="min-w-0 flex-1 space-y-4">
          <div>
            <p className="font-mono text-[12px] text-label">code</p>
            <p className="mt-1 font-mono text-[19px] tracking-[0.08em] text-foreground">
              {groupCode(pairing.code)}
            </p>
          </div>
          <div>
            <p className="font-mono text-[12px] text-label">url</p>
            {urls.length > 1 ? (
              <select
                value={choice.url}
                onChange={(event) => pick(event.target.value)}
                className="mt-1 w-full max-w-[36ch] rounded-lg border border-border bg-card px-2.5 py-1.5 font-mono text-[12.5px] text-foreground shadow-xs outline-none focus:border-input"
              >
                {urls.map((url) => (
                  <option key={url} value={url}>
                    {url}
                  </option>
                ))}
              </select>
            ) : (
              <p className="mt-1 font-mono text-[12.5px] break-all text-ink-2">{choice.url}</p>
            )}
          </div>
          <p className="font-mono text-[12px] text-label">
            {remaining === null ? "expired" : `expires in ${remaining}`}
          </p>
          <p className="max-w-[52ch] text-[13px] leading-relaxed text-muted-foreground">
            The QR encodes{" "}
            <span className="font-mono text-[12px] break-all text-ink-2">
              {pairingPayload(choice.url, pairing.code)}
            </span>
            . A phone that cannot scan can take the URL and the code by hand. The code works once.
          </p>
          {error === null ? null : (
            <p className="font-mono text-[12.5px] text-warning" role="alert">
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={onDismiss}
            className="font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * A token minted by hand, shown once. The device that cannot scan — an App
 * Review tester, a headless box — takes the URL and this token into the app's
 * Settings → Advanced. Mend keeps only the hash, so closing this loses it.
 */
export function MintedToken({
  minted,
  onDismiss,
}: {
  readonly minted: MintedDeviceDto;
  readonly onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(minted.token).then(() => setCopied(true));
  };
  return (
    <div className="mt-5 border-t border-[var(--sw-faint-rule)] pt-5">
      <div className="min-w-0 space-y-4">
        <div>
          <p className="font-mono text-[12px] text-label">device</p>
          <p className="mt-1 font-sans text-sm font-medium text-foreground">{minted.device.name}</p>
        </div>
        <div>
          <p className="font-mono text-[12px] text-label">url</p>
          {minted.urls.length === 0 ? (
            <p className="mt-1 font-mono text-[12.5px] text-ink-2">
              no public origin configured · use the address this page is open at
            </p>
          ) : (
            minted.urls.map((url) => (
              <p key={url} className="mt-1 font-mono text-[12.5px] break-all text-ink-2">
                {url}
              </p>
            ))
          )}
        </div>
        <div>
          <p className="font-mono text-[12px] text-label">token · shown once</p>
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <p className="font-mono text-[12.5px] break-all text-foreground select-all">
              {minted.token}
            </p>
            <button
              type="button"
              onClick={copy}
              className="shrink-0 font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
        <p className="max-w-[52ch] text-[13px] leading-relaxed text-muted-foreground">
          In the app: Settings → Advanced → server URL and bearer token. Mend keeps only the hash of
          this token; once this panel closes it cannot be shown again. Revoke the device to end it.
        </p>
        <button
          type="button"
          onClick={onDismiss}
          className="font-sans text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          Done
        </button>
      </div>
    </div>
  );
}
