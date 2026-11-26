// Discovery listing preferences (v9, workstream B).
//
// Two DIFFERENT mature-content rules exist on M2M, and they must not be conflated:
//
//   * DIRECT ACCESS (series page, reader, media/cover APIs): eligibility ONLY.
//     A verified 18+ user (canAccessMature / getMatureEligibility in "@/lib/age") may
//     open a mature series they navigate to directly, regardless of preferences.
//     Those pages do NOT use this module.
//
//   * DISCOVERY LISTINGS (home shelves, discover/search, creator series lists):
//     mature series appear only when the user is eligible AND has opted in via the
//     profiles.show_mature_content preference ("Show Mature 18+ series in discovery
//     and search"). Eligibility alone is not enough to surface mature series in
//     listings, and the preference alone never grants access to anything.
//
// On top of that, a signed-in user can hide whole warning themes from their listings
// via profiles.excluded_warnings, applied in memory with filterExcludedWarnings().
//
// The two pure helpers below are unit-tested in tests/discovery.test.ts.

import { canAccessMature, type SupabaseLike } from "@/lib/age";

/** Mature series may appear in a discovery listing only for an eligible user who opted in. */
export function matureVisibleInDiscovery(eligible: boolean, showMaturePref: boolean): boolean {
  return eligible && showMaturePref;
}

/**
 * Remove rows that carry ANY warning the user excluded. Rows with missing/null/empty
 * content_warnings are kept (nothing to exclude them by). An empty `excluded` list
 * returns the rows unchanged.
 */
export function filterExcludedWarnings<T extends { content_warnings?: string[] | null }>(rows: T[], excluded: string[]): T[] {
  if (!excluded?.length) return rows;
  const blocked = new Set(excluded);
  return rows.filter((r) => !(r.content_warnings ?? []).some((w) => blocked.has(w)));
}

export type DiscoveryPrefs = {
  /** Raw mature eligibility (verified 18+) — the DIRECT-access rule, unmodified. */
  eligible: boolean;
  /** The user's show_mature_content opt-in preference. */
  showMature: boolean;
  /** The user's excluded_warnings preference. */
  excludedWarnings: string[];
};

const GUEST_PREFS: DiscoveryPrefs = { eligible: false, showMature: false, excludedWarnings: [] };

/**
 * Server helper for listing pages: the signed-in user's eligibility + discovery
 * preferences. Guests (and any lookup failure) fail closed to GUEST_PREFS.
 * `sb` is the RLS Supabase server client, typed via age.ts's SupabaseLike.
 */
export async function getDiscoveryPrefs(sb: SupabaseLike): Promise<DiscoveryPrefs> {
  try {
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return { ...GUEST_PREFS };
    const eligible = await canAccessMature(sb);
    const { data } = await sb.from("profiles")
      .select("show_mature_content,excluded_warnings")
      .eq("id", user.id).maybeSingle();
    const row = data as unknown as { show_mature_content?: boolean | null; excluded_warnings?: string[] | null } | null;
    return {
      eligible,
      showMature: row?.show_mature_content === true,
      excludedWarnings: Array.isArray(row?.excluded_warnings) ? row.excluded_warnings : [],
    };
  } catch {
    return { ...GUEST_PREFS };
  }
}
