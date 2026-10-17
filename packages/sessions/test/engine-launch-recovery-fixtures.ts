// What engine-launch-recovery, -cold-resume and -install share: the clock their scenarios wait on.

import { makeEngineClock } from "./engine/clock-fixture.ts";

/**
 * What these scenarios wait on: the rows the engine writes (`world.sessions`, `world.processes`),
 * the lists a fake appends to, a standby the pool makes ready (`signallingPool`), every lease the
 * store releases (`releasing`), every look the PTY watcher takes and every checkpoint wait the
 * channel registers.
 */
export const makeLaunchClock = makeEngineClock(["sessions", "processes"]);
