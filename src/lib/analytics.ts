import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { headers } from "next/headers";

// Server-only. Uses the service-role key, which must never be imported from a client component.
function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

// Daily-rotating hash of IP + user agent: lets the database dedupe repeat views without storing either.
export function visitorKey(): string | null {
  const h = headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || h.get("x-real-ip") || "";
  const ua = h.get("user-agent") ?? "";
  if (!ip && !ua) return null;
  const day = new Date().toISOString().slice(0, 10);
  return createHash("sha256").update(`${process.env.ANALYTICS_SALT ?? ""}|${day}|${ip}|${ua}`).digest("hex").slice(0, 32);
}

export async function trackEvent(type: "series_view" | "chapter_view" | "chapter_complete", seriesId: string, chapterId: string | null, userId: string | null) {
  try {
    const sb = admin(); if (!sb) return;
    await sb.rpc("track_event", { p_type: type, p_series: seriesId, p_chapter: chapterId, p_user: userId, p_visitor: visitorKey() });
  } catch { /* analytics must never break a page */ }
}
