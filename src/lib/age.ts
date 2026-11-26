import { cookies } from "next/headers";
import { decideMatureEligibility, type EligibilityDecision, type EligibilityProfile } from "./age-core";
import { CURRENT_AGE_POLICY_VERSION } from "./age-policy";

export * from "./age-core";
export { CURRENT_AGE_POLICY_VERSION } from "./age-policy";

// LEGACY UX HINT ONLY: this cookie used to be the whole age gate. It is NOT an
// authorization signal for anything. It may still be set by /api/age so the interface
// can remember that a visitor clicked through an informational notice, but every
// server-side mature-content decision goes through getMatureEligibility() below.
// Changing, deleting or forging this cookie cannot grant access to mature series,
// chapters or media.
export const AGE_COOKIE = "m2m_adult";
export const hasAdultHintCookie = () => {
  try { return cookies().get(AGE_COOKIE)?.value === "1"; } catch { return false; }
};
/** @deprecated Kept for import compatibility. NOT an authorization check — see getMatureEligibility. */
export const isAdultConfirmed = hasAdultHintCookie;

type ProfileRow = {
  date_of_birth?: string | null;
  suspended?: boolean | null;
  age_policy_version?: string | null;
  age_policy_accepted_at?: string | null;
} | null;

export type SupabaseLike = {
  auth: { getUser: () => Promise<{ data: { user: { id: string } | null } }> };
  from: (table: string) => {
    select: (cols: string) => { eq: (col: string, val: string) => { maybeSingle: () => PromiseLike<{ data: ProfileRow }> } };
  };
};

export function profileToEligibility(row: ProfileRow): EligibilityProfile {
  if (!row) return null;
  return {
    dateOfBirth: row.date_of_birth ?? null,
    suspended: row.suspended ?? null,
    agePolicyVersion: row.age_policy_version ?? null,
    agePolicyAcceptedAt: row.age_policy_accepted_at ?? null,
  };
}

/**
 * Server-side mature-content eligibility for the current request (v9 self-declaration
 * model, migration 0023). Fails closed on any error, missing profile, missing DOB,
 * under-18 DOB, suspension, or a missing/stale age-policy acceptance.
 */
export async function getMatureEligibility(sb: SupabaseLike): Promise<EligibilityDecision> {
  const opts = { currentPolicyVersion: CURRENT_AGE_POLICY_VERSION };
  try {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return decideMatureEligibility(null, { signedIn: false, ...opts });
    const { data } = await sb.from("profiles")
      .select("date_of_birth,suspended,age_policy_version,age_policy_accepted_at")
      .eq("id", user.id).maybeSingle();
    return decideMatureEligibility(profileToEligibility(data), { signedIn: true, ...opts });
  } catch {
    return decideMatureEligibility(null, { signedIn: false, ...opts });
  }
}

export async function canAccessMature(sb: SupabaseLike): Promise<boolean> {
  return (await getMatureEligibility(sb)).canAccessMature;
}

// Hides mature series from a PostgREST listing query unless the caller is eligible.
// The boolean MUST come from getMatureEligibility()/canAccessMature() (server-side),
// never from a cookie or client state.
export const hideMature = (q: any, eligible: boolean) => (eligible ? q : q.neq("content_rating", "mature"));
