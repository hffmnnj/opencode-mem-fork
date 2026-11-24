import { execFile } from "node:child_process";
import { devNull } from "node:os";
import { resolveTrustedGitCommand } from "./tags.js";

const MAX_CANDIDATES = 3;
const MAX_BLOB_BYTES = 256 * 1024;
const MAX_QUOTE_LENGTH = 400;
const GIT_TIMEOUT_MS = 1_000;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface CodeAnchorCandidate {
  path: string;
  line: number;
  quote: string;
}

export interface VerifiedCodeAnchor extends CodeAnchorCandidate {
  sha: string;
  /** When the excerpt was matched to this revision, not a claim about truth, freshness or the working tree. */
  verifiedAt: string;
}

function git(
  cwd: string,
  args: string[],
  maxBuffer = 4096,
  input?: string
): Promise<Buffer | undefined> {
  const command = resolveTrustedGitCommand(cwd);
  // Never run model-supplied paths through a command shell.
  if (!command || command.shell !== false) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const child = execFile(
      command.executable,
      ["--literal-pathspecs", ...args],
      {
        cwd,
        env: {
          PATH: process.env.PATH,
          LC_ALL: "C",
          GIT_CONFIG_GLOBAL: devNull,
          GIT_CONFIG_SYSTEM: devNull,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_NO_REPLACE_OBJECTS: "1",
          GIT_NO_LAZY_FETCH: "1",
          GIT_ALLOW_PROTOCOL: "",
          GIT_TERMINAL_PROMPT: "0",
        },
        encoding: "buffer",
        timeout: GIT_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer,
      },
      (error, stdout) => resolve(error ? undefined : stdout)
    );
    // A failed or timed-out child can close its pipe before consuming the request.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

function eligible(candidate: CodeAnchorCandidate, sourceTexts: readonly string[]): boolean {
  const { path, line, quote } = candidate;
  return (
    typeof path === "string" &&
    typeof quote === "string" &&
    path.length <= 1024 &&
    !/[\\:\p{Cc}]/u.test(path) &&
    // Unpaired surrogates would be replaced when encoding an argv element.
    !/\p{Cs}/u.test(path) &&
    path
      .split("/")
      .every(
        (segment) =>
          segment &&
          !segment.startsWith("-") &&
          segment !== "." &&
          segment !== ".." &&
          segment.toLowerCase() !== ".git"
      ) &&
    Number.isSafeInteger(line) &&
    line > 0 &&
    quote.length <= MAX_QUOTE_LENGTH &&
    quote.replace(/\s/gu, "").length >= 8 &&
    /[\p{L}\p{N}]/u.test(quote) &&
    !quote.includes("\0") &&
    sourceTexts.some((source) => source.includes(quote))
  );
}

async function committedBlob(cwd: string, sha: string, path: string): Promise<string | undefined> {
  const tree = await git(cwd, ["ls-tree", "-l", "-z", "--full-tree", sha, "--", path], 8192);
  if (!tree) return;
  const entry = /^(100644|100755) blob ([a-f0-9]+) +([0-9]+)\t([^\0]+)\0$/u.exec(utf8.decode(tree));
  if (!entry || entry[4] !== path) return;
  const oid = entry[2] ?? "";
  const size = Number(entry[3]);
  if (!OBJECT_ID.test(oid) || oid.length !== sha.length || size > MAX_BLOB_BYTES) return;

  const result = await git(cwd, ["cat-file", "--batch"], MAX_BLOB_BYTES + 128, `${oid}\n`);
  const header = `${oid} blob ${size}\n`;
  if (
    !result ||
    result.length !== header.length + size + 1 ||
    !result.subarray(0, header.length).equals(Buffer.from(header)) ||
    result[result.length - 1] !== 10
  ) {
    return;
  }
  const data = result.subarray(header.length, -1);
  if (data.includes(0)) return;
  return utf8.decode(data);
}

/**
 * Only verifies an exact conversation excerpt against a committed regular file at the repository
 * root's sampled HEAD. The caller selects eligible sources; no working-tree files are read.
 */
export async function validateCodeAnchors(
  projectDir: string,
  candidates: readonly CodeAnchorCandidate[],
  eligibleSourceTexts: readonly string[]
): Promise<VerifiedCodeAnchor[]> {
  if (candidates.length === 0 || candidates.length > MAX_CANDIDATES) return [];
  // Copy validated fields before the first await so the checked values are the ones sent to Git.
  const eligibleCandidates = candidates.flatMap((candidate) => {
    if (!candidate) return [];
    const { path, line, quote } = candidate;
    const snapshot = { path, line, quote };
    return eligible(snapshot, eligibleSourceTexts) ? [snapshot] : [];
  });
  if (eligibleCandidates.length === 0) return [];

  let sha: string;
  try {
    const root = await git(projectDir, ["rev-parse", "--is-inside-work-tree", "--show-prefix"]);
    if (root?.toString() !== "true\n\n") return [];
    const head = await git(projectDir, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const match = /^([a-f0-9]+)\n$/u.exec(head?.toString() ?? "");
    sha = match?.[1] ?? "";
    if (!OBJECT_ID.test(sha)) return [];
  } catch {
    return [];
  }

  const anchors: VerifiedCodeAnchor[] = [];
  for (const candidate of eligibleCandidates) {
    try {
      const { path, line, quote } = candidate;
      const blob = await committedBlob(projectDir, sha, path);
      if (blob === undefined) continue;
      const lines = blob.split("\n");
      const span = quote.split("\n").length;
      if (
        line <= lines.length &&
        lines
          .slice(line - 1, line - 1 + span)
          .join("\n")
          .includes(quote)
      ) {
        anchors.push({ path, line, sha, quote, verifiedAt: new Date().toISOString() });
      }
    } catch {
      // Malformed text/object data or a failed spawn is not verification.
    }
  }
  return anchors;
}
