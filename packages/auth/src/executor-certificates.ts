// oxlint-disable-next-line import/no-unassigned-import -- X.509 decorators need Reflect metadata before their modules initialize.
import "reflect-metadata";
import { isIP } from "node:net";

import {
  BasicConstraintsExtension,
  ExtendedKeyUsageExtension,
  KeyUsagesExtension,
  KeyUsageFlags,
  SubjectAlternativeNameExtension,
  X509Certificate,
  X509CertificateGenerator,
} from "@peculiar/x509";
import { Redacted, Schema } from "effect";

const Secret = Schema.RedactedFromValue(Schema.String);
/** Persisted only through Mend's SecretCipher; the authority belongs to this installation. */
export const ExecutorAuthority = Schema.Struct({
  ca: Schema.String,
  caKey: Secret,
  secret: Secret,
  host: Schema.String,
  certificate: Schema.String,
  key: Secret,
});
export type ExecutorAuthority = typeof ExecutorAuthority.Type;
const keys = () =>
  crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
const pem = (value: ArrayBuffer) =>
  `-----BEGIN PRIVATE KEY-----\n${Buffer.from(value)
    .toString("base64")
    .match(/.{1,64}/g)
    ?.join("\n")}\n-----END PRIVATE KEY-----\n`;
const importKey = (value: string) =>
  crypto.subtle.importKey(
    "pkcs8",
    Buffer.from(value.replace(/-----[^-]+-----|\s/g, ""), "base64"),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

/** Renew the leaf on host changes or before expiry, keeping the sealed private authority. */
export const executorCertificates = async (
  host: string,
  previous?: ExecutorAuthority,
): Promise<ExecutorAuthority> => {
  const now = Date.now();
  if (
    previous?.host === host &&
    new X509Certificate(previous.certificate).notAfter.getTime() > now + 30 * 86_400_000
  )
    return previous;
  const notBefore = new Date(now - 300_000);
  const authority = await (async () => {
    if (previous !== undefined)
      return {
        ca: previous.ca,
        privateKey: await importKey(Redacted.value(previous.caKey)),
        sealedKey: previous.caKey,
        secret: previous.secret,
      };
    const pair = await keys();
    const certificate = await X509CertificateGenerator.createSelfSigned({
      name: "CN=Mend private Executor authority",
      keys: pair,
      notBefore,
      notAfter: new Date(now + 20 * 365 * 86_400_000),
      extensions: [
        new BasicConstraintsExtension(true, 0, true),
        new KeyUsagesExtension(KeyUsageFlags.keyCertSign | KeyUsageFlags.cRLSign, true),
      ],
    });
    return {
      ca: certificate.toString("pem"),
      privateKey: pair.privateKey,
      sealedKey: Redacted.make(pem(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
      secret: Redacted.make(
        Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"),
      ),
    };
  })();
  const ca = authority.ca;
  const leaf = await keys();
  const certificate = await X509CertificateGenerator.create({
    subject: "CN=Mend private Executor sign-in",
    issuer: new X509Certificate(ca).subject,
    publicKey: leaf.publicKey,
    signingKey: authority.privateKey,
    notBefore,
    notAfter: new Date(now + 365 * 86_400_000),
    extensions: [
      new BasicConstraintsExtension(false, undefined, true),
      new KeyUsagesExtension(KeyUsageFlags.digitalSignature | KeyUsageFlags.keyEncipherment, true),
      new ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"]),
      new SubjectAlternativeNameExtension([{ type: isIP(host) ? "ip" : "dns", value: host }]),
    ],
  });
  return {
    ca,
    caKey: authority.sealedKey,
    secret: authority.secret,
    host,
    certificate: certificate.toString("pem"),
    key: Redacted.make(pem(await crypto.subtle.exportKey("pkcs8", leaf.privateKey))),
  };
};
