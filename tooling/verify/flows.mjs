import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The flows the daily box run drives (`.agents/skills/box-main-run/flows.md`), as `verify judge`
// reads them: a feature PR names the flow that shows it on the box (SLNT-1050). Each flow is a
// `### <id>` heading; its `Areas:` line names the paths it passes through, and a
// `Box: after cut-over` line marks a flow for the new web app, which the box serves only from a
// preview built with `web_app=web` until cut-over (boxFlows).
// The "Not on the box" table names the features no flow can drive.

export const FLOWS_PATH = ".agents/skills/box-main-run/flows.md";

/** The new web app and its kit: the box serves `apps/web-old` until cut-over. */
export const NEW_WEB = ["apps/web/", "packages/ui/"];

const ticked = (line) => [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1]);

/** The flows and the Not-on-the-box features in a flows.md text. */
export const parseFlows = (text) => {
  const flows = [];
  const notOnTheBox = [];
  let section = "";
  let flow = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      section = line.slice(3).trim();
      flow = null;
      continue;
    }
    const heading = /^### (\S+)\s*$/.exec(line);
    if (heading) {
      flow = { id: heading[1], areas: [], afterCutOver: false };
      flows.push(flow);
      continue;
    }
    if (flow && line.startsWith("- **Areas:**")) {
      flow.areas = ticked(line).filter((path) => path.includes("/"));
      flow.readingAreas = true;
      continue;
    }
    if (flow?.readingAreas && /^\s{2,}\S/.test(line)) {
      flow.areas.push(...ticked(line).filter((path) => path.includes("/")));
      continue;
    }
    if (flow) flow.readingAreas = false;
    if (flow && /^- \*\*Box:\*\* after cut-over/.test(line)) flow.afterCutOver = true;
    if (section === "Not on the box") {
      const row = /^\|\s*([a-z][a-z0-9-]*)\s*\|/.exec(line);
      if (row) notOnTheBox.push(row[1]);
    }
  }
  return { flows: flows.map(({ readingAreas: _, ...rest }) => rest), notOnTheBox };
};

/** flows.md as the working tree has it, which `verify judge` only reads on a clean commit. */
export const loadFlows = (root) => {
  const path = join(root, FLOWS_PATH);
  return existsSync(path) ? parseFlows(readFileSync(path, "utf8")) : { flows: [], notOnTheBox: [] };
};

/** An Areas entry ending in `/` holds everything under it; any other names one file. */
const inArea = (file, area) => (area.endsWith("/") ? file.startsWith(area) : file === area);

/** The flows whose Areas hold `file`. */
export const flowsThrough = (flows, file) =>
  flows.filter((flow) => flow.areas.some((area) => inArea(file, area)));

export const inNewWeb = (file) => NEW_WEB.some((prefix) => file.startsWith(prefix));

/**
 * The web app a Mend image serves, from its `dev.sealant.mend.web-app` label: `web` for a preview
 * built with `web_app=web` (.github/workflows/preview.yml), `web-old` for every other image, those
 * built before the label existed included.
 */
export const webAppOf = (label) => (label?.trim() === "web" ? "web" : "web-old");

/**
 * The flows a box serving `webApp` runs, and those it leaves for cut-over. Today's app leaves every
 * flow marked `Box: after cut-over`; a preview of the new app runs them all.
 */
export const boxFlows = (flows, webApp) =>
  webApp === "web"
    ? { run: flows, afterCutOver: [] }
    : {
        run: flows.filter((flow) => !flow.afterCutOver),
        afterCutOver: flows.filter((flow) => flow.afterCutOver),
      };
