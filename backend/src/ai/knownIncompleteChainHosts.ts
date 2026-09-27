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

// Entrust DV TLS Issuing RSA CA 2: issuer of the *.wvsos.gov leaf (West
// Virginia Secretary of State). Downloaded 2026-09-26 from the leaf's AIA
// "CA Issuers" URL (http://crt.sectigo.com/EntrustDVTLSIssuingRSACA2.crt),
// chains to the "Sectigo Public Server Authentication Root R46" root in
// Node's bundle.
// SHA-256 fingerprint
// EC:37:DF:84:99:95:A5:30:89:C9:8B:D1:2E:CA:C7:74:06:A2:B4:14:78:77:9E:5C:B8:2C:5F:16:6E:7D:F8:3C.
// Expires 2027-12-10.
export const ENTRUST_DV_TLS_ISSUING_RSA_CA_2_PEM = `-----BEGIN CERTIFICATE-----
MIIGNTCCBB2gAwIBAgIQCtX1c5Gcd8kyz4XgxpLVPDANBgkqhkiG9w0BAQwFADBf
MQswCQYDVQQGEwJHQjEYMBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMTYwNAYDVQQD
Ey1TZWN0aWdvIFB1YmxpYyBTZXJ2ZXIgQXV0aGVudGljYXRpb24gUm9vdCBSNDYw
HhcNMjQxMjExMDAwMDAwWhcNMjcxMjEwMjM1OTU5WjBRMQswCQYDVQQGEwJDQTEY
MBYGA1UEChMPRW50cnVzdCBMaW1pdGVkMSgwJgYDVQQDEx9FbnRydXN0IERWIFRM
UyBJc3N1aW5nIFJTQSBDQSAyMIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKC
AYEAnq02xRySq9MV6qSoqYIMRIs263ND1bdHIagL3budUXdXu6lHyqB1100S1fBf
7SARFr70utHKaO9bPPktbRfxKw0NAebc/L3qOa6cjQfYYyhv8Y3a0ws/Cbd8a/xc
uiCPn4u7yswRKJiUfeoOXO9G7GGzIOv2wGiGCKHEoDnwZa8ZwSRrsJVTt3LOpolR
S9Sod0etzW46Ly4lHQCgxVBeeSS6hBWIARwflA3SuRentB7W2nxud5G2eupDbsnb
J6lqtzz2XqJeArjE8/xkKHk9GIhXPhEj3K0kekh4fB0me4c2csMdraSioZ7n1C43
IfOIlRLmswjRFAvpPImWksZLiCIn/hi+UHX+WG5mtWMIGuqQuOjMQWFnSne3giVT
b6T28puOUHQ8Lj12sotvNopFpVseN9qOK1u+5CLyDZvzSxUXR5wlRmACzqtYzArn
9dVwlxkmTu+/ovPsz22al3zY2s66m1lZKuIKqM+Aqd6B4RLs9EksHd+mTv9EUnkv
VIVlAgMBAAGjggF5MIIBdTAfBgNVHSMEGDAWgBRWc1hklfmSGrASKgRieaFAFYgh
STAdBgNVHQ4EFgQUjUJJN0C5R5WAmL6puTpr8M2WoYMwDgYDVR0PAQH/BAQDAgGG
MBIGA1UdEwEB/wQIMAYBAf8CAQAwHQYDVR0lBBYwFAYIKwYBBQUHAwEGCCsGAQUF
BwMCMBMGA1UdIAQMMAowCAYGZ4EMAQIBMFQGA1UdHwRNMEswSaBHoEWGQ2h0dHA6
Ly9jcmwuc2VjdGlnby5jb20vU2VjdGlnb1B1YmxpY1NlcnZlckF1dGhlbnRpY2F0
aW9uUm9vdFI0Ni5jcmwwgYQGCCsGAQUFBwEBBHgwdjBPBggrBgEFBQcwAoZDaHR0
cDovL2NydC5zZWN0aWdvLmNvbS9TZWN0aWdvUHVibGljU2VydmVyQXV0aGVudGlj
YXRpb25Sb290UjQ2LnA3YzAjBggrBgEFBQcwAYYXaHR0cDovL29jc3Auc2VjdGln
by5jb20wDQYJKoZIhvcNAQEMBQADggIBAAR7QD/G11LeMu8WoScjnrBMJeepJaK9
BjFuCxwF+aUUuKxxptz0xjXjB4J5mZaBGTWcfwpDokObsz7D6pScyaf0/kkzCL/g
lKoEImdv2T0pUaDk3P1RhH3v/nsbWde9IzssrxikpyQqNG1gAb2GCpJswHdwnNs1
utKeKTYItq4O1oqXPXglNSyBkaYph8ZzXiQgTtQAaiDA7hGOryUzRzdi6KTZAnBl
AfQw3GzIw9ZdSEuXLoYjPZ9mhgHhXflkxmInYo9PQpO0gDyx7rfhUkEppoS9sgK0
oc9qLKSPUxt3Nt9a5icghWCL/ViFAhdU4YPGZB3KgaZiu8zbH2kC8JrdI7rskROX
b30xUGhtHrCVO8lJzS7df4pGcROi5VYloF6Eyq6MPNVyq5/XumC+Gj+TQkIywrW9
V0IhH9lO32w1ZENtowwFblXfXDhsR7lB3/vLPUTqcqm6vorvixNZjWJuYP5D2nwb
q552qYAIvb3K9Yo50/J7mFsLNjzaaqKKjoE7zX0nT6LT5LxqdCYP0pQFRu3vf7DL
pqzLnF1+ZXlkJ/fgQDgv37DotO8GFZ49DnKX4B5utKrdcheSY3IntjCTtcb96Z3C
zg9mAR0sBwX86RhZKgZ1s33iqEmJXiP51On/M9UzdWdFnth8f4gIKtKPgO3MxupR
+CgUsrUKgzo4
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
      // Node loads CERTIFICATE and the legacy X509 CERTIFICATE label from this
      // file and ignores TRUSTED CERTIFICATE (verified on Node 23.9 against a
      // live host), so match exactly those two.
      const pemBlocks = readFileSync(extraFile, "utf8").match(
        /-----BEGIN (CERTIFICATE|X509 CERTIFICATE)-----[\s\S]*?-----END \1-----/g
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
  // candidates.wvsos.gov serves only the leaf (verified with
  // `openssl s_client -connect candidates.wvsos.gov:443 -servername candidates.wvsos.gov`
  // on 2026-09-26: issuer Entrust DV TLS Issuing RSA CA 2, verify error 21).
  { hostSuffix: "candidates.wvsos.gov", intermediates: [ENTRUST_DV_TLS_ISSUING_RSA_CA_2_PEM] },
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
