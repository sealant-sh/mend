// The verify skill's fake provider logins: published here, so none is a secret. A recipe that needs
// a provider to refuse a login (a GitHub token GitHub rejects, a Claude setup token the provider
// refuses at launch, a Codex auth.json the platform accepts and Codex refuses) uses these values and
// no other made-up one. The evidence scan (scan-evidence.mjs) does not count them as hits, as a
// value or as a credential shape; any other value a run registered, or a credential shape that is
// not one of these, still fails it. Redaction still hides them where the registry holds them.
//
//   import { FAKES } from "<skill>/scripts/fakes.mjs";
//   FAKES.github      → mend connect github --from-stdin, or the web's GitHub field
//   FAKES.claude      → mend connect claude --from-stdin, or the web's Claude field
//   FAKES.codexAuth   → an auth.json for mend connect codex --from-stdin

import { formsOf } from "./secrets.mjs";

export const FAKES = Object.freeze({
  // GitHub's classic token shape: ghp_ and 36 letters and digits.
  github: "ghp_mendVerifyFake0000000000000000000000",
  // Core takes a Claude setup token by its prefix (sk-ant-oat01-).
  claude: "sk-ant-oat01-mendVerifyFake-claude-setup-token-000000000000",
  // Core takes a Codex auth.json with tokens.refresh_token; account_id is what Mend shows.
  codexAuth: JSON.stringify(
    {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "mendVerifyFake-codex-id-token-000000000000",
        access_token: "mendVerifyFake-codex-access-token-000000000000",
        refresh_token: "mendVerifyFake-codex-refresh-token-000000000000",
        account_id: "mend-verify-fake-account",
      },
      last_refresh: "2026-01-01T00:00:00Z",
    },
    null,
    2,
  ),
});

/** Every form of every fake (as written, encoded, by key), longest first. */
export const FAKE_FORMS = [
  ...new Set(Object.values(FAKES).flatMap((value) => [value, ...formsOf(value)])),
].toSorted((a, b) => b.length - a.length);

/** Whether a registered value is one of the fakes, in any of its forms. */
export const isFake = (value) => FAKE_FORMS.includes(value);

/** The text with every fake replaced by `<fake>`, so neither a value nor a shape finds it. */
export const withoutFakes = (text) =>
  FAKE_FORMS.reduce(
    (out, fake) => (out.includes(fake) ? out.split(fake).join("<fake>") : out),
    text,
  );
