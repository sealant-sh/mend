// t3code's tests import vitest through vite-plus, its toolchain. Mend runs them on vitest itself
// (vitest.config.ts aliases the module at runtime); this declares the same alias for the compiler.
declare module "vite-plus/test" {
  export * from "vitest";
}
