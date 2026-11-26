"use client";
import { useEffect } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

// Marks everything read shortly after the list is shown. The list keeps its "new" highlight from the server snapshot.
export function MarkRead({ unread }: { unread: boolean }) {
  useEffect(() => {
    if (!unread) return;
    const t = setTimeout(async () => {
      await supabaseBrowser().from("notifications").update({ read_at: new Date().toISOString() }).is("read_at", null);
      dispatchEvent(new Event("m2m:notifications"));
    }, 1500);
    return () => clearTimeout(t);
  }, [unread]);
  return null;
}
