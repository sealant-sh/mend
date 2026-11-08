import { sql, type SQLWrapper } from "drizzle-orm";

export const credentialStanding = (column: SQLWrapper, now: Date, owner?: SQLWrapper) => {
  const sessionOwner = owner === undefined ? sql`` : sql` AND s."userId" = ${owner}`;
  const deviceOwner = owner === undefined ? sql`` : sql` AND d.user_id = ${owner}`;
  const at = sql`${now.toISOString()}::timestamptz`;
  return sql<boolean>`(
  ${column} IS NULL
  OR (${column} LIKE 'session:%' AND EXISTS (
    SELECT 1 FROM "session" s
     WHERE s."id" = substr(${column}, 9) AND s."expiresAt" > ${at}${sessionOwner}))
  OR (${column} LIKE 'device:%' AND EXISTS (
    SELECT 1 FROM device_tokens d
     WHERE d.id = substr(${column}, 8) AND d.kind = 'device' AND d.revoked_at IS NULL${deviceOwner}))
  OR (${column} LIKE 'key:%' AND EXISTS (
    SELECT 1 FROM device_tokens d
      JOIN organization_members m ON m.organization_id = d.organization_id AND m.user_id = d.user_id
     WHERE d.id = substr(${column}, 5) AND d.kind = 'access_key' AND d.revoked_at IS NULL
       AND (d.expires_at IS NULL OR d.expires_at > ${at})${deviceOwner}))
)`;
};
