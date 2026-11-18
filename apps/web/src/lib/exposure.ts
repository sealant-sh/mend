import type { MachineDto } from "./api.ts";

type Exposure = NonNullable<MachineDto["exposure"]>;

/**
 * How this server is reached, as the account menu says it (docs/adr/0004): what the operator
 * declared, then what the server observed, in that order. A report, never a verdict: a server
 * can't observe who can reach it. Copied from the old app's shell.
 */
export const exposureLine = (
  exposure: Pick<Exposure, "declared" | "originScheme" | "arrivedVia">,
): string =>
  [
    `exposure · ${exposure.declared}`,
    exposure.originScheme,
    ...(exposure.arrivedVia === "trusted-proxy" ? ["via proxy"] : []),
  ].join(" · ");

/** The line's hover text: who said what, and the kinds of address the host holds. */
export const exposureDetail = (exposure: Pick<Exposure, "addressKinds">): string =>
  exposure.addressKinds.length === 0
    ? "Declared by the operator."
    : `Declared by the operator. Addresses on the host: ${exposure.addressKinds.join(", ")}.`;
