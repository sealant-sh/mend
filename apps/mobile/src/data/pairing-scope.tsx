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

const PairingScope = ({
  pairingKey,
  config,
  children,
}: {
  readonly pairingKey: PairingKey;
  readonly config: MendConfig;
  readonly children: ReactNode;
}): ReactNode => {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1 } } }));
  const [asker] = useState(() => createAsker({ os: Platform.OS, alert: Alert.alert }));
  // Cancels the ended pairing's fetches and pending retries.
  useEffect(() => () => client.clear(), [client]);
  return (
    <PairingContext.Provider value={{ config, key: pairingKey, asker }}>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </PairingContext.Provider>
  );
};
