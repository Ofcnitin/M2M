const cdn = process.env.NEXT_PUBLIC_CDN_URL ? new URL(process.env.NEXT_PUBLIC_CDN_URL).hostname : undefined;

// Conservative CSP: the app renders no third-party scripts. Supabase (REST +
// realtime websockets) and https: images (CDN media) are allowed explicitly.
// 'unsafe-inline' for script/style is required by Next.js inline bootstrap and
// the Reader's inline <style>; tightening to nonces is a follow-up.
const csp = [
  "default-src 'self'",
  "img-src 'self' data: blob: https:",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https:",
  "font-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: csp },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

export default {
  images: { remotePatterns: cdn ? [{ protocol: "https", hostname: cdn }] : [] },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};
