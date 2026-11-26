import { isRestrictedKey } from "./media-keys";

export { isRestrictedKey, restrictedKeyFor, RESTRICTED_PREFIX, privacyForRating, deliveryDecision } from "./media-keys";
export type { MediaPrivacy, DeliveryDecision } from "./media-keys";

// Set NEXT_PUBLIC_IMAGE_TRANSFORMS=true once Cloudflare Image Transformations is enabled on the media domain.
// Public content only: restricted (mature) keys must NEVER be turned into public CDN URLs —
// use mediaUrlForAsset()/the /api/media/[assetId] gate instead (SEC-007 §4.4).
export const cdnUrl = (key: string, width?: number) => {
  if (isRestrictedKey(key)) throw new Error("Restricted media must be served through /api/media, not the public CDN");
  return width && process.env.NEXT_PUBLIC_IMAGE_TRANSFORMS === "true"
    ? `${process.env.NEXT_PUBLIC_CDN_URL}/cdn-cgi/image/width=${width},quality=85,format=auto/${key}`
    : `${process.env.NEXT_PUBLIC_CDN_URL}/${key}`;
};

/**
 * URL a reader may use for an asset. Mature-series assets go through the gated,
 * authenticated /api/media endpoint (which 302s to a <=5-minute signed R2 URL);
 * public assets keep fast public CDN delivery.
 */
export const mediaUrlForAsset = (asset: { id: string; storage_key: string }, rating: string | null | undefined, width?: number) =>
  rating === "mature" || isRestrictedKey(asset.storage_key) ? `/api/media/${asset.id}` : cdnUrl(asset.storage_key, width);

/** Cover URL for a series card/page: mature covers go through the gated /api/cover endpoint. */
export const coverUrlForSeries = (s: { id?: string | null; cover_url: string | null; content_rating?: string | null }): string | null => {
  if (!s.cover_url) return null;
  if (s.cover_url.startsWith("http")) return s.content_rating === "mature" ? null : s.cover_url;
  if (s.content_rating === "mature" || isRestrictedKey(s.cover_url)) return s.id ? `/api/cover/${s.id}` : null;
  return cdnUrl(s.cover_url);
};

/** Banner URL: same privacy rule as covers — mature banners go through /api/cover?kind=banner. */
export const bannerUrlForSeries = (s: { id?: string | null; banner_url: string | null; content_rating?: string | null }): string | null => {
  if (!s.banner_url) return null;
  if (s.banner_url.startsWith("http")) return s.content_rating === "mature" ? null : s.banner_url;
  if (s.content_rating === "mature" || isRestrictedKey(s.banner_url)) return s.id ? `/api/cover/${s.id}?kind=banner` : null;
  return cdnUrl(s.banner_url);
};
