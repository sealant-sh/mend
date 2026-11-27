import type { Plugin } from "@oxlint/plugins";

import { noEffectFetch, noStateCopyEffect } from "./rules/effects.ts";
import { noArbitraryTypeOrRadius } from "./rules/no-arbitrary-type-or-radius.ts";
import { noRawColors } from "./rules/no-raw-colors.ts";
import { noUseClient } from "./rules/no-use-client.ts";
import { queryStates } from "./rules/query-states.ts";
import { routerDefaultStates } from "./rules/router-default-states.ts";
import { spanName } from "./rules/span-name.ts";

const plugin: Plugin = {
  meta: { name: "mend" },
  rules: {
    "no-arbitrary-type-or-radius": noArbitraryTypeOrRadius,
    "no-effect-fetch": noEffectFetch,
    "no-raw-colors": noRawColors,
    "no-state-copy-effect": noStateCopyEffect,
    "no-use-client": noUseClient,
    "query-states": queryStates,
    "router-default-states": routerDefaultStates,
    "span-name": spanName,
  },
};

export default plugin;
