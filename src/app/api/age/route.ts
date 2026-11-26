import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { AGE_COOKIE, canAccessMature, type SupabaseLike } from "@/lib/age";
import { CURRENT_AGE_POLICY_VERSION } from "@/lib/age-policy";
import { safeNext } from "@/lib/url";

// V9 SELF-DECLARATION (migration 0023): POST records the signed-in user's acceptance
// of the current age policy via the record_age_policy_acceptance() RPC — the only
// write path for profiles.age_policy_version / age_policy_accepted_at. Acceptance
// alone does not grant access: mature eligibility is decided server-side from the
// profile's date of birth (18+) plus this acceptance (see src/lib/age-core.ts).
// The legacy hint cookie is still set for UX continuity; it authorizes nothing.
const withCookie = (res: NextResponse) => {
  res.cookies.set(AGE_COOKIE, "1", { maxAge: 60 * 60 * 24 * 365, path: "/", sameSite: "lax", httpOnly: true, secure: process.env.NODE_ENV === "production" });
  return res;
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const next = safeNext(url.searchParams.get("next"));
  const sb = supabaseServer();
  if (await canAccessMature(sb as unknown as SupabaseLike)) {
    return withCookie(NextResponse.redirect(new URL(next, url.origin)));
  }
  return NextResponse.redirect(new URL(`/age?next=${encodeURIComponent(next)}`, url.origin));
}

export async function POST(req: Request) {
  const form = await req.formData();
  const next = safeNext(String(form.get("next") ?? "/"));
  // The /age form's required declaration checkbox submits answer=yes.
  if (form.get("answer") !== "yes") return NextResponse.redirect(new URL("/", req.url), 303);
  const sb = supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.redirect(new URL(`/age?next=${encodeURIComponent(next)}`, req.url), 303);
  // Record the policy acceptance (append-only audit row + profile stamp) via the RPC.
  // The RPC acts on auth.uid(), so a user can only ever accept for themselves.
  const { error } = await sb.rpc("record_age_policy_acceptance", { p_version: CURRENT_AGE_POLICY_VERSION });
  if (error) return NextResponse.redirect(new URL("/age?status=error", req.url), 303);
  // Legacy informational timestamp, kept for continuity. It grants NOTHING.
  await sb.from("profiles").update({ adult_confirmed_at: new Date().toISOString() }).eq("id", user.id);
  const dest = (await canAccessMature(sb as unknown as SupabaseLike)) ? next : "/age?status=not_eligible";
  return withCookie(NextResponse.redirect(new URL(dest, req.url), 303));
}
