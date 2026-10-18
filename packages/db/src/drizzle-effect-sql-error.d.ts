// drizzle-orm 1.0.0-rc.5-5935859 declares its Effect driver's errors with SqlError from
// effect/unstable/sql/SqlError, a path Effect 4.0.0 moved to effect/sql/SqlError. Unresolved, every
// drizzle transaction's error type is any. Its runtime imports neither path.
declare module "effect/unstable/sql/SqlError" {
  export * from "effect/sql/SqlError";
}
