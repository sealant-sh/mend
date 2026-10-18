import { isAllowedOrigin, type PublicNetwork } from "@mend/network";
import { HttpMiddleware } from "effect/http";

/** Credentialed CORS restricted to the same exact origins used by authentication. */
export const publicNetworkCors = (network: PublicNetwork) =>
  HttpMiddleware.cors({
    allowedOrigins: (origin) => isAllowedOrigin(network, origin),
    credentials: true,
  });
