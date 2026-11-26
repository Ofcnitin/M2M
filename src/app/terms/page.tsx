export const metadata = { title: "Terms of service" };
export default function Terms() {
  return (
    <section className="neu mx-auto mt-6 max-w-2xl p-8">
      <h1 className="text-2xl font-bold">Terms of service</h1>
      <p className="mt-3 rounded bg-yellow-100 p-3 text-sm text-black"><strong>Draft — needs legal review before public launch.</strong> This page is a placeholder summary, not legal advice and not complete terms.</p>
      <div className="mt-4 grid gap-3 text-sm leading-relaxed">
        <p>You must be 13 or older to hold an M2M account. Mature (18+) content is restricted to adults: access is based on the date of birth you declare at registration (your age is calculated on our servers) together with your recorded acceptance of our age and mature-content policy — this is an age confirmation based on self-declared age, not identity verification. Declaring a false date of birth to access age-restricted content is a breach of these terms. Content ratings on M2M are platform classifications set by creators and moderators, not official statutory ratings. Explicit pornography is not permitted at launch; sexual content involving minors, child sexual abuse material and non-consensual sexual content are strictly prohibited and will be removed, with accounts suspended.</p>
        <p>Creators may publish only work they own or are licensed to publish, must classify it with an accurate content rating and content warnings, and accept the publishing terms version recorded at onboarding. Misclassification may lead to re-rating, restriction or removal by moderators, recorded in the audit log, with an appeal route through the copyright/moderation process.</p>
        <p>Copyright complaints can be submitted through the <a className="underline" href="/copyright">copyright page</a>. Deadlines and notice wording in that process require legal review for the operator&apos;s jurisdiction before launch.</p>
      </div>
    </section>
  );
}
