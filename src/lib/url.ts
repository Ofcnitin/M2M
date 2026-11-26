// Only allow same-site relative paths in ?next= parameters (blocks open redirects such as //evil.com or /\evil.com).
export function safeNext(next: string | null | undefined, fallback = "/"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}
