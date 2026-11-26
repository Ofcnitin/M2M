import "./globals.css";
import Link from "next/link";
import type { Metadata } from "next";
import { AuthNav } from "@/components/AuthNav";

export const metadata: Metadata = { title: { default: "M2M", template: "%s · M2M" }, description: "Read and publish independent comics." };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <header className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-5 py-5">
          <Link href="/" className="neu-sm px-4 py-2 text-xl font-bold tracking-tight">M<span className="text-sky">2</span>M</Link>
          <nav className="flex gap-2 overflow-x-auto py-2 text-sm" aria-label="Main">
            {[["/", "Home"], ["/discover", "Discover"], ["/library", "Library"], ["/studio", "Studio"]].map(([h, l]) => <Link key={h} href={h} className="btn">{l}</Link>)}
          </nav>
          <form action="/discover" className="ml-auto flex-1 sm:max-w-xs">
            <input name="q" type="search" placeholder="Search series, creators, tags" aria-label="Search" className="neu-in w-full bg-transparent px-4 py-2.5 text-sm outline-none" />
          </form>
          <AuthNav />
        </header>
        <main className="mx-auto max-w-6xl px-5 pb-24">{children}</main>
        <footer className="mx-auto flex max-w-6xl flex-wrap gap-4 px-5 pb-10 text-xs text-mute">
          <Link href="/privacy" className="underline">Privacy</Link>
          <Link href="/terms" className="underline">Terms</Link>
          <Link href="/copyright" className="underline">Copyright</Link>
          <Link href="/age" className="underline">Mature content (18+)</Link>
        </footer>
      </body>
    </html>
  );
}
