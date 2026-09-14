export const SESSION_AFFINITY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_AFFINITY_INDEX_MAX_PAGE_SIZE = 1000;

interface AffinityCredentialCandidate {
  credential_id: string;
  priority: number;
}

export interface AffinityProviderCandidate {
  provider_id: string;
  priority: number;
  credentials: AffinityCredentialCandidate[];
  supports_context_management?: boolean;
}

export interface SessionAffinityRecord {
  provider_id: string;
  credential_id: string;
  updated_at: number;
  binding_id: string;
  created_at: number;
  generation: number;
  registry_name: string;
  session_digest: string;
  session_id: string;
  index_registered: boolean;
  context_management?: boolean;
}

export interface SessionAffinityResolution extends SessionAffinityRecord {
  status: "hit" | "created" | "rebound" | "blocked";
}

export interface AffinitySelection {
  provider_id: string;
  credential_id: string;
}

export interface SessionAffinityRegistration {
  registry_name: string;
  session_digest: string;
  session_id: string;
}

export interface SessionAffinityIdentity extends SessionAffinityRegistration {
  object_name: string;
}

export interface StoredAffinityDecision {
  // Always present, possibly undefined: every caller computes a candidate that
  // may not exist rather than omitting the field.
  selection: AffinitySelection | undefined;
  status: "hit" | "rebound";
}

export function chooseAffinityCandidate(
  candidates: AffinityProviderCandidate[],
): AffinitySelection | undefined {
  const usableProviders = candidates.filter(
    (candidate) => candidate.credentials.length > 0,
  );
  if (usableProviders.length === 0) {
    return undefined;
  }
  const providerPriority = Math.max(
    ...usableProviders.map((candidate) => candidate.priority),
  );
  const provider = usableProviders.find(
    (candidate) => candidate.priority === providerPriority,
  );
  if (!provider) {
    return undefined;
  }
  const credentialPriority = Math.max(
    ...provider.credentials.map((credential) => credential.priority),
  );
  const credential = provider.credentials.find(
    (candidate) => candidate.priority === credentialPriority,
  );
  return credential
    ? {
        provider_id: provider.provider_id,
        credential_id: credential.credential_id,
      }
    : undefined;
}

export function affinitySelectionIsHighestPriority(
  selection: AffinitySelection | undefined,
  candidates: AffinityProviderCandidate[],
): selection is AffinitySelection {
  if (!selection) {
    return false;
  }
  const provider = candidates.find(
    (candidate) =>
      candidate.provider_id === selection.provider_id &&
      candidate.credentials.length > 0,
  );
  if (!provider) {
    return false;
  }
  const highestProviderPriority = Math.max(
    ...candidates
      .filter((candidate) => candidate.credentials.length > 0)
      .map((candidate) => candidate.priority),
  );
  if (provider.priority !== highestProviderPriority) {
    return false;
  }
  const credential = provider.credentials.find(
    (candidate) => candidate.credential_id === selection.credential_id,
  );
  if (!credential) {
    return false;
  }
  const highestCredentialPriority = Math.max(
    ...provider.credentials.map((candidate) => candidate.priority),
  );
  return credential.priority === highestCredentialPriority;
}

function choosePreferredCandidate(
  candidates: AffinityProviderCandidate[],
  preferred: AffinitySelection | undefined,
): AffinitySelection | undefined {
  return affinitySelectionIsHighestPriority(preferred, candidates)
    ? preferred
    : chooseAffinityCandidate(candidates);
}

function choosePreferredCredential(
  provider: AffinityProviderCandidate,
  preferred: AffinitySelection | undefined,
): AffinitySelection | undefined {
  const highestCredentialPriority = Math.max(
    ...provider.credentials.map((candidate) => candidate.priority),
  );
  const preferredCredential =
    preferred?.provider_id === provider.provider_id
      ? provider.credentials.find(
          (candidate) => candidate.credential_id === preferred.credential_id,
        )
      : undefined;
  return preferredCredential?.priority === highestCredentialPriority
    ? preferred
    : chooseAffinityCandidate([provider]);
}

export function resolveStoredAffinity(
  record: SessionAffinityRecord,
  candidates: AffinityProviderCandidate[],
  preferred?: AffinitySelection,
): StoredAffinityDecision {
  const fallback = (): AffinitySelection | undefined =>
    choosePreferredCandidate(candidates, preferred);
  const provider = candidates.find(
    (candidate) => candidate.provider_id === record.provider_id,
  );
  const credential = provider?.credentials.find(
    (candidate) => candidate.credential_id === record.credential_id,
  );
  if (!provider || !credential) {
    return { selection: fallback(), status: "rebound" };
  }

  const usableProviders = candidates.filter(
    (candidate) => candidate.credentials.length > 0,
  );
  const highestProviderPriority = Math.max(
    ...usableProviders.map((candidate) => candidate.priority),
  );
  if (provider.priority < highestProviderPriority) {
    return { selection: fallback(), status: "rebound" };
  }

  const highestCredentialPriority = Math.max(
    ...provider.credentials.map((candidate) => candidate.priority),
  );
  if (credential.priority < highestCredentialPriority) {
    return {
      selection: choosePreferredCredential(provider, preferred),
      status: "rebound",
    };
  }

  return {
    selection: {
      provider_id: record.provider_id,
      credential_id: record.credential_id,
    },
    status: "hit",
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function affinityObjectNameFromDigests(
  registryName: string,
  sessionDigest: string,
): string {
  return `${registryName}:${sessionDigest}`;
}

export function affinityRegistryName(clientId: string): Promise<string> {
  return sha256Hex(clientId);
}

function affinitySessionDigest(sessionId: string): Promise<string> {
  return sha256Hex(sessionId);
}

export async function sessionAffinityIdentity(
  clientId: string,
  sessionId: string,
): Promise<SessionAffinityIdentity> {
  const [registryName, sessionDigest] = await Promise.all([
    affinityRegistryName(clientId),
    affinitySessionDigest(sessionId),
  ]);
  return {
    registry_name: registryName,
    session_digest: sessionDigest,
    session_id: sessionId,
    object_name: affinityObjectNameFromDigests(registryName, sessionDigest),
  };
}

export async function affinityObjectName(
  clientId: string,
  sessionId: string,
): Promise<string> {
  return (await sessionAffinityIdentity(clientId, sessionId)).object_name;
}
