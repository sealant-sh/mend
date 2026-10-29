import * as fs from "node:fs";

import { EDGE_COMPOSE_OVERLAY, renderPreviewOverlay } from "../src/server-edge.ts";
import { PREVIEW_KEY_MODE } from "../src/server-store.ts";

const listed = (key: string): ReadonlyArray<string> => {
  const found = new RegExp(`^ {4}${key}: \\[(.*)\\]$`, "m").exec(EDGE_COMPOSE_OVERLAY)?.[1];
  if (found === undefined) throw new Error(`the packaged edge overlay sets no ${key}`);
  return found.split(",").map((entry) => entry.trim().replaceAll('"', ""));
};

/**
 * `docker run` arguments for the edge as the packaged overlays run it: its capabilities and
 * options, and the group the preview overlay adds it to, so a fixture reads only what it could.
 */
export const packagedEdgeArgs = (): ReadonlyArray<string> => {
  const overlay = renderPreviewOverlay({
    edgeHost: "mend.internal",
    preview: {
      mode: "domain",
      domain: "previews.internal",
      certificate: "/unused.crt",
      key: "/unused.key",
    },
  });
  const group = /^ {4}group_add: \["(\d+)"\]$/m.exec(overlay ?? "")?.[1];
  if (group === undefined) throw new Error("the preview overlay adds the edge to no group");
  return [
    ...listed("cap_drop").flatMap((capability) => ["--cap-drop", capability]),
    ...listed("cap_add").flatMap((capability) => ["--cap-add", capability]),
    ...listed("security_opt").flatMap((option) => ["--security-opt", option]),
    "--group-add",
    group,
  ];
};

/** The key as a generation holds it, for a fixture that mounts it where the edge reads it. */
export const copyPreviewKey = (source: string, destination: string): void => {
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, PREVIEW_KEY_MODE);
};
