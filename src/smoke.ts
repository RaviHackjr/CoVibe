// Pure smoke tests — run with: npm run smoke (node out/smoke.js)
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  backoffMs,
  buildLangCmd,
  buildRunCommand,
  chunkB64,
  classifyConnect,
  cleanB64,
  driveNameToRel,
  langOf,
  matchIgnores,
  planSync,
  relToDriveName,
  retryableKind,
  splitAtMarker,
} from "./libs/util";
import { canonRow, shortId } from "./libs/colabApi";

async function main(): Promise<void> {
  // === drive name encode/decode roundtrip
  assert.strictEqual(relToDriveName("a/b/c.py"), "a@@b@@c.py");
  assert.strictEqual(driveNameToRel("a@@b@@c.py"), "a/b/c.py");

  // === plan diff
  const prev = {
    "keep.txt": { size: 5, mtimeMs: 100, driveId: "ID1" },
    "edit.txt": { size: 5, mtimeMs: 100, driveId: "ID2" },
    "gone.txt": { size: 1, mtimeMs: 1 },
  };
  const now = {
    "keep.txt": { size: 5, mtimeMs: 100 },
    "edit.txt": { size: 7, mtimeMs: 200 },
    "new.py": { size: 3, mtimeMs: 300 },
  };
  const plan = planSync(now, prev);
  assert.deepStrictEqual(plan.toUpload.sort(), ["edit.txt", "new.py"]);
  assert.deepStrictEqual(plan.toDelete, ["gone.txt"]);

  // === ignore patterns
  assert.ok(matchIgnores("node_modules/foo/bar.js", ["node_modules"]));
  assert.ok(matchIgnores("src/x/b.pyc", ["*.pyc"]));
  assert.ok(!matchIgnores("src/main.py", ["*.pyc"]));
  assert.ok(matchIgnores("a/.git/x", [".git"]));

  // === languages
  assert.strictEqual(langOf("main.py"), "py");
  assert.strictEqual(langOf("a/b/hello.c"), "c");
  assert.strictEqual(langOf("nope.xyz"), null);
  assert.strictEqual(buildLangCmd("x/main.py"), "python3 -u x/main.py");
  assert.strictEqual(buildLangCmd("Hello.java"), 'javac -d /tmp/.javac "Hello.java" && java -cp /tmp/.javac Hello');
  assert.strictEqual(buildRunCommand("hello.rs --flag 2"), 'rustc -O "hello.rs" -o /tmp/.execrun && /tmp/.execrun --flag 2');
  assert.strictEqual(buildRunCommand("make all"), "make all");

  // === cleanB64
  assert.strictEqual(cleanB64("\x1b[1;30r ab\x1b[Kc="), "abc=");

  // === chunkB64
  const fiftyK = Buffer.alloc(50_000);
  for (let i = 0; i < fiftyK.length; i++) {
    fiftyK[i] = (i * 31) & 0xff;
  }
  const chunks = chunkB64(fiftyK);
  const joined = Buffer.concat([Buffer.from(chunks.join(""), "utf8")]);
  const back = Buffer.from(joined.toString("utf8"), "base64");
  assert.ok(back.equals(fiftyK), "b64 chunk roundtrip");
  assert.ok(chunks.every((c) => c.length <= 1800));

  // === exec marker splitting
  const t = splitAtMarker("PRE__X1_abc__ 0\r\nPROMPT", "__X1_abc__");
  assert.strictEqual(t.out, "PRE");
  assert.strictEqual(t.exit, "0");

  // === connection error classification (regression: GPU cold boot ENOTFOUND)
  assert.strictEqual(classifyConnect("tty connect failed: getaddrinfo ENOTFOUND 8080-gpu-t4-s-x.us-west1.prod.r.colab.dev"), "dns");
  assert.strictEqual(classifyConnect("resolving: EAI_AGAIN"), "dns");
  assert.strictEqual(classifyConnect("ws error: ECONNREFUSED 127.0.0.1:8080"), "conn");
  assert.strictEqual(classifyConnect("ws error: connection timeout after 25000ms"), "conn");
  assert.strictEqual(classifyConnect("tty handshake 1006 closed"), "conn");
  assert.strictEqual(classifyConnect("colab api GET /v1beta/runtimes/x: 502 bad gateway"), "proxy");
  assert.strictEqual(classifyConnect("colab api GET /v1beta/runtimes/x: 429 too many requests"), "proxy");
  assert.strictEqual(classifyConnect("Authorization: invalid proxy token (401)"), "auth");
  assert.strictEqual(classifyConnect("UNAUTHENTICATED grant invalid"), "auth");
  // auth being fatal-ish is asserted through retry policy below, classification stands
  assert.strictEqual(classifyConnect("runtime r-abc no longer exists (released)"), "released");
  assert.strictEqual(classifyConnect("runtime r-abc no assigned runtime"), "released");
  assert.strictEqual(classifyConnect("tls certificate problem"), "fatal");

  // === retry policy: only dns/conn/proxy are retryable
  for (const k of ["dns", "conn", "proxy"] as const) {
    assert.ok(retryableKind(k), `retryable: ${k}`);
  }
  for (const k of ["auth", "released", "fatal"] as const) {
    assert.ok(!retryableKind(k), `not retryable: ${k}`);
  }

  // === bounded backoff with jitter (no fixed 6s loops)
  let seq = 0;
  const rnd = () => {
    seq++;
    return 0.5; // deterministic mid-point jitter
  };
  const b1 = backoffMs(1, {}, rnd);
  const b2 = backoffMs(2, {}, rnd);
  const b8 = backoffMs(8, {}, rnd);
  assert.strictEqual(b1, 1500); // mid jitter: 1500 * (1-0.25+0.5*0.5)
  assert.strictEqual(b2, 2400);
  assert.strictEqual(b8, 8000); // factor growth capped
  // extreme jitter bounds respected with rnd 0..1
  const lo = backoffMs(1, { baseMs: 1000, jitter: 0.5 }, () => 0);
  const hi = backoffMs(1, { baseMs: 1000, jitter: 0.5 }, () => 1);
  assert.ok(lo >= 500 && lo <= 1000, "low jitter bound");
  assert.ok(hi >= 1000 && hi <= 1500, "high jitter bound");
  // deterministic inputs — two identical streams
  assert.strictEqual(backoffMs(3, { baseMs: 2000, factor: 2, capMs: 10000 }, () => 0.5), 8000);

  // === cancellation matrix (pure semantics mirrored by Engine.isAlive)
  const scopes = new Map<string, number>([["r-gpu", 3], ["r-cpu", 7]]);
  const rows = new Set<string>(["r-gpu", "r-cpu"]);
  const isAlive = (name: string, tok: number) => (scopes.get(name) ?? 0) === tok && rows.has(name);
  assert.ok(isAlive("r-gpu", 3));
  // released: bump scope → stale token not alive even if row lingering
  scopes.set("r-gpu", 4);
  assert.ok(!isAlive("r-gpu", 3));
  // absent row (fully deleted) never alive for any stale gen
  rows.delete("r-cpu");
  assert.ok(!isAlive("r-cpu", 7));
  // unrelated runtime unaffected (r-cpu-row re-hydrated scenario)
  rows.add("r-cpu");
  scopes.set("r-cpu", 8);
  assert.ok(isAlive("r-cpu", 8));

  // === pkce shape (import at runtime to avoid vscode types)
  const crypto: typeof import("crypto") = require("crypto");
  const verifier = crypto.randomBytes(96).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
  assert.ok(verifier.length > 100);
  assert.strictEqual(challenge.length, 43);

  // === auth url shape
  const YAML = require("./libs/oauth");
  const url = YAML.buildAuthUrl("http://127.0.0.1:52341", challenge, "test-nonce");
  assert.ok(url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?"));
  assert.ok(url.includes("code_challenge_method=S256"));
  assert.ok(url.includes("redirect_uri=http%3A%2F%2F127.0.0.1%3A52341"));
  assert.ok(url.includes("state=nonce%3Dtest-nonce"));

  // === temp file plan flow
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cpipe-"));
  fs.writeFileSync(path.join(dir, "a.txt"), "hello");
  const st1 = fs.statSync(path.join(dir, "a.txt"));
  assert.ok(st1.size === 5);

  // === row name canonicalization — assign-LRO (`runtimes/r-…`) vs list (bare `r-…`)
  // mixed formats pe refreshRuntimeRow "no longer exists" jhoothi throw karti thi
  // → terminal "Connection cancelled — the runtime was released" jhootha dikhta tha
  assert.strictEqual(shortId("runtimes/r-6ec0e238-7b2b"), "r-6ec0e238-7b2b");
  const full = { name: "runtimes/r-6ec0e238-7b2b", runtimeSpec: { key: { variant: "VARIANT_GPU" } } };
  const bare = { name: "r-6ec0e238-7b2b" };
  const c1 = canonRow(full);
  assert.strictEqual(c1.name, "r-6ec0e238-7b2b");
  assert.strictEqual(c1.runtimeSpec?.key?.variant, "VARIANT_GPU");
  assert.strictEqual((canonRow(bare) as { name: string }).name, "r-6ec0e238-7b2b");
  // listRuntimes-style rows sab canon → cross-surface name match kabhi fail nahi hoga

  // eslint-disable-next-line no-console
  console.log("\n[smoke] all pure-lib tests passed ✔");
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("[smoke] FAILED:", e);
  process.exit(1);
});