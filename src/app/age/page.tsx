import Link from "next/link";
import { safeNext } from "@/lib/url";
import { supabaseServer } from "@/lib/supabase/server";
import { getMatureEligibility, type SupabaseLike } from "@/lib/age";
import { AGE_POLICY_SUMMARY } from "@/lib/age-policy";

export const metadata = { title: "Mature content (18+)" };

const REASONS: Record<string, string> = {
  not_signed_in: "Sign in with an account that has a date of birth on file.",
  suspended: "This account is suspended, so mature content is unavailable.",
  no_date_of_birth: "There is no date of birth on your profile. Contact support to have it added — your age for mature content is calculated from it on our servers.",
  under_18: "The date of birth on your profile shows this account is under 18, so mature content is unavailable.",
  policy_not_accepted: "You have not confirmed the current age policy yet. Use the age confirmation below.",
  eligible: "You can access mature content.",
};

export default async function Age({ searchParams }: { searchParams: { next?: string } }) {
  const next = safeNext(searchParams.next);
  const sb = supabaseServer();
  const eligibility = await getMatureEligibility(sb as unknown as SupabaseLike);
  const signedIn = eligibility.reason !== "not_signed_in";
  const needsConfirmation = signedIn && !eligibility.canAccessMature && eligibility.reason === "policy_not_accepted";
  return (
    <section className="neu mx-auto mt-10 max-w-md p-8 text-center">
      <h1 className="text-2xl font-bold">Mature content (18+)</h1>
      <p className="mt-3 text-mute">
        Mature-rated series are restricted to adults aged 18 or older. Access is based on
        self-declaration: the date of birth on your profile, checked on our servers, plus
        your recorded confirmation of our age policy. It cannot be unlocked by a browser
        setting or cookie.
      </p>
      <p role="status" className="neu-in mt-5 p-4 text-sm">{REASONS[eligibility.reason] ?? REASONS.policy_not_accepted}</p>
      {needsConfirmation && (
        <form action="/api/age" method="post" className="mt-6 grid gap-4 text-left">
          <input type="hidden" name="next" value={next} />
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" name="answer" value="yes" required className="mt-1" />
            <span>{AGE_POLICY_SUMMARY} Your confirmation is recorded with the policy version and a timestamp.</span>
          </label>
          <button className="btn-primary">Confirm my age declaration</button>
        </form>
      )}
      <div className="mt-6 flex justify-center gap-3">
        {eligibility.canAccessMature
          ? <Link href={next} className="btn-primary">Continue</Link>
          : !signedIn && <Link href={`/login?next=${encodeURIComponent(next)}`} className="btn-primary">Sign in</Link>}
        <Link href="/" className="btn">Take me back</Link>
      </div>
    </section>
  );
}
