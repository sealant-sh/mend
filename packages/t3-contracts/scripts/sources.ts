// What this package vendors from t3code, shared by `sync.ts` (which copies it) and `drift.ts`
// (which says when a newer t3code changed it).

export const REPOSITORY = "https://github.com/pingdotgg/t3code.git";

const T3_SHARED_FILES = [
  "Array",
  "assistantCitations",
  "backgroundActivitySettings",
  "changeRequestUrl",
  "codexArtifactTemplates",
  "codexFileCitations",
  "codexMarkdownDirectives",
  "composerContextLegacy",
  "composerContextReferences",
  "fileLinks",
  "htmlRender",
  "inlineSkills",
  "keybindings",
  "markdownGithubAlerts",
  "markdownLinks",
  "markdownListIndentation",
  "markdownPipeline",
  "mcpApp",
  "model",
  "orchestrationV2PendingBackgroundWork",
  "path",
  "proposedPlanText",
  "schemaJson",
  "serverSettings",
  "sourceControl",
  "Struct",
  "t3McpToolPresentation",
  "themePalettes",
  "threadFindText",
  "threadLinks",
  "threadPullRequests",
  "threadSearch",
  "threadTranscript",
  "toolOutput",
];

const CLIENT_RUNTIME_STATE_FILES = [
  "models",
  "subagentDisplay",
  "subagentRuntime",
  "threadSettled",
];

/** Upstream directory or file → where it lands in this package. */
export const SOURCES: ReadonlyArray<{ readonly upstream: string; readonly local: string }> = [
  { upstream: "packages/contracts/src", local: "src" },
  ...T3_SHARED_FILES.map((name) => ({
    upstream: `packages/shared/src/${name}.ts`,
    local: `t3-shared/src/${name}.ts`,
  })),
  ...CLIENT_RUNTIME_STATE_FILES.map((name) => ({
    upstream: `packages/client-runtime/src/state/${name}.ts`,
    local: `client-runtime/${name}.ts`,
  })),
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
