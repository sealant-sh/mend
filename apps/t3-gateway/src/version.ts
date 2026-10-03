import pin from "@mend/t3-contracts/pin" with { type: "json" };

/** The t3code tag the vendored contracts were copied from (packages/t3-contracts/t3code.pin.json). */
export const T3CODE_TAG: string = pin.tag;

/**
 * The gateway's own revision against that tag. Raise it when the gateway changes what it serves
 * without the pin moving; reset it to 1 when the pin moves.
 */
export const MEND_REVISION = 1;

/** What the descriptor reports as `serverVersion` (ADR 0012, "Protocol churn"). */
export const SERVER_VERSION = `${T3CODE_TAG}+mend.${MEND_REVISION}`;
