import { Effect, Tracer } from "effect";
import { describe, expect, it } from "vitest";

import { quietIdlePasses, quietWhenIdle } from "./quiet-passes.ts";

/** A tracer that keeps the name of every span that ended, as an exporter would see it. */
const recording = () => {
  const sent: Array<string> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = Tracer.nativeTracer.span(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        sent.push(options.name);
        end(endTime, exit);
      };
      return span;
    },
  });
  return { sent, tracer: quietIdlePasses(tracer) };
};

const query = (text: string) =>
  Effect.annotateCurrentSpan("db.query.text", text).pipe(
    Effect.withSpan("sql.execute", { kind: "client" }),
  );

const pass = <E>(work: Effect.Effect<void, E>) =>
  work.pipe(Effect.withSpan("mend.session.reap"), Effect.withSpan("mend.session.capture_reaper"));

describe("a timer's pass", () => {
  it("leaves no trace when it only read", async () => {
    const { sent, tracer } = recording();
    await Effect.runPromise(
      pass(query("select * from agent_sessions where id = $1")).pipe(
        quietWhenIdle,
        Effect.withTracer(tracer),
      ),
    );
    expect(sent).toEqual([]);
  });

  it("is sent whole when it wrote, called out or failed", async () => {
    const { sent, tracer } = recording();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* pass(Effect.andThen(query("select 1"), query("update agent_sessions set x = $1")));
        yield* pass(Effect.annotateCurrentSpan("http.request.method", "GET"));
        yield* pass(Effect.fail("lost")).pipe(Effect.ignore);
      }).pipe(quietWhenIdle, Effect.withTracer(tracer)),
    );
    expect(sent).toEqual([
      "sql.execute",
      "sql.execute",
      "mend.session.reap",
      "mend.session.capture_reaper",
      "mend.session.reap",
      "mend.session.capture_reaper",
      "mend.session.reap",
      "mend.session.capture_reaper",
    ]);
  });

  it("changes nothing outside a timer's loop", async () => {
    const { sent, tracer } = recording();
    await Effect.runPromise(pass(query("select 1")).pipe(Effect.withTracer(tracer)));
    expect(sent).toEqual(["sql.execute", "mend.session.reap", "mend.session.capture_reaper"]);
  });
});
