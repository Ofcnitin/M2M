import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { privacyForRating, keyMatchesPrivacy } from "@/lib/media-keys";
import { signUploadForPrivacy } from "@/lib/r2";

// A signed URL lives 10 minutes. A retry after expiry asks for a fresh one for the SAME asset and key,
// so retrying never creates a duplicate slot. The RPC checks ownership and that the asset still awaits its upload.
const Body = z.object({ assetId: z.string().uuid() });

export async function POST(req: Request) {
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  const { data, error } = await sb.rpc("resign_chapter_asset", { p_asset: p.data.assetId });
  const row = Array.isArray(data) ? data[0] : data;
  if (error || !row) return NextResponse.json({ error: "This image can no longer be retried. Remove or replace it." }, { status: error?.code === "42501" ? 404 : 409 });
  // Privacy from the owning series' DB rating. Unlike sign/cover (which can rewrite a
  // freshly minted key), resign re-signs an EXISTING key: if that key's prefix disagrees
  // with the rating's privacy, REJECT rather than sign an upload into the wrong bucket.
  const { data: asset } = await sb.from("chapter_assets")
    .select("chapters(series(content_rating))").eq("id", p.data.assetId).maybeSingle();
  const rating = (asset as unknown as { chapters: { series: { content_rating: string } | null } | null } | null)
    ?.chapters?.series?.content_rating ?? null;
  const privacy = privacyForRating(rating);
  if (!keyMatchesPrivacy(row.storage_key, privacy)) {
    console.warn(JSON.stringify({ evt: "resign_key_privacy_mismatch", assetId: p.data.assetId, key: row.storage_key, rating }));
    return NextResponse.json({ error: "This image's storage key does not match its series' content rating. Remove or replace it." }, { status: 409 });
  }
  return NextResponse.json({ url: await signUploadForPrivacy(row.storage_key, row.mime_type, privacy) });
}
