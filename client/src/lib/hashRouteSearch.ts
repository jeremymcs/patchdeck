export type InitialHashRouteNormalization = {
  href: string;
  anchorId: string | null;
};

export function normalizeHashRouteSearch(href: string): string | null {
  const url = new URL(href);
  const rawHash = url.hash;
  const qIdx = rawHash.indexOf("?");

  if (qIdx === -1) {
    return null;
  }

  const searchParams = new URLSearchParams(url.search);
  const hashParams = new URLSearchParams(rawHash.slice(qIdx));

  hashParams.forEach((value, key) => {
    searchParams.set(key.toLowerCase(), value);
  });

  url.hash = rawHash.slice(0, qIdx);
  url.search = searchParams.toString();

  return url.href;
}

export function normalizeInitialHashRoute(href: string): InitialHashRouteNormalization | null {
  const normalizedSearchHref = normalizeHashRouteSearch(href);
  const url = new URL(normalizedSearchHref ?? href);
  const rawHash = url.hash;

  if (!rawHash || rawHash.startsWith("#/")) {
    return normalizedSearchHref ? { href: normalizedSearchHref, anchorId: null } : null;
  }

  url.hash = "#/";

  return {
    href: url.href,
    anchorId: decodeURIComponent(rawHash.slice(1)),
  };
}
