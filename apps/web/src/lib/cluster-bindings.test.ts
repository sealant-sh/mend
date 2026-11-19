import { describe, expect, it } from "vitest";

import { bindingRefusal, bindingWords, clusterSection } from "./cluster-bindings.ts";

const appEnv = { id: "b1", kind: "secret" as const, objectName: "app-env" };

describe("where the page shows cluster bindings", () => {
  it("shows them in full on a Kubernetes server, bound or not", () => {
    expect(clusterSection({ bindings: [], serviceAccount: null, clusterCapable: true })).toBe(
      "kubernetes",
    );
  });

  it("hides them on a server without Kubernetes when nothing is bound", () => {
    expect(clusterSection({ bindings: [], serviceAccount: null, clusterCapable: false })).toBe(
      "hidden",
    );
  });

  it("keeps a stranded binding or service account in view, since it blocks launches there", () => {
    expect(
      clusterSection({ bindings: [appEnv], serviceAccount: null, clusterCapable: false }),
    ).toBe("stranded");
    expect(
      clusterSection({ bindings: [], serviceAccount: "agent-ro", clusterCapable: false }),
    ).toBe("stranded");
  });
});

describe("binding words", () => {
  it("names the kind as Kubernetes does", () => {
    expect(bindingWords(appEnv)).toBe("Secret app-env");
    expect(bindingWords({ kind: "configmap", objectName: "flags" })).toBe("ConfigMap flags");
  });

  it("says a duplicate in a sentence, and passes the server's own refusal through", () => {
    expect(bindingRefusal({ kind: "duplicate", binding: "secret/app-env" })).toBe(
      "Secret app-env is already bound to this project.",
    );
    expect(bindingRefusal({ kind: "rejected", message: "Use a DNS-1123 name." })).toBe(
      "Use a DNS-1123 name.",
    );
  });
});
