// Age policy versioning for the v9 SELF-DECLARATION model (migration 0023).
//
// Mature (18+) access is based on the date of birth on the user's profile plus a
// recorded acceptance of the current age/content policy. There is no third-party
// age verification in v9. When the policy wording changes materially, bump
// CURRENT_AGE_POLICY_VERSION: existing acceptances recorded under an older version
// no longer satisfy eligibility (see decideMatureEligibility in age-core.ts) and
// users must confirm again on /age. The version string is passed by the app to the
// record_age_policy_acceptance() RPC, which stores it verbatim — keep this constant
// as the single source of truth for the current version.

export const CURRENT_AGE_POLICY_VERSION = "2026-11-v1";

/** Short human-readable summary of what accepting the policy means. */
export const AGE_POLICY_SUMMARY =
  "I confirm that the date of birth on my profile is accurate. I understand that " +
  "mature-rated content is restricted to people aged 18 or older, and that my " +
  "acceptance of this age and content policy is recorded with the policy version " +
  "and a timestamp.";
