// Storage-key conventions for SEC-007 restricted media. Kept dependency-free so both
// server code and client components (SeriesCard etc.) can import it safely.
//
// Restricted assets live under the `restricted/` prefix. In production that prefix (or a
// dedicated private bucket, R2_PRIVATE_BUCKET) must NOT be bound to the public CDN domain:
// see README "Production deployment checklist". Public assets keep their historical keys
// (<seriesId>/...) and public CDN delivery.
//
// PRIVACY MODEL (v8 fix): the key prefix is a *storage convention*, never the authority.
// Privacy is decided by the series' content_rating in the database, end to end:
//   rating === 'mature'  => privacy 'private' (private bucket, gated signed delivery)
//   anything else        => privacy 'public'  (public bucket / CDN)
// A mature asset whose key does NOT carry the restricted/ prefix is a data bug (see
// scripts/migrate-mature-media.mjs / migration 0017): delivery must REJECT it, never fall
// back to the public bucket/CDN where it would be directly reachable.
export const RESTRICTED_PREFIX = "restricted/";

export const isRestrictedKey = (key: string | null | undefined): boolean =>
  typeof key === "string" && key.startsWith(RESTRICTED_PREFIX);

export const restrictedKeyFor = (key: string): string =>
  isRestrictedKey(key) ? key : `${RESTRICTED_PREFIX}${key}`;

/** Delivery/storage privacy, derived ONLY from the authoritative DB content rating. */
export type MediaPrivacy = "public" | "private";

export const privacyForRating = (rating: string | null | undefined): MediaPrivacy =>
  rating === "mature" ? "private" : "public";

/** True when a storage key's prefix agrees with the privacy the DB rating demands. */
export const keyMatchesPrivacy = (key: unknown, privacy: MediaPrivacy): boolean =>
  typeof key === "string" && key.length > 0 && (privacy === "private" ? isRestrictedKey(key) : !isRestrictedKey(key));

export type DeliveryDecision =
  | { kind: "cdn" }
  | { kind: "signed-private" }
  | { kind: "reject"; reason: string };

/**
 * Pure delivery decision used by /api/media/[assetId] and /api/cover/[seriesId].
 * - mature series: key must be a restricted/ string, otherwise REJECT (fail closed —
 *   signing it would put a mature asset on the public bucket/CDN).
 * - non-mature series with a legacy restricted/ key: still gated signed-private delivery
 *   (never downgrade a restricted/ key to the CDN).
 * - non-mature series with an ordinary key: public CDN.
 */
export function deliveryDecision(input: { rating: string | null | undefined; storageKey: unknown }): DeliveryDecision {
  const { rating, storageKey } = input;
  if (typeof storageKey !== "string" || storageKey.length === 0) {
    return { kind: "reject", reason: "missing storage key" };
  }
  if (rating === "mature") {
    if (!isRestrictedKey(storageKey)) {
      return { kind: "reject", reason: "mature asset has a non-restricted storage key; refusing public delivery (needs migration 0017)" };
    }
    return { kind: "signed-private" };
  }
  if (isRestrictedKey(storageKey)) return { kind: "signed-private" };
  return { kind: "cdn" };
}
