import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { getMatureEligibility, type SupabaseLike } from "@/lib/age";
import { deliveryDecision } from "@/lib/media-keys";
import { signDownloadForPrivacy } from "@/lib/r2";
import { cdnUrl } from "@/lib/cdn";

// SEC-007 gated media delivery. Chapter/read pages return THIS endpoint (never a raw CDN
// URL) for mature-series assets. Flow: authenticate -> load asset + series rating ->
// public assets redirect to the CDN; restricted assets require full mature eligibility
// and get a 302 to a <=5-minute signed R2 GET URL. Eligibility is re-checked on every
// request, so revoked/expired verification takes effect immediately.
//
// V8 PRIVACY FIX: the bucket is decided by the series' DB content_rating (authoritative),
// never by the storage-key prefix. A mature asset whose key lacks the restricted/ prefix
// is REJECTED (403) — it is never signed out of, or redirected to, the public bucket/CDN.
// Such rows are data bugs for scripts/migrate-mature-media.mjs (migration 0017) to fix.
export async function GET(_req: Request, { params }: { params: { assetId: string } }) {
  const sb = supabaseServer();
  // Service-level lookup is intentionally NOT used: this query runs under RLS. Owners and
  // public-chapter readers can see ready assets; the rating check below is the real gate
  // for mature content (RLS alone does not know about age verification).
  const { data: asset } = await sb.from("chapter_assets")
    .select("id,storage_key,chapter_id,chapters(series_id,series(content_rating,visibility,removed_by_moderation))")
    .eq("id", params.assetId).maybeSingle();
  if (!asset) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const a = asset as unknown as { storage_key: unknown; chapters: { series: { content_rating: string; visibility: string; removed_by_moderation: boolean } } | null };
  const series = a.chapters?.series;
  if (!series || series.removed_by_moderation) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const decision = deliveryDecision({ rating: series.content_rating, storageKey: a.storage_key });
  if (decision.kind === "reject") {
    return NextResponse.json({ error: "This media is unavailable.", reason: decision.reason }, { status: 403 });
  }
  if (decision.kind === "cdn") {
    return NextResponse.redirect(cdnUrl(a.storage_key as string, 1080), 302);
  }
  const eligibility = await getMatureEligibility(sb as unknown as SupabaseLike);
  if (!eligibility.canAccessMature) {
    return NextResponse.json({ error: "Mature content requires a verified 18+ account.", reason: eligibility.reason }, { status: 403 });
  }
  // Explicit PRIVATE bucket: even if R2_PRIVATE_BUCKET is unset, privateBucket() fallback
  // semantics apply — this path never produces a public CDN URL.
  const url = await signDownloadForPrivacy(a.storage_key as string, "private", 300);
  return new NextResponse(null, { status: 302, headers: { Location: url, "Cache-Control": "private, no-store" } });
}
