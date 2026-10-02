import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { claudeMemoryDirFor, scanClaudeMemory, scanCodexMemory } from "./agent-memory.ts";

const dirs: Array<string> = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("reading this machine's Claude memory for a repository", () => {
  it("finds the directory Claude keeps for the checkout and reads it at a session's paths", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-claude-home-"));
    dirs.push(home);
    const memory = path.join(home, "projects", "-home-you-code-my-app", "memory");
    fs.mkdirSync(path.join(memory, "topics"), { recursive: true });
    fs.writeFileSync(path.join(memory, "MEMORY.md"), "- [build](topics/build.md)\n");
    fs.writeFileSync(path.join(memory, "topics", "build.md"), "pnpm, not npm\n");
    fs.mkdirSync(path.join(home, "projects", "-home-you-code-other", "memory"), {
      recursive: true,
    });

    // `my_app` and `my.app` both key to `my-app`.
    expect(claudeMemoryDirFor("/home/you/code/my_app", home)).toBe(memory);
    expect(claudeMemoryDirFor("/home/you/code/my.app", home)).toBe(memory);
    expect(claudeMemoryDirFor("/home/you/code/absent", home)).toBeNull();

    expect(scanClaudeMemory(memory).files).toEqual([
      {
        path: ".claude/projects/-workspace-repo/memory/MEMORY.md",
        encoding: "utf8",
        contents: "- [build](topics/build.md)\n",
      },
      {
        path: ".claude/projects/-workspace-repo/memory/topics/build.md",
        encoding: "utf8",
        contents: "pnpm, not npm\n",
      },
    ]);
  });
});

describe("reading this machine's Codex memory for a repository", () => {
  const codexHome = () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "mend-codex-home-"));
    dirs.push(home);
    const state = new DatabaseSync(path.join(home, "state_5.sqlite"));
    state.exec(
      "create table threads (id text primary key, cwd text not null, rollout_path text not null)",
    );
    const rollout = (thread: string) => {
      const file = path.join(home, "sessions", `rollout-${thread}.jsonl`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(
        file,
        `{"type":"session_meta","payload":{"id":"${thread}"}}\n{"type":"x"}\n`,
      );
      return file;
    };
    const thread = state.prepare("insert into threads values (?, ?, ?)");
    thread.run("in-repo", "/home/you/code/my-app", rollout("in-repo"));
    thread.run("in-subdir", "/home/you/code/my-app/packages/api", rollout("in-subdir"));
    thread.run("elsewhere", "/home/you/code/my-app-two", rollout("elsewhere"));
    state.close();
    const memories = new DatabaseSync(path.join(home, "memories_1.sqlite"));
    memories.exec(
      "create table _sqlx_migrations (version bigint primary key, description text not null, installed_on timestamp not null default current_timestamp, success boolean not null, checksum blob not null, execution_time bigint not null)",
    );
    memories.exec("insert into _sqlx_migrations values (1, 'init', 0, 1, x'00', 1)");
    memories.exec(
      "create table stage1_outputs (thread_id text primary key, source_updated_at integer not null, raw_memory text not null, rollout_summary text not null, rollout_slug text, generated_at integer not null, usage_count integer, last_usage integer, selected_for_phase2 integer not null default 0, selected_for_phase2_source_updated_at integer)",
    );
    const output = memories.prepare(
      "insert into stage1_outputs values (?, 1, ?, 's', null, 1, null, null, 1, 1)",
    );
    output.run("in-repo", "uses pnpm");
    output.run("in-subdir", "api on 3101");
    output.run("elsewhere", "another repository's secret");
    memories.exec(
      "create table consolidation_progress (singleton integer primary key, max_thread_count integer not null default 0)",
    );
    memories.exec("insert into consolidation_progress values (1, 0)");
    memories.close();
    return home;
  };

  it("keeps only the summaries of conversations held in the repository, unselected", () => {
    const home = codexHome();
    const scan = scanCodexMemory("/home/you/code/my-app", home);
    expect(scan.summaries).toBe(2);
    // The database, and each summarised conversation's first line for its stub.
    expect(scan.files.map((file) => file.path)).toEqual([
      ".codex/memories_1.sqlite",
      ".mend/codex-threads/in-repo.jsonl",
      ".mend/codex-threads/in-subdir.jsonl",
    ]);
    expect(scan.files[1]?.contents).toBe('{"type":"session_meta","payload":{"id":"in-repo"}}\n');
    const copy = path.join(home, "copy.sqlite");
    fs.writeFileSync(copy, Buffer.from(scan.files[0]?.contents ?? "", "base64"));
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      expect(
        db
          .prepare("select thread_id, selected_for_phase2 from stage1_outputs order by thread_id")
          .all(),
      ).toEqual([
        { thread_id: "in-repo", selected_for_phase2: 0 },
        { thread_id: "in-subdir", selected_for_phase2: 0 },
      ]);
      expect(db.prepare("select count(*) as n from _sqlx_migrations").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it("finds nothing for a repository Codex never worked in, or without Codex at all", () => {
    expect(scanCodexMemory("/home/you/code/unknown", codexHome()).files).toEqual([]);
    expect(scanCodexMemory("/home/you/code/my-app", "/nonexistent/codex").files).toEqual([]);
  });
});
