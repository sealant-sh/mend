import { Toaster } from "@mend/ui/components/ui/toast";
import { ToggleGroup, ToggleGroupItem } from "@mend/ui/components/ui/toggle-group";
import { TooltipProvider } from "@mend/ui/components/ui/tooltip";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import { sections } from "./sections.tsx";

// The URL sets the starting state, so a screenshot can ask for exactly one view:
// `?theme=dark&width=390&section=button`.
const params = new URLSearchParams(window.location.search);
const startTheme = params.get("theme") === "dark" ? "dark" : "light";
const startWidth = params.get("width") === "390" ? "390" : "full";
const onlySection = params.get("section");

function applyTheme(theme: "light" | "dark") {
  document.documentElement.classList.toggle("dark", theme === "dark");
}
applyTheme(startTheme);

function Gallery() {
  const [theme, setTheme] = useState<"light" | "dark">(startTheme);
  const [width, setWidth] = useState<"full" | "390">(startWidth);
  const shown = sections.filter((section) => onlySection === null || section.id === onlySection);

  return (
    <Toaster size={width === "390" ? "touch" : "default"}>
      <TooltipProvider>
        <div className="min-h-svh bg-canvas p-sheet-inset text-foreground">
          <div
            data-width={width}
            className="mx-auto rounded-xl border border-sheet-border bg-background shadow-sheet data-[width=390]:max-w-[390px]"
          >
            <header className="flex h-header items-center justify-between gap-3 border-b px-4">
              <h1 className="font-display text-base font-semibold">@mend/ui</h1>
              <div className="flex items-center gap-2">
                <ToggleGroup
                  aria-label="Theme"
                  variant="outline"
                  size="sm"
                  value={[theme]}
                  onValueChange={(value) => {
                    const next = value[0] === "dark" ? "dark" : "light";
                    setTheme(next);
                    applyTheme(next);
                  }}
                >
                  <ToggleGroupItem value="light">Light</ToggleGroupItem>
                  <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
                </ToggleGroup>
                <ToggleGroup
                  aria-label="Width"
                  variant="outline"
                  size="sm"
                  value={[width]}
                  onValueChange={(value) => setWidth(value[0] === "390" ? "390" : "full")}
                >
                  <ToggleGroupItem value="full">Full width</ToggleGroupItem>
                  <ToggleGroupItem value="390">390px</ToggleGroupItem>
                </ToggleGroup>
              </div>
            </header>
            <main className="divide-y">
              {shown.map((section) => (
                <section key={section.id} id={section.id} className="flex flex-col gap-4 p-6">
                  <h2 className="text-sm font-semibold">{section.title}</h2>
                  <section.Demo />
                </section>
              ))}
            </main>
          </div>
        </div>
      </TooltipProvider>
    </Toaster>
  );
}

const root = document.getElementById("root");
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <Gallery />
    </StrictMode>,
  );
}
