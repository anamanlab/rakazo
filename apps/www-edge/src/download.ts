/**
 * Redirects to the newest installer so a desktop release needs no site rebuild.
 */
import type { DesktopDownloads } from "@rakazo/www/github";
import { fetchDesktopDownloads } from "@rakazo/www/github";
import { LATEST_RELEASE_URL } from "@rakazo/www/site";

/** Redirects to the newest installer so a desktop release needs no site rebuild. */
export async function fetchDownload(
  request: Request,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const platform = new URL(request.url).searchParams.get("platform");
  const downloads = await fetchDesktopDownloads(fetchImpl);
  const location =
    (platform && Object.hasOwn(downloads, platform)
      ? downloads[platform as keyof DesktopDownloads]
      : undefined) ?? LATEST_RELEASE_URL;
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
    },
  });
}
