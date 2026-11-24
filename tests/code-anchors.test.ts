import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { validateCodeAnchors } from "../src/services/code-anchors";

const opening = "export function anchor() {";
const statement = "  return 'committed';";
const multilineQuote = `${opening}\n${statement}`;
const dirtyQuote = "  return 'working tree only';";
const original = `// heading\n${multilineQuote}\n}\n`;
const crlfQuote = "export const first = 1;\r\nexport const second = 2;";

let scratch: string;
let repo: string;
let head: string;
const files: string[] = [];
const directories: string[] = [];

async function dir(path: string) {
  if (!directories.includes(path)) {
    await mkdir(path);
    directories.push(path);
  }
}

async function file(path: string, contents: string | Buffer) {
  await writeFile(path, contents);
  files.push(path);
}

// A real Git object database, assembled only in scratch space without Git mutations.
async function object(type: string, contents: string | Buffer) {
  const data = Buffer.from(contents);
  const objectBytes = Buffer.concat([Buffer.from(`${type} ${data.length}\0`), data]);
  const oid = createHash("sha1").update(objectBytes).digest("hex");
  const bucket = join(repo, ".git", "objects", oid.slice(0, 2));
  await dir(bucket);
  await file(join(bucket, oid.slice(2)), deflateSync(objectBytes));
  return oid;
}

function entry(mode: string, path: string, oid: string) {
  return Buffer.concat([Buffer.from(`${mode} ${path}\0`), Buffer.from(oid, "hex")]);
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "mem-code-anchor-"));
  directories.push(scratch);
  repo = join(scratch, "repo");
  await dir(repo);
  await dir(join(repo, ".git"));
  await dir(join(repo, ".git", "objects"));
  await dir(join(repo, ".git", "refs"));
  await dir(join(repo, ".git", "refs", "replace"));
  await dir(join(repo, "src"));

  const regular = await object("blob", original);
  const dirty = await object("blob", `// heading\n${opening}\n${dirtyQuote}\n}\n`);
  const crlf = await object("blob", crlfQuote + "\r\n");
  const oversized = await object("blob", original + "x".repeat(256 * 1024));
  const nested = await object(
    "tree",
    Buffer.concat([
      entry("100644", "-anchor.ts", regular),
      entry("100644", "anchor.ts", regular),
      entry("100755", "executable.ts", crlf),
      entry("100644", "literal[1].ts", crlf),
    ])
  );
  const symlinkTarget = await object("blob", "src/anchor.ts");
  const tree = await object(
    "tree",
    Buffer.concat([
      entry("120000", "link.ts", symlinkTarget),
      entry("100644", "oversized.ts", oversized),
      entry("40000", "src", nested),
    ])
  );
  const identity = "Fixture <fixture@example.invalid> 1000000000 +0000";
  head = await object(
    "commit",
    `tree ${tree}\nauthor ${identity}\ncommitter ${identity}\n\nfixture\n`
  );
  await file(join(repo, ".git", "HEAD"), `${head}\n`);
  await file(join(repo, ".git", "refs", "replace", regular), `${dirty}\n`);
  await file(join(repo, "src", "anchor.ts"), `// heading\n${opening}\n${dirtyQuote}\n}\n`);
});

afterAll(async () => {
  for (const path of files.reverse()) await unlink(path);
  for (const path of directories.reverse()) await rmdir(path);
});

test("matches an exact multiline conversation quote at committed HEAD despite dirty files and replacement refs", async () => {
  const candidate = { path: "src/anchor.ts", line: 2, quote: multilineQuote };
  const before = Date.now();
  const anchors = await validateCodeAnchors(
    repo,
    [candidate, { ...candidate, line: 3, quote: dirtyQuote }],
    [`An eligible message:\n${multilineQuote}`, dirtyQuote]
  );

  expect(anchors).toEqual([{ ...candidate, sha: head, verifiedAt: expect.any(String) }]);
  const timestamp = Date.parse(anchors[0]!.verifiedAt);
  expect(timestamp).toBeGreaterThanOrEqual(before);
  expect(timestamp).toBeLessThanOrEqual(Date.now());
});

test("rejects both a fabricated conversation quote and a quote provided at the wrong line", async () => {
  expect(
    await validateCodeAnchors(
      repo,
      [
        { path: "src/anchor.ts", line: 2, quote: opening },
        { path: "src/anchor.ts", line: 2, quote: statement },
      ],
      [statement]
    )
  ).toEqual([]);
});

test.each([
  "../repo/src/anchor.ts",
  "src/../src/anchor.ts",
  "src//anchor.ts",
  "src/-anchor.ts",
  "src/\0anchor.ts",
])("rejects unsafe candidate path %j", async (path) => {
  expect(await validateCodeAnchors(repo, [{ path, line: 2, quote: opening }], [opening])).toEqual(
    []
  );
});

test.each([0, -1, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "2"])(
  "rejects malformed line %j",
  async (line) => {
    expect(
      await validateCodeAnchors(
        repo,
        [{ path: "src/anchor.ts", line: line as number, quote: opening }],
        [opening]
      )
    ).toEqual([]);
  }
);

test("rejects symlink blobs, oversized blobs and absolute paths even if the text matches", async () => {
  expect(
    await validateCodeAnchors(
      repo,
      [
        { path: "link.ts", line: 1, quote: "src/anchor.ts" },
        { path: "oversized.ts", line: 2, quote: opening },
        { path: join(repo, "src", "anchor.ts"), line: 2, quote: opening },
      ],
      ["src/anchor.ts", opening]
    )
  ).toEqual([]);
});

test("matches literal filenames and exact CRLF bytes without normalizing them", async () => {
  const literal = { path: "src/literal[1].ts", line: 1, quote: crlfQuote };
  const normalized = crlfQuote.replace("\r\n", "\n");
  expect(
    await validateCodeAnchors(
      repo,
      [literal, { ...literal, path: "src/executable.ts" }, { ...literal, quote: normalized }],
      [crlfQuote, normalized]
    )
  ).toEqual([
    { ...literal, sha: head, verifiedAt: expect.any(String) },
    { ...literal, path: "src/executable.ts", sha: head, verifiedAt: expect.any(String) },
  ]);
});

test("fails closed for excessive candidates, failed Git lookup and non-root project directories", async () => {
  const candidate = { path: "src/anchor.ts", line: 2, quote: opening };
  expect(await validateCodeAnchors(repo, Array(4).fill(candidate), [opening])).toEqual([]);
  expect(await validateCodeAnchors(scratch, [candidate], [opening])).toEqual([]);
  expect(await validateCodeAnchors(join(repo, "src"), [candidate], [opening])).toEqual([]);
  expect(await validateCodeAnchors(join(scratch, "missing"), [candidate], [opening])).toEqual([]);
});
