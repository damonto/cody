/** Ignore media-type parameters when deciding whether a body can be observed. */
export function responseFormat(response: Response): "json" | "sse" | undefined {
  const mediaType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType === "text/event-stream") return "sse";
  if (
    mediaType === "application/json" ||
    /^application\/[\w.+-]+\+json$/.test(mediaType ?? "")
  )
    return "json";
  return undefined;
}
