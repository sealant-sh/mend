import { sql, type SQLWrapper } from "drizzle-orm";

export const credentialStanding = (column: SQLWrapper, now: Date, owner?: SQLWrapper) => {
  const sessionOwner = owner === undefined ? sql`` : sql` AND s."userId" = ${owner}`;
  const deviceOwner = owner === undefined ? sql`` : sql` AND d.user_id = ${owner}`;
  return sql<boolean>`(
  ${column} IS NULL
  OR (${column} LIKE 'session:%' AND EXISTS (
    SELECT 1 FROM "session" s
     WHERE s."id" = substr(${column}, 9) AND s."expiresAt" > ${now.toISOString()}::timestamptz${sessionOwner}))
  OR (${column} LIKE 'device:%' AND EXISTS (
    SELECT 1 FROM device_tokens d
     WHERE d.id = substr(${column}, 8) AND d.revoked_at IS NULL${deviceOwner}))
)`;
};
