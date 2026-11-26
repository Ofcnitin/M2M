import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { isRestrictedKey, type MediaPrivacy } from "./media-keys";

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
});

export const publicBucket = () => process.env.R2_BUCKET ?? "m2m-media";
/** Private bucket for restricted media. Falls back to the main bucket + `restricted/` prefix. */
export const privateBucket = () => process.env.R2_PRIVATE_BUCKET || publicBucket();

/**
 * Bucket selection by PRIVACY (v8 fix). Privacy must come from the series' DB
 * content_rating (see privacyForRating in media-keys.ts), never from the key prefix:
 * 'private' => privateBucket(), 'public' => publicBucket(). There is no fallback from
 * private to public: if R2_PRIVATE_BUCKET is unset, privateBucket() falls back to the
 * main bucket NAME, but callers must still only reach such objects via gated signed
 * URLs (the restricted/ prefix must not be bound to the public CDN — see README).
 */
export const bucketForPrivacy = (privacy: MediaPrivacy) => (privacy === "private" ? privateBucket() : publicBucket());

/**
 * LEGACY prefix-based bucket selection. Kept only for backwards compatibility with
 * call sites that have no DB rating available (e.g. best-effort deletes of an already
 * removed row). It is fail-safer than the old delivery path in one respect only:
 * restricted/ keys still resolve to the private bucket. New code MUST use
 * bucketForPrivacy() with a rating-derived privacy.
 */
export const bucketForKey = (key: string) => (isRestrictedKey(key) ? privateBucket() : publicBucket());

const clampExpiry = (expiresInSeconds: number) => Math.min(Math.max(expiresInSeconds, 30), 300);

// Short-lived, single-object, content-type-bound upload URL. Credentials never reach the browser.
// Privacy-aware: mature-series uploads MUST be signed with privacy 'private' so the object
// lands in the private bucket under a restricted/ key.
export const signUploadForPrivacy = (key: string, contentType: string, privacy: MediaPrivacy) =>
  getSignedUrl(r2, new PutObjectCommand({ Bucket: bucketForPrivacy(privacy), Key: key, ContentType: contentType }), { expiresIn: 600 });

// Backwards-compatible wrapper: privacy defaults to the key prefix (restricted/ => private).
// Prefer signUploadForPrivacy() with a DB-rating-derived privacy at new call sites.
export const signUpload = (key: string, contentType: string, privacy?: MediaPrivacy) =>
  signUploadForPrivacy(key, contentType, privacy ?? (isRestrictedKey(key) ? "private" : "public"));

// Short-lived signed GET, issued only after the /api/media or /api/cover gate has
// authenticated the user and verified mature eligibility server-side. Maximum 5 minutes.
// Privacy is MANDATORY and must be derived from the DB content rating at the call site —
// there is deliberately no prefix-based default, so a mature asset can never be signed
// out of the public bucket by accident.
export const signDownloadForPrivacy = (key: string, privacy: MediaPrivacy, expiresInSeconds = 300) =>
  getSignedUrl(r2, new GetObjectCommand({ Bucket: bucketForPrivacy(privacy), Key: key }), { expiresIn: clampExpiry(expiresInSeconds) });

export const signDownload = (key: string, privacy: MediaPrivacy, expiresInSeconds = 300) =>
  signDownloadForPrivacy(key, privacy, expiresInSeconds);

// Privacy-aware delete. Use when the owning series' rating is known.
// Best effort: a failed delete only leaves an orphaned file, it never blocks the user's action.
export const deleteObjectForPrivacy = (key: string, privacy: MediaPrivacy) =>
  r2.send(new DeleteObjectCommand({ Bucket: bucketForPrivacy(privacy), Key: key })).catch(() => undefined);

// Backwards-compatible wrapper: bucket from the key prefix (restricted/ => private bucket).
export const deleteObject = (key: string, privacy?: MediaPrivacy) =>
  privacy ? deleteObjectForPrivacy(key, privacy) : r2.send(new DeleteObjectCommand({ Bucket: bucketForKey(key), Key: key })).catch(() => undefined);
