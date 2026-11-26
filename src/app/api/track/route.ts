import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { trackEvent } from "@/lib/analytics";
import { rateLimit, rateLimitFromEnv } from "@/lib/rate-limit";

// Only chapter_complete comes from the browser; the database validates the series/chapter pair and dedupes.
const Body = z.object({ seriesId: z.string().uuid(), chapterId: z.string().uuid() });

export async function POST(req: Request) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  // Authenticated, but completions are deduped in the DB (0005) — rate-limit per user as a baseline against event spam.
  const rl = rateLimit(`track:${user.id}`, rateLimitFromEnv("TRACK", { limit: 60, windowMs: 60_000 }));
  if (!rl.ok) return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } });
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  await trackEvent("chapter_complete", p.data.seriesId, p.data.chapterId, user.id);
  return NextResponse.json({ ok: true });
}
