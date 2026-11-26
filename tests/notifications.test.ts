import { test } from "node:test";
import assert from "node:assert/strict";
import { describe, type Notif } from "../src/lib/notifications";
import { formatRating, timeAgo } from "../src/lib/format";

const base: Notif = { id: 1, type: "", read_at: null, created_at: "2026-01-01T00:00:00Z", series_id: "sid", chapter_id: null, actor: { display_name: "Mina" }, series: { slug: "moon-ab12", title: "Moon" }, chapters: null };

test("new chapter links to the reader", () => {
  const d = describe({ ...base, type: "new_chapter", chapter_id: "cid", chapters: { chapter_number: "12.50" } });
  assert.equal(d.text, "Moon has a new chapter: Chapter 12.5");
  assert.equal(d.href, "/read/cid");
});
test("comments link to the comment section", () => {
  assert.deepEqual(describe({ ...base, type: "comment_reply" }), { text: "Mina replied to your comment on Moon", href: "/series/moon-ab12#comments" });
  assert.deepEqual(describe({ ...base, type: "series_comment" }), { text: "Mina commented on Moon", href: "/series/moon-ab12#comments" });
});
test("follower and removal", () => {
  assert.equal(describe({ ...base, type: "new_follower" }).text, "Mina started following you");
  assert.equal(describe({ ...base, type: "content_removed" }).href, "/studio/series/sid");
});
test("missing actor or series still renders", () => {
  const d = describe({ ...base, type: "series_comment", actor: null, series: null });
  assert.equal(d.text, "Someone commented on a series");
  assert.equal(d.href, "/");
});
test("unknown type does not throw", () => assert.equal(describe({ ...base, type: "future_thing" }).href, "/notifications"));

test("formatRating", () => {
  assert.equal(formatRating(4.256, 1234), "4.3 (1,234)");
  assert.equal(formatRating(0, 0), "No ratings yet");
  assert.equal(formatRating(null, null), "No ratings yet");
});
test("timeAgo", () => {
  const now = new Date("2026-06-10T12:00:00Z");
  assert.equal(timeAgo("2026-06-10T11:59:40Z", now), "just now");
  assert.equal(timeAgo("2026-06-10T11:15:00Z", now), "45m ago");
  assert.equal(timeAgo("2026-06-10T07:00:00Z", now), "5h ago");
  assert.equal(timeAgo("2026-06-07T12:00:00Z", now), "3d ago");
  assert.match(timeAgo("2026-01-01T12:00:00Z", now), /2026/);
  assert.equal(timeAgo("2026-06-10T13:00:00Z", now), "just now"); // clock skew never goes negative
});

test("contributor invite links to the studio", () => {
  const d = describe({ ...base, type: "contributor_invite" });
  assert.equal(d.text, "Mina invited you to contribute to Moon");
  assert.equal(d.href, "/studio");
});
