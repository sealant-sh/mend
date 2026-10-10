// What `drift.ts` decides, without git or the network: which tag is newest, and how its contract
// files differ from the pinned ones.
import { localOf } from "./sources.ts";

const NIGHTLY = /^v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$/;

/** The newest `v<x.y.z>-nightly.<yyyymmdd>.<n>` tag, by version, then date, then build. */
export const newestNightly = (tags: ReadonlyArray<string>): string | null => {
  let best: { readonly tag: string; readonly key: ReadonlyArray<number> } | null = null;
  for (const tag of tags) {
    const match = NIGHTLY.exec(tag);
    if (match === null) continue;
    const key = match.slice(1).map(Number);
    const newer =
      best === null ||
      key.some((part, index) => {
        const earlier = key.slice(0, index);
        const bestKey = best?.key ?? [];
        return earlier.every((value, at) => value === bestKey[at]) && part > (bestKey[index] ?? 0);
      });
    if (newer) best = { tag, key };
  }
  return best?.tag ?? null;
};

export interface PinnedFile {
  readonly upstream: string;
  readonly blob: string;
}

export interface UpstreamFile {
  readonly upstream: string;
  readonly blob: string;
}

export interface Drift {
  /** A pinned file whose content upstream is different now. */
  readonly changed: ReadonlyArray<{ readonly local: string; readonly upstream: string }>;
  /** An upstream file under a vendored source that the pin does not have. */
  readonly added: ReadonlyArray<{ readonly local: string; readonly upstream: string }>;
  /** A pinned file upstream no longer has. */
  readonly removed: ReadonlyArray<{ readonly local: string; readonly upstream: string }>;
}

const byLocal = (a: { readonly local: string }, b: { readonly local: string }) =>
  a.local.localeCompare(b.local);

/** How the files upstream has under the vendored sources differ from the pin, by git blob id. */
export const driftOf = (
  pinned: Readonly<Record<string, PinnedFile>>,
  upstream: ReadonlyArray<UpstreamFile>,
): Drift => {
  const byUpstream = new Map(
    Object.entries(pinned).map(([local, file]) => [file.upstream, { local, file }]),
  );
  const seen = new Set<string>();
  const changed: Array<{ local: string; upstream: string }> = [];
  const added: Array<{ local: string; upstream: string }> = [];
  for (const file of upstream) {
    const local = localOf(file.upstream);
    if (local === null) continue;
    seen.add(file.upstream);
    const pin = byUpstream.get(file.upstream);
    if (pin === undefined) added.push({ local, upstream: file.upstream });
    else if (pin.file.blob !== file.blob) changed.push({ local, upstream: file.upstream });
  }
  const removed = Array.from(byUpstream, ([upstreamPath, { local }]) => ({
    local,
    upstream: upstreamPath,
  })).filter((file) => !seen.has(file.upstream));
  return {
    changed: changed.toSorted(byLocal),
    added: added.toSorted(byLocal),
    removed: removed.toSorted(byLocal),
  };
};

export const hasDrift = (drift: Drift): boolean =>
  drift.changed.length + drift.added.length + drift.removed.length > 0;

/** `git ls-tree -r <commit> -- <paths>` output as files. */
export const parseLsTree = (out: string): ReadonlyArray<UpstreamFile> =>
  out
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      const tab = line.indexOf("\t");
      const [, type, blob] = line.slice(0, tab).split(" ");
      return type === "blob" && blob !== undefined ? [{ upstream: line.slice(tab + 1), blob }] : [];
    });

/** One list of the report, or nothing when it is empty. */
const listOf = (
  title: string,
  files: ReadonlyArray<{ readonly local: string; readonly upstream: string }>,
): ReadonlyArray<string> =>
  files.length === 0
    ? []
    : [
        `### ${title} (${files.length})`,
        "",
        ...files.map((file) => `- \`${file.local}\` (\`${file.upstream}\`)`),
        "",
      ];

/** The report, in Markdown: what moved between the pin and the tag, and how to move the pin. */
export const reportOf = (input: {
  readonly pinnedTag: string;
  readonly tag: string;
  readonly commit: string;
  readonly drift: Drift;
}): string => {
  const { drift } = input;
  if (!hasDrift(drift)) {
    return `t3code ${input.tag} (${input.commit}) has the same contract files as the pin, ${input.pinnedTag}.\n`;
  }
  return [
    `## t3code ${input.tag} changed its contracts since the pin, ${input.pinnedTag}`,
    "",
    `Compared by git blob id at ${input.commit}, under the sources \`packages/t3-contracts\` vendors.`,
    "",
    ...listOf("Changed", drift.changed),
    ...listOf("New upstream", drift.added),
    ...listOf("Gone upstream", drift.removed),
    "To move the pin: `pnpm --filter @mend/t3-contracts sync --tag " +
      input.tag +
      "`, then the gateway's typecheck and tests, and the `rpc-surface` test for methods t3code added (docs/adr/0012).",
    "",
  ].join("\n");
};
