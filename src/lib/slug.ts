export const slugify = (t: string) =>
  t.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) + "-" + Math.random().toString(36).slice(2, 6);
