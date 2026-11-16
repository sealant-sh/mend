/**
 * An invented machine holding T3 Code's state (its database and settings) and the harnesses'
 * homes, in a temp directory, for the reader's and the import command's tests.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";
import { afterEach } from "vitest";

import { readT3ImportCandidates, type T3ImportScanInput } from "../t3-import.ts";

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// The columns T3 Code's migrations give these tables (005_Projections, 055_OrchestrationV2 and
// the Foundation migration's provider_instance_id), with the payloads its projections write.
export const SCHEMA = `
  CREATE TABLE projection_projects (
    project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, archived_at TEXT
  );
  CREATE TABLE orchestration_v2_projection_threads (
    thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
    default_provider TEXT NOT NULL, runtime_mode TEXT NOT NULL, interaction_mode TEXT NOT NULL,
    active_provider_thread_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    archived_at TEXT, deleted_at TEXT, payload_json TEXT NOT NULL, provider_instance_id TEXT
  );
  CREATE TABLE orchestration_v2_projection_provider_threads (
    provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, owner_node_id TEXT,
    provider TEXT NOT NULL, provider_session_id TEXT, status TEXT NOT NULL,
    first_run_ordinal INTEGER, last_run_ordinal INTEGER, updated_at TEXT NOT NULL,
    payload_json TEXT NOT NULL, driver TEXT, provider_instance_id TEXT
  );
  CREATE INDEX orchestration_v2_projection_provider_threads_thread_idx
    ON orchestration_v2_projection_provider_threads(thread_id);
`;

interface ProviderThreadSpec {
  readonly id: string;
  readonly driver: string;
  readonly nativeId: string | null;
  readonly instance?: string;
}

interface ThreadSpec {
  readonly id: string;
  readonly project: string;
  readonly title?: string;
  readonly worktreePath?: string | null;
  readonly branch?: string | null;
  readonly runtimeMode?: string;
  readonly model?: { readonly instance: string; readonly model: string; readonly effort?: string };
  readonly parent?: { readonly id: string; readonly relationship: "subagent" | "fork" };
  readonly archived?: boolean;
  readonly deleted?: boolean;
  readonly providers?: ReadonlyArray<ProviderThreadSpec>;
  /** Defaults to the last provider thread; null records none. */
  readonly active?: string | null;
}

export const write = (file: string, content: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

const git = (cwd: string, ...args: ReadonlyArray<string>): void => {
  execFileSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, stdio: "ignore" });
};

/** A person's machine in a temp directory: home at `<tmp>/Users/ana`, as on macOS. */
export const t3Machine = () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mend-t3-import-")));
  roots.push(tmp);
  const home = path.join(tmp, "Users", "ana");
  const t3Home = path.join(home, ".t3");
  fs.mkdirSync(path.join(t3Home, "userdata"), { recursive: true });
  const databasePath = path.join(t3Home, "userdata", "statev2.sqlite");
  let order = 0;

  const repo = (name: string, origin: string | null): string => {
    const dir = path.join(home, "code", name);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    if (origin !== null) git(dir, "remote", "add", "origin", origin);
    return dir;
  };

  const database = (schema = SCHEMA): DatabaseSync => {
    const db = new DatabaseSync(databasePath);
    if (!fs.existsSync(`${databasePath}.schema`)) {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(schema);
      fs.writeFileSync(`${databasePath}.schema`, "");
    }
    return db;
  };

  const project = (id: string, title: string, root: string): void => {
    const db = database();
    db.prepare(
      "INSERT INTO projection_projects (project_id, title, workspace_root, created_at, updated_at) VALUES (?, ?, ?, '', '')",
    ).run(id, title, root);
    db.close();
  };

  const thread = (spec: ThreadSpec): void => {
    const db = database();
    const providers = spec.providers ?? [];
    const active =
      spec.active === undefined ? (providers.at(-1)?.id ?? null) : (spec.active ?? null);
    const createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, order++)).toISOString();
    const payload = {
      id: spec.id,
      title: spec.title ?? spec.id,
      branch: spec.branch ?? null,
      worktreePath: spec.worktreePath ?? null,
      modelSelection:
        spec.model === undefined
          ? null
          : {
              instanceId: spec.model.instance,
              model: spec.model.model,
              options:
                spec.model.effort === undefined
                  ? []
                  : [
                      { id: "effort", value: spec.model.effort },
                      { id: "reasoningEffort", value: spec.model.effort },
                    ],
            },
      lineage: {
        parentThreadId: spec.parent?.id ?? null,
        relationshipToParent: spec.parent?.relationship ?? null,
        rootThreadId: spec.parent?.id ?? spec.id,
      },
    };
    db.prepare(
      `INSERT INTO orchestration_v2_projection_threads
         (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json)
       VALUES (?, ?, ?, 'claudeAgent', ?, 'default', ?, ?, ?, ?, ?, ?)`,
    ).run(
      spec.id,
      spec.project,
      spec.title ?? spec.id,
      spec.runtimeMode ?? "full-access",
      active,
      createdAt,
      createdAt,
      spec.archived === true ? createdAt : null,
      spec.deleted === true ? createdAt : null,
      JSON.stringify(payload),
    );
    for (const provider of providers) {
      const instance = provider.instance ?? provider.driver;
      db.prepare(
        `INSERT INTO orchestration_v2_projection_provider_threads
           (provider_thread_id, thread_id, provider, status, updated_at, payload_json)
         VALUES (?, ?, ?, 'idle', '', ?)`,
      ).run(
        provider.id,
        spec.id,
        instance,
        JSON.stringify({
          id: provider.id,
          driver: provider.driver,
          providerInstanceId: instance,
          nativeThreadRef: {
            driver: provider.driver,
            nativeId: provider.nativeId,
            strength: "strong",
          },
        }),
      );
    }
    db.close();
  };

  const scan = (input: Omit<T3ImportScanInput, "t3Home" | "homeDirectory"> = {}) =>
    Effect.runPromise(
      readT3ImportCandidates({
        t3Home,
        homeDirectory: home,
        environment: {},
        ...input,
      }),
    );

  const scanError = (input: Partial<T3ImportScanInput> = {}) =>
    Effect.runPromise(
      Effect.flip(
        readT3ImportCandidates({ t3Home, homeDirectory: home, environment: {}, ...input }),
      ),
    );

  return { home, t3Home, databasePath, repo, database, project, thread, scan, scanError };
};

export const claudeId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const codexId = (n: number) => `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
export const rollout = (id: string, ancestor: string | null): string =>
  `${JSON.stringify({
    type: "session_meta",
    payload: {
      id,
      ...(ancestor === null
        ? {}
        : { history_mode: "paginated", history_base: { thread_id: ancestor } }),
    },
  })}\n{"type":"event_msg"}\n`;
