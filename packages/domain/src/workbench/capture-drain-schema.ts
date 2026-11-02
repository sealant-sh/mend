import { Schema } from "effect";

// The capture drain's Schema; `./capture-drain.ts` holds its rules, free of Effect, and
// re-exports this.

/** Why Mend is draining an executor before its compute goes. */
export const CaptureDrainReason = Schema.Literals(["stop", "relaunch", "replacement"]);
export type CaptureDrainReason = typeof CaptureDrainReason.Type;
