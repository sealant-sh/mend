import { rollbackCases } from "./engine/rollback-fixture.ts";

rollbackCases([
  {
    layout: "shared",
    harness: "codex",
    initiallyStopped: false,
    prefix: false,
    captured: false,
    ownService: true,
  },
  {
    layout: "shared",
    harness: "claude",
    initiallyStopped: false,
    prefix: false,
    captured: false,
    ownService: true,
    failSave: true,
  },
]);
