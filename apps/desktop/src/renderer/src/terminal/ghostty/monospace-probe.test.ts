import { expect, it } from "vitest";

import { areFontAdvancesMonospace } from "./monospace-probe";

it.each([
  { name: "equal positive advances", advances: [16, 16, 16], accepted: true },
  { name: "measurable sub-tolerance variation", advances: [16, 16.009], accepted: true },
  { name: "measurable variation above tolerance", advances: [16, 16.011], accepted: false },
  { name: "proportional glyph widths", advances: [4, 17, 20], accepted: false },
  { name: "no canvas observations", advances: [], accepted: true },
  { name: "unmeasurable zero width", advances: [0, 16], accepted: true },
  { name: "unmeasurable nonfinite width", advances: [16, Number.NaN], accepted: true },
])("$name", ({ advances, accepted }) => {
  expect(areFontAdvancesMonospace(advances)).toBe(accepted);
});
