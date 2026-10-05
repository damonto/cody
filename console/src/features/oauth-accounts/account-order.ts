import type { OAuthProviderConfig } from "../../../../src/config/types";

/** Toggles one account without opening its editor. */
export function setAccountDisabled<Provider extends OAuthProviderConfig>(
  provider: Provider,
  id: string,
  disabled: boolean,
): Provider {
  return {
    ...provider,
    credentials: provider.credentials.map((credential) =>
      credential.id === id ? { ...credential, disabled } : credential,
    ),
  };
}

export function moveAccount<Provider extends OAuthProviderConfig>(
  provider: Provider,
  id: string,
  direction: -1 | 1,
): Provider {
  const index = provider.credentials.findIndex(
    (credential) => credential.id === id,
  );
  const target = index + direction;
  if (index < 0 || target < 0 || target >= provider.credentials.length)
    return provider;
  const credentials = [...provider.credentials];
  [credentials[index], credentials[target]] = [
    credentials[target],
    credentials[index],
  ];
  return { ...provider, credentials };
}
