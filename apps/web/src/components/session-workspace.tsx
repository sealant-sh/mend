import { Tabs, TabsContent, TabsList, TabsTrigger } from "@mend/ui/components/ui/tabs";
import type { ReactNode } from "react";

/** The selected session panel, stored in the router rather than synchronized local state. */
export function sessionWorkspaceSearch(search: Record<string, unknown>): {
  readonly view?: "desktop";
} {
  return search["view"] === "desktop" ? { view: "desktop" } : {};
}

/** The terminal and screen stay mounted so switching tabs preserves their live connections. */
export function SessionWorkspace({
  view,
  onViewChange,
  terminal,
  screen,
}: {
  readonly view: "desktop" | undefined;
  readonly onViewChange: (view: "terminal" | "desktop") => void;
  readonly terminal: ReactNode;
  readonly screen: ReactNode | null;
}) {
  if (screen === null) return terminal;
  return (
    <Tabs
      value={view ?? "terminal"}
      onValueChange={(value) => {
        if (value === "terminal" || value === "desktop") onViewChange(value);
      }}
    >
      <TabsList aria-label="Session workspace">
        <TabsTrigger value="terminal">Terminal</TabsTrigger>
        <TabsTrigger value="desktop">Desktop</TabsTrigger>
      </TabsList>
      <TabsContent value="terminal" keepMounted className="data-[hidden]:hidden">
        {terminal}
      </TabsContent>
      <TabsContent value="desktop" keepMounted className="data-[hidden]:hidden">
        {screen}
      </TabsContent>
    </Tabs>
  );
}
