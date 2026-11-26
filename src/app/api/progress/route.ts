import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { rateLimit, rateLimitFromEnv } from "@/lib/rate-limit";

// Reading progress. A route (not a direct client write) so the page can flush it with fetch keepalive while it is closing.
// RLS still limits the row to the signed-in user, and the timestamp comes from the server so clock skew cannot reorder saves.
const Body = z.object({
  seriesId: z.string().uuid(), chapterId: z.string().uuid(), assetId: z.string().uuid().nullable(),
  position: z.number().min(0).max(1), completed: z.boolean(),
});

export async function POST(req: Request) {
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  // Authenticated + RLS-scoped; rate-limit per user (progress flushes are frequent by design, hence a higher ceiling).
  const rl = rateLimit(`progress:${user.id}`, rateLimitFromEnv("PROGRESS", { limit: 120, windowMs: 60_000 }));
  if (!rl.ok) return NextResponse.json({ error: "Too many requests." }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } });
  const { error } = await sb.from("reading_progress").upsert({
    user_id: user.id, series_id: p.data.seriesId, chapter_id: p.data.chapterId, asset_id: p.data.assetId,
    scroll_position: p.data.position, completed: p.data.completed, updated_at: new Date().toISOString(),
  });
  if (error) return NextResponse.json({ error: "Could not save progress." }, { status: 500 });
  return NextResponse.json({ ok: true });
}
