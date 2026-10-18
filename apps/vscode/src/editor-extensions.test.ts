import { describe, expect, it } from "vitest";

import {
  MISSING_TTL_MS,
  TimedOut,
  absentAfterInstall,
  captureLocalExtensions,
  classifyInstallFailure,
  editorIdentity,
  emptyInstallMemory,
  learn,
  notInWorkspace,
  parseEditorMode,
  parseInstallMemory,
  parseLocalExtensions,
  parseProvenance,
  parseRemoteExtensions,
  planExtensions,
  pruneUninstalled,
  runInstalls,
  sameCapture,
  type CompletedRun,
  type ExtensionRef,
  type InstallDeps,
  type InstallMemory,
  type InstalledExtension,
  type LocalExtensions,
  type Provenance,
  type ProvenanceIn,
  type RemoteExtensions,
} from "./editor-extensions.js";

const APP_ROOT = "/nix/store/x-vscode-1.139.1/lib/vscode/resources/app";
const FOLDER = "/home/me/.vscode/extensions";
const EDITOR = editorIdentity("Visual Studio Code", "1.139.1", "d41d8cd9");
const NOW = 1_792_270_215_287;

const installed = (
  id: string,
  manifest: Record<string, unknown>,
  extensionPath = `${FOLDER}/${id}-1.0.0`,
): InstalledExtension => ({
  id,
  extensionPath,
  packageJSON: { version: "1.0.0", main: "./out/extension.js", ...manifest },
});

const local = (...refs: ReadonlyArray<ExtensionRef>): LocalExtensions => ({
  version: 1,
  capturedAt: NOW,
  extensions: refs,
  fromFile: [],
});
const ref = (id: string, version = "1.0.0", uuid?: string): ExtensionRef => ({
  id,
  version,
  gallery: uuid === undefined ? null : { uuid, extensionsFolder: FOLDER },
});
const remoteOf = (...entries: ReadonlyArray<string | [string, string]>): RemoteExtensions =>
  new Map(entries.map((entry) => (typeof entry === "string" ? [entry, null] : entry)));

const unknownProvenance: ProvenanceIn = () => null;
const provenanceOf =
  (entries: Record<string, Provenance>): ProvenanceIn =>
  (folder) =>
    folder === FOLDER ? new Map(Object.entries(entries)) : null;

describe("parseEditorMode", () => {
  it.each([
    ["off", "off"],
    ["extensions", "extensions"],
    ["extensionsAndSettings", "extensionsAndSettings"],
    [undefined, "extensionsAndSettings"],
    ["sideways", "off"],
    [true, "off"],
  ])("%s → %s", (value, mode) => expect(parseEditorMode(value)).toBe(mode));
});

describe("captureLocalExtensions", () => {
  it.each([
    ["a built-in", installed("vscode.git", {}, `${APP_ROOT}/extensions/git`), false],
    ["a declarative theme", installed("dracula-theme.theme-dracula", { main: undefined }), false],
    [
      "a web-only extension",
      installed("x.web", { main: undefined, browser: "./dist/web.js" }),
      false,
    ],
    ["one declaring ui first", installed("x.ui", { extensionKind: ["ui", "workspace"] }), false],
    ["one declaring ui (old string form)", installed("x.ui-old", { extensionKind: "ui" }), false],
    ["Remote-SSH", installed("ms-vscode-remote.remote-ssh", { extensionKind: undefined }), false],
    ["Remote-SSH edit", installed("ms-vscode-remote.remote-ssh-edit", {}), false],
    ["Remote Explorer", installed("ms-vscode.remote-explorer", {}), false],
    ["Mend itself", installed("sealant-sh.mend", { extensionKind: ["workspace", "ui"] }), false],
    ["a workspace-kind extension with code", installed("editorconfig.editorconfig", {}), true],
    [
      "one declaring workspace first",
      installed("x.ws", { extensionKind: ["workspace", "ui"] }),
      true,
    ],
    [
      "one outside the app root that shares its prefix",
      installed("x.near", {}, `${APP_ROOT}x/e`),
      true,
    ],
    ["a manifest without a version", installed("x.nover", { version: undefined }), false],
  ])("%s → captured %s", (_name, extension, captured) => {
    expect(captureLocalExtensions([extension], APP_ROOT, unknownProvenance).extensions.length).toBe(
      captured ? 1 : 0,
    );
  });

  it("lowercases ids, keeps versions and sorts by id", () => {
    expect(
      captureLocalExtensions(
        [
          installed("Timonwong.ShellCheck", { version: "0.48.1" }),
          installed("EditorConfig.EditorConfig", { version: "0.18.2" }),
        ],
        APP_ROOT,
        unknownProvenance,
      ).extensions,
    ).toEqual([ref("editorconfig.editorconfig", "0.18.2"), ref("timonwong.shellcheck", "0.48.1")]);
  });

  it("records the gallery uuid, and names what was installed from a file", () => {
    const capture = captureLocalExtensions(
      [
        installed("EditorConfig.EditorConfig", {}),
        installed("me.sideloaded", {}),
        installed("me.unlisted", {}),
        installed("me.theme-from-file", { main: undefined }),
      ],
      APP_ROOT,
      provenanceOf({
        "editorconfig.editorconfig": { kind: "gallery", uuid: "f60a60a6" },
        "me.sideloaded": { kind: "file" },
        "me.theme-from-file": { kind: "file" },
      }),
    );
    expect(capture).toEqual({
      extensions: [ref("editorconfig.editorconfig", "1.0.0", "f60a60a6"), ref("me.unlisted")],
      fromFile: ["me.sideloaded"],
    });
  });

  it("tells a changed capture from the stored one", () => {
    const stored = { ...local(ref("a.one", "1.0.0", "u1")), fromFile: ["b.vsix"] };
    expect(
      sameCapture(stored, { extensions: [ref("a.one", "1.0.0", "u1")], fromFile: ["b.vsix"] }),
    ).toBe(true);
    expect(
      sameCapture(stored, { extensions: [ref("a.one", "1.0.0", "u2")], fromFile: ["b.vsix"] }),
    ).toBe(false);
    expect(sameCapture(stored, { extensions: [ref("a.one", "1.0.0", "u1")], fromFile: [] })).toBe(
      false,
    );
  });
});

describe("parseProvenance", () => {
  it("reads where each local extension came from", () => {
    const text = JSON.stringify([
      {
        identifier: { id: "EditorConfig.EditorConfig", uuid: "f60a60a6" },
        metadata: { source: "gallery", id: "f60a60a6" },
      },
      { identifier: { id: "me.vsix" }, metadata: { source: "vsix" } },
      { identifier: { id: "me.resource" }, metadata: { source: "resource" } },
      { identifier: { id: "old.entry", uuid: "aa" } },
      { identifier: { id: "gallery.nouuid" }, metadata: { source: "gallery" } },
    ]);
    expect(Object.fromEntries(parseProvenance(text) ?? [])).toEqual({
      "editorconfig.editorconfig": { kind: "gallery", uuid: "f60a60a6" },
      "me.vsix": { kind: "file" },
      "me.resource": { kind: "file" },
    });
    expect(parseProvenance("{")).toBeNull();
    expect(parseProvenance("{}")).toBeNull();
  });
});

describe("pruneUninstalled", () => {
  it("drops a gallery id the local folder no longer lists, and keeps the rest", () => {
    const list = local(
      ref("a.gone", "1.0.0", "u1"),
      ref("b.kept", "1.0.0", "u2"),
      ref("c.unknown"),
    );
    const now = provenanceOf({ "b.kept": { kind: "gallery", uuid: "u2" } });
    expect(pruneUninstalled(list, now).extensions.map((r) => r.id)).toEqual([
      "b.kept",
      "c.unknown",
    ]);
  });

  it("moves an id the person replaced with a file install to fromFile", () => {
    const list: LocalExtensions = {
      ...local(ref("a.vsix", "1.0.0", "u1"), ref("b.kept", "1.0.0", "u2")),
      fromFile: ["z.file"],
    };
    const now = provenanceOf({
      "a.vsix": { kind: "file" },
      "b.kept": { kind: "gallery", uuid: "u2" },
    });
    const pruned = pruneUninstalled(list, now);
    expect(pruned.extensions.map((r) => r.id)).toEqual(["b.kept"]);
    expect(pruned.fromFile).toEqual(["a.vsix", "z.file"]);
  });

  it("keeps the stored list when the folder cannot be read", () => {
    const list = local(ref("a.one", "1.0.0", "u1"));
    expect(pruneUninstalled(list, unknownProvenance)).toEqual(list);
  });
});

describe("stored records", () => {
  it("round-trip and refuse anything malformed", () => {
    const list: LocalExtensions = {
      ...local(ref("editorconfig.editorconfig", "1.0.0", "f60a"), ref("x.unknown")),
      fromFile: ["me.vsix"],
    };
    expect(parseLocalExtensions(JSON.parse(JSON.stringify(list)))).toEqual(list);
    for (const bad of [
      undefined,
      "x",
      { ...list, version: 2 },
      { ...list, extensions: [{ id: "x" }] },
      { ...list, extensions: [{ id: "x", version: "1" }] },
      { ...list, extensions: [{ id: "x", version: "1", gallery: { uuid: "u" } }] },
      { ...list, capturedAt: "now" },
      { ...list, fromFile: undefined },
      { ...list, fromFile: [1] },
    ]) {
      expect(parseLocalExtensions(bad)).toBeNull();
    }
    const memory: InstallMemory = { version: 1, staysLocal: { a: 1 }, missing: { b: 2 } };
    expect(parseInstallMemory(JSON.parse(JSON.stringify(memory)))).toEqual(memory);
    for (const bad of [null, { version: 1, staysLocal: {}, missing: { b: "2" } }, { version: 2 }]) {
      expect(parseInstallMemory(bad)).toBeNull();
    }
  });

  it("reads the remote extensions.json the spike saw", () => {
    const text = JSON.stringify([
      { identifier: { id: "editorconfig.editorconfig", uuid: "f60a" }, version: "0.18.2" },
      { identifier: { id: "DavidAnson.vscode-markdownlint" }, version: "0.62.1" },
      { identifier: { id: "x.server" }, metadata: { id: "5e7a", source: "gallery" } },
      { identifier: {} },
    ]);
    expect([...parseRemoteExtensions(text)]).toEqual([
      ["editorconfig.editorconfig", "f60a"],
      ["davidanson.vscode-markdownlint", null],
      ["x.server", "5e7a"],
    ]);
    expect(parseRemoteExtensions("").size).toBe(0);
    expect(parseRemoteExtensions("{").size).toBe(0);
  });
});

describe("planExtensions", () => {
  const list = local(ref("a.one"), ref("b.two", "2.0.0"), ref("c.three"));

  it("installs what the remote lacks", () => {
    expect(planExtensions(list, remoteOf("a.one"), emptyInstallMemory, EDITOR, NOW)).toEqual({
      install: [ref("b.two", "2.0.0"), ref("c.three")],
      recentlyMissing: [],
    });
  });

  it("skips an id that stays local at this version in this editor, and only then", () => {
    const memory: InstallMemory = {
      ...emptyInstallMemory,
      staysLocal: { [`${EDITOR}@b.two@2.0.0`]: NOW - 1 },
    };
    expect(planExtensions(list, remoteOf(), memory, EDITOR, NOW).install.map((r) => r.id)).toEqual([
      "a.one",
      "c.three",
    ]);
    const newer = local(ref("b.two", "2.1.0"));
    expect(planExtensions(newer, remoteOf(), memory, EDITOR, NOW).install).toEqual([
      ref("b.two", "2.1.0"),
    ]);
    const otherEditor = editorIdentity("Visual Studio Code", "1.140.0", "d41d8cd9");
    expect(planExtensions(list, remoteOf(), memory, otherEditor, NOW).install).toHaveLength(3);
  });

  it("skips a fresh missing id, names it, and asks again after a day", () => {
    const memory: InstallMemory = { ...emptyInstallMemory, missing: { "c.three": NOW - 1_000 } };
    const plan = planExtensions(list, remoteOf(), memory, EDITOR, NOW);
    expect(plan.install.map((r) => r.id)).toEqual(["a.one", "b.two"]);
    expect(plan.recentlyMissing).toEqual(["c.three"]);
    expect(
      planExtensions(list, remoteOf(), memory, EDITOR, NOW + MISSING_TTL_MS).install,
    ).toHaveLength(3);
  });

  it("gives the same plan for the same inputs", () => {
    const remote = remoteOf("c.three");
    expect(planExtensions(list, remote, emptyInstallMemory, EDITOR, NOW)).toEqual(
      planExtensions(list, remote, emptyInstallMemory, EDITOR, NOW),
    );
  });
});

describe("notInWorkspace", () => {
  it("a skipped missing id leaves the workspace out of sync", () => {
    const list = local(ref("a.one"), ref("c.three"));
    const memory: InstallMemory = { ...emptyInstallMemory, missing: { "c.three": NOW - 1_000 } };
    expect(planExtensions(list, remoteOf("a.one"), memory, EDITOR, NOW).install).toEqual([]);
    expect(notInWorkspace(list, remoteOf("a.one"), memory, EDITOR)).toEqual(["c.three"]);
  });

  it("counts an id held under another gallery uuid, and not one that stays local", () => {
    const list = local(ref("a.one", "1.0.0", "u1"), ref("b.ui"), ref("c.any"));
    const memory: InstallMemory = {
      ...emptyInstallMemory,
      staysLocal: { [`${EDITOR}@b.ui@1.0.0`]: NOW },
    };
    expect(notInWorkspace(list, remoteOf(["a.one", "other"], "c.any"), memory, EDITOR)).toEqual([
      "a.one",
    ]);
    expect(notInWorkspace(list, remoteOf(["a.one", "u1"], "c.any"), memory, EDITOR)).toEqual([]);
  });
});

describe("classifyInstallFailure", () => {
  it.each([
    ["Failed to fetch", "transient"],
    ["getaddrinfo EAI_AGAIN marketplace.visualstudio.com", "transient"],
    ["request failed: 503 Service Unavailable", "transient"],
    ["Extension 'nobody.nothing' not found.", "missing"],
    ["The extension 'nobody.nothing' cannot be installed because it was not found.", "missing"],
    ["Installing Extension x failed: Manifest is not found.", "failed"],
    ["Can't install 'x' extension because it is not compatible.", "failed"],
    ["This extension cannot be installed because Extension is not allowed.", "refused by policy"],
    [
      "This extension cannot be installed because the extensions from this publisher are not in the [allowed list](command:x)",
      "refused by policy",
    ],
    ["Can't install 'x' extension since it was reported to be problematic.", "refused by policy"],
  ])("%s → %s", (message, kind) => expect(classifyInstallFailure(new Error(message))).toBe(kind));

  it("a timeout is its own class", () => {
    expect(classifyInstallFailure(new TimedOut())).toBe("timed out");
  });
});

const harness = (fail: (id: string, attempt: number) => string | null) => {
  const calls: Array<string> = [];
  const sleeps: Array<number> = [];
  const progress: Array<string> = [];
  const controller = new AbortController();
  const attempts = new Map<string, number>();
  const deps: InstallDeps = {
    install: async (id) => {
      calls.push(id);
      const attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      const message = fail(id, attempt);
      if (message !== null) throw new Error(message);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    signal: controller.signal,
    onProgress: (current, total) => progress.push(`${current}/${total}`),
  };
  return { deps, calls, sleeps, progress, controller };
};

describe("runInstalls", () => {
  it("retries a transient failure after 1 s and then 4 s", async () => {
    const run = harness((id, attempt) =>
      id === "a.one" && attempt < 3 ? "Failed to fetch" : null,
    );
    const result = await runInstalls([ref("a.one"), ref("b.two")], run.deps);
    expect(run.calls).toEqual(["a.one", "a.one", "a.one", "b.two"]);
    expect(run.sleeps).toEqual([1_000, 4_000]);
    expect(result).toEqual({
      kind: "completed",
      outcomes: [
        { ref: ref("a.one"), kind: "reported" },
        { ref: ref("b.two"), kind: "reported" },
      ],
    });
    expect(run.progress).toEqual(["1/2", "2/2"]);
  });

  it("gives up after three transient failures and continues with the rest", async () => {
    const run = harness((id) => (id === "a.one" ? "Failed to fetch" : null));
    const result = await runInstalls([ref("a.one"), ref("b.two")], run.deps);
    expect(run.calls).toEqual(["a.one", "a.one", "a.one", "b.two"]);
    expect(result.outcomes).toEqual([
      { ref: ref("a.one"), kind: "failed", failure: "transient" },
      { ref: ref("b.two"), kind: "reported" },
    ]);
  });

  it("does not retry a missing, refused or failed id, and keeps no message", async () => {
    const run = harness((id) =>
      id === "a.one"
        ? "Extension 'a.one' not found."
        : id === "b.two"
          ? "Can't install at /home/mabc/.vscode-server: not compatible"
          : "This extension cannot be installed because Extension is not allowed.",
    );
    const result = await runInstalls([ref("a.one"), ref("b.two"), ref("c.three")], run.deps);
    expect(run.calls).toEqual(["a.one", "b.two", "c.three"]);
    expect(run.sleeps).toEqual([]);
    expect(result.outcomes).toEqual([
      { ref: ref("a.one"), kind: "missing" },
      { ref: ref("b.two"), kind: "failed", failure: "failed" },
      { ref: ref("c.three"), kind: "failed", failure: "refused by policy" },
    ]);
    expect(JSON.stringify(result)).not.toContain("/home/");
  });

  it("stops between ids when aborted, and says it did not complete", async () => {
    const run = harness(() => null);
    const deps: InstallDeps = {
      ...run.deps,
      install: async (id) => {
        await run.deps.install(id);
        run.controller.abort();
      },
    };
    const result = await runInstalls([ref("a.one"), ref("b.two")], deps);
    expect(run.calls).toEqual(["a.one"]);
    expect(result).toEqual({
      kind: "stopped",
      outcomes: [{ ref: ref("a.one"), kind: "reported" }],
    });
  });

  it("an abort during a retry's wait stops before the next attempt", async () => {
    const run = harness(() => "Failed to fetch");
    const deps: InstallDeps = {
      ...run.deps,
      sleep: async (ms) => {
        await run.deps.sleep(ms);
        run.controller.abort();
      },
    };
    const result = await runInstalls([ref("a.one")], deps);
    expect(run.calls).toEqual(["a.one"]);
    expect(result).toEqual({ kind: "stopped", outcomes: [] });
  });

  it("an empty plan completes with nothing to report", async () => {
    const run = harness(() => null);
    expect(await runInstalls([], run.deps)).toEqual({ kind: "completed", outcomes: [] });
    expect(run.progress).toEqual([]);
  });
});

const completed = (outcomes: CompletedRun["outcomes"]): CompletedRun => ({
  kind: "completed",
  outcomes,
});

describe("learn", () => {
  const reported = (id: string, uuid?: string) => ({
    ref: ref(id, "1.0.0", uuid),
    kind: "reported" as const,
  });

  it("success-but-absent becomes staysLocal only with UI-host evidence", () => {
    const outcomes = [reported("a.one"), reported("b.ui"), reported("c.lost")];
    const remote = remoteOf("a.one");
    expect(absentAfterInstall(outcomes, remote)).toEqual(["b.ui", "c.lost"]);
    const lesson = learn(
      emptyInstallMemory,
      completed(outcomes),
      remote,
      (id) => id === "b.ui",
      EDITOR,
      NOW,
    );
    expect(lesson.results).toEqual([
      { id: "a.one", kind: "installed" },
      { id: "b.ui", kind: "staysLocal" },
      { id: "c.lost", kind: "unresolved" },
    ]);
    expect(lesson.memory.staysLocal).toEqual({ [`${EDITOR}@b.ui@1.0.0`]: NOW });
  });

  it("an install that lands another gallery uuid fails as a different publisher; one without a uuid installed", () => {
    const lesson = learn(
      emptyInstallMemory,
      completed([reported("a.one", "u1"), reported("b.two", "u2"), reported("c.three", "u3")]),
      remoteOf(["a.one", "u1"], ["b.two", "evil"], "c.three"),
      () => false,
      EDITOR,
      NOW,
    );
    expect(lesson.results).toEqual([
      { id: "a.one", kind: "installed" },
      { id: "b.two", kind: "failed", failure: "different publisher" },
      { id: "c.three", kind: "installed" },
    ]);
  });

  it("records missing with a time, clears it on success, drops expired entries", () => {
    const memory: InstallMemory = {
      ...emptyInstallMemory,
      missing: { "a.one": NOW - 10, "old.gone": NOW - MISSING_TTL_MS },
    };
    const lesson = learn(
      memory,
      completed([reported("a.one"), { ref: ref("b.two"), kind: "missing" }]),
      remoteOf("a.one"),
      () => false,
      EDITOR,
      NOW,
    );
    expect(lesson.memory.missing).toEqual({ "b.two": NOW });
  });

  it("caches nothing for a failure", () => {
    const lesson = learn(
      emptyInstallMemory,
      completed([{ ref: ref("a.one"), kind: "failed", failure: "timed out" }]),
      remoteOf(),
      () => true,
      EDITOR,
      NOW,
    );
    expect(lesson.memory).toEqual(emptyInstallMemory);
    expect(lesson.results).toEqual([{ id: "a.one", kind: "failed", failure: "timed out" }]);
  });
});
