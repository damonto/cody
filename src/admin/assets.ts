import { CONSOLE_PATH } from "./paths.ts";

export async function serveConsoleAsset(
  request: Request,
  assets: Fetcher,
): Promise<Response> {
  const url = new URL(request.url);
  // Vite emits public URLs under /console/, while files live at the asset root.
  url.pathname = url.pathname.slice(CONSOLE_PATH.length) || "/";
  const response = await assets.fetch(new Request(url, request), {
    redirect: "manual",
  });
  const location = response.headers.get("location");
  if (!location) return response;

  // Keep asset canonicalization (for example, /index.html → /) inside Access.
  const target = new URL(location, url);
  if (target.origin !== url.origin) return response;
  const headers = new Headers(response.headers);
  headers.set(
    "location",
    `${CONSOLE_PATH}${target.pathname}${target.search}${target.hash}`,
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
