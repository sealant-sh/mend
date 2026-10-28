import { spawnSync } from "node:child_process";
import * as path from "node:path";

export const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;

export const makeCertificate = (
  directory: string,
  names: ReadonlyArray<string>,
  name = "preview",
  days = 90,
): { readonly certificate: string; readonly key: string } => {
  const certificate = path.join(directory, `${name}.crt`);
  const key = path.join(directory, `${name}.key`);
  const made = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-days",
      String(days),
      "-subj",
      `/CN=${names[0] ?? "example.test"}`,
      "-addext",
      `subjectAltName=${names.map((dns) => `DNS:${dns}`).join(",")}`,
      "-keyout",
      key,
      "-out",
      certificate,
    ],
    { encoding: "utf8" },
  );
  if (made.status !== 0) throw new Error(`openssl failed: ${made.stderr}`);
  return { certificate, key };
};
