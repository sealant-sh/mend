import { loadTerminalFontFamily, DEFAULT_TERMINAL_FONT_FAMILY } from "./surface";

// Browser-only fixture: load repository-pinned font bytes, never host-installed font names.
const run = async () => {
  const faces: Array<FontFace> = [];
  for (const [family, packageName] of [
    ["Audit Proportional", "inter"],
    ["Audit Monospace", "jetbrains-mono"],
  ] as const) {
    for (const style of ["normal", "italic"]) {
      for (const weight of ["400", "700"]) {
        const url = `/node_modules/@fontsource/${packageName}/files/${packageName}-latin-${weight}-${style}.woff2`;
        const face = new FontFace(family, `url(${url})`, { style, weight });
        document.fonts.add(await face.load());
        faces.push(face);
      }
    }
  }
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("Real browser canvas metrics are required");
  const widths = (family: string) => {
    context.font = `normal 400 32px "${family}"`;
    return { thin: context.measureText("i").width, wide: context.measureText("W").width };
  };
  const proportional = widths("Audit Proportional");
  const monospace = widths("Audit Monospace");
  const result = {
    loaded: faces.map((face) => face.status),
    proportional,
    monospace,
    proportionalIsMeasured: Math.abs(proportional.thin - proportional.wide) > 1,
    monospaceIsMeasured: monospace.thin > 0 && Math.abs(monospace.thin - monospace.wide) < 0.00001,
    rejected:
      (await loadTerminalFontFamily("Audit Proportional", 12)) === DEFAULT_TERMINAL_FONT_FAMILY,
    accepted: (await loadTerminalFontFamily("Audit Monospace", 12)).startsWith(
      '"Audit Monospace", ',
    ),
  };
  document.body.textContent = JSON.stringify(result);
  document.body.dataset.state = "complete";
};
void run().catch((error: unknown) => {
  document.body.textContent = String(error);
  document.body.dataset.state = "failed";
});
