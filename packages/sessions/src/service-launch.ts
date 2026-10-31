import * as net from "node:net";
import { Duplex } from "node:stream";
import * as tls from "node:tls";

import type { WorktreeId } from "@mend/domain";
import {
  DEFAULT_SERVICE_LAUNCH,
  dependencyEnvPrefix,
  type RecipeEnv,
  type RecipeReady,
  type RepoRelativePath,
  type ServiceAddress,
  type ServiceHostPolicy,
  type ServiceLaunch,
  type ServiceRecipe,
} from "@mend/domain/workbench";
import type { ForwardBytes, ForwardIoFailure, ForwardIssue } from "@mend/sealant";
import { Cause, Duration, Effect, Exit, Layer, Option } from "effect";
import * as Context from "effect/Context";

import type { ForwardAdapterShape, ForwardTarget } from "./forward.ts";

/**
 * Everything one Service start needs beyond the Service's identity (ADR 0017, delivery 9): what
 * runs, where, with which of the recipe's own environment, when it counts as up, the Host its
 * preview's requests carry, and where it listens. A restart replays the attempt's `ServiceLaunch`
 * part of it.
 */
export interface LaunchSpec extends ServiceLaunch {
  readonly argv: ReadonlyArray<string>;
  readonly host: ServiceHostPolicy;
  readonly address: ServiceAddress;
}

/** `mend service run --port … -- <command>`: no recipe, so nothing beyond the command. */
export const explicitLaunch = (argv: ReadonlyArray<string>): LaunchSpec => ({
  ...DEFAULT_SERVICE_LAUNCH,
  argv,
  host: "rewrite",
  address: "loopback",
});

export const recipeLaunch = (recipe: ServiceRecipe & { readonly command: string }): LaunchSpec => ({
  argv: ["sh", "-c", recipe.command],
  cwd: recipe.cwd,
  env: recipe.env,
  ready: recipe.ready,
  depends: recipe.depends,
  host: recipe.host,
  address: recipe.address,
});

/** The worktree is at `/workspace/repo` in every workspace; the SDK's default when none is given. */
export const WORKSPACE_REPO = "/workspace/repo";

export const serviceCwdOf = (cwd: RepoRelativePath | null): string | undefined =>
  cwd === null ? undefined : `${WORKSPACE_REPO}/${cwd}`;

/** Where a session dependency answers from inside the workspace. */
export interface DependencyAddress {
  readonly name: string;
  readonly host: string;
  readonly port: number;
}

/**
 * A Service process's environment, each layer over the one before (the workspace's and the
 * project's are the workspace's own, beneath all of these):
 *
 * 1. `sharedBinding`: what a bound shared service provides (P-SLNT-46); nothing binds one yet.
 * 2. `recipe`: the recipe's own `env`, which may not name `MEND_*` or `PORT`.
 * 3. Mend's: `PORT`, `MEND_PREVIEW_URL` when a preview has an address (unset, never empty, when
 *    none does), and `MEND_SERVICE_<NAME>_HOST`/`_PORT` for each dependency.
 * 4. `person`: Mend's identity plumbing for a person executor, last so nothing shadows it.
 */
export const serviceProcessEnv = (layers: {
  readonly sharedBinding: RecipeEnv;
  readonly recipe: RecipeEnv;
  readonly port: number;
  readonly previewUrl: string | null;
  readonly dependencies: ReadonlyArray<DependencyAddress>;
  readonly person: Readonly<Record<string, string>>;
}): Readonly<Record<string, string>> => ({
  ...layers.sharedBinding,
  ...layers.recipe,
  PORT: String(layers.port),
  ...(layers.previewUrl === null ? {} : { MEND_PREVIEW_URL: layers.previewUrl }),
  ...Object.fromEntries(
    layers.dependencies.flatMap(({ name, host, port }) => [
      [`${dependencyEnvPrefix(name)}_HOST`, host],
      [`${dependencyEnvPrefix(name)}_PORT`, String(port)],
    ]),
  ),
  ...layers.person,
});

/**
 * Where a worktree's preview is reached, for `MEND_PREVIEW_URL`. The API provides it from its
 * preview routing; it answers null while previews are off and for a preview with no address yet.
 * A composition root without previews provides `PreviewUrlsNone`.
 */
export class PreviewUrls extends Context.Service<
  PreviewUrls,
  {
    readonly of: (worktreeId: WorktreeId, serviceName: string) => Effect.Effect<string | null>;
  }
>()("@mend/sessions/PreviewUrls") {}

export const PreviewUrlsNone: Layer.Layer<PreviewUrls> = Layer.succeed(PreviewUrls, {
  of: () => Effect.succeed(null),
});

/** The `Host` an HTTP readiness request carries, as the preview's requests will. */
export const readyHostOf = (policy: ServiceHostPolicy, port: number, previewUrl: string | null) =>
  policy === "preserve" && previewUrl !== null ? new URL(previewUrl).host : `localhost:${port}`;

/**
 * An attempt's recorded `ready` rule, resolved for its probe: a TCP accept, or an HTTP answer for
 * `path` sent with the Host its preview's requests carry, over TLS for an `https` Service.
 */
export type ReadyCheck =
  | { readonly _tag: "Tcp" }
  | { readonly _tag: "Http"; readonly path: string; readonly host: string; readonly tls: boolean };

export const TCP_READY: ReadyCheck = { _tag: "Tcp" };

export const readyCheckOf = (
  ready: RecipeReady,
  service: {
    readonly hostPolicy: ServiceHostPolicy;
    readonly workspacePort: number;
    readonly browserScheme: "http" | "https" | null;
  },
  previewUrl: string | null,
): ReadyCheck =>
  ready._tag === "Tcp"
    ? TCP_READY
    : {
        _tag: "Http",
        path: ready.path,
        host: readyHostOf(service.hostPolicy, service.workspacePort, previewUrl),
        tls: service.browserScheme === "https",
      };

/**
 * What one check found. A refused dial carries its issue: some refusals say waiting cannot help.
 * `reason` is what an observation records.
 */
export type ReadyVerdict =
  /** `httpStatus`: the status an HTTP rule's `GET` read; null under a TCP rule. */
  | { readonly _tag: "Ready"; readonly httpStatus: number | null }
  | { readonly _tag: "NotReady"; readonly reason: string; readonly issue: ForwardIssue | null };

const READY: ReadyVerdict = { _tag: "Ready", httpStatus: null };

const HTTP_CHECK_BOUND_MS = 5_000;

/**
 * The one rule for whether a Service answers: its port accepts, and, under an HTTP rule, a `GET`
 * of its path gets a status line. Every start, restart, background probe and boot check asks this.
 */
export const checkReady = (
  adapter: ForwardAdapterShape,
  target: ForwardTarget,
  check: ReadyCheck,
  timeoutMs?: number,
): Effect.Effect<ReadyVerdict> =>
  Effect.gen(function* () {
    const options =
      timeoutMs === undefined
        ? { purpose: "readiness" as const }
        : { purpose: "readiness" as const, timeoutMs };
    const probed = yield* adapter.probe(target, options);
    if (probed.kind === "failed") {
      return { _tag: "NotReady", reason: probed.issue.reason, issue: probed.issue } as const;
    }
    if (check._tag === "Tcp") return READY;
    const answered = yield* Effect.scoped(
      Effect.flatMap(adapter.open(target, options), (connection) =>
        answersHttp(connection.bytes, check),
      ),
    ).pipe(
      Effect.timeoutOption(Duration.millis(Math.max(1, timeoutMs ?? HTTP_CHECK_BOUND_MS))),
      Effect.map((result) => Option.getOrElse(result, () => null)),
      Effect.catchTag("ForwardDialFailure", () => Effect.succeed(null)),
    );
    return answered !== null
      ? { _tag: "Ready", httpStatus: answered }
      : ({ _tag: "NotReady", reason: `no HTTP answer to GET ${check.path}`, issue: null } as const);
  });

const STATUS_LINE = /^HTTP\/\d(?:\.\d)? (\d{3})/u;

type HeadAnswer =
  | { readonly _tag: "Waiting" }
  | { readonly _tag: "Read"; readonly status: number | null };

const WAITING: HeadAnswer = { _tag: "Waiting" };

const headAnswers = (head: string): HeadAnswer => {
  const end = head.indexOf("\r\n");
  if (end >= 0) {
    const status = STATUS_LINE.exec(head.slice(0, end))?.[1];
    return { _tag: "Read", status: status === undefined ? null : Number(status) };
  }
  return head.length > 1024 ? { _tag: "Read", status: null } : WAITING;
};

const requestOf = (request: { readonly path: string; readonly host: string }) =>
  `GET ${request.path} HTTP/1.1\r\nHost: ${request.host}\r\nUser-Agent: mend-ready\r\n` +
  `Accept: */*\r\nConnection: close\r\n\r\n`;

const runThen = <A>(
  effect: Effect.Effect<A, ForwardIoFailure>,
  done: (exit: Exit.Exit<A, ForwardIoFailure>) => void,
) => void Effect.runCallback(effect, { onExit: done });

const errorOf = (exit: Exit.Exit<unknown, ForwardIoFailure>) =>
  Exit.isSuccess(exit) ? null : new Error(Cause.pretty(exit.cause));

/** A forward's bytes as the stream Node's TLS client runs over. */
const duplexOf = (bytes: ForwardBytes): Duplex =>
  new Duplex({
    read() {
      runThen(bytes.read(), (exit) => {
        if (Exit.isSuccess(exit)) this.push(exit.value.kind === "eof" ? null : exit.value.bytes);
        else this.destroy(errorOf(exit) ?? undefined);
      });
    },
    write(chunk: Uint8Array, _encoding, done) {
      runThen(bytes.write(chunk), (exit) => done(errorOf(exit)));
    },
    final(done) {
      runThen(bytes.finish(), () => done());
    },
    destroy(error, done) {
      runThen(bytes.close(), () => done(error));
    },
  });

/**
 * The same `GET` over TLS, for an `https` Service. The dev server's certificate is its own
 * (Vite's basic-ssl, `next dev --experimental-https`), so it is not verified: this asks whether
 * the server answers, and trusts nothing it says.
 */
const answersHttps = (
  bytes: ForwardBytes,
  request: { readonly path: string; readonly host: string },
): Effect.Effect<number | null> =>
  Effect.callback<number | null>((resume) => {
    const hostname = new URL(`https://${request.host}`).hostname;
    const socket = tls.connect({
      socket: duplexOf(bytes),
      rejectUnauthorized: false,
      ALPNProtocols: ["http/1.1"],
      ...(net.isIP(hostname) === 0 ? { servername: hostname } : {}),
    });
    let head = "";
    let settled = false;
    const settle = (answered: number | null) => {
      if (settled) return;
      settled = true;
      resume(Effect.succeed(answered));
      socket.destroy();
    };
    socket.once("secureConnect", () => socket.write(requestOf(request)));
    socket.on("data", (chunk: Buffer) => {
      head += chunk.toString("latin1");
      const answer = headAnswers(head);
      if (answer._tag === "Read") settle(answer.status);
    });
    socket.once("error", () => settle(null));
    socket.once("close", () => settle(null));
    return Effect.sync(() => socket.destroy());
  });

/**
 * Write one `GET` and read until the status line: any status counts as answered (a dev server's
 * 403 for a host it does not allow is an answer), and is what it answers. Null when the forward
 * ends first, or its first line is no status line.
 */
export const answersHttp = (
  bytes: ForwardBytes,
  request: { readonly path: string; readonly host: string; readonly tls: boolean },
): Effect.Effect<number | null> =>
  request.tls
    ? answersHttps(bytes, request)
    : Effect.gen(function* () {
        yield* bytes.write(new TextEncoder().encode(requestOf(request)));
        const decoder = new TextDecoder();
        let head = "";
        for (;;) {
          const read = yield* bytes.read();
          if (read.kind === "eof") return null;
          head += decoder.decode(read.bytes, { stream: true });
          const answer = headAnswers(head);
          if (answer._tag === "Read") return answer.status;
        }
      }).pipe(Effect.catchTag("ForwardIoFailure", () => Effect.succeed(null)));
