import Link from "next/link";
import { tagHref } from "@/lib/tags";

export function TagList({ genres, tags }: { genres?: { name: string; slug: string }[]; tags?: string[] }) {
  if (!genres?.length && !tags?.length) return null;
  const chip = "neu-sm px-3 py-1 text-xs";
  return (
    <ul className="mt-4 flex flex-wrap gap-2" aria-label="Genres and tags">
      {genres?.map((g) => <li key={g.slug}><Link href={`/discover?genre=${g.slug}`} className={`${chip} font-semibold`}>{g.name}</Link></li>)}
      {tags?.map((t) => <li key={t}><Link href={tagHref(t)} className={chip}>#{t}</Link></li>)}
    </ul>
  );
}
