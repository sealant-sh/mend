export interface PreviewGatewayLimits {
  readonly perPreview: number;
  readonly gateway: number;
  readonly forwards: number;
  readonly admitting: number;
  readonly waiting: number;
}

export type PreviewBodyCap =
  | { readonly _tag: "Unlimited" }
  | { readonly _tag: "Capped"; readonly bytes: number };

export interface PreviewGatewaySettings {
  readonly bind: string;
  readonly port: number;
  readonly startHoldMs: number;
  readonly bodyCap: PreviewBodyCap;
  readonly limits: PreviewGatewayLimits;
  readonly queueWaitMs: number;
  readonly trustedProxies: ReadonlyArray<string>;
}

export const PREVIEW_GATEWAY_DEFAULTS = {
  startHoldMs: 180_000,
  bodyCap: { _tag: "Unlimited" },
  limits: { perPreview: 64, gateway: 256, forwards: 128, admitting: 256, waiting: 2_048 },
  queueWaitMs: 30_000,
} as const satisfies Omit<PreviewGatewaySettings, "bind" | "port" | "trustedProxies">;
