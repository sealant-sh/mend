import { rollbackCases } from "./engine/rollback-fixture.ts";

rollbackCases([
  { layout: "person", harness: "codex", initiallyStopped: false, prefix: false, captured: false },
  { layout: "shared", harness: "codex", initiallyStopped: false, prefix: false, captured: false },
  { layout: "person", harness: "claude", initiallyStopped: false, prefix: false, captured: false },
  { layout: "shared", harness: "claude", initiallyStopped: false, prefix: false, captured: false },
  { layout: "shared", harness: "codex", initiallyStopped: true, prefix: false, captured: false },
  { layout: "shared", harness: "claude", initiallyStopped: true, prefix: false, captured: false },
]);
