import { AgentLogins, DEFAULT_AGENT_LOGINS } from "@mend/domain/workbench";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import * as Context from "effect/Context";

import { MendDB } from "../client.ts";
import { userAgentLogins } from "../schema/workbench.ts";

/**
 * Which of a person's own logins their Claude and Codex sessions receive (docs/adr/0016,
 * decision 5, amended 2026-10-10). Per account, like the git author: an account with no saved row
 * gets the default, every login it has connected.
 */
export class UserAgentLoginsRepo extends Context.Service<
  UserAgentLoginsRepo,
  {
    /** The account's setting, or the default when it saved none. */
    readonly forUser: (userId: string) => Effect.Effect<AgentLogins>;
    /** Save the account's setting whole, and answer it. */
    readonly set: (userId: string, setting: AgentLogins) => Effect.Effect<AgentLogins>;
  }
>()("@mend/db/UserAgentLoginsRepo") {}

export const UserAgentLoginsRepoLive: Layer.Layer<UserAgentLoginsRepo, never, MendDB> =
  Layer.effect(
    UserAgentLoginsRepo,
    Effect.gen(function* () {
      const db = yield* MendDB;

      const forUser = Effect.fn("UserAgentLoginsRepo.forUser")(function* (userId: string) {
        const [row] = yield* db
          .select({ selectedOnly: userAgentLogins.selectedOnly })
          .from(userAgentLogins)
          .where(eq(userAgentLogins.userId, userId))
          .limit(1)
          .pipe(Effect.orDie);
        return row === undefined
          ? DEFAULT_AGENT_LOGINS
          : new AgentLogins({ selectedOnly: row.selectedOnly });
      });

      const set = Effect.fn("UserAgentLoginsRepo.set")(function* (
        userId: string,
        setting: AgentLogins,
      ) {
        const [row] = yield* db
          .insert(userAgentLogins)
          .values({ userId, selectedOnly: setting.selectedOnly })
          .onConflictDoUpdate({
            target: userAgentLogins.userId,
            set: { selectedOnly: setting.selectedOnly, updatedAt: new Date() },
          })
          .returning({ selectedOnly: userAgentLogins.selectedOnly })
          .pipe(Effect.orDie);
        if (row === undefined) return yield* Effect.die("agent logins upsert returned no row");
        return new AgentLogins({ selectedOnly: row.selectedOnly });
      });

      return { forUser, set };
    }),
  );
