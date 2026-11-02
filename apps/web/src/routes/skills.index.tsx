import { createFileRoute } from "@tanstack/react-router";

import { AppShell } from "#/components/shell";
import { SkillsLibrary } from "#/components/skills-library";
import { useWorkbenchEvents } from "#/lib/workbench-events";

export const Route = createFileRoute("/skills/")({
  ssr: false,
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(context.trpc.skills.list.queryOptions());
  },
  component: SkillsPage,
});

function SkillsPage() {
  useWorkbenchEvents();
  return (
    <AppShell>
      <div className="min-w-0">
        <p className="ev-eyebrow">skills</p>
        <h1 className="mt-2 font-display text-3xl font-medium tracking-tight text-foreground">
          Your skill library
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Instruction bundles your projects inherit by default. Each project can turn inheritance
          off in Configuration; a same-named project skill overrides yours.
        </p>
        <SkillsLibrary scope="user" />
      </div>
    </AppShell>
  );
}
