function bytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function base64(value: Uint8Array): string {
  let text = "";
  for (let offset = 0; offset < value.length; offset += 8192) {
    text += String.fromCharCode(...value.subarray(offset, offset + 8192));
  }
  return btoa(text);
}

async function key(secret: string): Promise<CryptoKey> {
  let material: Uint8Array<ArrayBuffer>;
  try {
    material = bytes(secret);
  } catch {
    throw new Error(
      "CONFIG_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    );
  }
  if (material.byteLength !== 32)
    throw new Error(
      "CONFIG_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    );
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptConfig(
  value: unknown,
  secret: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await key(secret),
    encoded,
  );
  return JSON.stringify({
    version: 1,
    iv: base64(iv),
    data: base64(new Uint8Array(ciphertext)),
  });
}

export async function decryptConfig(
  payload: string,
  secret: string,
): Promise<unknown> {
  const envelope = JSON.parse(payload) as {
    version: number;
    iv: string;
    data: string;
  };
  if (envelope.version !== 1)
    throw new Error("Unsupported encrypted configuration version");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes(envelope.iv) },
    await key(secret),
    bytes(envelope.data),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
}
