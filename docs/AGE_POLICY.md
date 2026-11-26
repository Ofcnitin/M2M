# Age Policy — v9 Self-Declaration Model

Status: **implemented model for v9; legal sufficiency UNCONFIRMED (see below).**
Companion docs: `docs/SECURITY.md`, `docs/PRELAUNCH_CHECKLIST.md`.

## The model (v9)

v9 replaces third-party age-assurance **provider verification** (the v8 model:
provider registry, verification sessions/nonces, HMAC-signed provider
callbacks) with **self-declaration**:

1. **Date of birth is collected at registration** and stored on the profile.
   Registration rejects under-13s (database trigger, originally migration
   0015; v9 changes in migrations 0023–0024).
2. **Age is calculated server-side** from the stored date of birth on every
   eligibility decision. No client-supplied age, flag, or cookie is trusted.
3. **Policy acceptance is recorded**: when a user confirms they are 18+ for
   mature content, the acceptance is stored with the **policy version and a
   timestamp**, so the platform can show which version was accepted and when.
4. **DOB changes are admin-only.** A user cannot edit their own date of birth
   to become eligible. An admin DOB change **resets the policy acceptance** —
   the user must accept again before mature access is restored.
5. **DOB access is restricted** by row-level security and the profile guard:
   DOB is not publicly readable, not listed in public profile selects, and
   writes are guarded in the database, not just hidden in the UI.
6. **The cookie is not an authorization signal.** The legacy `m2m_adult`
   cookie is a UX hint only (it may remember that a notice was shown). Forging,
   setting, or deleting it grants nothing; every mature-content decision is
   re-checked server-side per request.
7. Eligibility also still requires: signed-in user, not suspended. Mature
   series are hidden from listings/search for ineligible users, and mature
   chapters, covers, and assets are served only through the gated endpoints
   (`/api/media/[assetId]`, `/api/cover/[seriesId]`) — see `docs/SECURITY.md`.

## What data is stored, and why

| Data | Why |
|---|---|
| Date of birth | Calculate age server-side for the 13+ account minimum and the 18+ mature gate |
| Policy acceptance: version + timestamp (+ the fact of acceptance) | Evidence that the user was shown and accepted the current age/mature-content policy; a DOB change or policy version change can invalidate it |
| Account status (e.g. suspended) | Eligibility must fail for suspended accounts |

M2M does **not** collect or store identity documents, government IDs, or
biometric data for age purposes under this model — there is no provider and
no document check. That is precisely why the legal question below matters:
self-declaration is weaker evidence of age than provider verification.

## Ratings are platform classifications

Content ratings on M2M (e.g. everyone / teen / mature) are **M2M platform
classifications** assigned by creators and adjustable by moderators/admins.
They are **not official Indian statutory ratings** and are not issued or
endorsed by any Indian government body, board, or regulator.

## India legal-review checklist (for qualified Indian counsel)

- [ ] **DPDP Act 2023 — children's data:** obligations for processing personal
  data of children (under 18): verifiable parental/guardian consent, no
  tracking/behavioural monitoring/targeted advertising directed at children,
  data-principal rights, breach notification. Does collecting DOB at
  registration + self-declaration satisfy the consent standard for this
  service? What about users aged 13–17 using the non-mature service?
- [ ] **DPDP Act 2023 — general:** consent notice wording, purpose limitation
  for DOB (age gating only), retention/erasure of DOB and acceptance records,
  grievance redressal for data principals.
- [ ] **IT Act / IT Rules 2021 — intermediary obligations:** due diligence,
  publishing rules/regulations, privacy policy and user agreement, content
  takedown timelines, and appointment/publication of a **Grievance Officer**
  (name and contact details) with acknowledgement/resolution timelines.
- [ ] **Obligations re minors and age-restricted content:** whether any Indian
  law, rule, or regulator guidance requires a stronger age-assurance standard
  than self-declaration for the mature (non-explicit) content category M2M
  allows; consequences of a minor mis-declaring their DOB.
- [ ] **Platform classification:** whether M2M is an **intermediary** or a
  **publisher** (or a significant social media intermediary) for its mix of
  user-published comics and platform curation, and what additional obligations
  follow from that classification (e.g. under the IT Rules 2021 and any
  applicable OTT/digital-media code).
- [ ] Content prohibitions: confirm the launch content policy (mature-rated,
  non-explicit only; no pornography at launch; absolutely no sexual content
  involving minors, CSAM, or non-consensual sexual content) against Indian law
  (IT Act §§67/67A/67B, POCSO, IPC/BNS provisions).
- [ ] Privacy policy, terms of service, and copyright process wording reviewed
  against the above before public launch.

## Blocking statement

> **Whether self-declared age is sufficient for this service and content
> category is UNCONFIRMED pending qualified Indian legal review. Mature
> content must not be enabled publicly until that review is completed.**

Until that review is completed and recorded, the platform may launch with
mature content disabled; the self-declaration machinery must not be presented
to users, partners, or regulators as "age verification".
