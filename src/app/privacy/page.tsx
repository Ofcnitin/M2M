export const metadata = { title: "Privacy policy" };
export default function Privacy() {
  return (
    <section className="neu mx-auto mt-6 max-w-2xl p-8">
      <h1 className="text-2xl font-bold">Privacy policy</h1>
      <p className="mt-3 rounded bg-yellow-100 p-3 text-sm text-black"><strong>Draft — needs legal review before public launch.</strong> This page is a placeholder summary, not legal advice and not a complete privacy policy.</p>
      <div className="mt-4 grid gap-3 text-sm leading-relaxed">
        <p>M2M stores the account details you provide (username, display name, email via our auth provider, and date of birth used for age eligibility), the comics and images you publish, your library, reading progress, comments, ratings and follows.</p>
        <p>Date of birth is used to calculate age eligibility for mature (18+) content. M2M uses self-declared age: we calculate your age on our servers from the date of birth you give at registration, and we record when you accept our age and mature-content policy (including the policy version and the time of acceptance). We do not use an external age-verification provider and we do not store identity documents or biometric data. You cannot change your own date of birth; corrections are handled by an administrator, and a change resets your policy acceptance.</p>
        <p>Analytics use a daily-rotating hash of network identifiers; raw IP addresses are not stored in analytics events. Media files are stored with our storage provider (Cloudflare R2); restricted media is delivered only through short-lived signed links after an eligibility check.</p>
        <p>To request access to, correction of, or deletion of your personal data, contact the platform operator. Account deletion and data-export procedures must be confirmed by the operator before launch.</p>
      </div>
    </section>
  );
}
