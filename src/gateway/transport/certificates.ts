import {
  BasicConstraintsExtension,
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  SubjectAlternativeNameExtension,
  X509Certificate,
} from "@peculiar/x509";
import {
  loadX509FromPem,
  MOZILLA_ROOT_CA_LIST,
  type X509Certificate as TlsCertificate,
} from "@reclaimprotocol/tls";
import { isIP } from "node:net";

type PeerCertificate = TlsCertificate<unknown>;
let publicRoots: readonly PeerCertificate[] | undefined;
const SUPPORTED_CRITICAL_EXTENSIONS = new Set([
  "2.5.29.14", // Subject key identifier
  "2.5.29.15", // Key usage
  "2.5.29.17", // Subject alternative name
  "2.5.29.19", // Basic constraints
  "2.5.29.35", // Authority key identifier
  "2.5.29.37", // Extended key usage
]);

function invalid(): never {
  throw new Error("Upstream TLS certificate validation failed");
}

function matchesDns(host: string, name: string): boolean {
  const pattern = name.toLowerCase();
  if (!pattern.includes("*")) {
    return host === pattern;
  }
  const labels = host.split(".");
  const expected = pattern.split(".");
  return (
    expected.length >= 3 &&
    expected[0] === "*" &&
    labels.length === expected.length &&
    labels.slice(1).join(".") === expected.slice(1).join(".")
  );
}

/** Add SAN, CA, path-length and usage checks to the TLS library's signature/chain verification. */
export function validatePeerCertificates(
  chain: readonly PeerCertificate[],
  hostname: string,
  additionalRoots: readonly PeerCertificate[] = [],
): void {
  if (!chain.length || chain.length > 16) {
    invalid();
  }
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const leaf = new X509Certificate(chain[0].serialiseToPem());
  const names =
    leaf.getExtension(SubjectAlternativeNameExtension)?.names.items ?? [];
  const ip = isIP(host);
  const matched = names.some((name) => {
    if (!ip) {
      return name.type === "dns" && matchesDns(host, name.value);
    }
    if (name.type !== "ip") {
      return false;
    }
    if (ip === 4) {
      return host === name.value;
    }
    try {
      return (
        new URL(`http://[${host}]/`).hostname ===
        new URL(`http://[${name.value}]/`).hostname
      );
    } catch {
      return false;
    }
  });
  if (!matched) {
    invalid();
  }
  publicRoots ??= MOZILLA_ROOT_CA_LIST.map(loadX509FromPem);
  const roots = [...publicRoots, ...additionalRoots];
  const remaining = chain.slice(1);
  let current = chain[0];
  let trusted = false;
  for (let depth = 0; depth <= 16; depth += 1) {
    const certificate = new X509Certificate(current.serialiseToPem());
    if (!current.isWithinValidity()) {
      invalid();
    }
    for (const extension of certificate.extensions) {
      // Do not silently ignore constraints this adapter cannot enforce.
      if (
        extension.type === "2.5.29.30" ||
        (extension.critical &&
          !SUPPORTED_CRITICAL_EXTENSIONS.has(extension.type))
      ) {
        invalid();
      }
    }
    const usages = certificate.getExtension(KeyUsagesExtension)?.usages;
    if (
      usages !== undefined &&
      !(
        usages &
        (depth ? KeyUsageFlags.keyCertSign : KeyUsageFlags.digitalSignature)
      )
    ) {
      invalid();
    }
    const extended = certificate.getExtension(
      ExtendedKeyUsageExtension,
    )?.usages;
    if (
      extended &&
      !extended.includes("1.3.6.1.5.5.7.3.1") &&
      !extended.includes("2.5.29.37.0")
    ) {
      invalid();
    }
    if (depth) {
      const constraints = certificate.getExtension(BasicConstraintsExtension);
      if (
        !constraints?.ca ||
        (constraints.pathLength !== undefined &&
          depth - 1 > constraints.pathLength)
      ) {
        invalid();
      }
    }
    if (trusted) {
      return;
    }
    const root = roots.find((issuer) => issuer.isIssuer(current));
    const issuer =
      root ?? remaining.find((candidate) => candidate.isIssuer(current));
    if (!issuer) {
      invalid();
    }
    if (!root) {
      remaining.splice(remaining.indexOf(issuer), 1);
    }
    current = issuer;
    trusted = !!root;
  }
  invalid();
}
