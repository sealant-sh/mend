import { createSerializationAdapter } from "@tanstack/react-router";
import { createStart } from "@tanstack/react-start";
import { TRPCClientError } from "@trpc/client";

/**
 * A tRPC error a page's loader met while the server rendered it reaches the browser as itself,
 * not as a bare `Error`: its `data` (code, status, the refusal's tag) comes with it. Without it, a
 * page that branches on the tag draws one thing on the server and another as the browser takes
 * over, and the browser's error reporting (lib/telemetry-sentry.ts) cannot tell a refusal the
 * server answered from a bug of its own. The shape crosses as JSON: it is the server's answer.
 */
const trpcClientErrors = createSerializationAdapter({
  key: "mend-trpc-client-error",
  test: (value): value is TRPCClientError<never> => value instanceof TRPCClientError,
  toSerializable: (error) => ({
    message: error.message,
    shape: error.shape === undefined ? null : JSON.stringify(error.shape),
  }),
  fromSerializable: ({ message, shape }): TRPCClientError<never> => {
    const parsed: unknown = shape === null ? null : JSON.parse(shape);
    return typeof parsed === "object" && parsed !== null
      ? TRPCClientError.from({ error: parsed })
      : new TRPCClientError(message);
  },
});

export const startInstance = createStart(() => ({ serializationAdapters: [trpcClientErrors] }));
