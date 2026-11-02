import type { Tone } from "#/components/kit/status";

/**
 * Pure view logic for Settings · Instance · Exposure (docs/adr/0004, "Exposure is declared, and
 * reported as observed"). Every sentence states what was declared or observed, never a verdict.
 */

export type Established = "observed" | "carried" | "declared" | "open";

export interface ExposureItemFacts {
  readonly established: Established;
  readonly blocksStart: boolean;
}

/** An item's dot: observed in effect, stated or carried without a dot, open in amber or red. */
export const establishedTone = (item: ExposureItemFacts): Tone | null => {
  switch (item.established) {
    case "observed":
      return "ok";
    case "carried":
    case "declared":
      return null;
    case "open":
      return item.blocksStart ? "bad" : "wait";
  }
};

/** How an item is known, in the words `mend operator exposure` prints. */
export const establishedWord = (item: ExposureItemFacts): string =>
  item.established === "open" && item.blocksStart
    ? "open · refuses a public start"
    : item.established;

/** The line over the table: how many items were observed, stated, carried and left open. */
export const exposureCounts = (items: ReadonlyArray<ExposureItemFacts>): string => {
  const count = (state: Established) => items.filter((item) => item.established === state).length;
  const open = count("open");
  return [
    `${count("observed")} observed`,
    `${count("declared")} declared`,
    `${count("carried")} carried`,
    open === 0 ? "none open" : `${open} open`,
  ].join(" · ");
};

/** What the operator declared `MEND_EXPOSURE` to be, in the access nouns. */
export const DECLARED_WORDS: Readonly<Record<"loopback" | "private" | "public", string>> = {
  loopback: "Loopback · this machine only",
  private: "Private · a network you control admission to",
  public: "Public · from the Internet",
};
