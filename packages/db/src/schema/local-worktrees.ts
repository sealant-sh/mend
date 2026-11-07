import type { WorktreeId } from "@mend/domain";
import { pgTable, text } from "drizzle-orm/pg-core";

import { projects } from "./workbench.ts";

/** The identity is allocated before its worktree exists, so it deliberately has no worktree FK. */
export const projectLocalWorktrees = pgTable("project_local_worktrees", {
  projectId: text()
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  worktreeId: text().$type<WorktreeId>().notNull().unique(),
});
