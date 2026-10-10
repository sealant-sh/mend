// What this package vendors from t3code, shared by `sync.ts` (which copies it) and `drift.ts`
// (which says when a newer t3code changed it).

export const REPOSITORY = "https://github.com/pingdotgg/t3code.git";

/** Upstream directory or file → where it lands in this package. */
export const SOURCES: ReadonlyArray<{ readonly upstream: string; readonly local: string }> = [
  { upstream: "packages/contracts/src", local: "src" },
  // The default keybindings live beside the shared helpers that compile them.
  { upstream: "packages/shared/src/keybindings.ts", local: "shared/keybindings.ts" },
  { upstream: "LICENSE", local: "LICENSE" },
];

/** Where an upstream file lands here, or null when no source covers it. */
export const localOf = (upstream: string): string | null => {
  for (const source of SOURCES) {
    if (upstream === source.upstream) return source.local;
    if (upstream.startsWith(`${source.upstream}/`)) {
      return `${source.local}${upstream.slice(source.upstream.length)}`;
    }
  }
  return null;
};
