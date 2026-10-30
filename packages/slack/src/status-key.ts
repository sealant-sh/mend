import { createHash } from "node:crypto";

import { SlackStatusKey } from "@mend/domain/workbench";

import type { SlackMessage } from "./blocks.ts";

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
};

/** A hash of the whole rendering, blocks and buttons included; field order does not move it. */
export const statusKey = (message: SlackMessage): SlackStatusKey =>
  SlackStatusKey.make(
    `k1:${createHash("sha256")
      .update(JSON.stringify(canonical({ text: message.text, blocks: message.blocks })))
      .digest("hex")}`,
  );
