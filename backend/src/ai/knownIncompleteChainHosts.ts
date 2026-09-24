// Official sites that serve their leaf certificate without the issuing
// intermediate. Browsers repair the chain through AIA fetching; Node's fetch
// does not, so the citation validator fails with
// UNABLE_TO_VERIFY_LEAF_SIGNATURE and every record citing the host is dropped.
// We complete the chain ourselves with the public intermediate, verified
// against the system roots, instead of disabling verification (same approach
// as alabamaFcpaTls.ts and northDakotaCfrsClient.ts).

import { readFileSync } from "node:fs";
import tls from "node:tls";

// Go Daddy Secure Certificate Authority - G2: issuer of the *.cga.ct.gov leaf
// (Connecticut General Assembly). Downloaded 2026-09-24 from GoDaddy's official
// repository (https://certs.godaddy.com/repository/gdig2.crt.pem), chains to
// the "Go Daddy Root Certificate Authority - G2" root in Node's bundle.
// SHA-256 fingerprint
// 97:3A:41:27:6F:FD:01:E0:27:A2:AA:D4:9E:34:C3:78:46:D3:E9:76:FF:6A:62:0B:67:12:E3:38:32:04:1A:A6.
// Expires 2031-05-03.
export const GODADDY_SECURE_CA_G2_PEM = `-----BEGIN CERTIFICATE-----
MIIE0DCCA7igAwIBAgIBBzANBgkqhkiG9w0BAQsFADCBgzELMAkGA1UEBhMCVVMx
EDAOBgNVBAgTB0FyaXpvbmExEzARBgNVBAcTClNjb3R0c2RhbGUxGjAYBgNVBAoT
EUdvRGFkZHkuY29tLCBJbmMuMTEwLwYDVQQDEyhHbyBEYWRkeSBSb290IENlcnRp
ZmljYXRlIEF1dGhvcml0eSAtIEcyMB4XDTExMDUwMzA3MDAwMFoXDTMxMDUwMzA3
MDAwMFowgbQxCzAJBgNVBAYTAlVTMRAwDgYDVQQIEwdBcml6b25hMRMwEQYDVQQH
EwpTY290dHNkYWxlMRowGAYDVQQKExFHb0RhZGR5LmNvbSwgSW5jLjEtMCsGA1UE
CxMkaHR0cDovL2NlcnRzLmdvZGFkZHkuY29tL3JlcG9zaXRvcnkvMTMwMQYDVQQD
EypHbyBEYWRkeSBTZWN1cmUgQ2VydGlmaWNhdGUgQXV0aG9yaXR5IC0gRzIwggEi
MA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC54MsQ1K92vdSTYuswZLiBCGzD
BNliF44v/z5lz4/OYuY8UhzaFkVLVat4a2ODYpDOD2lsmcgaFItMzEUz6ojcnqOv
K/6AYZ15V8TPLvQ/MDxdR/yaFrzDN5ZBUY4RS1T4KL7QjL7wMDge87Am+GZHY23e
cSZHjzhHU9FGHbTj3ADqRay9vHHZqm8A29vNMDp5T19MR/gd71vCxJ1gO7GyQ5HY
pDNO6rPWJ0+tJYqlxvTV0KaudAVkV4i1RFXULSo6Pvi4vekyCgKUZMQWOlDxSq7n
eTOvDCAHf+jfBDnCaQJsY1L6d8EbyHSHyLmTGFBUNUtpTrw700kuH9zB0lL7AgMB
AAGjggEaMIIBFjAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAdBgNV
HQ4EFgQUQMK9J47MNIMwojPX+2yz8LQsgM4wHwYDVR0jBBgwFoAUOpqFBxBnKLbv
9r0FQW4gwZTaD94wNAYIKwYBBQUHAQEEKDAmMCQGCCsGAQUFBzABhhhodHRwOi8v
b2NzcC5nb2RhZGR5LmNvbS8wNQYDVR0fBC4wLDAqoCigJoYkaHR0cDovL2NybC5n
b2RhZGR5LmNvbS9nZHJvb3QtZzIuY3JsMEYGA1UdIAQ/MD0wOwYEVR0gADAzMDEG
CCsGAQUFBwIBFiVodHRwczovL2NlcnRzLmdvZGFkZHkuY29tL3JlcG9zaXRvcnkv
MA0GCSqGSIb3DQEBCwUAA4IBAQAIfmyTEMg4uJapkEv/oV9PBO9sPpyIBslQj6Zz
91cxG7685C/b+LrTW+C05+Z5Yg4MotdqY3MxtfWoSKQ7CC2iXZDXtHwlTxFWMMS2
RJ17LJ3lXubvDGGqv+QqG+6EnriDfcFDzkSnE3ANkR/0yBOtg2DZ2HKocyQetawi
DsoXiWJYRBuriSUBAA/NxBti21G00w9RKpv0vHP8ds42pM3Z2Czqrpv1KrKQ0U11
GIo/ikGQI31bS/6kA1ibRrLDYGCD+H1QQc7CoZDDu+8CL9IVVO5EFdkKrqeKM+2x
LXY2JtwE65/3YR8V3Idv7kaWKK2hJn0KCacuBKONvPi8BDAB
-----END CERTIFICATE-----
`;

/**
 * The CA set Node trusts by default: the bundled roots plus anything the
 * process was started with in NODE_EXTRA_CA_CERTS. `tls.rootCertificates`
 * alone omits the extra file, and undici's `connect.ca` REPLACES the default
 * store, so building on the bundled roots alone would silently discard a
 * custom CA (TLS inspection, a corporate proxy) for the listed hosts only.
 * Node >= 24 reports the effective set directly; older versions get the same
 * answer by reading the file Node itself loads at startup. Read once.
 */
let cachedDefaultCaCertificates: readonly string[] | null = null;

export function defaultCaCertificates(): readonly string[] {
  if (cachedDefaultCaCertificates) {
    return cachedDefaultCaCertificates;
  }
  const getCACertificates = (
    tls as unknown as { getCACertificates?: (type: "default") => string[] }
  ).getCACertificates;
  if (typeof getCACertificates === "function") {
    cachedDefaultCaCertificates = getCACertificates.call(tls, "default");
    return cachedDefaultCaCertificates;
  }
  const extra: string[] = [];
  const extraFile = process.env.NODE_EXTRA_CA_CERTS?.trim();
  if (extraFile) {
    try {
      const pemBlocks = readFileSync(extraFile, "utf8").match(
        /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
      );
      extra.push(...(pemBlocks ?? []));
    } catch {
      // Node ignores an unreadable NODE_EXTRA_CA_CERTS file too (it warns
      // once at startup); trusting the bundled roots is the same outcome.
    }
  }
  cachedDefaultCaCertificates = [...tls.rootCertificates, ...extra];
  return cachedDefaultCaCertificates;
}

export function resetDefaultCaCertificatesForTests(): void {
  cachedDefaultCaCertificates = null;
}

type KnownIncompleteChainHost = {
  // Matches the hostname itself and any subdomain of it.
  hostSuffix: string;
  intermediates: readonly string[];
};

const KNOWN_INCOMPLETE_CHAIN_HOSTS: readonly KnownIncompleteChainHost[] = [
  // cga.ct.gov / www.cga.ct.gov serve only the leaf (verified with
  // `openssl s_client -connect www.cga.ct.gov:443 -servername www.cga.ct.gov`
  // on 2026-09-24: chain depth 1, issuer Go Daddy Secure CA - G2).
  { hostSuffix: "cga.ct.gov", intermediates: [GODADDY_SECURE_CA_G2_PEM] },
];

/**
 * Extra CA certificates to trust for `hostname`, or null when the host is not
 * on the known-incomplete-chain list. Callers must add these ON TOP of
 * `defaultCaCertificates()`: undici's `connect.ca` replaces the default store.
 */
export function extraCaCertificatesForHost(hostname: string): readonly string[] | null {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  for (const entry of KNOWN_INCOMPLETE_CHAIN_HOSTS) {
    if (host === entry.hostSuffix || host.endsWith("." + entry.hostSuffix)) {
      return entry.intermediates;
    }
  }
  return null;
}
