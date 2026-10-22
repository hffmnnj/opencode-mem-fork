import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

const fixturePath = fileURLToPath(
  new URL("./fixtures/memory-context-selection.fixture.ts", import.meta.url)
);

// Isolate profile mocks: mock.restore does not reload cached dependency graphs.
function runFixture() {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", fixturePath],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: Buffer.from(result.stdout).toString("utf8"),
    stderr: Buffer.from(result.stderr).toString("utf8"),
  };
}

describe("memory context selection (isolated subprocess)", () => {
  it("selector/formatter suite passes in isolation", () => {
    const result = runFixture();
    if (result.exitCode !== 0) {
      throw new Error(
        `memory-context-selection fixture failed (exit ${result.exitCode})\n--- stderr ---\n${result.stderr}\n--- stdout ---\n${result.stdout}`
      );
    }
    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toMatch(/\b[1-9]\d* pass\b/);
    expect(result.stdout + result.stderr).toContain("0 fail");
  }, 30_000);
});
