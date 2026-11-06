import { rollbackCases } from "./engine/rollback-fixture.ts";

rollbackCases([
  { layout: "shared", harness: "codex", initiallyStopped: false, prefix: true, captured: false },
  { layout: "shared", harness: "claude", initiallyStopped: false, prefix: true, captured: false },
  { layout: "person", harness: "codex", initiallyStopped: false, prefix: true, captured: false },
  { layout: "person", harness: "claude", initiallyStopped: false, prefix: true, captured: false },
]);
