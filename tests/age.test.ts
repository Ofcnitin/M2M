import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateAge, parseDateOfBirth, meetsMinimumRegistrationAge,
  decideMatureEligibility, minimumAgeForRating, sanitizeContentWarnings,
  CONTENT_WARNINGS, CONTENT_WARNING_VALUES,
} from "../src/lib/age-core";
import { CURRENT_AGE_POLICY_VERSION } from "../src/lib/age-policy";

const NOW = new Date("2026-06-15T12:00:00Z");
const base = { signedIn: true, currentPolicyVersion: CURRENT_AGE_POLICY_VERSION, now: NOW };
const ACCEPTED_AT = "2026-06-01T00:00:00Z";
// Adult who has declared: DOB proves 26, acceptance recorded for the current version.
const adult = {
  dateOfBirth: "2000-01-01",
  suspended: false,
  agePolicyVersion: CURRENT_AGE_POLICY_VERSION,
  agePolicyAcceptedAt: ACCEPTED_AT,
};

test("calculateAge handles birthdays correctly", () => {
  assert.equal(calculateAge(new Date("2000-06-15T00:00:00Z"), NOW), 26);
  assert.equal(calculateAge(new Date("2000-06-16T00:00:00Z"), NOW), 25);
  assert.equal(calculateAge(new Date("2008-06-15T00:00:00Z"), NOW), 18);
  assert.equal(calculateAge(new Date("2008-06-16T00:00:00Z"), NOW), 17);
});

test("parseDateOfBirth rejects invalid, future and rolled-over dates", () => {
  assert.ok(parseDateOfBirth("1990-05-01", NOW));
  assert.equal(parseDateOfBirth("2000-02-31", NOW), null);
  assert.equal(parseDateOfBirth("2999-01-01", NOW), null);
  assert.equal(parseDateOfBirth("15/06/2000", NOW), null);
  assert.equal(parseDateOfBirth("", NOW), null);
  assert.equal(parseDateOfBirth(null, NOW), null);
  assert.equal(parseDateOfBirth(20000101, NOW), null);
});

test("registration requires 13+", () => {
  assert.equal(meetsMinimumRegistrationAge("2013-06-15", NOW), true); // exactly 13
  assert.equal(meetsMinimumRegistrationAge("2013-06-16", NOW), false);
  assert.equal(meetsMinimumRegistrationAge(null, NOW), false);
  assert.equal(meetsMinimumRegistrationAge("garbage", NOW), false);
});

test("eligible adult: signed in, 18+, current-version acceptance recorded", () => {
  const d = decideMatureEligibility(adult, base);
  assert.equal(d.canAccessMature, true);
  assert.equal(d.reason, "eligible");
  assert.equal(d.age, 26);
});

test("guest / signed-out is denied", () => {
  assert.equal(decideMatureEligibility(null, { ...base, signedIn: false }).reason, "not_signed_in");
  assert.equal(decideMatureEligibility(adult, { ...base, signedIn: false }).canAccessMature, false);
  assert.equal(decideMatureEligibility(null, base).reason, "not_signed_in");
});

test("suspended users are denied, even with an acceptance", () => {
  const d = decideMatureEligibility({ ...adult, suspended: true }, base);
  assert.equal(d.canAccessMature, false);
  assert.equal(d.reason, "suspended");
});

test("missing DOB is denied", () => {
  const d = decideMatureEligibility({ ...adult, dateOfBirth: null }, base);
  assert.equal(d.canAccessMature, false);
  assert.equal(d.reason, "no_date_of_birth");
});

test("under-18 is denied even with a current-version acceptance", () => {
  const d = decideMatureEligibility({ ...adult, dateOfBirth: "2012-01-01" }, base);
  assert.equal(d.canAccessMature, false);
  assert.equal(d.reason, "under_18");
});

test("adult without any acceptance is denied (policy_not_accepted)", () => {
  const d = decideMatureEligibility({ ...adult, agePolicyVersion: null, agePolicyAcceptedAt: null }, base);
  assert.equal(d.canAccessMature, false);
  assert.equal(d.reason, "policy_not_accepted");
});

test("adult with a version but no acceptance timestamp is denied", () => {
  const d = decideMatureEligibility({ ...adult, agePolicyAcceptedAt: null }, base);
  assert.equal(d.canAccessMature, false);
  assert.equal(d.reason, "policy_not_accepted");
});

test("adult with a stale policy version acceptance is denied", () => {
  const d = decideMatureEligibility({ ...adult, agePolicyVersion: "2025-01-v0" }, base);
  assert.equal(d.canAccessMature, false);
  assert.equal(d.reason, "policy_not_accepted");
});

test("adult with an invalid acceptance timestamp is denied", () => {
  const d = decideMatureEligibility({ ...adult, agePolicyAcceptedAt: "not-a-date" }, base);
  assert.equal(d.canAccessMature, false);
  assert.equal(d.reason, "policy_not_accepted");
});

test("exactly 18 on the day is eligible with acceptance; day before is not", () => {
  assert.equal(decideMatureEligibility({ ...adult, dateOfBirth: "2008-06-15" }, base).canAccessMature, true);
  assert.equal(decideMatureEligibility({ ...adult, dateOfBirth: "2008-06-16" }, base).reason, "under_18");
});

test("cookie/forgery irrelevance: the decision takes no cookie or client flag input", () => {
  // decideMatureEligibility's options are only { signedIn, currentPolicyVersion, now }
  // and the profile is the only evidence. An adult profile WITHOUT a recorded
  // acceptance is denied no matter what a client might claim elsewhere — there is
  // simply no parameter through which a forged cookie/flag could be passed.
  const d = decideMatureEligibility(
    { dateOfBirth: "2000-01-01", suspended: false, agePolicyVersion: null, agePolicyAcceptedAt: null },
    { signedIn: true, currentPolicyVersion: CURRENT_AGE_POLICY_VERSION, now: NOW },
  );
  assert.equal(d.canAccessMature, false);
  assert.equal(d.reason, "policy_not_accepted");
  assert.deepEqual(Object.keys(base).sort(), ["currentPolicyVersion", "now", "signedIn"]);
});

test("rating minimum ages; unknown ratings are restricted", () => {
  assert.equal(minimumAgeForRating("everyone"), 0);
  assert.equal(minimumAgeForRating("teen"), 13);
  assert.equal(minimumAgeForRating("mature"), 18);
  assert.equal(minimumAgeForRating("bogus"), 18);
  assert.equal(minimumAgeForRating(null), 18);
});

test("CONTENT_WARNINGS contains exactly the 10 v9 values with their labels", () => {
  assert.deepEqual(
    CONTENT_WARNINGS.map((w) => [w.value, w.label]),
    [
      ["violence", "Violence"],
      ["graphic_violence", "Graphic violence"],
      ["gore", "Gore"],
      ["nudity", "Nudity"],
      ["strong_language", "Strong language"],
      ["sexual_themes", "Sexual themes"],
      ["psychological", "Psychological themes"],
      ["substance_use", "Substance use"],
      ["disturbing_imagery", "Disturbing imagery"],
      ["other", "Other sensitive themes"],
    ],
  );
  assert.equal(CONTENT_WARNING_VALUES.length, 10);
});

test("content warnings are sanitized to the allowed set", () => {
  assert.deepEqual(sanitizeContentWarnings(["violence", "gore", "violence", "hax"]), ["violence", "gore"]);
  assert.deepEqual(
    sanitizeContentWarnings(["graphic_violence", "sexual_themes", "substance_use", "disturbing_imagery", "bogus"]),
    ["graphic_violence", "sexual_themes", "substance_use", "disturbing_imagery"],
  );
  assert.deepEqual(sanitizeContentWarnings("violence"), []);
  assert.deepEqual(sanitizeContentWarnings(null), []);
});
