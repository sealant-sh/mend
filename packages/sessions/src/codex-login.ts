import type { PlacedLogin } from "@mend/sealant";

/** The model provider Mend defines on Codex's command line for a key with an endpoint. */
const ENDPOINT_PROVIDER = "mend-endpoint";

/**
 * The `-c` overrides that send a Codex key's requests to its endpoint (docs/adr/0018, decision 11):
 * a model provider of Mend's own that sends the key in `auth.json` as a bearer token, with
 * connection retries bounded (Codex otherwise retries a closed port forever) and analytics off.
 * On the command line only, never in a `config.toml`, which is captured with the worktree. Empty
 * for every other login, so a ChatGPT login's token never goes to an endpoint. A URL is a valid
 * TOML basic string once JSON quotes it: the platform's URL form percent-encodes everything else.
 */
export const codexLoginOverridesOf = (login: PlacedLogin | undefined): ReadonlyArray<string> =>
  login?.kind !== "api-key" || login.baseUrl === undefined
    ? []
    : [
        "-c",
        `model_provider="${ENDPOINT_PROVIDER}"`,
        "-c",
        `model_providers.${ENDPOINT_PROVIDER}.name="Custom endpoint"`,
        "-c",
        `model_providers.${ENDPOINT_PROVIDER}.base_url=${JSON.stringify(login.baseUrl)}`,
        "-c",
        `model_providers.${ENDPOINT_PROVIDER}.wire_api="responses"`,
        "-c",
        `model_providers.${ENDPOINT_PROVIDER}.requires_openai_auth=true`,
        "-c",
        "features.unbounded_connection_retries=false",
        "-c",
        "analytics.enabled=false",
      ];

/**
 * A Codex command line with its login's overrides right after `codex`, ahead of a subcommand
 * (`app-server`) and of the person's own flags. Any other command line is left as it is.
 */
export const withCodexLogin = (
  argv: ReadonlyArray<string>,
  login: PlacedLogin | undefined,
): ReadonlyArray<string> => {
  const [head, ...rest] = argv;
  const overrides = codexLoginOverridesOf(login);
  return head === "codex" && overrides.length > 0 ? [head, ...overrides, ...rest] : argv;
};
