import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";
import { OnboardForm } from "@/components/OnboardForm";

export const metadata = { title: "Creator setup" };
export default async function Onboard() {
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login?next=/studio/onboard");
  const { data: me } = await sb.from("profiles").select("username,display_name,role").eq("id", user.id).single();
  if (me?.role !== "reader") redirect("/studio");
  return <OnboardForm username={me.username} displayName={me.display_name} />;
}
