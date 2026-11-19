/**
 * The pairing code's QR, drawn in the browser: a phone scans it, and nothing else reads it. Black
 * on white whatever the theme, since a camera reads dark modules on a light ground best. Loaded
 * only when a code is shown.
 */
export const pairingQrUrl = async (payload: string): Promise<string> => {
  const { toString: toQrString } = await import("qrcode");
  const svg = await toQrString(payload, {
    type: "svg",
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#000000", light: "#ffffff" },
  });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
};
