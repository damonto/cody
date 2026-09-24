/**
 * A `101 Switching Protocols` response carrying a WebSocket peer. Workers
 * accept this natively. Standard runtimes reject status 101 in the Response
 * constructor, so the upgrade is described by overriding the status fields;
 * only this codebase and the Node upgrade bridge ever read such a response.
 */
export function webSocketUpgradeResponse(
  webSocket: WebSocket,
  headers?: HeadersInit,
): Response {
  try {
    return new Response(null, {
      status: 101,
      webSocket,
      ...(headers === undefined ? {} : { headers }),
    });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
  const response = new Response(null, {
    status: 200,
    ...(headers === undefined ? {} : { headers }),
  });
  Object.defineProperties(response, {
    status: { value: 101 },
    statusText: { value: "Switching Protocols" },
    ok: { value: false },
    webSocket: { value: webSocket },
  });
  return response;
}
