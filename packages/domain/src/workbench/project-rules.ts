import type { AutomationChoice } from "./project.ts";

// A project's automation switches: plain rules, free of Effect, so a client that reads them loads
// no Schema (`./project.ts` holds the Schemas and re-exports these).

export const resolveAutomation = (choice: AutomationChoice, settingsDefault: boolean): boolean =>
  choice === "inherit" ? settingsDefault : choice === "on";
