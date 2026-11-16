/**
 * Every third-party image Mend's CI pulls, and the one way it pulls them (SLNT-1071).
 *
 * Public registries limit anonymous pulls per address, and GitHub's runners share addresses: Docker
 * Hub refuses, and ECR Public has answered `Rate exceeded` and `Data limit exceeded`. So each image
 * is pinned here by digest and pulled from, in order:
 *
 *   1. its copy under ghcr.io/sealant-sh (`ci-mirror-<name>`), with the job's own GITHUB_TOKEN when
 *      the job passes one. .github/workflows/ci-images.yml keeps the copies, digest for digest.
 *   2. Docker's official-image mirror on ECR Public, for official images.
 *   3. Google's mirror of Docker Hub, mirror.gcr.io.
 *
 * Each source gets three tries (waits 0, 10 s, 30 s) before the next, except a copy that is not
 * there yet, which is skipped at once. The pulled image is tagged with its Docker Hub name, so the
 * product's own image names and the Dockerfile's `FROM` lines never change for CI. One line per
 * image names the source that served it; one line per failed try gives the registry's error.
 *
 *   node scripts/ci-images.mjs pull <name>...   pull and tag each (names as in CI_IMAGES)
 *   node scripts/ci-images.mjs postgres         pull postgres:17, start the job's throwaway database
 *   node scripts/ci-images.mjs sync [--dry-run] copy every image to GHCR (ci-images.yml only)
 *   node scripts/ci-images.mjs list             every name, digest and source, as JSON
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const GHCR_OWNER = "ghcr.io/sealant-sh";

/**
 * Docker Hub name → the index digest Docker Hub serves for it, which every source serves too.
 * `official` images are on ECR Public's docker/library; the rest only on mirror.gcr.io.
 */
export const CI_IMAGES = {
  // The engine lanes' and preview acceptance's database (startPostgres).
  "postgres:17": {
    digest: "sha256:0d938e975177bef9f1f61f3f9dbcf2e0aa0a139568f66d3415ed8892eb97f6ac",
    official: true,
  },
  // Setup's own images beside the server, which docker-suites and vscode-e2e run.
  "postgres:17-alpine": {
    digest: "sha256:a77aa70e641402a21411b92b721c58d10f23b50ae5fdd2333efd22d166e1e5f7",
    official: true,
  },
  "dxflrs/garage:v2.4.1": {
    digest: "sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020",
    official: false,
  },
  "nginx:1.29-alpine": {
    digest: "sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de",
    official: true,
  },
  "registry:3.1": {
    digest: "sha256:82f6ff4a7f982960c8aa51617fea3aabc485df6e55cce80d22deb1de36f1bc3c",
    official: true,
  },
  // The edge overlay's proxy (deploy/docker/compose.edge.yaml), and the preview edges' stand-ins.
  "caddy:2.10-alpine": {
    digest: "sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d",
    official: true,
  },
  // The Dockerfile's base, which the server build, store-image-git and the bundle tests run.
  "node:26-bookworm-slim": {
    digest: "sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1",
    official: true,
  },
  // The workspace base vscode-e2e's fresh-worktree session builds from.
  "node:26-bookworm": {
    digest: "sha256:b7087bc4d973034b30854b378ba107f9fab622b47514cb7e2592e41b8bab8d49",
    official: true,
  },
  // docker-suites' mounted rollback workspace.
  "node:26-trixie": {
    digest: "sha256:e18c3ccdf7d71619990b0e85639f506e2028a95410999cab24cc373cbd10e0ac",
    official: true,
  },
  // vscode-e2e's outer machine.
  "docker:27.5.1-dind": {
    digest: "sha256:aa3df78ecf320f5fafdce71c659f1629e96e9de0968305fe1de670e0ca9176ce",
    official: true,
  },
  // The server image's network guard (the Dockerfile's MEND_NETWORK_GUARD_IMAGE), which the
  // upgrade-window and Docker protocol tests also run as a small stand-in.
  "busybox:1.37": {
    digest: "sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e",
    official: true,
  },
  // Every PR's fixtures: the shell-profile image's base and the S3 contract's helper (both pinned to
  // the digest the fixtures always had; the tag has moved on), the rfb fixture's Xvnc base, and the
  // sessions pre-release check's small image.
  "alpine:3.22": {
    digest: "sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8",
    official: true,
  },
  "debian:trixie-slim": {
    digest: "sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2",
    official: true,
  },
  // The package-mirror runtime test's clients (scripts/mirrors-runtime.test.mjs).
  "curlimages/curl:8.16.0": {
    digest: "sha256:463eaf6072688fe96ac64fa623fe73e1dbe25d8ad6c34404a669ad3ce1f104b6",
    official: false,
  },
  "node:24-alpine": {
    digest: "sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5",
    official: true,
  },
  "alpine:3.20": {
    digest: "sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc",
    official: true,
  },
};

// CI_IMAGES_PULL_WAITS_MS (comma-separated) shortens the waits for a test that fakes a refusal.
const PULL_BACKOFF_MS = process.env.CI_IMAGES_PULL_WAITS_MS
  ? process.env.CI_IMAGES_PULL_WAITS_MS.split(",").map(Number)
  : [0, 10_000, 30_000];
// A copy that is not on GHCR yet (a digest changed in this PR, before ci-images.yml ran on main).
const ABSENT = /manifest unknown|not found|denied|name unknown/i;

/** `postgres:17` → `{ repository: "postgres", tag: "17" }`; `dxflrs/garage:v2.4.1` likewise. */
export const splitName = (name) => {
  const colon = name.lastIndexOf(":");
  if (colon <= 0) throw new Error(`${name} has no tag`);
  return { repository: name.slice(0, colon), tag: name.slice(colon + 1) };
};

const image = (name) => {
  const entry = CI_IMAGES[name];
  if (entry === undefined) throw new Error(`${name} is not in CI_IMAGES (scripts/ci-images.mjs)`);
  return entry;
};

/** The GHCR copy's repository: one package per image, `ci-mirror-` and the name, `/` as `-`. */
export const ghcrRepository = (name) =>
  `${GHCR_OWNER}/ci-mirror-${splitName(name).repository.replaceAll("/", "-")}`;

/** Every source of `name`, in pull order, each by digest. */
export const sourcesOf = (name) => {
  const { digest, official } = image(name);
  const { repository, tag } = splitName(name);
  const hub = repository.includes("/") ? repository : `library/${repository}`;
  return [
    { registry: "ghcr", reference: `${ghcrRepository(name)}:${tag}@${digest}` },
    ...(official
      ? [
          {
            registry: "ecr",
            reference: `public.ecr.aws/docker/${hub}:${tag}@${digest}`,
          },
        ]
      : []),
    { registry: "gcr", reference: `mirror.gcr.io/${hub}:${tag}@${digest}` },
  ];
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One command, awaited, output collected; never throws on a non-zero exit. */
export const run = (command, args, { env, input, timeout = 600_000 } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: env ?? process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.stdin.end(input);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += `\n${command} ${args.join(" ")} timed out after ${timeout} ms`;
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });

const lastLine = (result) => (result.stderr || result.stdout).trim().split("\n").at(-1) ?? "";

/**
 * A Docker client config of its own, logged in to GHCR when the job passes GITHUB_TOKEN, so the
 * job's later steps never see the credential. Without a token GHCR is read anonymously: the copies
 * are public, as packages this public repository's workflows publish are.
 */
export const withDockerConfig = async (body) => {
  const config = mkdtempSync(join(tmpdir(), "ci-images-"));
  const env = { ...process.env, DOCKER_CONFIG: config };
  try {
    const token = process.env.GITHUB_TOKEN;
    if (token) {
      const login = await run(
        "docker",
        [
          "login",
          "ghcr.io",
          "-u",
          process.env.GITHUB_ACTOR || "github-actions",
          "--password-stdin",
        ],
        { env, input: token },
      );
      if (login.status !== 0)
        console.log(`ghcr.io login failed, reading anonymously: ${lastLine(login)}`);
    }
    return await body(env);
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
};

/**
 * Pull `name` from the first source that serves it and tag it with its Docker Hub name. Returns
 * the source that served it. `docker` is injectable for tests.
 */
export const pullImage = async (name, { env, docker = run, waits = PULL_BACKOFF_MS } = {}) => {
  const failures = [];
  for (const { registry, reference } of sourcesOf(name)) {
    for (const [index, wait] of waits.entries()) {
      if (wait > 0) await sleep(wait);
      const attempt = `${reference} (try ${index + 1} of ${waits.length})`;
      const pulled = await docker("docker", ["pull", "-q", reference], { env });
      if (pulled.status === 0) {
        const tagged = await docker("docker", ["tag", reference, name], {
          env,
        });
        if (tagged.status !== 0)
          throw new Error(`docker tag ${reference} ${name}: ${lastLine(tagged)}`);
        console.log(
          `${name} ← ${attempt}${failures.length === 0 ? "" : `, after ${failures.length} failed`}`,
        );
        return reference;
      }
      const reason = lastLine(pulled);
      failures.push(`${attempt}: ${reason}`);
      console.log(`${name}: ${attempt} failed: ${reason}`);
      // The copy is not there (yet): the next source, without waiting.
      if (registry === "ghcr" && ABSENT.test(reason)) break;
    }
  }
  throw new Error(`${name} could not be pulled from any source:\n${failures.join("\n")}`);
};

export const pullImages = (names) =>
  withDockerConfig(async (env) => {
    for (const name of names) await pullImage(name, { env });
  });

export const POSTGRES = {
  image: "postgres:17",
  container: "mend-ci-postgres",
  user: "mend",
  password: "mend",
  database: "mend",
  port: 5432,
};

/**
 * The job's throwaway Postgres, as a `services:` container was, but pulled through pullImage. It
 * runs without durability: tests create and migrate throwaway databases, each migration commits on
 * its own, and with a flush per commit their time followed the runner's disk (SLNT-764).
 */
export const startPostgres = async () => {
  await pullImages([POSTGRES.image]);
  const { container, user, password, database, port } = POSTGRES;
  await run("docker", ["rm", "-f", container]);
  const started = await run("docker", [
    "run",
    "--detach",
    "--name",
    container,
    "--env",
    `POSTGRES_USER=${user}`,
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "--env",
    `POSTGRES_DB=${database}`,
    "--publish",
    `${port}:5432`,
    POSTGRES.image,
    "-c",
    "fsync=off",
    "-c",
    "synchronous_commit=off",
    "-c",
    "full_page_writes=off",
  ]);
  if (started.status !== 0) throw new Error(`docker run ${POSTGRES.image}: ${lastLine(started)}`);
  // The image's entrypoint starts a temporary server for its init scripts, then the real one: wait
  // for a query over TCP, which only the real one accepts.
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const ready = await run("docker", [
      "exec",
      container,
      "psql",
      "-h",
      "127.0.0.1",
      "-U",
      user,
      "-d",
      database,
      "-tAc",
      "SHOW fsync",
    ]);
    if (ready.status === 0 && ready.stdout.trim() === "off") {
      console.log(`${container} is accepting connections on localhost:${port}, fsync off`);
      return;
    }
    await sleep(500);
  }
  const logs = await run("docker", ["logs", "--tail", "50", container]);
  throw new Error(`${container} never accepted connections:\n${logs.stdout}${logs.stderr}`);
};

/**
 * Copy every image to GHCR, the whole index by digest, from the first source that serves it.
 * A copy already at its digest is left alone. Run by ci-images.yml with packages: write.
 */
export const syncImages = ({ dryRun = false } = {}) =>
  withDockerConfig(async (env) => {
    for (const name of Object.keys(CI_IMAGES)) {
      const [copy, ...upstream] = sourcesOf(name);
      const present = await run("docker", ["buildx", "imagetools", "inspect", copy.reference], {
        env,
      });
      if (present.status === 0) {
        console.log(`${name}: ${copy.reference} is present`);
        continue;
      }
      const target = copy.reference.replace(/@sha256:.*$/, "");
      if (dryRun) {
        console.log(`${name}: would copy to ${target} from ${upstream[0].reference}`);
        continue;
      }
      let copied = false;
      for (const source of upstream) {
        const created = await run(
          "docker",
          ["buildx", "imagetools", "create", "--tag", target, source.reference],
          { env },
        );
        if (created.status === 0) {
          console.log(`${name}: copied to ${target} from ${source.reference}`);
          copied = true;
          break;
        }
        console.log(`${name}: copy from ${source.reference} failed: ${lastLine(created)}`);
      }
      if (!copied) throw new Error(`${name}: no source could be copied to ${target}`);
      const check = await run("docker", ["buildx", "imagetools", "inspect", copy.reference], {
        env,
      });
      if (check.status !== 0)
        throw new Error(`${name}: ${copy.reference} is missing after the copy: ${lastLine(check)}`);
    }
  });

const main = async ([command, ...rest]) => {
  switch (command) {
    case "pull":
      if (rest.length === 0) throw new Error("pull needs at least one image name");
      return pullImages(rest);
    case "postgres":
      return startPostgres();
    case "sync":
      return syncImages({ dryRun: rest.includes("--dry-run") });
    case "list":
      console.log(
        JSON.stringify(
          Object.fromEntries(Object.keys(CI_IMAGES).map((name) => [name, sourcesOf(name)])),
          null,
          2,
        ),
      );
      return;
    default:
      throw new Error(`usage: node scripts/ci-images.mjs pull <name>... | postgres | sync | list`);
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
