/**
 * A remote window's extension API does not list the local extensions that would run in a
 * workspace, so local windows record them into global state.
 */
import * as path from "node:path";

export type EditorMode = "off" | "extensions" | "extensionsAndSettings";

export const parseEditorMode = (value: unknown): EditorMode => {
  if (value === undefined) return "extensionsAndSettings";
  return value === "extensions" || value === "extensionsAndSettings" ? value : "off";
};

export interface GallerySource {
  readonly uuid: string;
  readonly extensionsFolder: string;
}

export interface ExtensionRef {
  readonly id: string;
  readonly version: string;
  readonly gallery: GallerySource | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseGallery = (value: unknown): GallerySource | null | undefined => {
  if (value === null) return null;
  return isRecord(value) &&
    typeof value["uuid"] === "string" &&
    typeof value["extensionsFolder"] === "string"
    ? { uuid: value["uuid"], extensionsFolder: value["extensionsFolder"] }
    : undefined;
};

const parseRef = (value: unknown): ExtensionRef | null => {
  if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["version"] !== "string") {
    return null;
  }
  const gallery = parseGallery(value["gallery"]);
  return gallery === undefined ? null : { id: value["id"], version: value["version"], gallery };
};

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const numberMap = (value: unknown): Readonly<Record<string, number>> | null => {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  return entries.every((entry): entry is [string, number] => typeof entry[1] === "number")
    ? Object.fromEntries(entries)
    : null;
};

export const LOCAL_EXTENSIONS_KEY = "mend.editor.localExtensions";

export interface LocalCapture {
  readonly extensions: ReadonlyArray<ExtensionRef>;
  readonly fromFile: ReadonlyArray<string>;
}

export interface LocalExtensions extends LocalCapture {
  readonly version: 1;
  readonly capturedAt: number;
}

export const parseLocalExtensions = (value: unknown): LocalExtensions | null => {
  if (!isRecord(value) || value["version"] !== 1 || typeof value["capturedAt"] !== "number") {
    return null;
  }
  const listed = value["extensions"];
  const fromFile = value["fromFile"];
  if (!Array.isArray(listed) || !isStringArray(fromFile)) return null;
  const extensions = listed.map(parseRef);
  return extensions.every((ref): ref is ExtensionRef => ref !== null)
    ? { version: 1, capturedAt: value["capturedAt"], extensions, fromFile }
    : null;
};

export type Provenance =
  | { readonly kind: "gallery"; readonly uuid: string }
  | { readonly kind: "file" };

export const parseProvenance = (text: string): ReadonlyMap<string, Provenance> | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return new Map(
    parsed.flatMap((entry): Array<[string, Provenance]> => {
      if (!isRecord(entry)) return [];
      const { identifier, metadata } = entry;
      if (!isRecord(identifier) || typeof identifier["id"] !== "string") return [];
      const id = identifier["id"].toLowerCase();
      const source = isRecord(metadata) ? metadata["source"] : undefined;
      const uuid = identifier["uuid"];
      if (source === "gallery") {
        return typeof uuid === "string" ? [[id, { kind: "gallery", uuid }]] : [];
      }
      return typeof source === "string" ? [[id, { kind: "file" }]] : [];
    }),
  );
};

export type ProvenanceIn = (folder: string) => ReadonlyMap<string, Provenance> | null;

export interface InstalledExtension {
  readonly id: string;
  readonly extensionPath: string;
  readonly packageJSON: unknown;
}

const NEVER_INSTALL: ReadonlyArray<RegExp> = [
  /^ms-vscode-remote\./,
  /^ms-vscode\.remote-(?:explorer|server)$/,
  /^sealant-sh\.mend$/,
];

const isInside = (child: string, parent: string): boolean => {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

const declaresUiFirst = (manifest: Record<string, unknown>): boolean => {
  const kind = manifest["extensionKind"];
  return kind === "ui" || (Array.isArray(kind) && kind[0] === "ui");
};

const byId = (left: string, right: string) => left.localeCompare(right);

/**
 * VS Code runs an extension without `main`, or one whose `extensionKind` starts with `ui`, in the UI
 * host. The runtime `extensionKind` cannot tell: in a local window it is `ui` for every extension.
 */

export const captureLocalExtensions = (
  installed: ReadonlyArray<InstalledExtension>,
  appRoot: string,
  provenanceIn: ProvenanceIn,
): LocalCapture => {
  const extensions: Array<ExtensionRef> = [];
  const fromFile: Array<string> = [];
  for (const extension of installed) {
    const manifest = extension.packageJSON;
    const id = extension.id.toLowerCase();
    if (!isRecord(manifest) || typeof manifest["version"] !== "string") continue;
    if (isInside(extension.extensionPath, appRoot)) continue;
    if (NEVER_INSTALL.some((pattern) => pattern.test(id))) continue;
    if (typeof manifest["main"] !== "string" || declaresUiFirst(manifest)) continue;
    const folder = path.dirname(extension.extensionPath);
    const provenance = provenanceIn(folder)?.get(id);
    if (provenance?.kind === "file") {
      fromFile.push(id);
      continue;
    }
    const gallery =
      provenance === undefined ? null : { uuid: provenance.uuid, extensionsFolder: folder };
    extensions.push({ id, version: manifest["version"], gallery });
  }
  return {
    extensions: extensions.toSorted((left, right) => byId(left.id, right.id)),
    fromFile: fromFile.toSorted(byId),
  };
};

export const sameCapture = (left: LocalCapture, right: LocalCapture): boolean =>
  JSON.stringify([left.extensions, left.fromFile]) ===
  JSON.stringify([right.extensions, right.fromFile]);

const provenanceNow = (
  ref: ExtensionRef,
  provenanceIn: ProvenanceIn,
): Provenance | "uninstalled" | "unknown" => {
  const folder = ref.gallery === null ? null : provenanceIn(ref.gallery.extensionsFolder);
  return folder === null ? "unknown" : (folder.get(ref.id) ?? "uninstalled");
};

export const pruneUninstalled = (
  list: LocalExtensions,
  provenanceIn: ProvenanceIn,
): LocalExtensions => {
  const extensions: Array<ExtensionRef> = [];
  const fromFile = new Set(list.fromFile);
  for (const ref of list.extensions) {
    const now = provenanceNow(ref, provenanceIn);
    if (now === "uninstalled") continue;
    if (now !== "unknown" && now.kind === "file") fromFile.add(ref.id);
    else extensions.push(ref);
  }
  return { ...list, extensions, fromFile: [...fromFile].toSorted(byId) };
};

export const INSTALL_MEMORY_KEY = "mend.editor.installMemory";

export const MISSING_TTL_MS = 24 * 60 * 60_000;

export interface InstallMemory {
  readonly version: 1;
  readonly staysLocal: Readonly<Record<string, number>>;
  readonly missing: Readonly<Record<string, number>>;
}

export const emptyInstallMemory: InstallMemory = { version: 1, staysLocal: {}, missing: {} };

export const parseInstallMemory = (value: unknown): InstallMemory | null => {
  if (!isRecord(value) || value["version"] !== 1) return null;
  const staysLocal = numberMap(value["staysLocal"]);
  const missing = numberMap(value["missing"]);
  return staysLocal === null || missing === null ? null : { version: 1, staysLocal, missing };
};

/**
 * Where VS Code runs an extension depends on its product overrides, which change between versions,
 * and on the person's `remote.extensionKind` setting.
 */
export const editorIdentity = (appName: string, version: string, kindDigest: string): string =>
  `${appName} ${version} ${kindDigest}`;

const staysLocalKey = (editor: string, ref: ExtensionRef): string =>
  `${editor}@${ref.id}@${ref.version}`;

const recentlyMissing = (at: number | undefined, now: number): boolean =>
  at !== undefined && now - at < MISSING_TTL_MS;

export type RemoteExtensions = ReadonlyMap<string, string | null>;

export const parseRemoteExtensions = (text: string): RemoteExtensions => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Map();
  }
  if (!Array.isArray(parsed)) return new Map();
  return new Map(
    parsed.flatMap((entry): Array<[string, string | null]> => {
      if (!isRecord(entry)) return [];
      const { identifier, metadata } = entry;
      if (!isRecord(identifier) || typeof identifier["id"] !== "string") return [];
      const uuid = identifier["uuid"] ?? (isRecord(metadata) ? metadata["id"] : undefined);
      return [[identifier["id"].toLowerCase(), typeof uuid === "string" ? uuid : null]];
    }),
  );
};

/** VS Code 1.139.1's server records a gallery install without `identifier.uuid`. */
const inWorkspace = (ref: ExtensionRef, remote: RemoteExtensions): boolean => {
  if (!remote.has(ref.id)) return false;
  const uuid = remote.get(ref.id) ?? null;
  return ref.gallery === null || uuid === null || uuid === ref.gallery.uuid;
};

const knownLocal = (memory: InstallMemory, editor: string, ref: ExtensionRef): boolean =>
  memory.staysLocal[staysLocalKey(editor, ref)] !== undefined;

export interface Plan {
  readonly install: ReadonlyArray<ExtensionRef>;
  readonly recentlyMissing: ReadonlyArray<string>;
}

export const planExtensions = (
  local: LocalExtensions,
  remote: RemoteExtensions,
  memory: InstallMemory,
  editor: string,
  now: number,
): Plan => {
  const wanted = local.extensions.filter(
    (ref) => !remote.has(ref.id) && !knownLocal(memory, editor, ref),
  );
  const missing = (ref: ExtensionRef) => recentlyMissing(memory.missing[ref.id], now);
  return {
    install: wanted.filter((ref) => !missing(ref)),
    recentlyMissing: wanted.filter(missing).map((ref) => ref.id),
  };
};

export const notInWorkspace = (
  local: LocalExtensions,
  remote: RemoteExtensions,
  memory: InstallMemory,
  editor: string,
): ReadonlyArray<string> =>
  local.extensions
    .filter((ref) => !inWorkspace(ref, remote) && !knownLocal(memory, editor, ref))
    .map((ref) => ref.id);

export class TimedOut extends Error {}

export type InstallFailure = "transient" | "missing" | "refused by policy" | "timed out" | "failed";

/** The messages are VS Code 1.139.1's. */
export const classifyInstallFailure = (cause: unknown): InstallFailure => {
  if (cause instanceof TimedOut) return "timed out";
  const message = cause instanceof Error ? cause.message : String(cause);
  if (
    /failed to fetch|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|\b(?:429|502|503|504)\b/i.test(
      message,
    )
  ) {
    return "transient";
  }
  if (
    /allowed list|(?:is|are) not allowed|reported to be problematic|contact your administrator/i.test(
      message,
    )
  ) {
    return "refused by policy";
  }
  if (/\bnot found\b/i.test(message) && !/manifest/i.test(message)) return "missing";
  return "failed";
};

export type FailedBecause = Exclude<InstallFailure, "missing"> | "different publisher";

export const RETRY_DELAYS_MS: ReadonlyArray<number> = [1_000, 4_000];

export type InstallOutcome =
  | { readonly ref: ExtensionRef; readonly kind: "reported" }
  | { readonly ref: ExtensionRef; readonly kind: "missing" }
  | { readonly ref: ExtensionRef; readonly kind: "failed"; readonly failure: FailedBecause };

export interface InstallDeps {
  readonly install: (id: string) => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly signal: AbortSignal;
  readonly onProgress: (current: number, total: number) => void;
}

export interface CompletedRun {
  readonly kind: "completed";
  readonly outcomes: ReadonlyArray<InstallOutcome>;
}

export type InstallRun =
  | CompletedRun
  | { readonly kind: "stopped"; readonly outcomes: ReadonlyArray<InstallOutcome> };

const installOne = async (
  ref: ExtensionRef,
  deps: InstallDeps,
): Promise<InstallOutcome | "stopped"> => {
  for (let attempt = 0; ; attempt += 1) {
    if (deps.signal.aborted) return "stopped";
    try {
      await deps.install(ref.id);
      return { ref, kind: "reported" };
    } catch (cause) {
      const failure = classifyInstallFailure(cause);
      const delay = RETRY_DELAYS_MS[attempt];
      if (failure === "transient" && delay !== undefined) {
        await deps.sleep(delay);
        continue;
      }
      return failure === "missing" ? { ref, kind: "missing" } : { ref, kind: "failed", failure };
    }
  }
};

export const runInstalls = async (
  plan: ReadonlyArray<ExtensionRef>,
  deps: InstallDeps,
): Promise<InstallRun> => {
  const outcomes: Array<InstallOutcome> = [];
  for (const [index, ref] of plan.entries()) {
    deps.onProgress(index + 1, plan.length);
    const outcome = await installOne(ref, deps);
    if (outcome === "stopped") return { kind: "stopped", outcomes };
    outcomes.push(outcome);
  }
  return { kind: "completed", outcomes };
};

export const absentAfterInstall = (
  outcomes: ReadonlyArray<InstallOutcome>,
  remote: RemoteExtensions,
): ReadonlyArray<string> =>
  outcomes.flatMap((outcome) =>
    outcome.kind === "reported" && !remote.has(outcome.ref.id) ? [outcome.ref.id] : [],
  );

export type InstallResult =
  | { readonly id: string; readonly kind: "installed" }
  | { readonly id: string; readonly kind: "staysLocal" }
  | { readonly id: string; readonly kind: "unresolved" }
  | { readonly id: string; readonly kind: "missing" }
  | { readonly id: string; readonly kind: "failed"; readonly failure: FailedBecause };

export interface Lesson {
  readonly memory: InstallMemory;
  readonly results: ReadonlyArray<InstallResult>;
}

export const learn = (
  memory: InstallMemory,
  run: CompletedRun,
  remote: RemoteExtensions,
  inUiHost: (id: string) => boolean,
  editor: string,
  now: number,
): Lesson => {
  const staysLocal: Record<string, number> = { ...memory.staysLocal };
  const missing: Record<string, number> = Object.fromEntries(
    Object.entries(memory.missing).filter(([, at]) => recentlyMissing(at, now)),
  );
  const results = run.outcomes.map((outcome): InstallResult => {
    const { id } = outcome.ref;
    switch (outcome.kind) {
      case "missing":
        missing[id] = now;
        return { id, kind: "missing" };
      case "failed":
        return { id, kind: "failed", failure: outcome.failure };
      case "reported":
        delete missing[id];
        if (remote.has(id)) {
          return inWorkspace(outcome.ref, remote)
            ? { id, kind: "installed" }
            : { id, kind: "failed", failure: "different publisher" };
        }
        if (!inUiHost(id)) return { id, kind: "unresolved" };
        staysLocal[staysLocalKey(editor, outcome.ref)] = now;
        return { id, kind: "staysLocal" };
    }
  });
  return { memory: { version: 1, staysLocal, missing }, results };
};
