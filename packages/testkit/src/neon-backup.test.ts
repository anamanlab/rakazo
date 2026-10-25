import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function write(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "rakazo-neon-backup-"));
  temporaryDirectories.push(root);
  const checkout = path.join(root, "checkout");
  const snapshots = path.join(root, "snapshots");
  const bin = path.join(root, "bin");

  for (const script of [
    "infra/scripts/neon-backup.sh",
    "infra/scripts/neon-restore-drill.sh",
  ]) {
    const source = readFileSync(path.join(repoRoot, script), "utf8");
    write(path.join(checkout, script), source);
    chmodSync(path.join(checkout, script), 0o755);
  }

  const logFile = path.join(root, "commands.log");

  // Mock pg_dump
  const pgDump = path.join(bin, "pg_dump");
  write(
    pgDump,
    `#!/usr/bin/env -S node --
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync("${logFile}", JSON.stringify({ bin: "pg_dump", args }) + "\\n");
if (process.env.FAIL_DUMP === "1") process.exit(2);
process.stdout.write("PGDMP-CUSTOM-FORMAT-TEST-DATA");
`,
  );
  chmodSync(pgDump, 0o755);

  // Mock pg_restore
  const pgRestore = path.join(bin, "pg_restore");
  write(
    pgRestore,
    `#!/usr/bin/env -S node --
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync("${logFile}", JSON.stringify({ bin: "pg_restore", args }) + "\\n");
fs.readFileSync(0); // consume stdin
if (process.env.FAIL_VERIFY === "1") process.exit(2);
process.exit(0);
`,
  );
  chmodSync(pgRestore, 0o755);

  // Mock psql
  const psql = path.join(bin, "psql");
  write(
    psql,
    `#!/usr/bin/env -S node --
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync("${logFile}", JSON.stringify({ bin: "psql", args }) + "\\n");
if (process.env.FAIL_PSQL === "1") {
  console.error("connection refused");
  process.exit(2);
}
if (args.includes("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public';")) {
  console.log("42");
} else {
  console.log("1");
}
process.exit(0);
`,
  );
  chmodSync(psql, 0o755);

  // Mock sha256sum
  const sha256sum = path.join(bin, "sha256sum");
  write(
    sha256sum,
    `#!/usr/bin/env -S node --
const fs = require("node:fs");
const crypto = require("node:crypto");
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const args = process.argv.slice(2).filter((a) => a !== "--quiet");
if (args[0] === "--check") {
  const file = args.at(-1);
  for (const line of fs.readFileSync(file, "utf8").trim().split("\\n")) {
    const [sum, filename] = line.split("  ");
    if (hash(filename) !== sum) process.exit(1);
  }
} else {
  const files = args.filter((a) => a !== "--");
  for (const file of files) console.log(hash(file) + "  " + file);
}
`,
  );
  chmodSync(sha256sum, 0o755);

  // Mock age
  const age = path.join(bin, "age");
  write(
    age,
    `#!/usr/bin/env -S node --
const fs = require("node:fs");
const args = process.argv.slice(2);
const value = (flag) => args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []));
const lines = (file) => fs.readFileSync(file, "utf8").split("\\n").map((l) => l.trim());
if (args.includes("--decrypt")) {
  const file = args.at(-1);
  const content = fs.readFileSync(file, "utf8");
  const [header, payload = ""] = content.split("\\n---\\n");
  const keys = value("-i").flatMap(lines).flatMap((l) => l.match(/^# public key: (\\S+)$/)?.slice(1) ?? []);
  if (!keys.some((key) => header.split("\\n").includes("-> fake " + key))) process.exit(1);
  process.stdout.write(Buffer.from(payload, "base64"));
} else {
  const recipients = [...value("-r"), ...value("-R").flatMap(lines).filter((l) => l && !l.startsWith("#"))];
  if (!recipients.length || recipients.some((r) => !r.startsWith("age1"))) process.exit(1);
  const sealed = ["age-encryption.org/v1", ...recipients.map((r) => "-> fake " + r), "---", fs.readFileSync(0).toString("base64")].join("\\n");
  const out = value("-o");
  out.length ? fs.writeFileSync(out[0], sealed) : process.stdout.write(sealed);
}
`,
  );
  chmodSync(age, 0o755);

  // Mock gpg
  const gpg = path.join(bin, "gpg");
  write(
    gpg,
    `#!/usr/bin/env -S node --
const fs = require("node:fs");
const args = process.argv.slice(2);
const value = (flag) => args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []));
if (args.includes("--decrypt")) {
  const file = args.at(-1);
  const content = fs.readFileSync(file, "utf8");
  const [header, payload = ""] = content.split("\\n---\\n");
  process.stdout.write(Buffer.from(payload, "base64"));
} else {
  const out = value("--output");
  const sealed = ["-----BEGIN PGP MESSAGE-----", "---", fs.readFileSync(0).toString("base64")].join("\\n");
  out.length ? fs.writeFileSync(out[0], sealed) : process.stdout.write(sealed);
}
`,
  );
  chmodSync(gpg, 0o755);

  return { root, checkout, snapshots, bin, logFile };
}

describe("neon backup script", () => {
  it("rejects execution when no database URL is provided", () => {
    const f = fixture();
    const run = spawnSync(path.join(f.checkout, "infra/scripts/neon-backup.sh"), [], {
      env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}`, DATABASE_URL: "" },
    });
    expect(run.status).toBe(1);
    expect(run.stderr.toString()).toContain("Database connection URL is required");
  });

  it("rejects non-absolute output directory", () => {
    const f = fixture();
    const run = spawnSync(
      path.join(f.checkout, "infra/scripts/neon-backup.sh"),
      ["--database-url", "postgres://user:pass@host/db", "--out-dir", "relative/path"],
      { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` } },
    );
    expect(run.status).toBe(1);
    expect(run.stderr.toString()).toContain("must be an absolute path");
  });

  it("refuses unencrypted backup unless --allow-plaintext is passed", () => {
    const f = fixture();
    const run = spawnSync(
      path.join(f.checkout, "infra/scripts/neon-backup.sh"),
      ["--database-url", "postgres://user:pass@host/db", "--out-dir", f.snapshots],
      { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` } },
    );
    expect(run.status).toBe(1);
    expect(run.stderr.toString()).toContain("Backups must be encrypted");
  });

  it("masks secret credentials in stdout and stderr", () => {
    const f = fixture();
    const secretPassword = "ultraSecretPassword123!";
    const run = spawnSync(
      path.join(f.checkout, "infra/scripts/neon-backup.sh"),
      [
        "--database-url",
        `postgres://test_user:${secretPassword}@ep-test-branch.neon.tech/neondb`,
        "--out-dir",
        f.snapshots,
        "--dry-run",
      ],
      { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` } },
    );
    const output = run.stdout.toString() + run.stderr.toString();
    expect(output).not.toContain(secretPassword);
    expect(output).toContain("postgres://test_user:***@ep-test-branch.neon.tech/neondb?sslmode=require");
    expect(run.status).toBe(0);
  });

  it("creates encrypted backup with age, verifies dump, and generates metadata and checksums", () => {
    const f = fixture();
    const recipient = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";
    const run = spawnSync(
      path.join(f.checkout, "infra/scripts/neon-backup.sh"),
      [
        "--database-url",
        "postgres://rakazo:secret@neon.tech/rakazodb",
        "--out-dir",
        f.snapshots,
        "--age-recipient",
        recipient,
      ],
      { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` } },
    );
    expect(run.status).toBe(0);

    const entries = readdirSync(f.snapshots).filter((e) => !e.startsWith("."));
    expect(entries.length).toBe(1);
    const stampDir = path.join(f.snapshots, entries[0]);
    expect(existsSync(path.join(stampDir, "rakazo.dump.age"))).toBe(true);
    expect(existsSync(path.join(stampDir, "SHA256SUMS"))).toBe(true);
    expect(existsSync(path.join(stampDir, "METADATA.json"))).toBe(true);

    const metadata = JSON.parse(readFileSync(path.join(stampDir, "METADATA.json"), "utf8"));
    expect(metadata.encryption).toBe("age");
    expect(metadata.verified).toBe(true);
    expect(metadata.database).not.toContain("secret");
    expect(metadata.database).toContain("***");
  });

  it("enforces retention by pruning older verified backups", () => {
    const f = fixture();
    const recipient = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";

    // Create 3 older fake verified snapshot directories
    for (const stamp of ["20261020T100000Z", "20261021T100000Z", "20261022T100000Z"]) {
      const dir = path.join(f.snapshots, stamp);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "SHA256SUMS"), "fake  rakazo.dump.age\n");
    }

    const run = spawnSync(
      path.join(f.checkout, "infra/scripts/neon-backup.sh"),
      [
        "--database-url",
        "postgres://rakazo:secret@neon.tech/rakazodb",
        "--out-dir",
        f.snapshots,
        "--keep",
        "2",
        "--age-recipient",
        recipient,
      ],
      { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` } },
    );
    expect(run.status).toBe(0);

    const remaining = readdirSync(f.snapshots).filter((e) => !e.startsWith(".")).sort();
    // 2 newest snapshots kept
    expect(remaining.length).toBe(2);
    expect(remaining).not.toContain("20261020T100000Z");
    expect(remaining).not.toContain("20261021T100000Z");
  });

  it("cleans up partial snapshot directory when dump fails", () => {
    const f = fixture();
    const recipient = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";

    const run = spawnSync(
      path.join(f.checkout, "infra/scripts/neon-backup.sh"),
      [
        "--database-url",
        "postgres://rakazo:secret@neon.tech/rakazodb",
        "--out-dir",
        f.snapshots,
        "--age-recipient",
        recipient,
      ],
      {
        env: {
          ...process.env,
          PATH: `${f.bin}:${process.env.PATH}`,
          FAIL_DUMP: "1",
        },
      },
    );
    expect(run.status).toBe(2);
    const entries = readdirSync(f.snapshots).filter((e) => !e.startsWith("."));
    expect(entries.length).toBe(0);
  });
});

describe("neon restore drill script", () => {
  it("authenticates and verifies encrypted snapshot in an offline drill", () => {
    const f = fixture();
    const recipient = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";
    const identityFile = path.join(f.root, "identity.txt");
    write(identityFile, `# public key: ${recipient}\nAGE-SECRET-KEY-FAKE\n`);

    // Create a real encrypted backup using neon-backup.sh
    const backupRun = spawnSync(
      path.join(f.checkout, "infra/scripts/neon-backup.sh"),
      [
        "--database-url",
        "postgres://rakazo:secret@neon.tech/rakazodb",
        "--out-dir",
        f.snapshots,
        "--age-recipient",
        recipient,
      ],
      { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` } },
    );
    expect(backupRun.status).toBe(0);

    const entries = readdirSync(f.snapshots).filter((e) => !e.startsWith("."));
    const snapshotDir = path.join(f.snapshots, entries[0]);

    // Run offline drill
    const drillRun = spawnSync(
      path.join(f.checkout, "infra/scripts/neon-restore-drill.sh"),
      [snapshotDir, "--age-identity", identityFile],
      { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` } },
    );
    expect(drillRun.status).toBe(0);
    expect(drillRun.stdout.toString()).toContain("Offline drill PASSED");
  });

  it("fails drill when snapshot file has been tampered with", () => {
    const f = fixture();
    const recipient = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";
    const identityFile = path.join(f.root, "identity.txt");
    write(identityFile, `# public key: ${recipient}\nAGE-SECRET-KEY-FAKE\n`);

    spawnSync(
      path.join(f.checkout, "infra/scripts/neon-backup.sh"),
      [
        "--database-url",
        "postgres://rakazo:secret@neon.tech/rakazodb",
        "--out-dir",
        f.snapshots,
        "--age-recipient",
        recipient,
      ],
      { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` } },
    );

    const entries = readdirSync(f.snapshots).filter((e) => !e.startsWith("."));
    const snapshotDir = path.join(f.snapshots, entries[0]);

    // Tamper with the dump file
    writeFileSync(path.join(snapshotDir, "rakazo.dump.age"), "corrupted-content");

    const drillRun = spawnSync(
      path.join(f.checkout, "infra/scripts/neon-restore-drill.sh"),
      [snapshotDir, "--age-identity", identityFile],
      { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` } },
    );
    expect(drillRun.status).toBe(1);
    expect(drillRun.stderr.toString()).toContain("SHA256 checksum verification failed");
  });

  it("rehearses full restore into a target database branch", () => {
    const f = fixture();
    const recipient = "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p";
    const identityFile = path.join(f.root, "identity.txt");
    write(identityFile, `# public key: ${recipient}\nAGE-SECRET-KEY-FAKE\n`);

    spawnSync(
      path.join(f.checkout, "infra/scripts/neon-backup.sh"),
      [
        "--database-url",
        "postgres://rakazo:secret@neon.tech/rakazodb",
        "--out-dir",
        f.snapshots,
        "--age-recipient",
        recipient,
      ],
      { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` } },
    );

    const entries = readdirSync(f.snapshots).filter((e) => !e.startsWith("."));
    const snapshotDir = path.join(f.snapshots, entries[0]);

    const targetUrl = "postgres://rakazo_app:secret123@ep-target-isolated-branch.neon.tech/neondb";
    const drillRun = spawnSync(
      path.join(f.checkout, "infra/scripts/neon-restore-drill.sh"),
      [snapshotDir, "--age-identity", identityFile, "--target-url", targetUrl],
      { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` } },
    );
    expect(drillRun.status).toBe(0);
    const out = drillRun.stdout.toString();
    expect(out).toContain("Restore rehearsal drill PASSED");
    expect(out).toContain("42 public tables");
    expect(out).not.toContain("secret123");
  });
});
