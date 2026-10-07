import { createFileRoute } from "@tanstack/react-router";

import { DesktopWorkbench } from "#/components/desktop-workbench";

export const Route = createFileRoute("/desktop-experiment")({
  ssr: false,
  component: DesktopExperiment,
});

function DesktopExperiment() {
  if (!import.meta.env.DEV)
    return <main className="p-8">This experiment runs in development.</main>;
  return (
    <main className="mx-auto max-w-[1440px] space-y-6 px-6 py-8 lg:px-12">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="ev-eyebrow">Mend · desktop experiment</p>
          <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight">
            Watch the agent use the app
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            An isolated local desktop. These test runs are separate from project sessions.
          </p>
        </div>
        <a href="/" className="text-sm text-info">
          Open workbench
        </a>
      </div>
      <DesktopWorkbench baseUrl="/__desktop-preview" />
    </main>
  );
}
