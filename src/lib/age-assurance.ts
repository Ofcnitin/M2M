// FUTURE-EXTENSION SEAM ONLY — no runtime behaviour in v9.
//
// V9 MODEL: age access uses SELF-DECLARATION. A user's date of birth on their
// profile plus a recorded acceptance of the current age policy version
// (src/lib/age-policy.ts, migration 0023) decides mature-content eligibility in
// src/lib/age-core.ts (decideMatureEligibility). There is deliberately:
//   - NO provider registry and NO built-in providers in this file,
//   - NO environment-variable configuration (the AGE_ASSURANCE_* vars are gone),
//   - NO verification sessions, callbacks or signatures,
//   - NOTHING in this file is imported by eligibility code.
//
// If a future version reintroduces third-party age assurance, it would integrate
// WITHOUT changing the self-declaration record:
//   1. Implement the FutureAgeAssuranceProvider interface below in a new module and
//      resolve the configured implementation server-side only.
//   2. Add API routes that start a provider flow for the signed-in user and receive
//      its outcome on a signature-checked callback.
//   3. Record outcomes through a new SECURITY DEFINER RPC (in the style of
//      record_age_policy_acceptance) — never by letting clients write profile
//      columns directly — and extend decideMatureEligibility to require the
//      provider assertion in addition to (not instead of) the DOB check.
//   4. Add a migration for any session/audit tables the flow needs, with RLS
//      locked down like age_policy_acceptances (migration 0023).
// Until then this interface is documentation of that seam, and it is unused.

export interface FutureAgeAssuranceProvider {
  /** Stable provider identifier, stored alongside any recorded assertion. */
  readonly name: string;
  /** True only for providers that actually verify age with evidence. */
  readonly isRealVerification: boolean;
  /** Begin/perform a check for a user; resolves with the provider's assertion. */
  verify(input: { userId: string; dateOfBirth: string }): Promise<{
    status: "verified" | "failed" | "pending";
    provider: string;
    reference: string | null;
    verifiedAt: string | null;
    expiresAt: string | null;
  }>;
}
