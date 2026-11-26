import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "crypto";
import { supabaseServer } from "@/lib/supabase/server";
import { privacyForRating, restrictedKeyFor } from "@/lib/media-keys";
import { signUploadForPrivacy } from "@/lib/r2";

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;
const Body = z.object({ seriesId: z.string().uuid(), type: z.enum(["image/jpeg", "image/png", "image/webp"]), size: z.number().int().positive().max(8 * 1024 * 1024) });

export async function POST(req: Request) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to upload." }, { status: 401 });
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return NextResponse.json({ error: "Covers must be JPEG, PNG or WebP up to 8 MB." }, { status: 400 });
  const { data: s } = await sb.from("series").select("id,content_rating").eq("id", p.data.seriesId).eq("creator_id", user.id).single();
  if (!s) return NextResponse.json({ error: "Series not found." }, { status: 404 });
  // Privacy from the DB rating: mature covers are forced under restricted/ AND signed
  // against the private bucket (previously the prefix alone decided the bucket).
  const privacy = privacyForRating(s.content_rating);
  const base = `${s.id}/cover/${randomUUID()}.${EXT[p.data.type]}`;
  const key = privacy === "private" ? restrictedKeyFor(base) : base;
  return NextResponse.json({ key, url: await signUploadForPrivacy(key, p.data.type, privacy) });
}
