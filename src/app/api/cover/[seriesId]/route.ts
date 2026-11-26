import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { getMatureEligibility, type SupabaseLike } from "@/lib/age";
import { deliveryDecision } from "@/lib/media-keys";
import { signDownloadForPrivacy } from "@/lib/r2";
import { cdnUrl } from "@/lib/cdn";

// Gated cover/banner delivery for mature series (SEC-007 §4.4: thumbnails and previews get
// the same protection as chapter pages). Public series redirect to the CDN as before.
// `?kind=banner` serves series.banner_url under exactly the same rules as the cover.
//
// V8 PRIVACY FIX: privacy is decided by the series' DB content_rating, never by the key
// prefix. A mature series whose cover/banner key lacks the restricted/ prefix is REJECTED
// (403), and an http(s) cover/banner URL on a mature series is a 404 — neither is ever
// proxied or redirected to through the public CDN.
export async function GET(req: Request, { params }: { params: { seriesId: string } }) {
  const sb = supabaseServer();
  const kind = new URL(req.url).searchParams.get("kind") === "banner" ? "banner" : "cover";
  const { data } = await sb.from("series").select("cover_url,banner_url,content_rating,removed_by_moderation").eq("id", params.seriesId).maybeSingle();
  const s = data as { cover_url: string | null; banner_url: string | null; content_rating: string; removed_by_moderation: boolean } | null;
  const raw = kind === "banner" ? s?.banner_url : s?.cover_url;
  if (!s || !raw || s.removed_by_moderation) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (typeof raw !== "string" || raw.startsWith("http")) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const key = raw;
  const decision = deliveryDecision({ rating: s.content_rating, storageKey: key });
  if (decision.kind === "reject") {
    return NextResponse.json({ error: "This media is unavailable.", reason: decision.reason }, { status: 403 });
  }
  if (decision.kind === "cdn") return NextResponse.redirect(cdnUrl(key), 302);
  const eligibility = await getMatureEligibility(sb as unknown as SupabaseLike);
  if (!eligibility.canAccessMature) {
    return NextResponse.json({ error: "Mature content requires a verified 18+ account.", reason: eligibility.reason }, { status: 403 });
  }
  const url = await signDownloadForPrivacy(key, "private", 300);
  return new NextResponse(null, { status: 302, headers: { Location: url, "Cache-Control": "private, no-store" } });
}
