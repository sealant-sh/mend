import { describe, expect, it } from "vitest";

import { redactDetail } from "./redact-detail.ts";

// The rule redactDetail promises for each shape of secret its comments name: wherever such a
// secret sits in a message from below, the text that leaves the server does not carry it. Each
// case generates the secret on its own and plants it in a sentence; the expected value is only
// "the secret is gone", worked out from the generated input, never from the function.
//
// Inputs come from a small seeded generator rather than fast-check, which @mend/network does not
// depend on (adding it changes the lockfile; SLNT-1004). The seed is fixed, so every run checks the
// same inputs, and a failure names the run and the exact message it built.

const SEED = 997;
const RUNS = 300;

interface Gen {
  readonly int: (min: number, max: number) => number;
  readonly pick: <T>(values: ReadonlyArray<T>) => T;
  readonly chars: (alphabet: string, minLength: number, maxLength: number) => string;
}

/** mulberry32: a tiny deterministic PRNG, enough to spread inputs over each shape. */
const generator = (seed: number): Gen => {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(values: ReadonlyArray<T>): T => {
    const value = values[int(0, values.length - 1)];
    if (value === undefined) throw new Error("pick from an empty list");
    return value;
  };
  const chars = (alphabet: string, minLength: number, maxLength: number) =>
    Array.from({ length: int(minLength, maxLength) }, () => pick([...alphabet])).join("");
  return { int, pick, chars };
};

/** Runs `check` over RUNS generated cases; a failure names its run so it can be replayed. */
const forAll = (build: (gen: Gen) => () => void) => {
  const gen = generator(SEED);
  for (let run = 0; run < RUNS; run += 1) {
    const check = build(gen);
    try {
      check();
    } catch (error) {
      throw new Error(`run ${run} of seed ${SEED} failed`, { cause: error });
    }
  }
};

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = LOWER.toUpperCase();
const DIGITS = "0123456789";
const ALNUM = LOWER + UPPER + DIGITS;

/**
 * A secret value: letters and digits with at least one capital, one digit and one small letter,
 * so it is never a word of the surrounding sentence nor a commit-like hex string.
 */
const secret = (gen: Gen, minLength: number, maxLength: number) =>
  `${gen.pick([...UPPER])}${gen.chars(ALNUM, minLength - 3, maxLength - 3)}${gen.pick([...DIGITS])}${gen.pick([...LOWER])}`;

/** Where upstream text puts a value: git, a platform message, a Node exception. */
const around = (gen: Gen, text: string) =>
  `${gen.pick(["", "fatal: unable to access: ", "request failed (401) ", "Error: upstream said ", "warning: "])}${text}${gen.pick(["", " (exit 128)", ".", "\nretrying in 2s", " and gave up"])}`;

const expectGone = (message: string, ...secrets: ReadonlyArray<string>) => {
  const shown = redactDetail(message);
  for (const value of secrets) expect(shown, message).not.toContain(value);
};

/** A credential's name as upstream text writes it, in any mix of case. */
const anyCase = (gen: Gen, name: string) =>
  [...name].map((ch) => (gen.int(0, 1) === 1 ? ch.toUpperCase() : ch)).join("");

describe("redactDetail removes every secret shape it names, wherever it sits", () => {
  it("drops a URL's credentials, query and fragment", () => {
    forAll((gen) => {
      const user = secret(gen, 8, 24);
      const password = secret(gen, 8, 24);
      const query = secret(gen, 12, 40);
      const fragment = secret(gen, 12, 40);
      const scheme = gen.pick(["https", "http", "git+ssh", "s3"]);
      const host = gen.pick(["github.com", "s3.eu-central-1.amazonaws.com", "example.org"]);
      const name = gen.pick(["token", "X-Amz-Signature", "ticket", "q"]);
      const url = `${scheme}://${user}:${password}@${host}/acme/app?${name}=${query}#${fragment}`;
      return () => expectGone(around(gen, `'${url}': 403`), user, password, query, fragment);
    });
  });

  it("drops an internal host from a URL and keeps its path", () => {
    forAll((gen) => {
      const host = gen.pick([
        () => gen.pick(["localhost", "garage", "postgres"]),
        () => `${gen.chars(LOWER, 4, 12)}.svc.cluster.local`,
        () => `${gen.chars(LOWER, 4, 12)}.internal`,
        () => `10.${gen.int(0, 255)}.0.${gen.int(1, 254)}`,
        () => `172.${gen.int(16, 31)}.0.${gen.int(1, 254)}`,
        () => `192.168.1.${gen.int(1, 254)}`,
      ])();
      const message = `connect ECONNREFUSED http://${host}:${gen.int(1, 65535)}/v1/workspaces`;
      return () => {
        const shown = redactDetail(message);
        expect(shown, message).not.toContain(host);
        expect(shown, message).toContain("/v1/workspaces");
      };
    });
  });

  it("drops a value that names itself a credential, keeping the name", () => {
    // Also ordinary words, so these are taken only alone and before a bare `=`.
    const words = ["ticket", "code", "signature", "key"];
    // Credentials whatever precedes them, so these take a prefix and any separator.
    const credentials = [
      "token",
      "password",
      "passwd",
      "passphrase",
      "secret",
      "credentials",
      "apikey",
      "api_key",
      "api-key",
      "accesskey",
      "access_key",
      "private_key",
      "private-key",
    ];
    const prefixes = [
      "",
      "DB_",
      "PG",
      "access_",
      "refresh_",
      "client_",
      "aws_secret_",
      "X-",
      "app.",
    ];
    forAll((gen) => {
      const value = secret(gen, 8, 32);
      const { named, assignment } = gen.pick([
        () => {
          const word = anyCase(gen, gen.pick(words));
          const quote = gen.pick(["", '"', "'"]);
          return { named: word, assignment: `${word}=${quote}${value}${quote}` };
        },
        () => {
          const name = anyCase(gen, `${gen.pick(prefixes)}${gen.pick(credentials)}`);
          const quote = gen.pick(["", '"', "'"]);
          const separator = gen.pick(["=", " = ", ": ", ":", " : "]);
          // As upstream writes it: bare, a JSON field, or a Python dict entry.
          return gen.pick([
            () => ({ named: name, assignment: `${name}${separator}${quote}${value}${quote}` }),
            () => ({ named: name, assignment: `{"user":"carol","${name}":"${value}"}` }),
            () => ({ named: name, assignment: `{'${name}': '${value}'}` }),
          ])();
        },
      ])();
      const message = around(gen, `${assignment}${gen.pick([" ", "&", ",", ";"])}`);
      return () => {
        const shown = redactDetail(message);
        expect(shown, message).not.toContain(value);
        expect(shown, message).toContain(named);
      };
    });
  });

  it("drops a Bearer or Basic authorization value", () => {
    forAll((gen) => {
      const value = secret(gen, 12, 48);
      const scheme = gen.pick(["Bearer", "Basic"]);
      const lead = gen.pick(["Authorization: ", "sent ", ""]);
      return () => expectGone(around(gen, `${lead}${scheme} ${value}`), value);
    });
  });

  it("drops an Authorization header's value in any case, GitHub's token scheme too", () => {
    forAll((gen) => {
      const value = secret(gen, 12, 48);
      const header = `${anyCase(gen, "authorization")}${gen.pick([": ", ":", "="])}`;
      const scheme = anyCase(gen, gen.pick(["bearer", "basic", "token"]));
      return () => expectGone(around(gen, `${header}${scheme} ${value}`), value);
    });
  });

  it("drops a JWT whole", () => {
    forAll((gen) => {
      const segment = () => gen.chars(`${ALNUM}_-`, 8, 60);
      const [header, payload, signature] = [segment(), segment(), segment()];
      const message = around(gen, `token eyJ${header}.${payload}.${signature} expired`);
      return () => expectGone(message, header, payload, signature);
    });
  });

  it("drops a bearer Mend, Sealant or a provider mints", () => {
    const prefixes = ["mdt", "mut", "slt", "ghp", "gho", "ghu", "ghs", "ghr", "github_pat", "sk"];
    forAll((gen) => {
      const minted = gen.pick([
        () => {
          const value = secret(gen, 8, 36);
          return {
            token: `${gen.pick([...prefixes, "xoxb", "xoxp"])}${gen.pick(["_", "-"])}${value}`,
            value,
          };
        },
        () => {
          const value = gen.chars(UPPER + DIGITS, 16, 16);
          return { token: `${gen.pick(["AKIA", "ASIA"])}${value}`, value };
        },
      ])();
      return () => expectGone(around(gen, `rejected ${minted.token}`), minted.value);
    });
  });

  it("keeps only the head of a long hex string or a long opaque value", () => {
    forAll((gen) => {
      const { value, head } =
        gen.int(0, 1) === 0
          ? { value: gen.chars("0123456789abcdef", 32, 80), head: 12 }
          : { value: secret(gen, 40, 90), head: 8 };
      return () => expectGone(around(gen, `checkpoint ${value} not found`), value.slice(head));
    });
  });

  it("drops a forty-character base64 secret key", () => {
    forAll((gen) => {
      const body = gen.chars(`${ALNUM}+/`, 39, 39);
      const at = gen.int(0, 39);
      const value = `${body.slice(0, at)}${gen.pick(["+", "/"])}${body.slice(at)}`;
      return () => expectGone(around(gen, `secret access key ${value} invalid`), value);
    });
  });

  it("keeps a server path's leaf and drops the directories that lead to it", () => {
    forAll((gen) => {
      const root = gen.pick([
        "/home",
        "/var",
        "/srv",
        "/data",
        "/workspace",
        "/mend",
        "/root",
        "~",
      ]);
      const directories = Array.from({ length: gen.int(1, 4) }, () => secret(gen, 6, 14));
      const leaf = `${gen.chars(LOWER, 3, 10)}.json`;
      const message = around(gen, `open '${root}/${directories.join("/")}/${leaf}'`);
      return () => {
        const shown = redactDetail(message);
        for (const name of directories) expect(shown, message).not.toContain(name);
        expect(shown, message).toContain(leaf);
      };
    });
  });

  it("never returns more than its bound, whatever arrives", () => {
    forAll((gen) => {
      const detail = gen.chars(`${ALNUM} /:=._-?&#@"'\n`, 0, 20_000);
      return () => expect(redactDetail(detail).length).toBeLessThanOrEqual(601);
    });
  });
});

describe("redactDetail on the shapes SLNT-998 found left in place", () => {
  it("drops an environment-style assignment such as DB_PASSWORD=…", () => {
    forAll((gen) => {
      const name = gen.pick(["DB_PASSWORD", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN"]);
      const value = secret(gen, 12, 32);
      return () => expectGone(`env: ${name}=${value} rejected`, value);
    });
  });

  it('drops a JSON credential field such as {"password":"…"}', () => {
    forAll((gen) => {
      const name = gen.pick(["password", "token", "secret", "apiKey"]);
      const value = secret(gen, 12, 32);
      const body = JSON.stringify({ user: "carol", [name]: value });
      return () => expectGone(`upstream answered ${body}`, value);
    });
  });
});
