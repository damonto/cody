import { object, text } from "./json.ts";

/** Only inspect upstream error envelopes, never generated content or tool arguments. */
export function xaiErrorDetails(value: unknown) {
  const root = object(value);
  const envelopes = [root, object(root.response), object(root.body)];
  const codes = envelopes
    .flatMap((entry) => [text(entry.code), text(object(entry.error).code)])
    .filter(Boolean);
  const messages = envelopes
    .flatMap((entry) => [
      text(entry.error),
      text(object(entry.error).message),
      text(entry.message),
    ])
    .filter(Boolean);
  return { code: codes[0] ?? "", message: messages[0] ?? "", codes, messages };
}

export function xaiBadCredentials(value: unknown): boolean {
  const { codes, messages } = xaiErrorDetails(value);
  return (
    codes.some((code) => code.toLowerCase().includes("bad-credentials")) ||
    messages.some((message) =>
      message.toLowerCase().includes("access token could not be validated"),
    )
  );
}
