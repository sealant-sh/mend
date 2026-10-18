import { defineConfig } from "vitest/config";

import { vitestCiGuard } from "../src/vitest.ts";

defineConfig({ plugins: [vitestCiGuard({ packageName: "@mend/fixture" })] });
