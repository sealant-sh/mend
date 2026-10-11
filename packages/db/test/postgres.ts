/**
 * PostgreSQL tests are required by default and use isolated throwaway databases.
 * Set MEND_TEST_DATABASE_URL to a server whose account can create databases, or use the dev
 * server from compose.dev.yaml. Local runs can explicitly opt out with
 * MEND_SKIP_POSTGRES_TESTS=1. A configured URL or CI run always requires the database.
 */
export function postgresTestConfig(): { readonly adminUrl: string; readonly skip: boolean } {
  const configuredUrl = process.env["MEND_TEST_DATABASE_URL"];
  const skip = process.env["MEND_SKIP_POSTGRES_TESTS"];
  if (skip !== undefined && skip !== "0" && skip !== "1") {
    throw new Error("MEND_SKIP_POSTGRES_TESTS must be 0 or 1");
  }
  if (skip === "1" && (configuredUrl !== undefined || process.env["CI"])) {
    throw new Error("PostgreSQL tests cannot be skipped in CI or with MEND_TEST_DATABASE_URL");
  }

  const adminUrl = configuredUrl ?? "postgres://mend:mend@localhost:5434/mend";
  let parsed: URL;
  try {
    parsed = new URL(adminUrl);
  } catch {
    throw new Error("MEND_TEST_DATABASE_URL must be a PostgreSQL URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("MEND_TEST_DATABASE_URL must be a PostgreSQL URL");
  }
  return { adminUrl, skip: skip === "1" };
}
