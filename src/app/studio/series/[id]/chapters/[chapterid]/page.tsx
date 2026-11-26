import { notFound, redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { ChapterBuilder } from "@/components/ChapterBuilder";

export const metadata = { title: "Chapter Builder" };
export default async function Builder({ params }: { params: { id: string; chapterId: string } }) {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login");
  const { data: ch } = await sb.from("chapters").select("id,series_id,chapter_number,publication_status,reading_mode").eq("id", params.chapterId).eq("series_id", params.id).single();
  // Owner, editor or uploader (checked in the database; the RPCs repeat the check on every write).
  const { data: role } = await sb.rpc("series_member_role", { sid: params.id });
  if (!ch || !["owner", "editor", "uploader"].includes(role as string)) notFound();
  const { data: assets } = await sb.from("chapter_assets").select("id,storage_key,processing_status").eq("chapter_id", ch.id).order("display_order");
  return <ChapterBuilder chapter={ch as any} initial={assets ?? []} />;
}
