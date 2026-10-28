import { ServerRefusal } from "./server-store.ts";

export class ServerSetupError extends ServerRefusal {
  readonly _tag = "ServerSetupError" as const;
}

export const setupError = (message: string): ServerSetupError => new ServerSetupError(message);
