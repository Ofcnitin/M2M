"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { CURRENT_AGE_POLICY_VERSION } from "@/lib/age-policy";

export function AuthForm({ next }: { next: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setMsg("");
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email")), password = String(f.get("password"));
    const sb = supabaseBrowser();
    if (mode === "in") {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) setMsg("Email or password is incorrect."); else { router.push(next); router.refresh(); }
    } else {
      const username = String(f.get("username")).toLowerCase();
      if (!/^[a-z0-9_]{3,30}$/.test(username)) { setMsg("Username must be 3 to 30 letters, numbers or underscores."); setBusy(false); return; }
      const dob = String(f.get("date_of_birth") ?? "");
      // Client-side mirror of the server rule (the database trigger enforces it for real):
      // a valid date of birth is required and you must be 13 or older to register.
      const dobDate = /^\d{4}-\d{2}-\d{2}$/.test(dob) ? new Date(`${dob}T00:00:00Z`) : null;
      const ageYears = dobDate && !Number.isNaN(dobDate.getTime()) ? Math.floor((Date.now() - dobDate.getTime()) / (365.2425 * 24 * 3600 * 1000)) : null;
      if (ageYears === null || ageYears < 13 || ageYears > 120) { setMsg("Enter your date of birth — you must be 13 or older to create an account."); setBusy(false); return; }
      if (!f.get("age_policy_accepted")) { setMsg("Please confirm your date of birth is accurate and accept the age policy."); setBusy(false); return; }
      // Age-policy acceptance flow (v9 self-declaration): the checkbox below is the
      // user's declaration. We pass age_policy_accepted + the current policy version in
      // sign-up metadata; handle_new_user() (migration 0023) records the acceptance on
      // the new profile when both are present. The canonical acceptance point remains
      // the /age page (POST /api/age -> record_age_policy_acceptance RPC): it covers
      // accounts created before this metadata existed, policy-version bumps, and DOB
      // corrections, which all require a fresh confirmation there.
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { username, display_name: String(f.get("display_name") || username), age_confirmed: true, date_of_birth: dob, age_policy_accepted: true, age_policy_version: CURRENT_AGE_POLICY_VERSION }, emailRedirectTo: `${location.origin}/auth/callback?next=${encodeURIComponent(next)}` } });
      if (error) setMsg(error.message);
      else if (data.session) { router.push(next); router.refresh(); }
      else setMsg("Check your email to confirm your account, then sign in.");
    }
    setBusy(false);
  }
  const field = "neu-in w-full bg-transparent px-4 py-3 text-sm outline-none focus:outline-2 focus:outline-sky";
  return (
    <form onSubmit={submit} className="neu mx-auto mt-10 grid max-w-sm gap-4 p-8">
      <h1 className="text-2xl font-bold">{mode === "in" ? "Sign in" : "Create your account"}</h1>
      {mode === "up" && <>
        <input name="username" required placeholder="Username" aria-label="Username" className={field} />
        <input name="display_name" placeholder="Display name" aria-label="Display name" className={field} /></>}
      <input name="email" type="email" required placeholder="Email" aria-label="Email" className={field} />
      <input name="password" type="password" required minLength={8} placeholder="Password (8+ characters)" aria-label="Password" className={field} />
      {mode === "up" && <>
        <label className="grid gap-1 text-sm"><span>Date of birth (required — you must be 13 or older)</span><input type="date" name="date_of_birth" required aria-label="Date of birth" className={field} /></label>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" name="age_policy_accepted" required className="mt-1" aria-label="Confirm date of birth accuracy and accept the age policy" />
          <span>I confirm my date of birth is accurate. I understand mature (18+) content is restricted to people aged 18 or older, and that my acceptance of the age and content policy is recorded with the policy version and a timestamp.</span>
        </label>
        <p className="text-xs text-mute">Mature (18+) series require a date of birth showing you are 18 or older plus an age confirmation — you can complete or renew your confirmation any time on the age confirmation page.</p></>}
      {msg && <p role="alert" className="text-sm">{msg}</p>}
      <button disabled={busy} className="btn-primary">{mode === "in" ? "Sign in" : "Create account"}</button>
      <button type="button" className="text-sm text-mute underline" onClick={() => { setMode(mode === "in" ? "up" : "in"); setMsg(""); }}>
        {mode === "in" ? "New here? Create an account" : "Already registered? Sign in"}</button>
    </form>
  );
}
