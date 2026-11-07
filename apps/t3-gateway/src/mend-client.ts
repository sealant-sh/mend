import type { ProofArtifactId } from "@mend/domain";
import { isChosenDefault } from "@mend/domain/default-login";
import type { ConversationWaitWork } from "@mend/domain/workbench";
import type { TurnSelection } from "@mend/domain/workbench";
import {
  ForkOperation,
  MergeBackTransfer,
  SessionHistoryView,
  RollbackOperation,
  type RollbackRequest,
  type HistoryPosition,
  type ForkPoint,
  Person,
  ProofMimeType,
  RemovalBlocker,
} from "@mend/domain/workbench";
import { SourceControlRepositoryInfo } from "@mend/t3-contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { GatewayConfig } from "./config.ts";
import {
  MendPullRequestMergeAccess,
  type MendPullRequestMergeInput,
} from "./mend-pull-request-merge.ts";
import {
  MendChangeTour,
  MendChangePass,
  MendPullRequestDetail,
  MendPullRequestPage,
  type PullRequestSearch,
} from "./mend-pull-requests.ts";
import {
  MendActiveSession,
  MendChangeDiff,
  MendConversationWait,
  MendEventPointer,
  MendItem,
  MendProject,
  MendChangeLandings,
  MendChangeStats,
  MendCheckpoint,
  MendLanding,
  MendLandingReport,
  MendRangeDiff,
  MendWorktreeContents,
  MendWorktreeDetail,
  MendFileListing,
  MendSkill,
  MendPageFrame,
  MendPastedImage,
  MendProjectDetail,
  MendRemovalReport,
  MendShell,
  MendUpgradeTicket,
  MendRequest,
  MendSession,
  MendSessionDetail,
  MendTurn,
  MendTurnSteer,
  MendWorkspaceRetirement,
  type MendWorktree,
  MendLocalWorktree,
  MendWorktreeListing,
} from "./mend-workbench.ts";

/**
 * The gateway's view of Mend: an ordinary HTTP client of `/api`, calling as the person who paired
 * (ADR 0012, "A gateway, not a provider"). It does not import `@mend/api-contracts` (Effect
 * beta.93); it decodes only the fields it reads, so Mend can add fields freely.
 */

/**
 * A second more than Mend's ten-second wait to prepare a captured or checkpoint file
 * (`RawPreparationWait` in @mend/store), so a cold file usually gets Mend's `RawFilePreparing`
 * rather than this deadline. Either one shows the preview as unavailable.
 */
const RAW_HEADERS_DEADLINE = Duration.seconds(11);

const PAGE_DEADLINE = Duration.seconds(11);
const PAGE_VIEW_PATH = "/api/page-view";

/** A scoped response from Mend's raw endpoint; no upstream request or cause escapes. */
export interface MendRawFile {
  readonly captureId: string | null;
  readonly status: 200 | 206 | 416;
  readonly canonicalPath: Redacted.Redacted<string>;
  readonly revision: string;
  /** The file's device and inode, hashed: kept through an in-place edit, new for a replacement. */
  readonly identity: string;
  readonly length: number;
  readonly contentRange: string | undefined;
  readonly body: Stream.Stream<Uint8Array, MendRawFileUnavailable>;
}

export interface MendRawFileRequest {
  /** The capture a grant is pinned to (null: none); absent when minting accepts any. */
  readonly captureId?: string | null;
  readonly path: Redacted.Redacted<string>;
  readonly within: Redacted.Redacted<string>;
  readonly method: "GET" | "HEAD";
  readonly range?: string | undefined;
}

export class MendRawFileUnavailable extends Schema.TaggedError<MendRawFileUnavailable>()(
  "MendRawFileUnavailable",
  { status: Schema.NullOr(Schema.Number) },
) {}

/** A durable proof blob, checked against the caller's current change visibility by Mend. */
export interface MendProofMedia {
  readonly status: 200 | 206 | 416;
  readonly mimeType: ProofMimeType;
  readonly length: number;
  readonly contentRange: string | undefined;
  readonly body: Stream.Stream<Uint8Array, MendProofMediaUnavailable>;
}

export class MendProofMediaUnavailable extends Schema.TaggedError<MendProofMediaUnavailable>()(
  "MendProofMediaUnavailable",
  { status: Schema.NullOr(Schema.Number) },
) {}

export class MendPageUnavailable extends Schema.TaggedError<MendPageUnavailable>()(
  "MendPageUnavailable",
  { status: Schema.NullOr(Schema.Number) },
) {}

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
});
export type MendHarnessCatalog = typeof MendHarnessCatalog.Type;
const decodeHarnessCatalogs = Schema.decodeUnknownEffect(Schema.Array(MendHarnessCatalog));

/** `ProjectBranch` in @mend/api-contracts: a branch of the project's store. */
const MendBranch = Schema.Struct({ name: Schema.String, isDefault: Schema.Boolean });
export type MendBranch = typeof MendBranch.Type;
const decodeBranches = Schema.decodeUnknownEffect(Schema.Array(MendBranch));

const MendGithubRepository = Schema.Struct({
  ...SourceControlRepositoryInfo.fields,
  cloneUrl: Schema.String,
});
/** Repository identity and Mend's picker transport choice, from the caller's GitHub login. */
export type MendGithubRepository = typeof MendGithubRepository.Type;

/**
 * The person's connected accounts, from `GET /api/me/sealant` (`SealantIdentity` in
 * @mend/api-contracts). Mend never returns secret material here.
 */
const MendConnectedAccountWire = Schema.Struct({
  id: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  provider: Schema.String,
  name: Schema.String,
  isDefault: Schema.optional(Schema.Boolean),
  status: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type MendConnectedAccount = Omit<typeof MendConnectedAccountWire.Type, "isDefault"> & {
  readonly isDefault: boolean;
};
const decodeConnectedAccounts = Schema.decodeUnknownEffect(
  Schema.Struct({ accounts: Schema.Array(MendConnectedAccountWire) }),
);

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

/**
 * Mend refused a launch for a reason the session itself answers: the launch races another, or
 * finds the agent up. A 422 carries only words (`session_starting`, `session_active`); a 409 is
 * `SessionMovedOn` or `SessionAgentLive` (SLNT-167). Either way the caller reads the session.
 */
export const launchRacedOrLive = (error: MendCommandRefused): boolean =>
  error.status === 422 || error.status === 409;

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
  readonly speed?: "standard" | "fast";
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly permissionMode?: "bypass" | "ask" | undefined;
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

/**
 * What Mend answered a worktree or project removal (docs/adr/0007-landing.md, "Worktree
 * removal"). `Refused` carries Mend's blockers, never its words, which may offer a force no client
 * outside Mend has. `Unreadable` is any other refusal, or one whose body did not decode.
 */
export type MendRemoval =
  | { readonly _tag: "Removed" }
  | {
      readonly _tag: "Refused";
      readonly blockers: readonly [RemovalBlocker, ...Array<RemovalBlocker>];
      readonly forceWouldLift: boolean;
    }
  | { readonly _tag: "NotChangeOwner"; readonly owner: Person }
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Unreadable"; readonly status: number; readonly tag: string | null };

export type MendContentsQuestion =
  | { readonly path: string; readonly at: string | null }
  | {
      readonly query: string;
      readonly caseSensitive: boolean;
      readonly wholeWord: boolean;
      readonly regex: boolean;
      readonly limit: number;
    };

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
    /** `GET /api/me/sealant`, as the person who paired: the logins Mend holds for them. */
    readonly connectedAccounts: (
      deviceToken: string,
    ) => Effect.Effect<ReadonlyArray<MendConnectedAccount>, MendDeviceRefused | MendUnavailable>;
    /** Disconnect the caller's exact connected login, through Mend's existing account route. */
    readonly disconnectAccount: (deviceToken: string, accountId: string) => MendCommand<void>;
    /** `GET /api/harnesses/models`, as the person who paired: Mend's model catalog. */
    readonly listHarnessModels: (
      deviceToken: string,
    ) => Effect.Effect<ReadonlyArray<MendHarnessCatalog>, MendDeviceRefused | MendUnavailable>;
    /** Adopt a remote into Mend’s private project store using the caller’s git access. */
    readonly adoptProject: (
      deviceToken: string,
      name: string,
      source: string,
    ) => MendCommand<MendProject>;
    /** Rename a manageable project in Mend. */
    readonly renameProject: (
      deviceToken: string,
      projectId: string,
      name: string,
    ) => MendCommand<MendProject>;
    /** Resolve a repository in a workspace carrying only the caller’s GitHub login. */
    readonly lookupRepository: (
      deviceToken: string,
      repository: string,
    ) => MendCommand<MendGithubRepository>;
    /** `POST /api/projects/new`: a private project named `name`, or `name-2` on, with a README. */
    readonly createProject: (deviceToken: string, name: string) => MendCommand<MendProject>;
    /** `POST /api/projects/scratch`: the person's scratch project, created on first use. */
    readonly ensureScratchProject: (deviceToken: string) => MendCommand<MendProject>;
    /** `GET /api/projects`: the projects the person can see. */
    readonly listProjects: (deviceToken: string) => MendRead<ReadonlyArray<MendProject>>;
    /** `GET /api/projects/:id`: the project, its sessions and their list facts. */
    readonly projectDetail: (deviceToken: string, projectId: string) => MendRead<MendProjectDetail>;
    /** `GET /api/sessions/:id/turns`: the session's protocol turns, oldest first. */
    readonly nativeHistory: (
      deviceToken: string,
      sessionId: string,
    ) => MendRead<SessionHistoryView>;
    readonly mergeBack: (
      deviceToken: string,
      sessionId: string,
      input: {
        readonly commandId: string;
        readonly targetSessionId: string;
        readonly at: ForkPoint;
      },
    ) => MendCommand<MergeBackTransfer>;
    readonly rollbackSession: (
      deviceToken: string,
      sessionId: string,
      input: {
        readonly commandId: string;
        readonly at: RollbackRequest["at"];
        readonly expected: RollbackRequest["expected"];
        readonly restoreFiles?: boolean;
      },
    ) => MendCommand<RollbackOperation>;
    readonly forkSession: (
      deviceToken: string,
      sessionId: string,
      input: {
        readonly commandId: string;
        readonly at: ForkPoint;
        readonly title: string | null;
        readonly clientTarget?: string;
        readonly clientSource?: string;
      },
    ) => MendCommand<ForkOperation>;
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
    /** End provider background work through Mend's ownership check. */
    readonly endBackgroundWork: (
      deviceToken: string,
      sessionId: string,
      work: { readonly kind: ConversationWaitWork["kind"]; readonly id: string },
    ) => MendCommand<void>;
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
    /**
     * `GET /api/projects/:id/branches`: the branches the project's store holds now (no fetch), as
     * the composer's branch picker reads them. Never a session branch.
     */
    readonly projectBranches: (
      deviceToken: string,
      projectId: string,
    ) => MendRead<ReadonlyArray<MendBranch>>;
    /**
     * `POST /api/projects/:id/refresh`: fetches every origin branch into the project's store, then
     * answers its branches, so a worktree made from a branch afterwards starts at origin's tip.
     */
    readonly refreshProject: (
      deviceToken: string,
      projectId: string,
    ) => MendCommand<ReadonlyArray<MendBranch>>;
    /** `GET /api/projects/:id/worktrees`: the project's worktrees. */
    readonly listWorktrees: (
      deviceToken: string,
      projectId: string,
    ) => MendRead<ReadonlyArray<MendWorktree>>;
    /**
     * `DELETE /api/worktrees/:id`, never with `force`: only Mend, asked by the change's owner,
     * removes a change that is not on origin.
     */
    readonly removeWorktree: (
      deviceToken: string,
      worktreeId: string,
    ) => Effect.Effect<MendRemoval, MendDeviceRefused | MendUnavailable>;
    /** `DELETE /api/projects/:id`, which has no force. */
    readonly removeProject: (
      deviceToken: string,
      projectId: string,
    ) => Effect.Effect<MendRemoval, MendDeviceRefused | MendUnavailable>;

    /**
     * `GET /api/projects/:id/files?session=`: every file of the session's worktree, or, with no
     * session, of the project's default branch. Mend checks the project's visibility.
     */
    readonly projectFiles: (
      deviceToken: string,
      projectId: string,
      sessionId: string | null,
      after?: string,
    ) => MendRead<MendFileListing>;
    /** `GET /api/skills`: the person's own skill library. */
    readonly listSkills: (deviceToken: string) => MendRead<ReadonlyArray<MendSkill>>;
    /** `GET /api/projects/:id/skills`: the project's skill library. */
    readonly projectSkills: (
      deviceToken: string,
      projectId: string,
    ) => MendRead<ReadonlyArray<MendSkill>>;
    /** The worktree's checkpoint chain, oldest first (`GET /api/worktrees/:id`). */
    readonly worktreeCheckpoints: (
      deviceToken: string,
      worktreeId: string,
    ) => MendRead<ReadonlyArray<MendCheckpoint>>;
    /**
     * `GET /api/worktrees/:id/diff?from=&to=`: a slice of the chain, from a checkpoint (or the
     * worktree's base, for null) to a later one.
     */
    readonly worktreeDiff: (
      deviceToken: string,
      worktreeId: string,
      range: {
        readonly from: string | null;
        readonly to: string;
        readonly ignoreWhitespace: boolean;
      },
    ) => MendRead<MendRangeDiff>;
    /** `GET|HEAD /api/worktrees/:id/raw`: one file's bytes, current or at a pinned capture, whole or one range. */
    readonly openRawFile: (
      deviceToken: Redacted.Redacted<string>,
      worktreeId: string,
      input: MendRawFileRequest,
    ) => Effect.Effect<MendRawFile, MendRawFileUnavailable | MendDeviceRefused, Scope.Scope>;
    /** `GET|HEAD /api/proof-artifacts/:id/media`, with current change access checked on every read. */
    readonly openProofMedia: (
      deviceToken: Redacted.Redacted<string>,
      artifactId: ProofArtifactId,
      input: { readonly method: "GET" | "HEAD"; readonly range?: string | undefined },
    ) => Effect.Effect<MendProofMedia, MendProofMediaUnavailable | MendDeviceRefused, Scope.Scope>;
    readonly pageFrame: (
      deviceToken: Redacted.Redacted<string>,
      pageId: string,
    ) => Effect.Effect<Redacted.Redacted<string>, MendPageUnavailable | MendDeviceRefused>;
    readonly openPage: (
      deviceToken: Redacted.Redacted<string>,
      pageId: string,
    ) => Effect.Effect<
      Stream.Stream<Uint8Array, MendPageUnavailable>,
      MendPageUnavailable | MendDeviceRefused,
      Scope.Scope
    >;
    /**
     * `GET /api/worktrees/:id/contents`: one file (as it stands, or at a checkpoint) or the lines a
     * search matches. A path Mend refuses (outside the worktree) is its 422, a refusal. A path with
     * no readable file is `file: null` (Mend's 404 `NotFound` naming the path); a worktree or
     * checkpoint Mend does not have is `MendNotFound`.
     */
    /** Reads/searches the project's default branch, before a worktree exists. */
    readonly projectContents: (
      deviceToken: string,
      projectId: string,
      question: MendContentsQuestion,
    ) => MendCommand<MendWorktreeContents>;
    /** Default-branch bytes through Mend's bounded raw cache. */
    readonly openProjectRawFile: (
      deviceToken: Redacted.Redacted<string>,
      projectId: string,
      input: MendRawFileRequest,
    ) => Effect.Effect<MendRawFile, MendRawFileUnavailable | MendDeviceRefused, Scope.Scope>;
    readonly worktreeContents: (
      deviceToken: string,
      worktreeId: string,
      question:
        | { readonly path: string; readonly at: string | null }
        | {
            readonly query: string;
            readonly caseSensitive: boolean;
            readonly wholeWord: boolean;
            readonly regex: boolean;
            readonly limit: number;
          },
    ) => MendCommand<MendWorktreeContents>;
    /** `PUT /api/worktrees/:id/contents`, enforced by Mend's owner/shared-control boundary. */
    readonly writeWorktreeFile: (
      deviceToken: string,
      worktreeId: string,
      input: { readonly path: string; readonly contents: string },
    ) => MendCommand<{ readonly path: string }>;
    /** `GET /api/changes/:id/stats`: how many files, lines added and removed, without the patch. */
    readonly changeStats: (deviceToken: string, changeId: string) => MendRead<MendChangeStats>;
    /** `GET /api/changes/:id/diff`: the change against its base, as git answers now. */
    readonly changeDiff: (deviceToken: string, changeId: string) => MendRead<MendChangeDiff>;
    /** Stored review tour and its durable inference pass status, visible with the change. */
    readonly changeTour: (deviceToken: string, changeId: string) => MendRead<MendChangeTour | null>;
    readonly changePasses: (
      deviceToken: string,
      changeId: string,
    ) => MendRead<ReadonlyArray<MendChangePass>>;
    /** Compose with the asking person's Mend inference settings and login. */
    readonly composeChangeTour: (
      deviceToken: string,
      changeId: string,
    ) => MendCommand<{ readonly queued: boolean }>;
    /** Current caller GitHub login, without searching any repositories. */
    readonly pullRequestIdentity: (deviceToken: string) => MendRead<{ readonly viewer: string }>;
    /** Search one visible project's PRs as the caller's own GitHub account. */
    readonly pullRequestList: (
      deviceToken: string,
      projectId: string,
      input: PullRequestSearch,
    ) => MendCommand<MendPullRequestPage>;
    /** Observe a PR using the caller's GitHub rights, after Mend checks project visibility. */
    readonly pullRequestDetail: (
      deviceToken: string,
      projectId: string,
      repository: string,
      number: number,
    ) => MendRead<MendPullRequestDetail>;
    /**
     * `GET /api/changes/:id/landings`, without a fetch of origin. The change's landing record,
     * what Mend observed about it, and whether the caller owns it.
     */
    readonly changeLandings: (
      deviceToken: string,
      changeId: string,
    ) => MendRead<MendChangeLandings>;
    /**
     * `POST /api/sessions/:id/land`. Mend commits what the agent left uncommitted under its own
     * ref, pushes the change to its branch on origin, and opens or updates its pull request when
     * asked.
     * The change's owner only (403 `LandingNotAllowed`); 409 `LandingNotStarted` when nothing is
     * new. The pull request step can take a while, within `MEND_RESPONSE_DEADLINE`.
     */
    readonly land: (
      deviceToken: string,
      sessionId: string,
      input: { readonly pullRequest: boolean },
    ) => MendCommand<MendLandingReport>;
    /**
     * `POST /api/landings/:id/refresh`: Mend asks GitHub, as the change's owner, for the landing's
     * pull request now and records what it said. The owner only (403 `LandingNotAllowed`).
     */
    /** Fresh GitHub merge methods and rights on the connected person's account. */
    readonly pullRequestMergeAccess: (
      deviceToken: string,
      projectId: string,
      repository: string,
      number: number,
    ) => MendRead<MendPullRequestMergeAccess>;
    /** Only an explicit merge request, never called by automatic landing. */
    readonly mergePullRequest: (
      deviceToken: string,
      projectId: string,
      number: number,
      input: MendPullRequestMergeInput,
    ) => MendCommand<void>;
    readonly refreshLanding: (deviceToken: string, landingId: string) => MendCommand<MendLanding>;
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
    /** Read-only lookup; opening a project never starts Local. */
    readonly findLocalWorktree: (
      deviceToken: string,
      projectId: string,
    ) => MendRead<MendLocalWorktree | null>;
    /** Explicit Local/preview start; Mend preserves the shared checkout. */
    readonly startLocalWorktree: (
      deviceToken: string,
      projectId: string,
    ) => MendCommand<MendLocalWorktree>;
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
     * answers the path the agent sees. Steering rights, 10 MiB, PNG, JPEG, GIF or WebP.
     */
    readonly pasteImage: (
      deviceToken: string,
      sessionId: string,
      bytes: Uint8Array,
    ) => MendCommand<MendPastedImage>;
    /**
     * `POST /api/sessions/:id/shell`: a shell beside the agent in the session's live workspace.
     * Its owner's alone (`steering.owned`); a workspace that is not running is Mend's 409.
     */
    readonly openShell: (deviceToken: string, sessionId: string) => MendCommand<MendShell>;
    /** `POST /api/processes/:id/stop`: ends a shell. */
    readonly stopShell: (deviceToken: string, processId: string) => MendCommand<void>;
    /**
     * `POST /api/upgrade-tickets` for a `tty`: Mend's single-use, thirty-second ticket that opens
     * `/api/tty?process=` for this process and nothing else. Redacted: it is never logged.
     */
    readonly ttyTicket: (
      deviceToken: string,
      processId: string,
    ) => MendCommand<Redacted.Redacted<string>>;
    /** `POST /api/sessions/:id/turns`: one input for the session's live protocol agent. */
    readonly submitTurn: (
      deviceToken: string,
      sessionId: string,
      input: string,
      selection?: TurnSelection | null,
      receipt?: { readonly clientMessageId: string; readonly historyPosition: HistoryPosition },
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
    readonly steerTurn: (
      deviceToken: string,
      turnId: string,
      input: {
        readonly input: string;
        readonly clientSteerId: string;
        readonly historyPosition?: HistoryPosition;
        readonly selection?: TurnSelection;
      },
    ) => MendCommand<MendTurnSteer>;
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
const decodeTurnSteer = Schema.decodeUnknownEffect(MendTurnSteer);
const decodeTurn = Schema.decodeUnknownEffect(MendTurn);
const decodeWorktreeListing = Schema.decodeUnknownEffect(MendWorktreeListing);
const decodeLocalWorktree = Schema.decodeUnknownEffect(MendLocalWorktree);
const decodeLocalWorktreeOrNull = Schema.decodeUnknownEffect(Schema.NullOr(MendLocalWorktree));
const decodeSession = Schema.decodeUnknownEffect(MendSession);
const decodeRequest = Schema.decodeUnknownEffect(MendRequest);
const decodeRemovalReport = Schema.decodeUnknownEffect(MendRemovalReport);
const decodePastedImage = Schema.decodeUnknownEffect(MendPastedImage);
const decodeShell = Schema.decodeUnknownEffect(MendShell);
const decodeUpgradeTicket = Schema.decodeUnknownEffect(MendUpgradeTicket);
const decodeFileListing = Schema.decodeUnknownEffect(MendFileListing);
const decodeSkills = Schema.decodeUnknownEffect(Schema.Array(MendSkill));
const decodeChangeStats = Schema.decodeUnknownEffect(MendChangeStats);
const decodeChangeLandings = Schema.decodeUnknownEffect(MendChangeLandings);
const decodeLandingReport = Schema.decodeUnknownEffect(MendLandingReport);
const decodeLanding = Schema.decodeUnknownEffect(MendLanding);
const decodeWorktreeDetail = Schema.decodeUnknownEffect(MendWorktreeDetail);
const decodeRangeDiff = Schema.decodeUnknownEffect(MendRangeDiff);
const decodeWorktreeContents = Schema.decodeUnknownEffect(MendWorktreeContents);
const MendErrorBody = Schema.Struct({
  _tag: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
const decodeErrorBody = Schema.decodeUnknownOption(MendErrorBody);
const MendNotFoundBody = Schema.Struct({
  _tag: Schema.Literals(["NotFound", "WorktreeNotFound"]),
  id: Schema.String,
});
const decodeNotFoundBody = Schema.decodeUnknownOption(MendNotFoundBody);
/** `RemovalRefused` (409) and `RemovalForbidden` (403) in @mend/api-contracts. */
const decodeRemovalRefusal = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({
      _tag: Schema.Literal("RemovalRefused"),
      blockers: Schema.NonEmptyArray(RemovalBlocker),
      forceWouldLift: Schema.Boolean,
    }),
    Schema.Struct({ _tag: Schema.Literal("RemovalForbidden"), owner: Person }),
  ]),
);
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

/**
 * How long a call waits for Mend's response to begin. Generous: starting a session's workspace can
 * take tens of seconds. The event stream's response begins at once and is then read for as long as
 * it lasts.
 */
export const MEND_RESPONSE_DEADLINE = "2 minutes";

/** Speaks to the configured Mend through whatever `HttpClient` it is given. */
export const MendClientLive: Layer.Layer<MendClient, never, GatewayConfig | HttpClient.HttpClient> =
  Layer.effect(
    MendClient,
    Effect.gen(function* () {
      const config = yield* GatewayConfig;
      const http = yield* HttpClient.HttpClient;
      const url = (path: string) => new URL(path, config.mendUrl);

      const withinPageDeadline = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.timeoutOrElse(effect, {
          duration: PAGE_DEADLINE,
          orElse: () => Effect.fail(new MendPageUnavailable({ status: null })),
        });

      const pageResponse = (request: HttpClientRequest.HttpClientRequest) =>
        HttpClient.withScope(http)
          .execute(request)
          .pipe(
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
            Effect.mapError(() => new MendPageUnavailable({ status: null })),
          );

      const pageFrame: MendClient["Service"]["pageFrame"] = (deviceToken, pageId) =>
        Effect.scoped(
          Effect.gen(function* () {
            const response = yield* pageResponse(
              HttpClientRequest.get(
                url(`/api/pages/${encodeURIComponent(pageId)}/frame?appearance=light`),
              ).pipe(HttpClientRequest.bearerToken(deviceToken)),
            );
            if (response.status === 401)
              return yield* new MendDeviceRefused({ operation: "page frame" });
            if (response.status !== 200)
              return yield* new MendPageUnavailable({ status: response.status });
            const frame = yield* response.json.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(MendPageFrame)),
              Effect.mapError(() => new MendPageUnavailable({ status: 200 })),
            );
            const target = URL.parse(frame.url, config.mendUrl);
            if (
              target === null ||
              target.origin !== config.mendUrl.origin ||
              target.pathname !== PAGE_VIEW_PATH ||
              target.hash !== "" ||
              !target.searchParams.get("view") ||
              !(Date.parse(frame.expiresAt) > (yield* Clock.currentTimeMillis))
            )
              return yield* new MendPageUnavailable({ status: 200 });
            return Redacted.make(target.toString());
          }),
        ).pipe(withinPageDeadline);

      const openPage: MendClient["Service"]["openPage"] = (deviceToken, pageId) =>
        Effect.gen(function* () {
          const frame = yield* pageFrame(deviceToken, pageId);
          const response = yield* pageResponse(HttpClientRequest.get(Redacted.value(frame))).pipe(
            withinPageDeadline,
          );
          if (response.status !== 200)
            return yield* new MendPageUnavailable({ status: response.status });
          if (
            response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "text/html"
          )
            return yield* new MendPageUnavailable({ status: 200 });
          return response.stream.pipe(
            Stream.mapError(() => new MendPageUnavailable({ status: 200 })),
          );
        });

      const send = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
        http.execute(request).pipe(
          Effect.mapError((cause) => new MendUnavailable({ operation, status: null, cause })),
          // A Mend that takes the connection and never answers is Mend not answering.
          Effect.timeoutOrElse({
            duration: MEND_RESPONSE_DEADLINE,
            orElse: () =>
              Effect.fail(
                new MendUnavailable({
                  operation,
                  status: null,
                  cause: `no response within ${MEND_RESPONSE_DEADLINE}`,
                }),
              ),
          }),
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

      const connectedAccounts = Effect.fn("MendClient.connectedAccounts")(function* (
        deviceToken: string,
      ) {
        const operation = "GET /api/me/sealant";
        const response = yield* send(
          operation,
          HttpClientRequest.get(url("/api/me/sealant")).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bearerToken(deviceToken),
          ),
        );
        if (response.status === 401) return yield* new MendDeviceRefused({ operation });
        if (response.status !== 200) {
          return yield* new MendUnavailable({ operation, status: response.status, cause: null });
        }
        const body = yield* readJson(operation, response);
        return yield* decodeConnectedAccounts(body).pipe(
          Effect.map((identity) =>
            identity.accounts.map(
              (account): MendConnectedAccount => ({
                ...account,
                isDefault: isChosenDefault(account),
              }),
            ),
          ),
          Effect.mapError(
            (cause) => new MendUnavailable({ operation, status: response.status, cause }),
          ),
        );
      });

      const disconnectAccount: MendClient["Service"]["disconnectAccount"] = Effect.fn(
        "MendClient.disconnectAccount",
      )(function* (deviceToken, accountId) {
        const operation = "DELETE /api/me/sealant/accounts/:id";
        const response = yield* send(
          operation,
          HttpClientRequest.delete(
            url(`/api/me/sealant/accounts/${encodeURIComponent(accountId)}`),
          ).pipe(HttpClientRequest.bearerToken(deviceToken)),
        );
        if (response.status === 401) return yield* new MendDeviceRefused({ operation });
        if (response.status >= 500)
          return yield* new MendUnavailable({ operation, status: response.status, cause: null });
        if (response.status !== 200)
          return yield* new MendCommandRefused({
            operation,
            status: response.status,
            tag: null,
            detail: null,
          });
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
        method: "POST" | "PUT" = "POST",
      ): MendCommand<A | undefined> =>
        Effect.gen(function* () {
          const request =
            body === DELETE
              ? HttpClientRequest.delete(url(path))
              : (method === "PUT"
                  ? HttpClientRequest.put(url(path))
                  : HttpClientRequest.post(url(path))
                ).pipe(HttpClientRequest.bodyJsonUnsafe(body));
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

      const endBackgroundWork: MendClient["Service"]["endBackgroundWork"] = (
        deviceToken,
        sessionId,
        work,
      ) =>
        command(
          "POST /api/sessions/:id/waiting/end",
          `/api/sessions/${encodeURIComponent(sessionId)}/waiting/end`,
          deviceToken,
          work,
          null,
        ).pipe(Effect.asVoid);

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

      const projectBranches = (deviceToken: string, projectId: string) =>
        read(
          "GET /api/projects/:id/branches",
          `/api/projects/${encodeURIComponent(projectId)}/branches`,
          deviceToken,
          decodeBranches,
        );

      const refreshProject = (deviceToken: string, projectId: string) =>
        answered(
          command(
            "POST /api/projects/:id/refresh",
            `/api/projects/${encodeURIComponent(projectId)}/refresh`,
            deviceToken,
            {},
            decodeBranches,
          ),
          "POST /api/projects/:id/refresh",
        );

      const listWorktrees = (deviceToken: string, projectId: string) =>
        read(
          "GET /api/projects/:id/worktrees",
          `/api/projects/${encodeURIComponent(projectId)}/worktrees`,
          deviceToken,
          decodeWorktreeListing,
        ).pipe(Effect.map((listing) => listing.worktrees));

      const removal = (operation: string, path: string, deviceToken: string) =>
        Effect.gen(function* () {
          const response = yield* send(
            operation,
            HttpClientRequest.delete(url(path)).pipe(
              HttpClientRequest.acceptJson,
              HttpClientRequest.bearerToken(deviceToken),
            ),
          );
          if (response.status === 401) return yield* new MendDeviceRefused({ operation });
          if (response.status === 200) {
            yield* decodeRemovalReport(yield* readJson(operation, response)).pipe(
              Effect.mapError(
                (cause) => new MendUnavailable({ operation, status: response.status, cause }),
              ),
            );
            return { _tag: "Removed" } as const;
          }
          if (response.status === 404) return { _tag: "NotFound" } as const;
          if (response.status < 400 || response.status >= 500) {
            return yield* new MendUnavailable({ operation, status: response.status, cause: null });
          }
          const body = yield* response.json.pipe(Effect.orElseSucceed((): unknown => null));
          const refusal = Option.getOrNull(decodeRemovalRefusal(body));
          if (refusal?._tag === "RemovalRefused" && response.status === 409) {
            return {
              _tag: "Refused",
              blockers: refusal.blockers,
              forceWouldLift: refusal.forceWouldLift,
            } as const;
          }
          if (refusal?._tag === "RemovalForbidden" && response.status === 403) {
            return { _tag: "NotChangeOwner", owner: refusal.owner } as const;
          }
          const words = decodeErrorBody(body);
          return {
            _tag: "Unreadable",
            status: response.status,
            tag: words._tag === "Some" ? (words.value._tag ?? null) : null,
          } as const;
        }).pipe(Effect.withSpan(`MendClient ${operation}`));

      const removeWorktree = (deviceToken: string, worktreeId: string) =>
        removal(
          "DELETE /api/worktrees/:id",
          `/api/worktrees/${encodeURIComponent(worktreeId)}`,
          deviceToken,
        );

      const removeProject = (deviceToken: string, projectId: string) =>
        removal(
          "DELETE /api/projects/:id",
          `/api/projects/${encodeURIComponent(projectId)}`,
          deviceToken,
        );

      const projectFiles = (
        deviceToken: string,
        projectId: string,
        sessionId: string | null,
        after?: string,
      ) => {
        const query = new URLSearchParams();
        if (sessionId !== null) query.set("session", sessionId);
        if (after !== undefined) query.set("after", after);
        return read(
          "GET /api/projects/:id/files",
          `/api/projects/${encodeURIComponent(projectId)}/files${
            query.size === 0 ? "" : `?${query}`
          }`,
          deviceToken,
          decodeFileListing,
        );
      };

      const listSkills = (deviceToken: string) =>
        read("GET /api/skills", "/api/skills", deviceToken, decodeSkills);

      const projectSkills = (deviceToken: string, projectId: string) =>
        read(
          "GET /api/projects/:id/skills",
          `/api/projects/${encodeURIComponent(projectId)}/skills`,
          deviceToken,
          decodeSkills,
        );

      const nativeHistory = (deviceToken: string, sessionId: string) =>
        read(
          "GET /api/sessions/:id/native-history",
          `/api/sessions/${encodeURIComponent(sessionId)}/native-history`,
          deviceToken,
          Schema.decodeUnknownEffect(Schema.toCodecJson(SessionHistoryView)),
        );
      const mergeBack: MendClient["Service"]["mergeBack"] = (deviceToken, sessionId, input) =>
        answered(
          command(
            "POST /api/sessions/:id/merge-backs",
            `/api/sessions/${encodeURIComponent(sessionId)}/merge-backs`,
            deviceToken,
            input,
            Schema.decodeUnknownEffect(Schema.toCodecJson(MergeBackTransfer)),
          ),
          "POST /api/sessions/:id/merge-backs",
        );
      const rollbackSession: MendClient["Service"]["rollbackSession"] = (
        deviceToken,
        sessionId,
        input,
      ) =>
        answered(
          command(
            "POST /api/sessions/:id/rollbacks",
            `/api/sessions/${encodeURIComponent(sessionId)}/rollbacks`,
            deviceToken,
            input,
            Schema.decodeUnknownEffect(Schema.toCodecJson(RollbackOperation)),
          ),
          "POST /api/sessions/:id/rollbacks",
        );
      const forkSession = (
        deviceToken: string,
        sessionId: string,
        input: {
          readonly commandId: string;
          readonly at: ForkPoint;
          readonly title: string | null;
          readonly clientTarget?: string;
          readonly clientSource?: string;
        },
      ) =>
        answered(
          command(
            "POST /api/sessions/:id/forks",
            `/api/sessions/${encodeURIComponent(sessionId)}/forks`,
            deviceToken,
            input,
            Schema.decodeUnknownEffect(Schema.toCodecJson(ForkOperation)),
          ),
          "POST /api/sessions/:id/forks",
        );
      const worktreeCheckpoints = (deviceToken: string, worktreeId: string) =>
        read(
          "GET /api/worktrees/:id",
          `/api/worktrees/${encodeURIComponent(worktreeId)}`,
          deviceToken,
          decodeWorktreeDetail,
        ).pipe(Effect.map((detail) => detail.checkpoints));

      const worktreeDiff = (
        deviceToken: string,
        worktreeId: string,
        range: {
          readonly from: string | null;
          readonly to: string;
          readonly ignoreWhitespace: boolean;
        },
      ) => {
        const query = new URLSearchParams({ to: range.to });
        if (range.from !== null) query.set("from", range.from);
        if (range.ignoreWhitespace) query.set("whitespace", "ignore");
        return read(
          "GET /api/worktrees/:id/diff",
          `/api/worktrees/${encodeURIComponent(worktreeId)}/diff?${query.toString()}`,
          deviceToken,
          decodeRangeDiff,
        );
      };

      const openRawAt = (
        deviceToken: Redacted.Redacted<string>,
        collection: "projects" | "worktrees",
        id: string,
        input: MendRawFileRequest,
      ): Effect.Effect<MendRawFile, MendRawFileUnavailable | MendDeviceRefused, Scope.Scope> =>
        Effect.gen(function* () {
          const query = new URLSearchParams({
            path: Redacted.value(input.path),
            within: Redacted.value(input.within),
          });
          if (input.captureId !== undefined && input.captureId !== null)
            query.set("capture", input.captureId);
          const request = HttpClientRequest.make(input.method)(
            url(`/api/${collection}/${encodeURIComponent(id)}/raw?${query}`),
          ).pipe(
            HttpClientRequest.bearerToken(deviceToken),
            HttpClientRequest.setHeaders(input.range === undefined ? {} : { range: input.range }),
          );
          const response = yield* HttpClient.withScope(http)
            .execute(request)
            .pipe(
              Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
              Effect.mapError(() => new MendRawFileUnavailable({ status: null })),
              Effect.timeoutOrElse({
                duration: RAW_HEADERS_DEADLINE,
                orElse: () => Effect.fail(new MendRawFileUnavailable({ status: null })),
              }),
            );
          const status = response.status;
          if (status === 401) return yield* new MendDeviceRefused({ operation: "worktree raw" });
          if (status !== 200 && status !== 206 && status !== 416)
            return yield* new MendRawFileUnavailable({ status });
          const canonicalPath = yield* Effect.try({
            try: () => decodeURIComponent(response.headers["x-mend-file-path"] ?? ""),
            catch: () => new MendRawFileUnavailable({ status }),
          });
          const lengthText = response.headers["content-length"] ?? "";
          const length = Number(lengthText);
          const revision = response.headers["x-mend-file-revision"] ?? "";
          const identity = response.headers["x-mend-file-identity"] ?? "";
          const contentRange = response.headers["content-range"];
          const captureId = response.headers["x-mend-capture-id"] ?? null;
          if (
            (captureId !== null && !/^[a-f0-9]{64}$/.test(captureId)) ||
            (input.captureId !== undefined && captureId !== input.captureId) ||
            !/^\d+$/.test(lengthText) ||
            !Number.isSafeInteger(length) ||
            length < 0 ||
            !/^[a-f0-9]{64}$/.test(revision) ||
            !/^[a-f0-9]{64}$/.test(identity) ||
            canonicalPath === "" ||
            (status === 206 && !/^bytes \d+-\d+\/\d+$/.test(contentRange ?? "")) ||
            (status === 416 && !/^bytes \*\/\d+$/.test(contentRange ?? ""))
          )
            return yield* new MendRawFileUnavailable({ status });
          return {
            status,
            canonicalPath: Redacted.make(canonicalPath),
            captureId,
            revision,
            identity,
            length,
            contentRange,
            body: response.stream.pipe(
              Stream.mapError(() => new MendRawFileUnavailable({ status })),
            ),
          };
        });

      const openRawFile: MendClient["Service"]["openRawFile"] = (token, id, input) =>
        openRawAt(token, "worktrees", id, input);
      const openProjectRawFile: MendClient["Service"]["openProjectRawFile"] = (token, id, input) =>
        openRawAt(token, "projects", id, input);

      const openProofMedia: MendClient["Service"]["openProofMedia"] = (
        deviceToken,
        artifactId,
        input,
      ) =>
        Effect.gen(function* () {
          const request = HttpClientRequest.make(input.method)(
            url(`/api/proof-artifacts/${encodeURIComponent(artifactId)}/media`),
          ).pipe(
            HttpClientRequest.bearerToken(deviceToken),
            HttpClientRequest.setHeaders(input.range === undefined ? {} : { range: input.range }),
          );
          const response = yield* HttpClient.withScope(http)
            .execute(request)
            .pipe(
              Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
              Effect.mapError(() => new MendProofMediaUnavailable({ status: null })),
              Effect.timeoutOrElse({
                duration: RAW_HEADERS_DEADLINE,
                orElse: () => Effect.fail(new MendProofMediaUnavailable({ status: null })),
              }),
            );
          const status = response.status;
          if (status === 401) return yield* new MendDeviceRefused({ operation: "proof media" });
          if (status !== 200 && status !== 206 && status !== 416)
            return yield* new MendProofMediaUnavailable({ status });
          const mimeType = Schema.decodeUnknownOption(ProofMimeType)(
            response.headers["content-type"],
          );
          const lengthText = response.headers["content-length"] ?? "";
          const length = Number(lengthText);
          const contentRange = response.headers["content-range"];
          if (
            Option.isNone(mimeType) ||
            !/^\d+$/.test(lengthText) ||
            !Number.isSafeInteger(length) ||
            length < 0 ||
            (input.method === "HEAD" && status !== 200) ||
            (status === 206 && !/^bytes \d+-\d+\/\d+$/.test(contentRange ?? "")) ||
            (status === 416 && (length !== 0 || !/^bytes \*\/\d+$/.test(contentRange ?? "")))
          )
            return yield* new MendProofMediaUnavailable({ status });
          return {
            status,
            mimeType: mimeType.value,
            length,
            contentRange,
            body: response.stream.pipe(
              Stream.mapError(() => new MendProofMediaUnavailable({ status })),
            ),
          };
        });

      const contentsAt = (
        deviceToken: string,
        collection: "projects" | "worktrees",
        id: string,
        question:
          | { readonly path: string; readonly at: string | null }
          | {
              readonly query: string;
              readonly caseSensitive: boolean;
              readonly wholeWord: boolean;
              readonly regex: boolean;
              readonly limit: number;
            },
      ): MendCommand<MendWorktreeContents> => {
        const operation = `GET /api/${collection}/:id/contents`;
        const query = new URLSearchParams();
        if ("path" in question) {
          query.set("path", question.path);
          if (question.at !== null) query.set("at", question.at);
        } else {
          query.set("query", question.query);
          query.set("caseSensitive", String(question.caseSensitive));
          query.set("wholeWord", String(question.wholeWord));
          query.set("regex", String(question.regex));
          query.set("limit", String(question.limit));
        }
        return Effect.gen(function* () {
          const response = yield* send(
            operation,
            HttpClientRequest.get(
              url(`/api/${collection}/${encodeURIComponent(id)}/contents?${query.toString()}`),
            ).pipe(HttpClientRequest.acceptJson, HttpClientRequest.bearerToken(deviceToken)),
          );
          if (response.status === 401) return yield* new MendDeviceRefused({ operation });
          if (response.status === 404) {
            const missing = decodeNotFoundBody(
              yield* response.json.pipe(Effect.orElseSucceed((): unknown => null)),
            );
            const noFile =
              "path" in question &&
              missing._tag === "Some" &&
              missing.value._tag === "NotFound" &&
              missing.value.id === question.path;
            if (noFile) return { file: null, search: null };
            return yield* new MendNotFound({ operation });
          }
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
          if (response.status !== 200) {
            return yield* new MendUnavailable({ operation, status: response.status, cause: null });
          }
          const body = yield* readJson(operation, response);
          return yield* decodeWorktreeContents(body).pipe(
            Effect.mapError(
              (cause) => new MendUnavailable({ operation, status: response.status, cause }),
            ),
          );
        }).pipe(Effect.withSpan(`MendClient ${operation}`));
      };

      const writeWorktreeFile: MendClient["Service"]["writeWorktreeFile"] = (token, id, input) =>
        answered(
          command(
            "PUT /api/worktrees/:id/contents",
            `/api/worktrees/${encodeURIComponent(id)}/contents`,
            token,
            input,
            Schema.decodeUnknownEffect(Schema.Struct({ path: Schema.String })),
            "PUT",
          ),
          "PUT /api/worktrees/:id/contents",
        );
      const worktreeContents: MendClient["Service"]["worktreeContents"] = (token, id, question) =>
        contentsAt(token, "worktrees", id, question);
      const projectContents: MendClient["Service"]["projectContents"] = (token, id, question) =>
        contentsAt(token, "projects", id, question);

      const changeStats = (deviceToken: string, changeId: string) =>
        read(
          "GET /api/changes/:id/stats",
          `/api/changes/${encodeURIComponent(changeId)}/stats`,
          deviceToken,
          decodeChangeStats,
        );

      const changeDiff = (deviceToken: string, changeId: string) =>
        read(
          "GET /api/changes/:id/diff",
          `/api/changes/${encodeURIComponent(changeId)}/diff`,
          deviceToken,
          decodeChangeDiff,
        );

      const changeTour = (deviceToken: string, changeId: string) =>
        read(
          "GET /api/changes/:id/tour",
          `/api/changes/${encodeURIComponent(changeId)}/tour`,
          deviceToken,
          Schema.decodeUnknownEffect(Schema.NullOr(MendChangeTour)),
        );
      const changePasses = (deviceToken: string, changeId: string) =>
        read(
          "GET /api/changes/:id/passes",
          `/api/changes/${encodeURIComponent(changeId)}/passes`,
          deviceToken,
          Schema.decodeUnknownEffect(Schema.Array(MendChangePass)),
        );
      const composeChangeTour = (deviceToken: string, changeId: string) =>
        answered(
          command(
            "POST /api/changes/:id/tour",
            `/api/changes/${encodeURIComponent(changeId)}/tour`,
            deviceToken,
            {},
            Schema.decodeUnknownEffect(Schema.Struct({ queued: Schema.Boolean })),
          ),
          "POST /api/changes/:id/tour",
        );

      const pullRequestIdentity = (deviceToken: string) =>
        read(
          "GET /api/github/pull-request-identity",
          "/api/github/pull-request-identity",
          deviceToken,
          Schema.decodeUnknownEffect(Schema.Struct({ viewer: Schema.String })),
        );
      const pullRequestList = (deviceToken: string, projectId: string, input: PullRequestSearch) =>
        answered(
          command(
            "POST /api/projects/:id/pull-requests/search",
            `/api/projects/${encodeURIComponent(projectId)}/pull-requests/search`,
            deviceToken,
            input,
            Schema.decodeUnknownEffect(MendPullRequestPage),
          ),
          "POST /api/projects/:id/pull-requests/search",
        );
      const pullRequestDetail = (
        deviceToken: string,
        projectId: string,
        repository: string,
        number: number,
      ) =>
        read(
          "GET /api/projects/:id/pull-requests/:number",
          `/api/projects/${encodeURIComponent(projectId)}/pull-requests/${number}?repository=${encodeURIComponent(repository)}`,
          deviceToken,
          Schema.decodeUnknownEffect(MendPullRequestDetail),
        );

      const changeLandings = (deviceToken: string, changeId: string) =>
        read(
          "GET /api/changes/:id/landings",
          `/api/changes/${encodeURIComponent(changeId)}/landings`,
          deviceToken,
          decodeChangeLandings,
        );

      const land = (
        deviceToken: string,
        sessionId: string,
        input: { readonly pullRequest: boolean },
      ) =>
        answered(
          command(
            "POST /api/sessions/:id/land",
            `/api/sessions/${encodeURIComponent(sessionId)}/land`,
            deviceToken,
            { pullRequest: input.pullRequest, branch: null, title: null, body: null },
            decodeLandingReport,
          ),
          "POST /api/sessions/:id/land",
        );

      const refreshLanding = (deviceToken: string, landingId: string) =>
        answered(
          command(
            "POST /api/landings/:id/refresh",
            `/api/landings/${encodeURIComponent(landingId)}/refresh`,
            deviceToken,
            {},
            decodeLanding,
          ),
          "POST /api/landings/:id/refresh",
        );

      const submitTurn = (
        deviceToken: string,
        sessionId: string,
        input: string,
        selection?: TurnSelection | null,
        receipt?: { readonly clientMessageId: string; readonly historyPosition: HistoryPosition },
      ) =>
        receipt === undefined
          ? answered(
              command(
                "POST /api/sessions/:id/turns",
                `/api/sessions/${encodeURIComponent(sessionId)}/turns`,
                deviceToken,
                { input, ...(selection == null ? {} : { selection }) },
                decodeTurn,
              ),
              "POST /api/sessions/:id/turns",
            )
          : answered(
              command(
                "POST /api/sessions/:id/messages",
                `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
                deviceToken,
                { input, ...(selection == null ? {} : { selection }), ...receipt, queue: true },
                Schema.decodeUnknownEffect(
                  Schema.Struct({ _tag: Schema.Literal("Turn"), turn: MendTurn }),
                ),
              ),
              "POST /api/sessions/:id/messages",
            ).pipe(Effect.map((result) => result.turn));

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

      const adoptProject = (token: string, name: string, source: string) =>
        answered(
          command(
            "POST /api/projects",
            "/api/projects",
            token,
            { name, source, visibility: "private" },
            Schema.decodeUnknownEffect(MendProject),
          ),
          "POST /api/projects",
        );
      const renameProject = (token: string, id: string, name: string) =>
        answered(
          command(
            "POST /api/projects/:id/name",
            `/api/projects/${encodeURIComponent(id)}/name`,
            token,
            { name },
            Schema.decodeUnknownEffect(MendProject),
          ),
          "POST /api/projects/:id/name",
        );
      const lookupRepository = (token: string, repository: string) =>
        answered(
          command(
            "POST /api/github/repository",
            "/api/github/repository",
            token,
            { repository },
            Schema.decodeUnknownEffect(MendGithubRepository),
          ),
          "POST /api/github/repository",
        );

      const createProject = (deviceToken: string, name: string) =>
        answered(
          command(
            "POST /api/projects/new",
            "/api/projects/new",
            deviceToken,
            { name },
            Schema.decodeUnknownEffect(MendProject),
          ),
          "POST /api/projects/new",
        );
      const ensureScratchProject = (deviceToken: string) =>
        answered(
          command(
            "POST /api/projects/scratch",
            "/api/projects/scratch",
            deviceToken,
            {},
            Schema.decodeUnknownEffect(MendProject),
          ),
          "POST /api/projects/scratch",
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

      const findLocalWorktree = (deviceToken: string, projectId: string) =>
        read(
          "GET /api/projects/:id/local-worktree",
          `/api/projects/${encodeURIComponent(projectId)}/local-worktree`,
          deviceToken,
          decodeLocalWorktreeOrNull,
        );

      const startLocalWorktree = (deviceToken: string, projectId: string) =>
        answered(
          command(
            "POST /api/projects/:id/local-worktree",
            `/api/projects/${encodeURIComponent(projectId)}/local-worktree`,
            deviceToken,
            {},
            decodeLocalWorktree,
          ),
          "POST /api/projects/:id/local-worktree",
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

      const openShell = (deviceToken: string, sessionId: string) =>
        answered(
          command(
            "POST /api/sessions/:id/shell",
            `/api/sessions/${encodeURIComponent(sessionId)}/shell`,
            deviceToken,
            {},
            decodeShell,
          ),
          "POST /api/sessions/:id/shell",
        );

      const stopShell = (deviceToken: string, processId: string) =>
        command(
          "POST /api/processes/:id/stop",
          `/api/processes/${encodeURIComponent(processId)}/stop`,
          deviceToken,
          {},
          null,
        ).pipe(Effect.asVoid);

      const ttyTicket = (deviceToken: string, processId: string) =>
        answered(
          command(
            "POST /api/upgrade-tickets",
            "/api/upgrade-tickets",
            deviceToken,
            { target: "tty", process: processId },
            decodeUpgradeTicket,
          ),
          "POST /api/upgrade-tickets",
        ).pipe(Effect.map((minted) => Redacted.make(minted.ticket)));

      const steerTurn: MendClient["Service"]["steerTurn"] = (deviceToken, turnId, input) =>
        answered(
          command(
            "POST /api/turns/:id/steer",
            `/api/turns/${encodeURIComponent(turnId)}/steer`,
            deviceToken,
            input,
            decodeTurnSteer,
          ),
          "POST /api/turns/:id/steer",
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
          `/api/projects/${encodeURIComponent(projectId)}?deadEnds=include`,
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
        nativeHistory,
        mergeBack,
        rollbackSession,
        forkSession,
        claimPairing,
        checkDevice,
        connectedAccounts,
        disconnectAccount,
        listHarnessModels,
        listProjects,
        adoptProject,
        renameProject,
        lookupRepository,
        createProject,
        ensureScratchProject,
        projectDetail,
        listTurns,
        listItems,
        listRequests,
        sessionDetail,
        listActiveSessions,
        conversationWait,
        endBackgroundWork,
        workspaceRetirement,
        changeDiff,
        projectBranches,
        refreshProject,
        listWorktrees,
        removeWorktree,
        removeProject,
        changeStats,
        changeLandings,
        changeTour,
        changePasses,
        composeChangeTour,
        pullRequestIdentity,
        pullRequestList,
        pullRequestDetail,
        land,
        pullRequestMergeAccess: (token, projectId, repository, number) =>
          read(
            "GET /api/projects/:id/pull-requests/:number/merge-access",
            `/api/projects/${encodeURIComponent(projectId)}/pull-requests/${number}/merge-access?${new URLSearchParams({ repository })}`,
            token,
            Schema.decodeUnknownEffect(MendPullRequestMergeAccess),
          ),
        mergePullRequest: (token, projectId, number, input) =>
          command(
            "POST /api/projects/:id/pull-requests/:number/merge",
            `/api/projects/${encodeURIComponent(projectId)}/pull-requests/${number}/merge`,
            token,
            input,
            null,
          ).pipe(Effect.asVoid),
        refreshLanding,
        worktreeCheckpoints,
        worktreeDiff,
        worktreeContents,
        writeWorktreeFile,
        projectContents,
        openProjectRawFile,
        openRawFile,
        openProofMedia,
        pageFrame,
        openPage,
        projectFiles,
        listSkills,
        projectSkills,
        createSession,
        joinWorktree,
        findLocalWorktree,
        startLocalWorktree,
        labelSession,
        stopSession,
        removeSession,
        pasteImage,
        openShell,
        stopShell,
        ttyTicket,
        submitTurn,
        launchProtocol,
        steerTurn,
        interruptTurn,
        respondRequest,
        events,
      };
    }),
  );
