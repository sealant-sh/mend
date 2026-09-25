import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The branch the saved repository names; deleted on the fixture before the degraded launch. */
export const DOTFILES_REF = "dotfiles-proof";
/** The repository's home tree lives here, as the alpha owner's does (`dots/`). */
export const DOTFILES_SUBDIRECTORY = "dots";
/**
 * Ubuntu, because it runs natively on both acceptance runners: Sealant builds the Arch family with
 * `--platform linux/amd64`, which on ubuntu-24.04-arm is emulation. zsh, so the login shell is not
 * the default one. No packages and no Docker service: nothing the dotfiles proof does not need.
 */
export const DOTFILES_WORKSPACE_IMAGE = {
  mode: "family",
  os: "ubuntu",
  packages: [],
  shell: "zsh",
  services: { docker: false },
};
const probePrefix = "mend-dotfiles-proof";

function requireFact(condition, message) {
  // Never include process output, API bodies or assertion diffs in diagnostics.
  assert.ok(condition, message);
}

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * The dotfiles repository, shaped like the tree that exposed sealantd's stow detection on alpha:
 * dot entries (`.config/`, `.gitconfig`, `.tmux.conf`, `.zshenv`) beside package-looking
 * directories (`bin/`, `legacy/`, `Library/`) and a loose `Brewfile`, all under `dots/`, with a
 * root file that must not land because the archive is re-rooted at the subdirectory. `.zshrc` is
 * also in the snapshot, which must win. `install.sh` is the bootstrap: it proves it ran, and ran
 * with HOME set.
 */
export function dotfilesRepositoryFiles(marker) {
  const home = (path, contents, mode = 0o644) => ({
    path: `${DOTFILES_SUBDIRECTORY}/${path}`,
    home: path,
    contents,
    mode,
  });
  return [
    { path: "README.md", home: null, contents: "Not part of the home tree.\n", mode: 0o644 },
    home(
      ".zshrc",
      "# The synced snapshot replaces this file.\nexport MEND_DOTFILES_PROOF=repository\n",
    ),
    home(".zshenv", `export MEND_DOTFILES_ZSHENV=${marker}\n`),
    home(".gitconfig", "[user]\n\tname = Dotfiles Acceptance\n"),
    home(".tmux.conf", "set -g mouse on\n"),
    home(".config/mend-repo/config", `repository ${marker}\n`),
    home("bin/mend-proof", `#!/bin/sh\necho ${marker}\n`, 0o755),
    home("legacy/notes.txt", `legacy ${marker}\n`),
    home("Library/Preferences/mend-proof.plist", `library ${marker}\n`),
    home("Brewfile", 'brew "git"\n'),
    home(
      "install.sh",
      '#!/bin/sh\nset -eu\nprintf \'%s\\n\' "$HOME" > "$HOME/.mend-bootstrap-proof"\n',
      0o755,
    ),
  ];
}

/** Files `mend dotfiles sync` uploads from a HOME of their own; `.zshrc` overrides the repo's. */
export function dotfilesSnapshotFiles(marker) {
  return [
    { path: ".zshrc", contents: `export MEND_DOTFILES_PROOF=${marker}\n`, mode: 0o644 },
    { path: ".config/mend-proof/config", contents: `snapshot ${marker}\n`, mode: 0o644 },
  ];
}

/** Every home path the probe reports on, in a fixed order. */
export function dotfilesProbePaths(marker) {
  return [
    ...dotfilesRepositoryFiles(marker).flatMap((file) => (file.home === null ? [] : [file.home])),
    ...dotfilesSnapshotFiles(marker).map((file) => file.path),
    ".mend-bootstrap-proof",
    "README.md",
    DOTFILES_SUBDIRECTORY,
  ].filter((path, index, all) => all.indexOf(path) === index);
}

/**
 * The session's command: facts about `home` (/root, where sealantd applies dotfiles), one
 * `mend-dotfiles-proof <key> <value>` line each, and nothing judged in the workspace. It always
 * exits 0, so a missing file is a named fact here, not a failed session. zsh proves the synced
 * `.zshrc` is the one an interactive shell of that home loads.
 */
export function dotfilesProbeScript(paths, home = "/root") {
  for (const path of [...paths, home])
    requireFact(/^[A-Za-z0-9._/-]+$/.test(path), "Probe paths must be plain paths");
  const zshrc = `${home}/.mend-dotfiles-zshrc-probe`;
  return [
    `h=${home}`,
    `p() { printf '${probePrefix} %s %s\\n' "$1" "$2"; }`,
    'p uid "$(id -u)"',
    `for f in ${paths.join(" ")}; do`,
    '  if [ -f "$h/$f" ]; then p "file:$f" "$(sha256sum "$h/$f" | cut -d " " -f 1)";',
    '  elif [ -e "$h/$f" ]; then p "file:$f" present-not-file;',
    '  else p "file:$f" absent; fi',
    "done",
    'if [ -x "$h/bin/mend-proof" ]; then p exec:bin/mend-proof yes; else p exec:bin/mend-proof no; fi',
    'p shell "$(getent passwd root | cut -d : -f 7)"',
    `rm -f ${zshrc}`,
    "if command -v zsh >/dev/null 2>&1; then",
    `  HOME="$h" zsh -ic 'printf %s "\${MEND_DOTFILES_PROOF:-unset}" > ${zshrc}' </dev/null >/dev/null 2>&1 || true`,
    "fi",
    `if [ -s ${zshrc} ]; then p zshrc "$(cat ${zshrc})"; else p zshrc none; fi`,
    `rm -f ${zshrc}`,
    "p done 1",
  ].join("\n");
}

/**
 * The probe's facts from the session's record, as a Map. Terminal output may carry `\r`; a key
 * reported twice with different values, or a record without the closing `done`, is refused.
 */
export function dotfilesProbeFacts(text) {
  const facts = new Map();
  for (const match of text.matchAll(new RegExp(`^${probePrefix} (\\S+) (\\S*)\\r?$`, "gm"))) {
    const [, key, value] = match;
    requireFact(
      !facts.has(key) || facts.get(key) === value,
      `The dotfiles probe reported ${key} twice with different values`,
    );
    facts.set(key, value);
  }
  requireFact(facts.get("done") === "1", "The dotfiles probe did not finish in the session record");
  return facts;
}

/**
 * What the probe must report. `repository: true` is a launch with both archives: the repository's
 * home tree copied to /root, its bootstrap run, and the snapshot applied after it. `false` is a
 * launch whose repository clone failed: the snapshot alone, and nothing of the repository's.
 */
export function expectedDotfilesFacts(marker, { repository, home = "/root" }) {
  const expected = new Map([
    ["uid", "0"],
    ["shell", "/usr/bin/zsh"],
    ["zshrc", marker],
  ]);
  const snapshot = new Map(dotfilesSnapshotFiles(marker).map((file) => [file.path, file]));
  for (const file of dotfilesRepositoryFiles(marker)) {
    if (file.home === null || snapshot.has(file.home)) continue;
    expected.set(`file:${file.home}`, repository ? sha256(file.contents) : "absent");
  }
  for (const file of snapshot.values()) expected.set(`file:${file.path}`, sha256(file.contents));
  expected.set("file:.mend-bootstrap-proof", repository ? sha256(`${home}\n`) : "absent");
  expected.set("exec:bin/mend-proof", repository ? "yes" : "no");
  // The archive is re-rooted at the subdirectory: its contents land, the directory and the
  // repository's root files do not.
  expected.set("file:README.md", "absent");
  expected.set(`file:${DOTFILES_SUBDIRECTORY}`, "absent");
  return expected;
}

const inWords = (value) =>
  value === "absent" ? "absent" : /^[0-9a-f]{64}$/.test(value) ? "the fixture's contents" : value;

/** Names the first fact that differs, with what was expected in words, never raw output. */
export function assertDotfilesFacts(observed, expected, when) {
  for (const [key, value] of expected)
    requireFact(
      observed.get(key) === value,
      `${when}: the workspace reported ${key} ${observed.has(key) ? "differently" : "not at all"}; expected ${inWords(value)}`,
    );
}

/**
 * The session detail's record of its dotfiles: the repository url+ref it tried, the snapshot sha
 * it applied, and what it left out. `notApplied` is `[]` or `["repository"]`.
 */
export function sessionDotfilesEvidence(session, { url, ref, snapshotSha, notApplied }) {
  const dotfiles = session?.dotfiles;
  requireFact(
    dotfiles !== null && typeof dotfiles === "object",
    "The session must report the dotfiles it launched with",
  );
  requireFact(
    dotfiles.repository?.url === url && dotfiles.repository.ref === ref,
    "The session must name the dotfiles repository url and ref it tried",
  );
  requireFact(
    dotfiles.snapshotSha === snapshotSha,
    "The session must name the exact dotfiles snapshot it applied",
  );
  requireFact(
    Array.isArray(dotfiles.notApplied) &&
      dotfiles.notApplied.length === notApplied.length &&
      dotfiles.notApplied.every(
        (entry, index) =>
          entry?.source === notApplied[index] &&
          typeof entry.reason === "string" &&
          entry.reason.length > 0,
      ),
    notApplied.length === 0
      ? "The session must report no dotfiles source left out"
      : `The session must report the ${notApplied.join(" and ")} as not applied, with a reason`,
  );
  return dotfiles;
}

async function writeTree(root, files) {
  for (const file of files) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, file.contents, { mode: file.mode, flag: "wx" });
  }
}

/**
 * Dotfiles against the real packaged instance, through the installed CLI and the public API:
 * `mend dotfiles sync` from a HOME of its own, `mend dotfiles repo` pointed at a repository the
 * network Git fixture serves (manager copy, a subdirectory, a bootstrap), a project on a family
 * image with zsh, a session whose command reports /root, and a second launch after the saved ref
 * was deleted, which must launch without the repository and say so.
 *
 * await runPackagedDotfilesAcceptance({ cli, startCli, docker, run, until, api, scratch,
 *   environment, fixtureId, fixtureOrigin, sourceUrl, runId })
 *
 * Callbacks match check-packaged-server.mjs: cli/run/docker resolve stdout and reject a failed
 * process; startCli returns { result, terminate } and never rejects. `fixtureId` is the running
 * HTTP Git fixture container (its repositories live under /fixture) and `fixtureOrigin` its
 * address on the installation's network.
 */
export async function runPackagedDotfilesAcceptance({
  cli,
  startCli,
  docker,
  run,
  until,
  api,
  scratch,
  environment,
  fixtureId,
  fixtureOrigin,
  sourceUrl,
  runId,
}) {
  const marker = `dotfiles-${runId}`;
  const projectName = `acceptance-dotfiles-${runId}`;

  // ── the repository, served by the fixture over smart HTTP ────────────────
  const source = join(scratch, "dotfiles-source");
  await mkdir(source, { mode: 0o700 });
  const git = (args, cwd = source) => run("git", args, { cwd });
  await git(["init", "-b", "main"]);
  await writeTree(source, dotfilesRepositoryFiles(marker));
  await git(["add", "."]);
  await git([
    "-c",
    "user.name=Acceptance",
    "-c",
    "user.email=acceptance@example.invalid",
    "commit",
    "-m",
    "dotfiles fixture",
  ]);
  await git(["branch", DOTFILES_REF]);
  const bare = join(scratch, "dots.git");
  await git(["clone", "--bare", source, bare]);
  await docker(["cp", bare, `${fixtureId}:/fixture/dots.git`]);
  const url = `${fixtureOrigin}/dots.git`;

  // ── the snapshot, synced by the installed CLI from its own HOME ──────────
  const home = join(scratch, "dotfiles-home");
  await mkdir(home, { mode: 0o700 });
  const snapshotFiles = dotfilesSnapshotFiles(marker);
  await writeTree(home, snapshotFiles);
  await cli(["dotfiles", "sync", ...snapshotFiles.map((file) => file.path)], {
    environment: { ...environment, HOME: home },
  });
  const synced = await api("/dotfiles");
  requireFact(
    /^[0-9a-f]{40}$/.test(synced.snapshot?.sha ?? "") &&
      synced.snapshot.files
        .map((file) => file.path)
        .toSorted()
        .join(",") ===
        snapshotFiles
          .map((file) => file.path)
          .toSorted()
          .join(","),
    "mend dotfiles sync must store exactly the named files as one snapshot",
  );
  const snapshotSha = synced.snapshot.sha;

  // ── the repository, saved by the installed CLI (the server clones it once to check) ──
  // TODO(sealantd auto detection): once the pinned Sealant ships a sealantd whose auto manager
  // resolves this mixed tree (dot entries beside package directories) to copy instead of stow,
  // save it with `--manager auto` as well and expect the same facts. Sealant 0.37.0 carries
  // sealantd 0.18.1, which stows `bin/`, `legacy/` and `Library/` and drops every dot entry.
  await cli(
    [
      "dotfiles",
      "repo",
      url,
      "--ref",
      DOTFILES_REF,
      "--subdirectory",
      DOTFILES_SUBDIRECTORY,
      "--manager",
      "copy",
    ],
    { timeout: 180_000 },
  );
  const saved = await api("/dotfiles");
  requireFact(
    saved.repository?.url === url &&
      saved.repository.ref === DOTFILES_REF &&
      saved.repository.subdirectory === DOTFILES_SUBDIRECTORY &&
      saved.repository.manager === "copy" &&
      saved.repository.bootstrap === true &&
      saved.snapshot?.sha === snapshotSha,
    "mend dotfiles repo must save the repository exactly as typed, beside the synced snapshot",
  );
  requireFact(
    (await cli(["dotfiles"])).includes("manager copy"),
    "mend dotfiles must show the repository's manager",
  );
  console.log(
    "PASS mend dotfiles sync stored a snapshot and mend dotfiles repo saved a repository the server cloned over smart HTTP",
  );

  // ── a project on a family image with zsh; dotfiles apply by default ──────
  await cli(["adopt", sourceUrl, "--name", projectName], { timeout: 180_000 });
  const project = (await api("/projects")).find((item) => item.name === projectName);
  requireFact(
    project !== undefined && project.applyDotfiles === true,
    "A newly adopted project must apply its owner's dotfiles",
  );
  const image = await api(`/projects/${project.id}/workspace-image`, {
    method: "PUT",
    body: { workspaceImage: DOTFILES_WORKSPACE_IMAGE },
  });
  requireFact(image.saved === true, "Public API must accept the ubuntu family image with zsh");

  const probe = dotfilesProbeScript(dotfilesProbePaths(marker));
  const launch = async (name, timeout) => {
    const launched = startCli(
      ["run", "--project", projectName, "--name", name, "--", "sh", "-c", probe],
      { timeout },
    );
    const session = await until(
      `dotfiles session ${name}`,
      async () =>
        (await api(`/projects/${project.id}?deadEnds=include`)).sessions?.find(
          (item) => item.branch === `mend/${name}`,
        ),
      timeout,
    );
    const detail = await until(
      `dotfiles session ${name} to complete`,
      async () => {
        const current = await api(`/sessions/${session.id}`);
        requireFact(
          current.session.status !== "failed",
          `Dotfiles session ${name} failed; inspect private owned-container diagnostics`,
        );
        return current.session.status === "completed" && current.currentAgent?.status === "exited"
          ? current
          : false;
      },
      timeout,
    );
    requireFact(
      (await launched.result).ok,
      `mend run for dotfiles session ${name} must finish through the real record stream`,
    );
    return { detail, facts: dotfilesProbeFacts(await recordText(api, detail)) };
  };

  // ── launch 1: both archives ──────────────────────────────────────────────
  // The first launch builds the family image, so it gets the longest bound.
  const first = await launch("dotfiles-proof", 1_200_000);
  sessionDotfilesEvidence(first.detail.session, {
    url,
    ref: DOTFILES_REF,
    snapshotSha,
    notApplied: [],
  });
  assertDotfilesFacts(
    first.facts,
    expectedDotfilesFacts(marker, { repository: true }),
    "Dotfiles launch",
  );
  console.log(
    "PASS dotfiles on an ubuntu family image: repository tree copied from dots/ to /root with its bootstrap run, snapshot applied over it, zsh the login shell loading the synced .zshrc, session names repository ref and snapshot sha",
  );

  // ── launch 2: the saved ref is gone from the remote ──────────────────────
  await docker([
    "exec",
    fixtureId,
    "git",
    "-c",
    "safe.directory=*",
    "-C",
    "/fixture/dots.git",
    "update-ref",
    "-d",
    `refs/heads/${DOTFILES_REF}`,
  ]);
  const second = await launch("dotfiles-degraded", 600_000);
  sessionDotfilesEvidence(second.detail.session, {
    url,
    ref: DOTFILES_REF,
    snapshotSha,
    notApplied: ["repository"],
  });
  assertDotfilesFacts(
    second.facts,
    expectedDotfilesFacts(marker, { repository: false }),
    "Dotfiles launch without its repository",
  );
  console.log(
    "PASS a dotfiles repository whose ref is gone costs no launch: the session applied the snapshot alone and reports the repository not applied",
  );
}

/** The session's process output from the durable record, every page. */
async function recordText(api, detail) {
  let from = "0";
  let text = "";
  for (let page = 0; page < 100; page++) {
    const logs = await api(`/processes/${detail.currentAgent.id}/logs?from=${from}&limit=500`);
    requireFact(
      logs.sealantRunId === detail.session.sealantRunId && Array.isArray(logs.chunks),
      "Process logs must identify the session run",
    );
    if (logs.chunks.length === 0) return text;
    text += logs.chunks
      .map((chunk) => Buffer.from(chunk.dataBase64, "base64").toString("utf8"))
      .join("");
    requireFact(BigInt(logs.nextFrom) > BigInt(from), "Record cursor must advance");
    from = logs.nextFrom;
  }
  requireFact(false, "Record exceeded acceptance's bounded page budget");
}
