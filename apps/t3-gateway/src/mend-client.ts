import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { GatewayConfig } from "./config.ts";
import {
  MendActiveSession,
  MendChangeDiff,
  MendConversationWait,
  MendEventPointer,
  MendItem,
  MendProject,
  MendFileListing,
  MendPastedImage,
  MendProjectDetail,
  MendRemovalReport,
  MendRequest,
  MendSession,
  MendSessionDetail,
  MendTurn,
  MendWorkspaceRetirement,
  MendWorktreeListing,
} from "./mend-workbench.ts";

/**
 * The gateway's view of Mend: an ordinary HTTP client of `/api`, calling as the person who paired
 * (ADR 0012, "A gateway, not a provider"). It does not import `@mend/api-contracts` (Effect
 * beta.93); it decodes only the fields it reads, so Mend can add fields freely.
 */

/** The platforms Mend's `POST /api/pair` accepts (`DEVICE_PLATFORMS` in @mend/api-contracts). */
export type MendDevicePlatform = "ios" | "android" | "web" | "desktop" | "other";

/** What the gateway reads from Mend's `PairClaimResult`. */
const PairClaim = Schema.Struct({
  token: Schema.String,
  user: Schema.Struct({ id: Schema.String, name: Schema.String, email: Schema.String }),
  device: Schema.Struct({ id: Schema.String, name: Schema.String }),
});
export type PairClaim = typeof PairClaim.Type;

/**
 * What the gateway reads from one entry of Mend's `GET /api/harnesses/models`
 * (`HarnessModelCatalog` in @mend/domain): a harness's models in picker order, the efforts its CLI
 * accepts, and whether a launch may ask for priority processing.
 */
const MendHarnessModel = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  isDefault: Schema.Boolean,
  /** The efforts this model takes when fewer than its harness's; null means the harness's. */
  efforts: Schema.NullOr(Schema.Array(Schema.String)),
});
const MendHarnessCatalog = Schema.Struct({
  harness: Schema.String,
  models: Schema.Array(MendHarnessModel),
  defaultModel: Schema.NullOr(Schema.String),
  efforts: Schema.Array(Schema.String),
  fastCapable: Schema.Boolean,
});
export type MendHarnessCatalog = typeof MendHarnessCatalog.Type;
const decodeHarnessCatalogs = Schema.decodeUnknownEffect(Schema.Array(MendHarnessCatalog));

/** Mend refused the pairing code: unknown, or already claimed or expired. */
export class MendPairingRefused extends Schema.TaggedError<MendPairingRefused>()(
  "MendPairingRefused",
  {
    reason: Schema.Literals(["unknown-code", "spent-code"]),
  },
) {
  override get message(): string {
    return `Mend refused the pairing code (${this.reason}).`;
  }
}

/**
 * Mend refused the claim without looking at the code: too many failed codes from the client's
 * address. `retryAfterSeconds` is Mend's own answer, or null when its body did not carry one.
 */
export class MendPairingRateLimited extends Schema.TaggedError<MendPairingRateLimited>()(
  "MendPairingRateLimited",
  {
    retryAfterSeconds: Schema.NullOr(Schema.Int),
  },
) {
  override get message(): string {
    return "Mend refused the pairing claim: too many failed codes from this address.";
  }
}

/** Mend's `PairingRateLimited` body (`@mend/api-contracts`, not imported here). */
const PairingRateLimitedBody = Schema.Struct({ retryAfterSeconds: Schema.Int });

/** Mend no longer accepts the device token: the device was revoked or its person deactivated. */
export class MendDeviceRefused extends Schema.TaggedError<MendDeviceRefused>()(
  "MendDeviceRefused",
  { operation: Schema.String },
) {
  override get message(): string {
    return `Mend refused the device token on ${this.operation}.`;
  }
}

/** Mend did not answer, or answered something the gateway cannot read. */
export class MendUnavailable extends Schema.TaggedError<MendUnavailable>()("MendUnavailable", {
  operation: Schema.String,
  status: Schema.NullOr(Schema.Number),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return this.status === null
      ? `Mend did not answer ${this.operation}.`
      : `Mend answered ${this.operation} with ${this.status}.`;
  }
}

/** Mend has no such thing, or the person may not see it: a 404 on a read. */
export class MendNotFound extends Schema.TaggedError<MendNotFound>()("MendNotFound", {
  operation: Schema.String,
}) {
  override get message(): string {
    return `Mend found nothing for ${this.operation}.`;
  }
}

/**
 * Mend refused a command with one of its typed errors: the session is not the caller's to steer
 * (403 `SessionNotSteerable`), its agent is not live (409 `ProtocolSessionNotLive`), the request
 * was already answered (409 `AgentRequestResolved`), and so on. `tag` and `message` are Mend's.
 */
export class MendCommandRefused extends Schema.TaggedError<MendCommandRefused>()(
  "MendCommandRefused",
  {
    operation: Schema.String,
    status: Schema.Number,
    tag: Schema.NullOr(Schema.String),
    detail: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return this.detail ?? `Mend refused ${this.operation} (${this.tag ?? this.status}).`;
  }
}

/** A command as the person: Mend's answer, or why it did not take it. */
export type MendCommand<A> = Effect.Effect<
  A,
  MendDeviceRefused | MendNotFound | MendCommandRefused | MendUnavailable
>;

/** The answer a request takes (`RespondAgentRequest` in @mend/api-contracts). */
export type MendRequestResponse =
  | { readonly decision: "accept" | "accept-for-session" | "decline" | "cancel" }
  | { readonly answers: Readonly<Record<string, ReadonlyArray<string>>> };

/**
 * What a protocol launch may name (`LaunchRequest` in @mend/api-contracts). Anything left out is
 * Mend's to choose: the request's, else what the session's last protocol agent recorded (mend#493),
 * else the catalog's default.
 */
export interface MendLaunchOptions {
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly permissionMode?: "bypass" | "ask" | undefined;
  readonly speed?: "standard" | "fast" | undefined;
}

/** A new session in a new worktree of a project (`NewWorkbenchSession` in @mend/api-contracts). */
export interface MendNewSession {
  readonly harness: string;
  readonly label: string | null;
  /** The new worktree's name; null lets Mend name it. */
  readonly name: string | null;
  /** The branch or sha the worktree starts from; null is the project's default branch. */
  readonly base: string | null;
}

/** A read of the person's workbench: Mend's answer, or why there is none. */
export type MendRead<A> = Effect.Effect<A, MendDeviceRefused | MendNotFound | MendUnavailable>;

export class MendClient extends Context.Service<
  MendClient,
  {
    /**
     * `POST /api/pair`: spends the code and returns a device token for its person. `forwardedFor`
     * is the `x-forwarded-for` the gateway sends: the client's chain plus the address the gateway
     * saw, so Mend counts failed claims per client rather than one bucket for the gateway.
     */
    readonly claimPairing: (input: {
      readonly code: string;
      readonly name: string;
      readonly platform: MendDevicePlatform;
      readonly forwardedFor: string | undefined;
    }) => Effect.Effect<PairClaim, MendPairingRefused | MendPairingRateLimited | MendUnavailable>;
    /**
     * Whether Mend still accepts a device token. Mend has no `GET /api/me`; `GET /api/me/devices`
     * is the smallest read every signed-in person may make, and it answers 401 once the device is
     * revoked or its person deactivated.
     */
    readonly checkDevice: (
      deviceToken: string,
    ) => Effect.Effect<"accepted" | "refused", MendUnavailable>;
    /** `GET /api/harnesses/models`, as the person who paired: Mend's model catalog. */
    readonly listHarnessModels: (
      deviceToken: string,
    ) => Effect.Effect<ReadonlyArray<MendHarnessCatalog>, MendDeviceRefused | MendUnavailable>;
    /** `GET /api/projects`: the projects the person can see. */
    readonly listProjects: (deviceToken: string) => MendRead<ReadonlyArray<MendProject>>;
    /** `GET /api/projects/:id`: the project, its sessions and their list facts. */
    readonly projectDetail: (deviceToken: string, projectId: string) => MendRead<MendProjectDetail>;
    /** `GET /api/sessions/:id/turns`: the session's protocol turns, oldest first. */
    readonly listTurns: (
      deviceToken: string,
      sessionId: string,
    ) => MendRead<ReadonlyArray<MendTurn>>;
    /**
     * `GET /api/sessions/:id/items?after=&limit=`: the items whose change-feed cursor is past
     * `after`, in cursor order, at most `limit` of them.
     */
    readonly listItems: (
      deviceToken: string,
      sessionId: string,
      after: number,
      limit: number,
    ) => MendRead<ReadonlyArray<MendItem>>;
    /** `GET /api/sessions/:id/requests`: what its agent asked, answered or not. */
    readonly listRequests: (
      deviceToken: string,
      sessionId: string,
    ) => MendRead<ReadonlyArray<MendRequest>>;
    /** `GET /api/sessions/:id`: the session, what the caller may do with it, and its change. */
    readonly sessionDetail: (deviceToken: string, sessionId: string) => MendRead<MendSessionDetail>;
    /**
     * `GET /api/sessions`: the person's live sessions, each with the people live in its executor
     * (docs/adr/0016, decision 13).
     */
    readonly listActiveSessions: (
      deviceToken: string,
    ) => MendRead<ReadonlyArray<MendActiveSession>>;
    /** `GET /api/sessions/:id/waiting`: what holds the next sender's turn; null when nothing. */
    readonly conversationWait: (
      deviceToken: string,
      sessionId: string,
    ) => MendRead<MendConversationWait | null>;
    /**
     * `GET /api/sessions/:id/workspace-retirement`: the session's executor waiting to be replaced;
     * null while none of that is under way.
     */
    readonly workspaceRetirement: (
      deviceToken: string,
      sessionId: string,
    ) => MendRead<MendWorkspaceRetirement | null>;
    /** `GET /api/projects/:id/worktrees`: the names of the project's worktrees. */
    readonly worktreeNames: (
      deviceToken: string,
      projectId: string,
    ) => MendRead<ReadonlyArray<string>>;

    /**
     * `GET /api/projects/:id/files?session=`: every file of the session's worktree, or, with no
     * session, of the project's default branch. Mend checks the project's visibility.
     */
    readonly projectFiles: (
      deviceToken: string,
      projectId: string,
      sessionId: string | null,
    ) => MendRead<MendFileListing>;
    /** `GET /api/changes/:id/diff`: the change against its base, as git answers now. */
    readonly changeDiff: (deviceToken: string, changeId: string) => MendRead<MendChangeDiff>;
    /**
     * `POST /api/projects/:id/sessions`: a session owned by the caller, in a new worktree. Mend
     * stamps origin `mend` and the caller as owner, so its agent runs as them (docs/adr/0016).
     */
    readonly createSession: (
      deviceToken: string,
      projectId: string,
      input: MendNewSession,
    ) => MendCommand<MendSession>;
    /**
     * `POST /api/worktrees/:id/sessions`: a session owned by the caller in an existing worktree
     * (`NewWorktreeSession` in @mend/api-contracts), origin `mend`.
     */
    readonly joinWorktree: (
      deviceToken: string,
      worktreeId: string,
      input: { readonly harness: string; readonly label: string | null },
    ) => MendCommand<MendSession>;
    /** `POST /api/sessions/:id/label`: the session's name; null clears it. Owner only. */
    readonly labelSession: (
      deviceToken: string,
      sessionId: string,
      label: string | null,
    ) => MendCommand<MendSession>;
    /** `POST /api/sessions/:id/stop`: stops the session's processes and its workspace. */
    readonly stopSession: (deviceToken: string, sessionId: string) => MendCommand<MendSession>;
    /** `DELETE /api/sessions/:id`: a settled session, its record and workspace. Owner only. */
    readonly removeSession: (
      deviceToken: string,
      sessionId: string,
    ) => MendCommand<MendRemovalReport>;
    /**
     * `POST /api/sessions/:id/images`: an image placed in the session's live workspace; Mend
     * answers the path the agent sees. Steering rights, 8 MiB, PNG, JPEG, GIF or WebP.
     */
    readonly pasteImage: (
      deviceToken: string,
      sessionId: string,
      bytes: Uint8Array,
    ) => MendCommand<MendPastedImage>;
    /** `POST /api/sessions/:id/turns`: one input for the session's live protocol agent. */
    readonly submitTurn: (
      deviceToken: string,
      sessionId: string,
      input: string,
    ) => MendCommand<MendTurn>;
    /**
     * `POST /api/sessions/:id/launch` in protocol mode, with the prompt as its opening turn or, for
     * an empty prompt, none. What the options leave out runs on what the session's last protocol
     * agent recorded (mend#493).
     */
    readonly launchProtocol: (
      deviceToken: string,
      sessionId: string,
      prompt: string,
      options?: MendLaunchOptions,
    ) => MendCommand<MendSession>;
    /** `POST /api/turns/:id/interrupt`. */
    readonly interruptTurn: (deviceToken: string, turnId: string) => MendCommand<void>;
    /** `POST /api/requests/:id/respond`. */
    readonly respondRequest: (
      deviceToken: string,
      requestId: string,
      response: MendRequestResponse,
    ) => MendCommand<MendRequest>;
    /**
     * `GET /api/events`: Mend's SSE pointers, filtered by Mend to what the person can see. The
     * stream ends when the connection does; the caller reconnects and re-reads.
     */
    readonly events: (
      deviceToken: string,
    ) => Stream.Stream<MendEventPointer, MendDeviceRefused | MendUnavailable>;
  }
>()("@mend/t3-gateway/MendClient") {}

const decodeProjects = Schema.decodeUnknownEffect(Schema.Array(MendProject));
const decodeProjectDetail = Schema.decodeUnknownEffect(MendProjectDetail);
const decodeTurns = Schema.decodeUnknownEffect(Schema.Array(MendTurn));
const decodeRequests = Schema.decodeUnknownEffect(Schema.Array(MendRequest));
const decodeItems = Schema.decodeUnknownEffect(Schema.Array(MendItem));
const decodeSessionDetail = Schema.decodeUnknownEffect(MendSessionDetail);
const decodeChangeDiff = Schema.decodeUnknownEffect(MendChangeDiff);
const decodeActiveSessions = Schema.decodeUnknownEffect(Schema.Array(MendActiveSession));
const decodeConversationWait = Schema.decodeUnknownEffect(Schema.NullOr(MendConversationWait));
const decodeWorkspaceRetirement = Schema.decodeUnknownEffect(
  Schema.NullOr(MendWorkspaceRetirement),
);
const decodeTurn = Schema.decodeUnknownEffect(MendTurn);
const decodeWorktreeListing = Schema.decodeUnknownEffect(MendWorktreeListing);
const decodeSession = Schema.decodeUnknownEffect(MendSession);
const decodeRequest = Schema.decodeUnknownEffect(MendRequest);
const decodeRemovalReport = Schema.decodeUnknownEffect(MendRemovalReport);
const decodePastedImage = Schema.decodeUnknownEffect(MendPastedImage);
const decodeFileListing = Schema.decodeUnknownEffect(MendFileListing);
const MendErrorBody = Schema.Struct({
  _tag: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
const decodeErrorBody = Schema.decodeUnknownOption(MendErrorBody);
const decodePointer = Schema.decodeUnknownOption(Schema.fromJsonString(MendEventPointer));

/** The pointer an SSE `data:` line carries, or null for a heartbeat, a blank or a stray line. */
export const pointerOfSseLine = (line: string): MendEventPointer | null => {
  if (!line.startsWith("data:")) return null;
  const pointer = decodePointer(line.slice("data:".length).trim());
  return pointer._tag === "Some" ? pointer.value : null;
};

const readJson = (
  operation: string,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<unknown, MendUnavailable> =>
  response.json.pipe(
    Effect.mapError((cause) => new MendUnavailable({ operation, status: response.status, cause })),
  );

/** The body of a command that is a `DELETE`: it has none. */
const DELETE: unique symbol = Symbol("DELETE");

/** Speaks to the configured Mend through whatever `HttpClient` it is given. */
export const MendClientLive: Layer.Layer<MendClient, never, GatewayConfig | HttpClient.HttpClient> =
  Layer.effect(
    MendClient,
    Effect.gen(function* () {
      const config = yield* GatewayConfig;
      const http = yield* HttpClient.HttpClient;
      const url = (path: string) => new URL(path, config.mendUrl);

      const send = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
        http
          .execute(request)
          .pipe(
            Effect.mapError((cause) => new MendUnavailable({ operation, status: null, cause })),
          );

      const claimPairing = Effect.fn("MendClient.claimPairing")(function* ({
        forwardedFor,
        ...claim
      }: {
        readonly code: string;
        readonly name: string;
        readonly platform: MendDevicePlatform;
        readonly forwardedFor: string | undefined;
      }) {
        const operation = "POST /api/pair";
        const response = yield* send(
          operation,
          HttpClientRequest.post(url("/api/pair")).pipe(
            HttpClientRequest.acceptJson,
            forwardedFor === undefined
              ? (request) => request
              : HttpClientRequest.setHeader("x-forwarded-for", forwardedFor),
            HttpClientRequest.bodyJsonUnsafe(claim),
          ),
        );
        switch (response.status) {
          case 200: {
            const body = yield* readJson(operation, response);
            return yield* Schema.decodeUnknownEffect(PairClaim)(body).pipe(
              Effect.mapError(
                (cause) => new MendUnavailable({ operation, status: response.status, cause }),
              ),
            );
          }
          case 404:
            return yield* new MendPairingRefused({ reason: "unknown-code" });
          case 410:
            return yield* new MendPairingRefused({ reason: "spent-code" });
          case 429: {
            const body = yield* response.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(PairingRateLimitedBody)),
              Effect.option,
            );
            return yield* new MendPairingRateLimited({
              retryAfterSeconds: Option.getOrNull(Option.map(body, (b) => b.retryAfterSeconds)),
            });
          }
          default:
            return yield* new MendUnavailable({
              operation,
              status: response.status,
              cause: null,
            });
        }
      });

      const checkDevice = Effect.fn("MendClient.checkDevice")(function* (deviceToken: string) {
        const operation = "GET /api/me/devices";
        const response = yield* send(
          operation,
          HttpClientRequest.get(url("/api/me/devices")).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bearerToken(deviceToken),
          ),
        );
        if (response.status === 200) return "accepted" as const;
        if (response.status === 401) return "refused" as const;
        return yield* new MendUnavailable({ operation, status: response.status, cause: null });
      });

      const listHarnessModels = Effect.fn("MendClient.listHarnessModels")(function* (
        deviceToken: string,
      ) {
        const operation = "GET /api/harnesses/models";
        const response = yield* send(
          operation,
          HttpClientRequest.get(url("/api/harnesses/models")).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bearerToken(deviceToken),
          ),
        );
        if (response.status === 401) return yield* new MendDeviceRefused({ operation });
        if (response.status !== 200) {
          return yield* new MendUnavailable({ operation, status: response.status, cause: null });
        }
        const body = yield* readJson(operation, response);
        return yield* decodeHarnessCatalogs(body).pipe(
          Effect.mapError(
            (cause) => new MendUnavailable({ operation, status: response.status, cause }),
          ),
        );
      });

      /** A JSON read as the person: 401 is a refused device, 404 is nothing there. */
      const read = <A>(
        operation: string,
        path: string,
        deviceToken: string,
        decode: (body: unknown) => Effect.Effect<A, Schema.SchemaError>,
      ): MendRead<A> =>
        Effect.gen(function* () {
          const response = yield* send(
            operation,
            HttpClientRequest.get(url(path)).pipe(
              HttpClientRequest.acceptJson,
              HttpClientRequest.bearerToken(deviceToken),
            ),
          );
          if (response.status === 401) return yield* new MendDeviceRefused({ operation });
          if (response.status === 404) return yield* new MendNotFound({ operation });
          if (response.status !== 200) {
            return yield* new MendUnavailable({ operation, status: response.status, cause: null });
          }
          const body = yield* readJson(operation, response);
          return yield* decode(body).pipe(
            Effect.mapError(
              (cause) => new MendUnavailable({ operation, status: response.status, cause }),
            ),
          );
        }).pipe(Effect.withSpan(`MendClient ${operation}`));

      /**
       * A JSON command as the person. 401 is a refused device and 404 is nothing there; any other
       * 4xx is Mend's typed refusal, read from its body.
       */
      const command = <A>(
        operation: string,
        path: string,
        deviceToken: string,
        body: unknown,
        decode: ((value: unknown) => Effect.Effect<A, Schema.SchemaError>) | null,
      ): MendCommand<A | undefined> =>
        Effect.gen(function* () {
          const request =
            body === DELETE
              ? HttpClientRequest.delete(url(path))
              : HttpClientRequest.post(url(path)).pipe(HttpClientRequest.bodyJsonUnsafe(body));
          const response = yield* send(
            operation,
            request.pipe(HttpClientRequest.acceptJson, HttpClientRequest.bearerToken(deviceToken)),
          );
          if (response.status === 401) return yield* new MendDeviceRefused({ operation });
          if (response.status === 404) return yield* new MendNotFound({ operation });
          if (response.status >= 400 && response.status < 500) {
            const refusal = decodeErrorBody(
              yield* response.json.pipe(Effect.orElseSucceed((): unknown => null)),
            );
            return yield* new MendCommandRefused({
              operation,
              status: response.status,
              tag: refusal._tag === "Some" ? (refusal.value._tag ?? null) : null,
              detail: refusal._tag === "Some" ? (refusal.value.message ?? null) : null,
            });
          }
          if (response.status < 200 || response.status >= 300) {
            return yield* new MendUnavailable({ operation, status: response.status, cause: null });
          }
          if (decode === null) return undefined;
          const value = yield* readJson(operation, response);
          return yield* decode(value).pipe(
            Effect.mapError(
              (cause) => new MendUnavailable({ operation, status: response.status, cause }),
            ),
          );
        }).pipe(Effect.withSpan(`MendClient ${operation}`));

      /** The decoded answer of a command that has one. */
      const answered = <A>(effect: MendCommand<A | undefined>, operation: string): MendCommand<A> =>
        Effect.flatMap(effect, (value) =>
          value === undefined
            ? Effect.fail(new MendUnavailable({ operation, status: null, cause: null }))
            : Effect.succeed(value),
        );

      const sessionDetail = (deviceToken: string, sessionId: string) =>
        read(
          "GET /api/sessions/:id",
          `/api/sessions/${encodeURIComponent(sessionId)}`,
          deviceToken,
          decodeSessionDetail,
        );

      const listActiveSessions = (deviceToken: string) =>
        read("GET /api/sessions", "/api/sessions", deviceToken, decodeActiveSessions);

      const conversationWait = (deviceToken: string, sessionId: string) =>
        read(
          "GET /api/sessions/:id/waiting",
          `/api/sessions/${encodeURIComponent(sessionId)}/waiting`,
          deviceToken,
          decodeConversationWait,
        );

      const workspaceRetirement = (deviceToken: string, sessionId: string) =>
        read(
          "GET /api/sessions/:id/workspace-retirement",
          `/api/sessions/${encodeURIComponent(sessionId)}/workspace-retirement`,
          deviceToken,
          decodeWorkspaceRetirement,
        );

      const worktreeNames = (deviceToken: string, projectId: string) =>
        read(
          "GET /api/projects/:id/worktrees",
          `/api/projects/${encodeURIComponent(projectId)}/worktrees`,
          deviceToken,
          decodeWorktreeListing,
        ).pipe(Effect.map((listing) => listing.worktrees.map((worktree) => worktree.name)));

      const projectFiles = (deviceToken: string, projectId: string, sessionId: string | null) =>
        read(
          "GET /api/projects/:id/files",
          `/api/projects/${encodeURIComponent(projectId)}/files${
            sessionId === null ? "" : `?session=${encodeURIComponent(sessionId)}`
          }`,
          deviceToken,
          decodeFileListing,
        );

      const changeDiff = (deviceToken: string, changeId: string) =>
        read(
          "GET /api/changes/:id/diff",
          `/api/changes/${encodeURIComponent(changeId)}/diff`,
          deviceToken,
          decodeChangeDiff,
        );

      const submitTurn = (deviceToken: string, sessionId: string, input: string) =>
        answered(
          command(
            "POST /api/sessions/:id/turns",
            `/api/sessions/${encodeURIComponent(sessionId)}/turns`,
            deviceToken,
            { input },
            decodeTurn,
          ),
          "POST /api/sessions/:id/turns",
        );

      const launchProtocol = (
        deviceToken: string,
        sessionId: string,
        prompt: string,
        options: MendLaunchOptions = {},
      ) =>
        answered(
          command(
            "POST /api/sessions/:id/launch",
            `/api/sessions/${encodeURIComponent(sessionId)}/launch`,
            deviceToken,
            // No prompt is a launch that only brings the agent up (the gateway's relaunch).
            prompt === ""
              ? { mode: "protocol", ...options }
              : { mode: "protocol", prompt, ...options },
            decodeSession,
          ),
          "POST /api/sessions/:id/launch",
        );

      const createSession = (deviceToken: string, projectId: string, input: MendNewSession) =>
        answered(
          command(
            "POST /api/projects/:id/sessions",
            `/api/projects/${encodeURIComponent(projectId)}/sessions`,
            deviceToken,
            { ...input, mode: "protocol" },
            decodeSession,
          ),
          "POST /api/projects/:id/sessions",
        );

      const joinWorktree = (
        deviceToken: string,
        worktreeId: string,
        input: { readonly harness: string; readonly label: string | null },
      ) =>
        answered(
          command(
            "POST /api/worktrees/:id/sessions",
            `/api/worktrees/${encodeURIComponent(worktreeId)}/sessions`,
            deviceToken,
            { ...input, mode: "protocol" },
            decodeSession,
          ),
          "POST /api/worktrees/:id/sessions",
        );

      const labelSession = (deviceToken: string, sessionId: string, label: string | null) =>
        answered(
          command(
            "POST /api/sessions/:id/label",
            `/api/sessions/${encodeURIComponent(sessionId)}/label`,
            deviceToken,
            { label },
            decodeSession,
          ),
          "POST /api/sessions/:id/label",
        );

      const stopSession = (deviceToken: string, sessionId: string) =>
        answered(
          command(
            "POST /api/sessions/:id/stop",
            `/api/sessions/${encodeURIComponent(sessionId)}/stop`,
            deviceToken,
            {},
            decodeSession,
          ),
          "POST /api/sessions/:id/stop",
        );

      const removeSession = (deviceToken: string, sessionId: string) =>
        answered(
          command(
            "DELETE /api/sessions/:id",
            `/api/sessions/${encodeURIComponent(sessionId)}`,
            deviceToken,
            DELETE,
            decodeRemovalReport,
          ),
          "DELETE /api/sessions/:id",
        );

      const pasteImage = (deviceToken: string, sessionId: string, bytes: Uint8Array) =>
        answered(
          command(
            "POST /api/sessions/:id/images",
            `/api/sessions/${encodeURIComponent(sessionId)}/images`,
            deviceToken,
            { contentsBase64: Buffer.from(bytes).toString("base64") },
            decodePastedImage,
          ),
          "POST /api/sessions/:id/images",
        );

      const interruptTurn = (deviceToken: string, turnId: string) =>
        command(
          "POST /api/turns/:id/interrupt",
          `/api/turns/${encodeURIComponent(turnId)}/interrupt`,
          deviceToken,
          {},
          null,
        ).pipe(Effect.asVoid);

      const respondRequest = (
        deviceToken: string,
        requestId: string,
        response: MendRequestResponse,
      ) =>
        answered(
          command(
            "POST /api/requests/:id/respond",
            `/api/requests/${encodeURIComponent(requestId)}/respond`,
            deviceToken,
            response,
            decodeRequest,
          ),
          "POST /api/requests/:id/respond",
        );

      const listProjects = (deviceToken: string) =>
        read("GET /api/projects", "/api/projects", deviceToken, decodeProjects);

      const projectDetail = (deviceToken: string, projectId: string) =>
        read(
          "GET /api/projects/:id",
          `/api/projects/${encodeURIComponent(projectId)}`,
          deviceToken,
          decodeProjectDetail,
        );

      const listTurns = (deviceToken: string, sessionId: string) =>
        read(
          "GET /api/sessions/:id/turns",
          `/api/sessions/${encodeURIComponent(sessionId)}/turns`,
          deviceToken,
          decodeTurns,
        );

      const listItems = (deviceToken: string, sessionId: string, after: number, limit: number) =>
        read(
          "GET /api/sessions/:id/items",
          `/api/sessions/${encodeURIComponent(sessionId)}/items?after=${after}&limit=${limit}`,
          deviceToken,
          decodeItems,
        );

      const listRequests = (deviceToken: string, sessionId: string) =>
        read(
          "GET /api/sessions/:id/requests",
          `/api/sessions/${encodeURIComponent(sessionId)}/requests`,
          deviceToken,
          decodeRequests,
        );

      const events = (deviceToken: string) => {
        const operation = "GET /api/events";
        return Stream.unwrap(
          Effect.gen(function* () {
            const response = yield* send(
              operation,
              HttpClientRequest.get(url("/api/events")).pipe(
                HttpClientRequest.accept("text/event-stream"),
                HttpClientRequest.bearerToken(deviceToken),
              ),
            );
            if (response.status === 401) return yield* new MendDeviceRefused({ operation });
            if (response.status !== 200) {
              return yield* new MendUnavailable({
                operation,
                status: response.status,
                cause: null,
              });
            }
            return response.stream.pipe(
              Stream.mapError(
                (cause) => new MendUnavailable({ operation, status: response.status, cause }),
              ),
            );
          }),
        ).pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.map(pointerOfSseLine),
          Stream.filter((pointer): pointer is MendEventPointer => pointer !== null),
        );
      };

      return {
        claimPairing,
        checkDevice,
        listHarnessModels,
        listProjects,
        projectDetail,
        listTurns,
        listItems,
        listRequests,
        sessionDetail,
        listActiveSessions,
        conversationWait,
        workspaceRetirement,
        changeDiff,
        worktreeNames,

        projectFiles,
        createSession,
        joinWorktree,
        labelSession,
        stopSession,
        removeSession,
        pasteImage,
        submitTurn,
        launchProtocol,
        interruptTurn,
        respondRequest,
        events,
      };
    }),
  );
