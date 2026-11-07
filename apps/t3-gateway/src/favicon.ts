import { posix } from "node:path";

import { Effect, Option, Schema } from "effect";

const CANDIDATES = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "app/favicon.ico",
  "app/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/icon.ico",
  "src/favicon.ico",
  "src/favicon.svg",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
  ".idea/icon.svg",
  "Resources/AppIcon.icns",
  "AppIcon.icns",
];
const SOURCES = [
  "index.html",
  "public/index.html",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
  "app/root.tsx",
  "src/root.tsx",
  "src/index.html",
];
const ProjectConfig = Schema.fromJsonString(
  Schema.Struct({ iconPath: Schema.optional(Schema.String) }),
);
const decodeConfig = Schema.decodeUnknownOption(ProjectConfig);

const contained = (path: string) => {
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.includes(":"))
    return null;
  const normalized = posix.normalize(path);
  return normalized.split("/").some((part) => part === ".." || part === ".git") ? null : normalized;
};
const iconHref = (source: string) => {
  const html =
    /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i.exec(
      source,
    );
  if (html?.[1]) return html[1];
  for (const run of source.split("}")) {
    if (!/\brel\s*:\s*["'](?:icon|shortcut icon)["']/i.test(run)) continue;
    const match = /\bhref\s*:\s*["']([^"'?]+)/i.exec(run);
    if (match?.[1]) return match[1];
  }
  return null;
};

/** T3 v0.1.2's project-config, well-known icon, and source-link precedence, within the visible root. */
export const resolveFavicon = <E>(
  files: ReadonlyArray<string>,
  readText: (path: string) => Effect.Effect<string | null, E>,
) =>
  Effect.gen(function* () {
    const names = new Set(files);
    const existing = (path: string) => {
      const relative = contained(path);
      return relative !== null && names.has(relative) ? relative : null;
    };
    const config = yield* readText("t3.json");
    const decoded = config === null ? Option.none() : decodeConfig(config);
    if (Option.isSome(decoded) && decoded.value.iconPath !== undefined) {
      const selected = existing(decoded.value.iconPath);
      if (selected !== null) return selected;
    }
    for (const path of CANDIDATES) if (names.has(path)) return path;
    for (const path of SOURCES) {
      if (!names.has(path)) continue;
      const source = yield* readText(path);
      const href = source === null ? null : iconHref(source);
      if (href === null || href.startsWith("//")) continue;
      const clean = href.replace(/^\//, "");
      const selected = existing(`public/${clean}`) ?? existing(clean);
      if (selected !== null) return selected;
    }
    return null;
  });
