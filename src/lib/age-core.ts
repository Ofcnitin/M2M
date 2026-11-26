// Pure age / eligibility logic. No Next.js, cookie or database imports:
// this module is unit-tested directly (tests/age.test.ts) and imported by server code.
//
// V9 MODEL — SELF-DECLARED AGE (migration 0023): mature (18+) access requires ALL of:
//   1. a signed-in user who is not suspended,
//   2. a stored date of birth proving age >= 18 (calculated server-side), and
//   3. a recorded acceptance of the CURRENT age policy version
//      (profiles.age_policy_version === current version AND
//       profiles.age_policy_accepted_at present), recorded only through the
//      record_age_policy_acceptance() RPC — users cannot forge it by updating
//      their own profile (profiles_guard pins those columns).
// There is no third-party age verification in v9 and no provider concept in this
// decision. A cookie or any other client-supplied flag is NEVER an input here.
// If any input is missing/invalid the decision is deny (fail closed).

export type ContentRatingValue = "everyone" | "teen" | "mature";

export const CONTENT_WARNINGS = [
  { value: "violence", label: "Violence" },
  { value: "graphic_violence", label: "Graphic violence" },
  { value: "gore", label: "Gore" },
  { value: "nudity", label: "Nudity" },
  { value: "strong_language", label: "Strong language" },
  { value: "sexual_themes", label: "Sexual themes" },
  { value: "psychological", label: "Psychological themes" },
  { value: "substance_use", label: "Substance use" },
  { value: "disturbing_imagery", label: "Disturbing imagery" },
  { value: "other", label: "Other sensitive themes" },
] as const;
export type ContentWarning = (typeof CONTENT_WARNINGS)[number]["value"];
export const CONTENT_WARNING_VALUES: string[] = CONTENT_WARNINGS.map((w) => w.value);

export function sanitizeContentWarnings(input: unknown): ContentWarning[] {
  if (!Array.isArray(input)) return [];
  const allowed = new Set<string>(CONTENT_WARNING_VALUES);
  return [...new Set(input.map((v) => String(v)).filter((v) => allowed.has(v)))] as ContentWarning[];
}

/** Parse a YYYY-MM-DD date of birth. Returns null for anything invalid/future/implausible. */
export function parseDateOfBirth(value: unknown, now: Date = new Date()): Date | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return null;
  // Reject rolled-over dates such as 2000-02-31.
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  if (d.getTime() > now.getTime()) return null;
  if (calculateAge(d, now) > 120) return null;
  return d;
}

/** Whole years old at `now`, calculated in UTC so the result does not depend on server timezone. */
export function calculateAge(dob: Date, now: Date = new Date()): number {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
}

export function ageFromDobString(value: unknown, now: Date = new Date()): number | null {
  const dob = value instanceof Date ? value : parseDateOfBirth(value, now);
  return dob ? calculateAge(dob, now) : null;
}

/** Registration gate: M2M does not register anyone under 13. Missing/invalid DOB also fails. */
export function meetsMinimumRegistrationAge(value: unknown, now: Date = new Date()): boolean {
  const age = ageFromDobString(value, now);
  return age !== null && age >= 13;
}

export type EligibilityProfile = {
  dateOfBirth?: string | Date | null;
  suspended?: boolean | null;
  /** Policy version the user accepted (profiles.age_policy_version), or null if never. */
  agePolicyVersion?: string | null;
  /** When the user accepted the policy (profiles.age_policy_accepted_at), or null if never. */
  agePolicyAcceptedAt?: string | Date | null;
} | null | undefined;

export type EligibilityDecision = {
  canAccessMature: boolean;
  age: number | null;
  reason:
    | "eligible"
    | "not_signed_in"
    | "suspended"
    | "no_date_of_birth"
    | "under_18"
    | "policy_not_accepted";
};

/**
 * The single eligibility decision used by pages, APIs, search and media delivery.
 *
 * Eligible iff ALL of:
 *   - signed in and not suspended,
 *   - DOB on the profile proving age >= 18 at `now`,
 *   - the profile's recorded acceptance is for the CURRENT policy version
 *     (`opts.currentPolicyVersion`, from src/lib/age-policy.ts) and has a timestamp.
 * An acceptance recorded under an older policy version, or with no timestamp,
 * denies with 'policy_not_accepted'. This function takes no cookie, header or
 * other client-controlled input: the profile row is the only evidence.
 */
export function decideMatureEligibility(
  profile: EligibilityProfile,
  opts: {
    signedIn: boolean;
    currentPolicyVersion: string;
    now?: Date;
  },
): EligibilityDecision {
  const now = opts.now ?? new Date();
  const age = profile ? ageFromDobString(profile.dateOfBirth ?? null, now) : null;
  if (!opts.signedIn || !profile) return { canAccessMature: false, age, reason: "not_signed_in" };
  if (profile.suspended) return { canAccessMature: false, age, reason: "suspended" };
  if (age === null) return { canAccessMature: false, age, reason: "no_date_of_birth" };
  if (age < 18) return { canAccessMature: false, age, reason: "under_18" };
  const acceptedAt = profile.agePolicyAcceptedAt
    ? (profile.agePolicyAcceptedAt instanceof Date ? profile.agePolicyAcceptedAt : new Date(profile.agePolicyAcceptedAt))
    : null;
  const acceptanceValid =
    profile.agePolicyVersion === opts.currentPolicyVersion &&
    acceptedAt !== null && !Number.isNaN(acceptedAt.getTime());
  if (!acceptanceValid) return { canAccessMature: false, age, reason: "policy_not_accepted" };
  return { canAccessMature: true, age, reason: "eligible" };
}

/** Minimum age for a rating, or null when the rating is unknown (treated as restricted). */
export function minimumAgeForRating(rating: string | null | undefined): number {
  switch (rating) {
    case "everyone": return 0;
    case "teen": return 13;
    case "mature": return 18;
    default: return 18;
  }
}

export function isRestrictedRating(rating: string | null | undefined): boolean {
  return rating === "mature";
}
