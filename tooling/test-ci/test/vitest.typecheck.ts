import { defineConfig as defineVitest5 } from "vitest-v5/config";
import { defineConfig as defineVitest3 } from "vitest/config";

import { vitestCiGuard } from "../src/vitest.ts";

// Ordinary call sites prove the structural plugin fits both public APIs without adapter casts.
defineVitest3({ plugins: [vitestCiGuard({ packageName: "@mend/fixture" })] });
defineVitest5({ plugins: [vitestCiGuard({ packageName: "@mend/fixture" })] });
