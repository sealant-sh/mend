/**
 * The ports the tailnet default serves previews on unless setup is given others: sixteen, decided
 * by Yiannis on 2026-10-29 (docs/adr/0017, decision 6).
 */
export const DEFAULT_TAILNET_PREVIEW_PORTS = "20001-20016";

const MAX_PORTS = 1000;

export type PreviewPortsRead =
  | { readonly _tag: "Ports"; readonly ports: ReadonlyArray<number> }
  | { readonly _tag: "Refused"; readonly problem: string };

const refused = (problem: string): PreviewPortsRead => ({ _tag: "Refused", problem });

const portOf = (raw: string): number | null => {
  const port = /^[0-9]{1,5}$/.test(raw) ? Number(raw) : Number.NaN;
  return port >= 1 && port <= 65_535 ? port : null;
};

/**
 * A comma-separated list of ports and ranges, such as `20001-20016` or `20001,20003,20010-20012`,
 * in ascending order with no port twice. A `port=previewId` entry is the form Mend read before it
 * assigned ports itself, and says so.
 */
export const readPreviewPorts = (raw: string): PreviewPortsRead => {
  const ports: Array<number> = [];
  for (const entry of raw.split(",").map((part) => part.trim())) {
    if (entry.includes("=")) {
      return refused(
        `"${entry}" pairs a port with a preview, the form before Mend assigned ports itself: list only the ports previews may use, such as ${DEFAULT_TAILNET_PREVIEW_PORTS}, and Mend gives each preview one when it is first opened`,
      );
    }
    const bounds = entry.split("-").map((part) => part.trim());
    const first = portOf(bounds[0] ?? "");
    const last = bounds.length === 2 ? portOf(bounds[1] ?? "") : first;
    if (bounds.length > 2 || first === null || last === null || last < first) {
      return refused(
        `"${entry}" is not a TCP port (1 to 65535) or an ascending range of them, such as ${DEFAULT_TAILNET_PREVIEW_PORTS}`,
      );
    }
    if (ports.length + (last - first + 1) > MAX_PORTS) {
      return refused(`lists more than ${MAX_PORTS} ports`);
    }
    for (let port = first; port <= last; port += 1) {
      const previous = ports.at(-1);
      if (previous !== undefined && port <= previous) {
        return refused(
          port === previous
            ? `port ${port} is listed twice`
            : `port ${port} comes after ${previous}: list ports in ascending order`,
        );
      }
      ports.push(port);
    }
  }
  return { _tag: "Ports", ports };
};

/** The shortest list of ports and ranges that `readPreviewPorts` reads back as `ports`. */
export const writePreviewPorts = (ports: ReadonlyArray<number>): string => {
  const runs: Array<[number, number]> = [];
  for (const port of ports) {
    const run = runs.at(-1);
    if (run !== undefined && port === run[1] + 1) run[1] = port;
    else runs.push([port, port]);
  }
  return runs.map(([first, last]) => (first === last ? `${first}` : `${first}-${last}`)).join(",");
};
