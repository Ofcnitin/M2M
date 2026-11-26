export type Notif = {
  id: number; type: string; read_at: string | null; created_at: string;
  series_id: string | null; chapter_id: string | null;
  actor: { display_name: string } | null;
  series: { slug: string; title: string } | null;
  chapters: { chapter_number: number | string } | null;
};

// Turns a notification row into display text and a link. Unknown types still render so old clients never break.
export function describe(n: Notif): { text: string; href: string } {
  const who = n.actor?.display_name ?? "Someone";
  const title = n.series?.title ?? "a series";
  const slug = n.series?.slug;
  switch (n.type) {
    case "new_chapter":
      return { text: `${title} has a new chapter: Chapter ${Number(n.chapters?.chapter_number ?? 0)}`, href: n.chapter_id ? `/read/${n.chapter_id}` : slug ? `/series/${slug}` : "/" };
    case "comment_reply":
      return { text: `${who} replied to your comment on ${title}`, href: slug ? `/series/${slug}#comments` : "/" };
    case "series_comment":
      return { text: `${who} commented on ${title}`, href: slug ? `/series/${slug}#comments` : "/" };
    case "new_follower":
      return { text: `${who} started following you`, href: "/studio/analytics" };
    case "contributor_invite":
      return { text: `${who} invited you to contribute to ${title}`, href: "/studio" };
    case "content_removed":
      return { text: `${title} was removed by moderators`, href: n.series_id ? `/studio/series/${n.series_id}` : "/studio" };
    default:
      return { text: "You have a new notification", href: "/notifications" };
  }
}
