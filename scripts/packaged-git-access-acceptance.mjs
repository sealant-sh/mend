import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const port = 2222;
const repositories = ["repo.git", "bridge-first.git", "bridge-second.git"];
const pushBranch = "packaged-proof-push";
const refreshBranch = "packaged-refresh-proof";
const pushEvidence = "/tmp/mend-acceptance-push.log";
const processTimeout = 5000;

function requireFact(condition, message) {
  // Never include process output, API bodies, key material or assertion diffs in diagnostics.
  assert.ok(condition, message);
}

/** One OpenSSH ed25519 public key line, with its optional comment; nothing else may be authorized. */
export function ed25519PublicKey(line) {
  const match = /^(ssh-ed25519) ([A-Za-z0-9+/]+={0,2})(?: ([^\r\n]*))?$/.exec(line);
  requireFact(match !== null, "A git access key must be one ssh-ed25519 public key line");
  const bytes = Buffer.from(match[2], "base64");
  requireFact(
    bytes.toString("base64") === match[2] &&
      bytes.length === 51 &&
      bytes.readUInt32BE(0) === 11 &&
      bytes.subarray(4, 15).toString() === "ssh-ed25519",
    "A git access public key has an invalid ed25519 encoding",
  );
  return `${match[1]} ${match[2]}`;
}

/** The SHA256 fingerprint from `ssh-keygen -lf`: "256 SHA256:<base64> <comment> (ED25519)". */
export function keygenFingerprint(output) {
  const match = /^256 (SHA256:[A-Za-z0-9+/]{43}) .*\(ED25519\)\n?$/.exec(output);
  requireFact(match !== null, "ssh-keygen must describe exactly one ed25519 key");
  return match[1];
}

/**
 * Fingerprints sshd accepted for a completed `git` login, in log order. Only the "Accepted
 * publickey" line counts: "Accepted key … found at" is the query phase, before any signature.
 */
export function acceptedFingerprints(log) {
  return [
    ...log.matchAll(
      /^Accepted publickey for git from [0-9a-f.:]+ port [0-9]+ ssh2: ED25519 (SHA256:[A-Za-z0-9+/]{43})$/gm,
    ),
  ].map((match) => match[1]);
}

/**
 * Git access through the installed CLI against an SSH git remote, which is what a git host is to
 * Mend (docs/GIT-ACCESS.md): `keys init` / `keys show`, adoption signed by the account's Mend key,
 * `refresh`, the ssh-agent bridge through `keys share`, and a push from inside a session.
 *
 * await preparePackagedGitAccessAcceptance({ cli, startCli, docker, startDocker, run, start, until, api, own,
 *   scratch, fixtures, runId, name, network, bare, baseSha, environment })
 *   -> { project, image, containerId, pushCommand, pushEvidence, verifyPush, mendKeySignatures,
 *        assertKeyUnchanged }
 *
 * Callbacks match check-packaged-server.mjs. cli(args) and run(command, args, options) resolve
 * stdout and reject an unsuccessful process; startCli(args, options), startDocker(args, options)
 * and start(command, args, options) return { result, terminate } and never reject, so an expected refusal is observed
 * rather than thrown. own(id) registers a container for the parent's cleanup; the parent also
 * removes `image`. `environment` is the isolated client environment: it carries no agent socket,
 * and only `keys share` receives one.
 *
 * Every adoption is proven on both sides: the public API reports the project, and the remote's
 * sshd log names the fingerprint that signed. An adoption that succeeds with the wrong signer
 * fails here.
 */
export async function preparePackagedGitAccessAcceptance({
  cli,
  startCli,
  docker,
  startDocker,
  run,
  start,
  until,
  api,
  own,
  scratch,
  fixtures,
  runId,
  name,
  network,
  bare,
  baseSha,
  environment,
}) {
  requireFact(
    /^[a-z0-9][a-z0-9-]*$/.test(name) && /^[a-f0-9]{40}$/.test(baseSha),
    "Git access acceptance requires a DNS-safe fixture name and the fixture's base commit",
  );
  const image = `mend-acceptance-git-ssh:${runId}`;
  const label = `sh.sealant.mend.acceptance=${runId}`;
  await docker(["build", "--quiet", "--label", label, "--tag", image, fixtures], {
    timeout: 600_000,
  });
  const containerId = (
    await docker(["create", "--name", name, "--label", label, "--network", network, image])
  ).trim();
  requireFact(
    /^[a-f0-9]{64}$/.test(containerId),
    "Docker must return an immutable SSH remote container ID",
  );
  own(containerId);
  for (const repository of repositories)
    await docker(["cp", bare, `${containerId}:/srv/git/${repository}`]);
  await docker(["start", containerId]);
  await docker(["exec", containerId, "chown", "-R", "git:git", "/srv/git"]);
  await until(
    "SSH git remote",
    async () =>
      (await startDocker(["exec", containerId, "nc", "-z", "127.0.0.1", String(port)]).result).ok,
  );
  const remote = (repository) => `ssh://git@${name}:${port}/srv/git/${repository}`;
  const authorized = [];
  const authorize = async (publicKey) => {
    authorized.push(ed25519PublicKey(publicKey));
    // Keys travel as arguments to a fixed script, never through a shell-interpreted string.
    await docker([
      "exec",
      containerId,
      "sh",
      "-c",
      'printf "%s\\n" "$@" > /etc/ssh/authorized/git',
      "authorize",
      ...authorized,
    ]);
  };
  // sshd -e writes its log to stderr, and `docker logs` keeps the two streams apart.
  const accepted = async () => {
    const logs = await startDocker(["logs", containerId]).result;
    requireFact(logs.ok, "The SSH remote's log must be readable");
    return acceptedFingerprints(`${logs.output}\n${logs.error}`);
  };
  const inRemote = (repository, args) =>
    docker(["exec", "--user", "git", containerId, "git", "-C", `/srv/git/${repository}`, ...args]);
  const directory = join(scratch, "git-access");
  await mkdir(directory, { mode: 0o700 });
  const fingerprintOf = async (label, publicKey) => {
    const file = join(directory, `${label}.pub`);
    await writeFile(file, `${publicKey}\n`, { mode: 0o600, flag: "wx" });
    return keygenFingerprint(await run("ssh-keygen", ["-lf", file], { timeout: processTimeout }));
  };
  const projectNamed = async (projectName) =>
    (await api("/projects")).find((item) => item.name === projectName);
  const adopted = async (projectName, repository, mode) => {
    const project = await projectNamed(projectName);
    requireFact(
      project !== undefined &&
        project.originUrl === remote(repository) &&
        project.adoptedSha === baseSha &&
        project.gitAuthMode === mode,
      `An adoption with --auth ${mode} must record the SSH remote, its commit and its mode`,
    );
    return project;
  };

  // ── Mend key ──────────────────────────────────────────────────────────────
  const initialized = ed25519PublicKey((await cli(["keys", "init"])).split("\n")[1] ?? "");
  const shown = ed25519PublicKey((await cli(["keys", "show"])).split("\n")[0] ?? "");
  const view = await api("/keys/git");
  requireFact(
    view.exists === true &&
      initialized === shown &&
      ed25519PublicKey(view.publicKey ?? "") === shown,
    "keys init, keys show and the public API must name one Mend key",
  );
  const mendFingerprint = await fingerprintOf("mend-key", shown);
  requireFact(
    typeof view.fingerprint === "string" && view.fingerprint.includes(mendFingerprint),
    "The reported Mend key fingerprint must be the fingerprint of the reported public key",
  );

  const keyProject = `acceptance-key-${runId}`;
  const refused = await startCli(
    ["adopt", remote("repo.git"), "--name", keyProject, "--auth", "mend-key"],
    { timeout: 180_000 },
  ).result;
  requireFact(
    !refused.ok && (await projectNamed(keyProject)) === undefined,
    "Adoption must fail and leave no project while the remote has not authorized the Mend key",
  );
  requireFact(
    (await accepted()).length === 0,
    "The SSH remote must not have accepted any key before one was authorized",
  );

  await authorize(shown);
  await cli(["adopt", remote("repo.git"), "--name", keyProject, "--auth", "mend-key"], {
    timeout: 180_000,
  });
  const project = await adopted(keyProject, "repo.git", "mend-key");
  requireFact(
    (await accepted()).includes(mendFingerprint),
    "The SSH remote must observe the account's Mend key signing the adoption",
  );

  await inRemote("repo.git", ["update-ref", `refs/heads/${refreshBranch}`, baseSha]);
  requireFact(
    (await cli(["refresh", keyProject], { timeout: 180_000 })).includes(refreshBranch),
    "mend refresh must fetch a branch that appeared on the SSH remote after adoption",
  );
  console.log(
    "PASS keys init/show, refused then Mend-key-signed SSH adoption, and refresh; signer observed on the remote",
  );

  // ── ssh-agent bridge ──────────────────────────────────────────────────────
  // Two identities, the unauthorized one first: a bridge that offers only the first key, or
  // that works only with a single-key agent, fails here.
  const agentSocket = join(directory, "agent.sock");
  const agentEnvironment = { ...environment, SSH_AUTH_SOCK: agentSocket };
  const agent = start("ssh-agent", ["-D", "-a", agentSocket], {
    timeout: 900_000,
    environment,
  });
  let share;
  try {
    await until(
      "ssh-agent socket",
      async () =>
        // Exit status 1 is "no identities"; only 2 means the agent cannot be reached.
        (
          await start("ssh-add", ["-L"], {
            environment: agentEnvironment,
            timeout: processTimeout,
          }).result
        ).code !== 2,
    );
    const keys = {};
    for (const identity of ["decoy", "signer"]) {
      const file = join(directory, identity);
      await run(
        "ssh-keygen",
        ["-q", "-t", "ed25519", "-N", "", "-C", `mend-acceptance-${identity}`, "-f", file],
        { timeout: processTimeout },
      );
      await run("ssh-add", ["-q", file], {
        environment: agentEnvironment,
        timeout: processTimeout,
      });
      keys[identity] = keygenFingerprint(
        await run("ssh-keygen", ["-lf", `${file}.pub`], { timeout: processTimeout }),
      );
    }
    const listed = await run("ssh-add", ["-L"], {
      environment: agentEnvironment,
      timeout: processTimeout,
    });
    const signerLine = listed.split("\n").find((line) => line.endsWith(" mend-acceptance-signer"));
    await authorize(signerLine ?? "");

    const absent = await startCli(
      [
        "adopt",
        remote("bridge-first.git"),
        "--name",
        `acceptance-absent-${runId}`,
        "--auth",
        "bridge",
      ],
      { timeout: 180_000 },
    ).result;
    requireFact(
      !absent.ok &&
        `${absent.output}${absent.error}`.includes("no signer connected") &&
        (await projectNamed(`acceptance-absent-${runId}`)) === undefined,
      "A bridge adoption without a connected signer must fail saying no signer is connected",
    );

    share = startCli(["keys", "share"], { timeout: 900_000, environment: agentEnvironment });
    await until("connected ssh-agent bridge", async () => {
      const status = await api("/keys/bridge");
      return status.connected === true;
    });
    // The second adoption is the regression in docs/BUGS.md (2026-08-30): a repeat bridge adopt
    // that never consults the connected signer.
    for (const repository of ["bridge-first.git", "bridge-second.git"]) {
      const before = (await accepted()).filter((item) => item === keys.signer).length;
      const bridgeProject = `acceptance-${repository.replace(".git", "")}-${runId}`;
      await cli(["adopt", remote(repository), "--name", bridgeProject, "--auth", "bridge"], {
        timeout: 180_000,
      });
      await adopted(bridgeProject, repository, "bridge");
      const after = await accepted();
      requireFact(
        after.filter((item) => item === keys.signer).length > before && !after.includes(keys.decoy),
        "Each bridge adoption must be signed by the agent's authorized identity, observed on the remote",
      );
    }
    share.terminate();
    await share.result;
    share = undefined;
    await until("disconnected ssh-agent bridge", async () => {
      const status = await api("/keys/bridge");
      return status.connected === false;
    });
  } finally {
    share?.terminate();
    agent.terminate();
    await agent.result;
  }
  console.log(
    "PASS keys share: refused without a signer, two bridge adoptions signed by the agent's authorized identity, presence observed both ways",
  );

  return {
    project,
    image,
    containerId,
    /** Shell for the session: non-fatal, so a refused push is named by verifyPush, not by a failed session. */
    // git's own words stay in the workspace (pushEvidence): the parent reads them as private
    // evidence while the executor is alive, because a refused push leaves nothing on the remote.
    pushCommand: `{ git remote -v; git push origin HEAD:refs/heads/${pushBranch} && echo pushed || echo "refused $?"; } > ${pushEvidence} 2>&1; touch ${pushEvidence}.done`,
    pushEvidence,
    /** The session's commit must have reached the remote, signed by its owner's Mend key. */
    async verifyPush(marker, signaturesBefore) {
      const pushed = await startDocker([
        "exec",
        "--user",
        "git",
        containerId,
        "git",
        "-C",
        "/srv/git/repo.git",
        "show",
        `refs/heads/${pushBranch}:packaged-proof.txt`,
      ]).result;
      requireFact(
        pushed.ok && pushed.output === `${marker}\n`,
        "A git push from inside the session must arrive at the SSH remote with the session's commit",
      );
      requireFact(
        (await accepted()).filter((item) => item === mendFingerprint).length > signaturesBefore,
        "The session's push must be signed by its owner's Mend key, observed on the remote",
      );
    },
    mendKeySignatures: async () =>
      (await accepted()).filter((item) => item === mendFingerprint).length,
    /** Restart, stop/start and upgrade must keep the key a git host already trusts. */
    async assertKeyUnchanged(when) {
      const current = await api("/keys/git");
      requireFact(
        current.exists === true && ed25519PublicKey(current.publicKey ?? "") === shown,
        `The account's Mend key must be unchanged ${when}`,
      );
    },
  };
}
