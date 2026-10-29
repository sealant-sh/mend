import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Alert, Platform } from "react-native";

import { createAsker, type Asker } from "@/data/ask";
import { useConfig, type MendConfig } from "@/data/live";
import { pairingKeyOf, type PairingKey } from "@/data/pairing-key";

export interface Pairing {
  readonly config: MendConfig;
  readonly key: PairingKey;
  readonly asker: Asker;
}

const PairingContext = createContext<Pairing | null>(null);

export const usePairing = (): Pairing => {
  const pairing = useContext(PairingContext);
  if (pairing === null) throw new Error("usePairing needs a PairingBoundary above it");
  return pairing;
};

export const PairingBoundary = ({ children }: { readonly children: ReactNode }): ReactNode => {
  const config = useConfig();
  if (config === null) return null;
  const key = pairingKeyOf(config);
  return (
    <PairingScope key={key} pairingKey={key} config={config}>
      {children}
    </PairingScope>
  );
};

// A pairing outlives the screens under it: a web history step can mount the root layout afresh.
interface Held {
  readonly key: PairingKey;
  readonly client: QueryClient;
  readonly asker: Asker;
}
let held: Held | null = null;

const heldFor = (key: PairingKey): Held => {
  if (held?.key !== key) {
    held = {
      key,
      client: new QueryClient({ defaultOptions: { queries: { retry: 1 } } }),
      asker: createAsker({ os: Platform.OS, alert: Alert.alert }),
    };
  }
  return held;
};

const PairingScope = ({
  pairingKey,
  config,
  children,
}: {
  readonly pairingKey: PairingKey;
  readonly config: MendConfig;
  readonly children: ReactNode;
}): ReactNode => {
  const [{ client, asker }] = useState(() => heldFor(pairingKey));
  // Once another pairing holds the cache, cancels the ended one's fetches and pending retries.
  useEffect(
    () => () => {
      if (held?.client !== client) client.clear();
    },
    [client],
  );
  return (
    <PairingContext.Provider value={{ config, key: pairingKey, asker }}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </PairingContext.Provider>
  );
};
