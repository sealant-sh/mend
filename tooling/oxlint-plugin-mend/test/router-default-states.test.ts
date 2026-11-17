import { routerDefaultStates } from "../src/rules/router-default-states.ts";
import { tester } from "./tester.ts";

const ROUTER = `import { createRouter } from "@tanstack/react-router";\n`;

tester.run("router-default-states", routerDefaultStates, {
  valid: [
    {
      name: "sets all three inline",
      code: `${ROUTER}export const getRouter = () => createRouter({
        routeTree,
        defaultPendingComponent: Loading,
        defaultErrorComponent: Failed,
        defaultNotFoundComponent: NotFound,
      });`,
    },
    {
      name: "sets them through a const and a spread",
      code: `${ROUTER}const states = { defaultPendingComponent: Loading, defaultErrorComponent: Failed };
      const options = { ...states, routeTree, defaultNotFoundComponent: NotFound };
      export const router = createRouter(options);`,
    },
    {
      name: "a createRouter that isn't TanStack Router's",
      code: `import { createRouter } from "./elsewhere";
      export const router = createRouter({ routes });`,
    },
  ],
  invalid: [
    {
      name: "sets none",
      code: `${ROUTER}export const router = createRouter({ routeTree });`,
      errors: [
        {
          messageId: "missing",
          data: {
            missing:
              "`defaultPendingComponent`, `defaultErrorComponent`, `defaultNotFoundComponent`",
          },
        },
      ],
    },
    {
      name: "misses the not-found component",
      code: `${ROUTER}export const router = createRouter({
        routeTree,
        defaultPendingComponent: Loading,
        defaultErrorComponent: Failed,
      });`,
      errors: [{ messageId: "missing", data: { missing: "`defaultNotFoundComponent`" } }],
    },
    {
      name: "options built somewhere this rule can't read",
      code: `${ROUTER}export const router = createRouter(routerOptions());`,
      errors: [{ messageId: "missing" }],
    },
  ],
});
