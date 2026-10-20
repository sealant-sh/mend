import type { TranscriptEntry } from "./review-wire.js";

/**
 * Show record (story d, step 3) as text: Mend's transcript carries no record sequence, so it opens
 * whole, with the evidence it was asked for on top (G9).
 */
export const recordText = (input: {
  readonly name: string;
  readonly evidence: string | null;
  readonly entries: ReadonlyArray<TranscriptEntry>;
}): string => {
  const lines = [
    `# Record · ${input.name}`,
    "",
    ...(input.evidence === null ? [] : [`Evidence: ${input.evidence}`, ""]),
    "The whole transcript: Mend cannot open it at a record sequence yet.",
    "",
  ];
  for (const entry of input.entries) {
    const heading = entry.name === null ? entry.kind : `${entry.kind} · ${entry.name}`;
    lines.push(`## ${heading}`, "");
    if (entry.command !== null) lines.push("```", `$ ${entry.command}`, "```", "");
    if (entry.text !== null && entry.text.trim() !== "") lines.push(entry.text.trim(), "");
    if (entry.output !== null && entry.output.trim() !== "")
      lines.push("```", entry.output.trimEnd(), "```", "");
  }
  if (input.entries.length === 0) lines.push("The transcript has no entries yet.", "");
  return lines.join("\n");
};
