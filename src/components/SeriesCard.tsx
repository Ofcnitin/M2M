import Link from "next/link";
import { coverUrlForSeries } from "@/lib/cdn";

export type SeriesCardData = {
  id?: string | null;
  slug: string; title: string; cover_url: string | null; content_format: string;
  content_rating?: string; rating_avg?: number | string | null; rating_count?: number | null;
  profiles: { display_name: string } | null;
};

export function SeriesCard({ s }: { s: SeriesCardData }) {
  const rated = (s.rating_count ?? 0) > 0;
  return (
    <Link href={`/series/${s.slug}`} className="neu block p-2.5 transition-shadow">
      <div className="relative aspect-[3/4] overflow-hidden rounded-2xl bg-wash">
        {s.cover_url && /* eslint-disable-next-line @next/next/no-img-element */
          <img src={coverUrlForSeries(s) ?? ""} alt="" loading="lazy" className="h-full w-full object-cover" />}
        {s.content_rating === "mature" && <span className="absolute left-2 top-2 rounded-full bg-black/75 px-2 py-0.5 text-[11px] font-semibold text-white">18+</span>}
      </div>
      <h3 className="mt-2.5 truncate px-1 text-sm font-semibold">{s.title}</h3>
      <p className="truncate px-1 pb-1 text-xs text-mute">
        {s.profiles?.display_name} · {s.content_format}{rated && <> · <span aria-label={`Rated ${Number(s.rating_avg).toFixed(1)} out of 5`}>★ {Number(s.rating_avg).toFixed(1)}</span></>}
      </p>
    </Link>
  );
}
