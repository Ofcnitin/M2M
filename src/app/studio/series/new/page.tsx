import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { NewSeriesForm } from "@/components/NewSeriesForm";

export const metadata = { title: "Create series" };
export default async function NewSeries() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login?next=/studio/series/new");
  const { data: me } = await sb.from("profiles").select("role").eq("id", user.id).single();
  if (me?.role === "reader") redirect("/studio/onboard");
  const { data: genres } = await sb.from("genres").select("id,name").order("name");
  return <NewSeriesForm genres={genres ?? []} />;
}
