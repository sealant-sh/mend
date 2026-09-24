import type { DotfilesCloner } from "@mend/sessions";
import { Effect } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createTenancyApi, type TenancyApi } from "../../test/support/tenancy-api.ts";
import type { HarnessUser } from "../../test/support/tenancy-harness.ts";

/**
 * The dotfiles routes over the real store (docs/adr/0003): dotfiles are identity, so every route
 * acts as the authenticated account and nobody else's repository or snapshot is ever read,
 * changed or shown. A save tries the clone as the caller.
 */

/** Every clone a save asked for, as `<account> <url>`; the clone itself always succeeds. */
const clones: Array<string> = [];
const cloner: DotfilesCloner["Service"] = {
  archive: (ownerUserId, repository) =>
    Effect.sync(() => {
      clones.push(`${ownerUserId} ${repository.url}`);
      return { data: "", manager: repository.manager, bootstrap: repository.bootstrap };
    }),
};

const file = (path: string, contents: string | Buffer) => ({
  path,
  contentsBase64: Buffer.from(contents).toString("base64"),
});

const repositoryOf = (url: string) => ({
  url,
  ref: null,
  subdirectory: null,
  manager: "auto",
  bootstrap: true,
});

interface View {
  readonly repository: ReturnType<typeof repositoryOf> | null;
  readonly snapshot: {
    readonly sha: string;
    readonly source: string;
    readonly files: ReadonlyArray<{ readonly path: string; readonly bytes: number }>;
  } | null;
}

const isView = (value: unknown): value is View =>
  typeof value === "object" && value !== null && "repository" in value && "snapshot" in value;

const send = async (
  api: TenancyApi,
  user: HarnessUser,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly body: unknown }> => {
  const response = await api.request(user, method, `/api${path}`, body);
  return { status: response.status, body: await response.json() };
};

/** A request the route must answer with the caller's dotfiles. */
const viewOf = async (
  api: TenancyApi,
  user: HarnessUser,
  method: string,
  path: string,
  body?: unknown,
): Promise<View> => {
  const result = await send(api, user, method, path, body);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  if (!isView(result.body)) throw new Error(`not a dotfiles view: ${JSON.stringify(result.body)}`);
  return result.body;
};

const snapshotFiles = (view: View) => view.snapshot?.files.map((entry) => entry.path) ?? null;

const sync = (files: ReadonlyArray<ReturnType<typeof file>>, merge = false) => ({
  files,
  source: "laptop",
  merge,
});

describe("dotfiles routes on a single-tenant instance", () => {
  let api: TenancyApi;
  beforeAll(async () => {
    api = await createTenancyApi({}, { dotfiles: { cloner } });
  });
  afterAll(async () => {
    await api.dispose();
  });
  afterEach(async () => {
    clones.length = 0;
    for (const user of ["alice", "carol", "bob"] as const) {
      await send(api, user, "PUT", "/dotfiles/repository", { repository: null });
      await send(api, user, "DELETE", "/dotfiles/snapshot");
    }
  });

  it("each account reads and changes only its own dotfiles", async () => {
    const url = "https://github.com/alice/dots.git";
    const saved = await viewOf(api, "alice", "PUT", "/dotfiles/repository", {
      repository: repositoryOf(url),
    });
    expect(saved.repository).toEqual(repositoryOf(url));
    expect(clones).toEqual([`alice ${url}`]);
    const synced = await viewOf(
      api,
      "alice",
      "POST",
      "/dotfiles/snapshot",
      sync([file(".zshrc", "export EDITOR=vim\n")]),
    );
    expect(synced.snapshot).toMatchObject({
      source: "laptop",
      files: [{ path: ".zshrc", bytes: 18 }],
    });

    // A member of the same organization and the owner of another see nothing of alice's.
    for (const user of ["carol", "bob"] as const) {
      expect(await viewOf(api, user, "GET", "/dotfiles")).toEqual({
        repository: null,
        snapshot: null,
      });
    }

    // Bob's own sync and clear leave alice's snapshot exactly as it was.
    await viewOf(api, "bob", "POST", "/dotfiles/snapshot", sync([file(".vimrc", "set nu\n")]));
    await viewOf(api, "bob", "DELETE", "/dotfiles/snapshot");
    const alice = await viewOf(api, "alice", "GET", "/dotfiles");
    expect(alice.repository).toEqual(repositoryOf(url));
    expect(alice.snapshot?.sha).toBe(synced.snapshot?.sha);
    expect(snapshotFiles(alice)).toEqual([".zshrc"]);
  });

  it("a merge overlays the current snapshot; a sync without merge replaces it", async () => {
    await viewOf(
      api,
      "carol",
      "POST",
      "/dotfiles/snapshot",
      sync([file(".zshrc", "a\n"), file(".gitconfig", "[user]\n")]),
    );
    const merged = await viewOf(
      api,
      "carol",
      "POST",
      "/dotfiles/snapshot",
      sync([file(".config/starship.toml", "add_newline = false\n"), file(".zshrc", "b\n")], true),
    );
    expect(snapshotFiles(merged)).toEqual([".config/starship.toml", ".gitconfig", ".zshrc"]);
    expect(merged.snapshot?.files.find((entry) => entry.path === ".zshrc")?.bytes).toBe(2);

    const replaced = await viewOf(
      api,
      "carol",
      "POST",
      "/dotfiles/snapshot",
      sync([file(".tmux.conf", "set -g mouse on\n")]),
    );
    expect(snapshotFiles(replaced)).toEqual([".tmux.conf"]);
  });

  it.each([
    ["a file over 1MB", [file(".big", Buffer.alloc(1024 * 1024 + 1))], /^\.big is over 1MB/],
    [
      "more than 4MB in all",
      [0, 1, 2, 3, 4].map((index) => file(`.part${index}`, Buffer.alloc(1024 * 1024))),
      /^snapshot exceeds the 4MB cap/,
    ],
    ["a path above home", [file("../outside", "x")], /non-home-relative path: \.\.\/outside$/],
    ["an absolute path", [file("/etc/profile", "x")], /non-home-relative path: \/etc\/profile$/],
    [
      "a path that climbs out midway",
      [file(".config/../../outside", "x")],
      /non-home-relative path: \.config\/\.\.\/\.\.\/outside$/,
    ],
    ["an empty segment", [file(".config//x", "x")], /non-home-relative path: \.config\/\/x$/],
    ["a dot segment", [file("./.zshrc", "x")], /non-home-relative path: \.\/\.zshrc$/],
  ])("refuses %s and keeps the snapshot it had", async (_label, files, message) => {
    const before = await viewOf(
      api,
      "carol",
      "POST",
      "/dotfiles/snapshot",
      sync([file(".zshrc", "kept\n")]),
    );
    const refused = await send(api, "carol", "POST", "/dotfiles/snapshot", sync(files, true));
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({
      _tag: "SettingsFailure",
      message: expect.stringMatching(message),
    });
    const after = await viewOf(api, "carol", "GET", "/dotfiles");
    expect(after.snapshot?.sha).toBe(before.snapshot?.sha);
    expect(snapshotFiles(after)).toEqual([".zshrc"]);
  });

  it("clearing the snapshot keeps the repository, and clearing the repository keeps the snapshot", async () => {
    const url = "https://github.com/carol/dots.git";
    await viewOf(api, "carol", "PUT", "/dotfiles/repository", { repository: repositoryOf(url) });
    await viewOf(api, "carol", "POST", "/dotfiles/snapshot", sync([file(".zshrc", "x\n")]));

    const cleared = await viewOf(api, "carol", "DELETE", "/dotfiles/snapshot");
    expect(cleared).toEqual({ repository: repositoryOf(url), snapshot: null });

    await viewOf(api, "carol", "POST", "/dotfiles/snapshot", sync([file(".zshrc", "x\n")]));
    const unset = await viewOf(api, "carol", "PUT", "/dotfiles/repository", { repository: null });
    expect(unset.repository).toBeNull();
    expect(snapshotFiles(unset)).toEqual([".zshrc"]);
    // Clearing tries no clone.
    expect(clones).toEqual([`carol ${url}`]);
  });
});

describe("dotfiles routes on a multi-tenant instance", () => {
  let api: TenancyApi;
  beforeAll(async () => {
    api = await createTenancyApi({}, { dotfiles: { cloner }, tenancy: "multi" });
  });
  afterAll(async () => {
    await api.dispose();
  });
  afterEach(() => {
    clones.length = 0;
  });

  it("a member who is not the operator manages their own dotfiles", async () => {
    const url = "https://github.com/carol/dots.git";
    const saved = await viewOf(api, "carol", "PUT", "/dotfiles/repository", {
      repository: repositoryOf(url),
    });
    expect(saved.repository).toEqual(repositoryOf(url));
    // The clone a save tries is carol's own, never the operator's.
    expect(clones).toEqual([`carol ${url}`]);

    const synced = await viewOf(
      api,
      "carol",
      "POST",
      "/dotfiles/snapshot",
      sync([file(".gitconfig", "[user]\n")]),
    );
    expect(snapshotFiles(synced)).toEqual([".gitconfig"]);
    expect(await viewOf(api, "carol", "DELETE", "/dotfiles/snapshot")).toEqual({
      repository: repositoryOf(url),
      snapshot: null,
    });
    // Alice, carol's organization owner and the instance operator, sees none of it.
    expect(await viewOf(api, "alice", "GET", "/dotfiles")).toEqual({
      repository: null,
      snapshot: null,
    });
  });

  it("refuses an unauthenticated git:// repository for a tenant, before any clone", async () => {
    const refused = await send(api, "carol", "PUT", "/dotfiles/repository", {
      repository: repositoryOf("git://github.com/carol/dots.git"),
    });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({
      message: "git:// is unauthenticated and unencrypted; use HTTPS or SSH.",
    });
    expect(clones).toEqual([]);
  });
});
