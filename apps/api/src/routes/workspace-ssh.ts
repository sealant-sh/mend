import {
  AccountRejected,
  CurrentUser,
  MendApi,
  SealantUnavailable,
  WorkspaceSshGateway,
  WorkspaceSshKey,
  WorkspaceSshKeyNotFound,
  WorkspaceSshKeyRemoved,
  WorkspaceSshRunningSession,
  WorkspaceSshView,
} from "@mend/api-contracts";
import { AuditEventsRepo, OrganizationsRepo, SessionsRepo } from "@mend/db";
import { type PlatformSshKey, SealantClients } from "@mend/sealant";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";

const keyView = (key: PlatformSshKey) =>
  new WorkspaceSshKey({
    sshKeyId: key.sshKeyId,
    name: key.name,
    algorithm: key.algorithm,
    fingerprint: key.fingerprint,
    createdAt: key.createdAt,
  });

/**
 * Whether the platform ends the connections opened with a removed key (Core reports it as
 * `sshKeyRemovalEndsConnections`). Unknown, as on a platform that cannot be asked, is "no": the
 * answer then tells the caller how to end them.
 */
const removalEndsConnections = (clients: SealantClients["Service"]) =>
  clients.controlPlaneFeatures().pipe(
    Effect.map((features) => features.sshKeyRemovalEndsConnections),
    Effect.orElseSucceed(() => false),
  );

/**
 * Records a key the caller registered or removed in their organization's audit log. The subject is
 * the member who holds the key; an account in no organization has no log to write to.
 */
const recordKeyAudit = (
  action: "ssh_key.added" | "ssh_key.removed",
  userId: string,
  key: PlatformSshKey,
) =>
  Effect.gen(function* () {
    const found = yield* (yield* OrganizationsRepo).membershipOf(userId);
    if (found === null) return;
    yield* (yield* AuditEventsRepo).record({
      organizationId: found.organization.id,
      actorUserId: userId,
      action,
      subjectType: "member",
      subjectId: userId,
      data: { sshKeyId: key.sshKeyId, fingerprint: key.fingerprint, name: key.name },
    });
  });

/**
 * Workspace SSH for the signed-in user (docs/WORKSPACE-SSH.md): gateway discovery plus
 * self-service key registration and removal. Keys are registered under the user's own Sealant
 * identity — the gateway resolves a connection to its key's owner and authorizes that principal
 * against the workspace, so one user's key never opens another user's workspace. Every route reads
 * and changes only the caller's own keys: the platform scopes each call to their Sealant id.
 */
export const WorkspaceSshGroupLive = HttpApiBuilder.group(MendApi, "workspaceSsh", (handlers) =>
  handlers
    .handle("get", () =>
      Effect.gen(function* () {
        const clients = yield* SealantClients;
        const caller = yield* CurrentUser;
        const gateway = yield* clients.workspaceSshInfo();
        const keys = yield* clients.sshKeys(caller.user.id).list();
        return new WorkspaceSshView({
          gateway: gateway === null ? null : new WorkspaceSshGateway(gateway),
          keys: keys.map(keyView),
        });
      }).pipe(
        Effect.catchTag("SealantPlatformError", (error) =>
          Effect.fail(new SealantUnavailable({ code: error.code, message: error.message })),
        ),
      ),
    )
    .handle("ensureKey", ({ payload }) =>
      Effect.gen(function* () {
        const clients = yield* SealantClients;
        const caller = yield* CurrentUser;
        const keys = clients.sshKeys(caller.user.id);
        // Re-offering a registered key returns its row; only a key new to the account is audited.
        const before = yield* keys.list();
        const key = yield* keys.ensure({
          publicKey: payload.publicKey,
          ...(payload.name === undefined ? {} : { name: payload.name }),
        });
        if (!before.some((known) => known.sshKeyId === key.sshKeyId)) {
          yield* recordKeyAudit("ssh_key.added", caller.user.id, key);
        }
        return keyView(key);
      }).pipe(
        Effect.catchTag("SealantPlatformError", (error) =>
          Effect.fail(
            // 4xx = the platform judged the key (invalid line, another account holds it).
            error.status !== null && error.status >= 400 && error.status < 500
              ? new AccountRejected({ message: error.message })
              : new SealantUnavailable({ code: error.code, message: error.message }),
          ),
        ),
      ),
    )
    .handle("removeKey", ({ params }) =>
      Effect.gen(function* () {
        const clients = yield* SealantClients;
        const caller = yield* CurrentUser;
        const removed = yield* clients.sshKeys(caller.user.id).remove(params.sshKeyId);
        if (removed === null) {
          return yield* new WorkspaceSshKeyNotFound({ sshKeyId: params.sshKeyId });
        }
        yield* recordKeyAudit("ssh_key.removed", caller.user.id, removed);
        if (yield* removalEndsConnections(clients)) {
          return new WorkspaceSshKeyRemoved({
            ...keyView(removed),
            openConnections: "end",
            runningSessions: [],
          });
        }
        // An older platform keeps them open until the workspaces they reach stop: the caller's
        // running sessions are what to stop.
        const running = yield* (yield* SessionsRepo).listUnsettledForOwner(caller.user.id);
        return new WorkspaceSshKeyRemoved({
          ...keyView(removed),
          openConnections: "stay",
          runningSessions: running.map(
            (session) =>
              new WorkspaceSshRunningSession({ sessionId: session.id, label: session.label }),
          ),
        });
      }).pipe(
        Effect.catchTag("SealantPlatformError", (error) =>
          Effect.fail(new SealantUnavailable({ code: error.code, message: error.message })),
        ),
      ),
    ),
);
