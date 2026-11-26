"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";

export function FollowButton({ creatorId }: { creatorId: string }) {
  const router = useRouter();
  const [uid, setUid] = useState<string | null>(null);
  const [following, setFollowing] = useState(false);
  useEffect(() => { (async () => {
    const sb = supabaseBrowser();
    const { data: { user } } = await sb.auth.getUser(); if (!user) return; setUid(user.id);
    const { data } = await sb.from("follows").select("creator_id").eq("creator_id", creatorId).maybeSingle(); setFollowing(!!data);
  })(); }, [creatorId]);
  if (uid === creatorId) return null;
  async function toggle() {
    if (!uid) return router.push(`/login?next=${encodeURIComponent(location.pathname)}`);
    const sb = supabaseBrowser();
    if (following) await sb.from("follows").delete().eq("creator_id", creatorId).eq("user_id", uid);
    else await sb.from("follows").insert({ user_id: uid, creator_id: creatorId });
    setFollowing(!following);
  }
  return <button className="btn" aria-pressed={following} onClick={toggle}>{following ? "Following" : "Follow"}</button>;
}
