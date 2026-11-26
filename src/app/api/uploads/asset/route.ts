import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { privacyForRating, isRestrictedKey, type MediaPrivacy } from "@/lib/media-keys";
import { signUploadForPrivacy, deleteObjectForPrivacy, deleteObject } from "@/lib/r2";

const MAX_BYTES = 15 * 1024 * 1024;
const Replace = z.object({ assetId: z.string().uuid(), type: z.enum(["image/jpeg", "image/png", "image/webp"]), size: z.number().int().positive().max(MAX_BYTES) });
const Remove = z.object({ assetId: z.string().uuid() });

type Sb = ReturnType<typeof supabaseServer>;

// Authoritative privacy for an asset: chapter_assets -> chapters -> series.content_rating.
// Returns null when the row/rating cannot be read (callers then fall back to the
// fail-safer prefix-based wrapper in r2.ts, never to a public default for restricted keys).
async function privacyForAsset(sb: Sb, assetId: string): Promise<MediaPrivacy | null> {
  const { data } = await sb.from("chapter_assets")
    .select("chapters(series(content_rating))").eq("id", assetId).maybeSingle();
  const rating = (data as unknown as { chapters: { series: { content_rating: string } | null } | null } | null)
    ?.chapters?.series?.content_rating;
  return typeof rating === "string" ? privacyForRating(rating) : null;
}

const deleteWithPrivacy = (key: string, privacy: MediaPrivacy | null) =>
  privacy ? deleteObjectForPrivacy(key, privacy) : deleteObject(key);

// Replace one image in place: same slot and order, new file. The RPC checks ownership and returns the old key.
export async function PATCH(req: Request) {
  const p = Replace.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "Only JPEG, PNG or WebP files up to 15 MB are accepted." }, { status: 400 });
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  const privacy = await privacyForAsset(sb, p.data.assetId);
  const { data, error } = await sb.rpc("replace_chapter_asset", { p_asset: p.data.assetId, p_type: p.data.type, p_size: p.data.size });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row) return NextResponse.json({ error: error?.code === "42501" ? "Image not found." : "Could not replace the image." }, { status: error?.code === "42501" ? 404 : 500 });
  await deleteWithPrivacy(row.old_key, privacy);
  // Mature series: sign the replacement into the PRIVATE bucket even if the RPC minted a
  // non-restricted key (see the note in uploads/sign — key minting is fixed by migration,
  // bucket privacy is enforced here). The key mismatch is logged for the 0017 audit.
  const effectivePrivacy: MediaPrivacy = privacy ?? (isRestrictedKey(row.new_key) ? "private" : "public");
  if (effectivePrivacy === "private" && !isRestrictedKey(row.new_key)) {
    console.warn(JSON.stringify({ evt: "mature_upload_key_not_restricted", assetId: p.data.assetId, key: row.new_key }));
  }
  return NextResponse.json({ id: p.data.assetId, url: await signUploadForPrivacy(row.new_key, p.data.type, effectivePrivacy) });
}

export async function DELETE(req: Request) {
  const p = Remove.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  // Read the rating BEFORE the RPC deletes the row, so the delete targets the right bucket.
  const privacy = await privacyForAsset(sb, p.data.assetId);
  const { data: key, error } = await sb.rpc("remove_chapter_asset", { p_asset: p.data.assetId });
  if (error || !key) return NextResponse.json({ error: error?.code === "42501" ? "Image not found." : "Could not remove the image." }, { status: error?.code === "42501" ? 404 : 500 });
  await deleteWithPrivacy(key as string, privacy);
  return NextResponse.json({ ok: true });
}
