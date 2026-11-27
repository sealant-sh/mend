import { spanName } from "../src/rules/span-name.ts";
import { tester } from "./tester.ts";

tester.run("span-name", spanName, {
  valid: [
    {
      name: "an Effect.fn the catalog holds",
      code: `const provision = Effect.fn("SessionEngine.provision")(function* () {});`,
    },
    {
      name: "a withSpan the catalog holds",
      code: `const turn = work.pipe(Effect.withSpan("mend.turn.dispatch"));`,
    },
    {
      name: "a tracer's span the catalog holds",
      code: `tracer.span({ name: "mend.turn.first_output", parent });`,
    },
    {
      name: "an untraced function",
      code: `const read = Effect.fnUntraced(function* () {});`,
    },
    {
      name: "a name made at run time, which the exporter names",
      code: 'Effect.makeSpan(`mend.web.${path}`, { kind: "server" });',
    },
    {
      name: "fn on something other than Effect",
      code: `const handler = router.fn("anything");`,
    },
    {
      name: "a test's own span",
      filename: "packages/sessions/src/engine.test.ts",
      code: `Effect.withSpan("mend.test.work");`,
    },
  ],
  invalid: [
    {
      name: "an Effect.fn the catalog lacks",
      code: `const look = Effect.fn("SlackReporter.lookAgain")(function* () {});`,
      errors: [{ messageId: "unnamed" }],
    },
    {
      name: "a withSpan the catalog lacks",
      code: `Effect.withSpan(work, "mend.session.sweep");`,
      errors: [{ messageId: "unnamed" }],
    },
    {
      name: "a tracer's span the catalog lacks",
      code: `tracer.span({ name: "mend.turn.first_word" });`,
      errors: [{ messageId: "unnamed" }],
    },
  ],
});
