import { rollbackCases } from "./engine/rollback-fixture.ts";

rollbackCases([
  { layout: "shared", harness: "codex", initiallyStopped: false, prefix: true, captured: true },
  { layout: "shared", harness: "claude", initiallyStopped: false, prefix: true, captured: true },
]);
