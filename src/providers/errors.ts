export class ProviderRequestError extends Error {
  override name = "ProviderRequestError";
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "invalid_provider_request",
    readonly param?: string,
  ) {
    super(message);
  }
}
