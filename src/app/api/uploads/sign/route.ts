import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseServer } from "@/lib/supabase/server";
import { privacyForRating, isRestrictedKey } from "@/lib/media-keys";
import { signUploadForPrivacy } from "@/lib/r2";

const MAX_BYTES = 15 * 1024 * 1024;
const Body = z.object({
  chapterId: z.string().uuid(),
  files: z.array(z.object({ type: z.enum(["image/jpeg", "image/png", "image/webp"]), size: z.number().int().positive().max(MAX_BYTES) })).min(1).max(200),
});

export async function POST(req: Request) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in to upload." }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Only JPEG, PNG or WebP files up to 15 MB are accepted." }, { status: 400 });
  const { chapterId, files } = parsed.data;

  // Privacy comes from the series' DB content_rating (authoritative), never the key prefix.
  const { data: chapter } = await sb.from("chapters")
    .select("series_id,series(content_rating)").eq("id", chapterId).maybeSingle();
  const rating = (chapter as unknown as { series: { content_rating: string } | null } | null)?.series?.content_rating ?? null;
  const privacy = privacyForRating(rating);

  // Slots and storage keys are created by the register_chapter_assets RPC, which checks ownership,
  // creator status and limits, and moves a draft chapter to "uploading". Clients cannot write chapter_assets.
  const { data: assets, error } = await sb.rpc("register_chapter_assets", { p_chapter: chapterId, p_files: files });
  if (error || !assets) return NextResponse.json({ error: error?.code === "42501" ? "Chapter not found." : "Could not prepare the upload." }, { status: error?.code === "42501" ? 404 : 500 });
  const uploads = await Promise.all((assets as { id: string; storage_key: string; display_order: number; mime_type: string }[])
    .map(async (a) => {
      // NOTE: the RPC currently mints non-restricted keys even for mature series (migrations
      // 0005/0014 — outside this route). We still sign into the PRIVATE bucket for mature
      // series so the bytes never land in the public bucket; the key itself is flagged by
      // assert_series_media_private() (migration 0017) until the RPC/migration fixes it.
      if (privacy === "private" && !isRestrictedKey(a.storage_key)) {
        console.warn(JSON.stringify({ evt: "mature_upload_key_not_restricted", assetId: a.id, key: a.storage_key }));
      }
      return { id: a.id, order: a.display_order, url: await signUploadForPrivacy(a.storage_key, a.mime_type, privacy) };
    }));
  return NextResponse.json({ uploads });
}
