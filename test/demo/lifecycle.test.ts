import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runDemo } from "../../src/demo/orchestrator.js";
import { AwError, EXIT } from "../../src/errors.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("demo lifecycle failures", () => {
  it("surfaces startup failure without starting assessments", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "augmentworks-demo-life-"));
    directories.push(cwd);
    await expect(
      runDemo(
        { cwd, outputDirectory: join(cwd, "out"), handleSignals: false },
        {
          stderr: { write: () => true },
          startTarget: async () => {
            throw new AwError({
              code: "DEMO_STARTUP_FAILED",
              category: "target",
              message: "bind failed"
            });
          }
        }
      )
    ).rejects.toMatchObject({ code: "DEMO_STARTUP_FAILED" });
  });

  it("times out when the overall bound elapses before readiness", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "augmentworks-demo-life-"));
    directories.push(cwd);
    await expect(
      runDemo(
        { cwd, outputDirectory: join(cwd, "out"), handleSignals: false, timeoutMs: 20 },
        {
          stderr: { write: () => true },
          startTarget: async (options) =>
            await new Promise((_, reject) => {
              const fail = (): void => {
                reject(
                  options.signal?.reason instanceof Error
                    ? options.signal.reason
                    : new AwError({
                        code: "DEMO_TIMEOUT",
                        category: "target",
                        message: "aborted before listen"
                      })
                );
              };
              if (options.signal?.aborted === true) {
                fail();
                return;
              }
              options.signal?.addEventListener("abort", fail, { once: true });
            })
        }
      )
    ).rejects.toMatchObject({ code: "DEMO_TIMEOUT" });
  }, 10_000);

  it("does not hide a listener close failure after a passing story", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "augmentworks-demo-life-"));
    directories.push(cwd);
    const result = await runDemo(
      {
        cwd,
        outputDirectory: join(cwd, "out"),
        handleSignals: false,
        mode: "corrected",
        policies: { faulty: "enforce-limit", corrected: "enforce-limit" }
      },
      {
        stderr: { write: () => true },
        startTarget: async (options) => {
          const { startDemoTarget } = await import("../../src/demo/target.js");
          const target = await startDemoTarget(options);
          return {
            ...target,
            close: async () => {
              await target.close();
              throw new AwError({
                code: "DEMO_CLEANUP_FAILED",
                category: "cleanup",
                message: "listener close failed"
              });
            }
          };
        }
      }
    );
    expect(result.exitCode).toBe(EXIT.CLEANUP);
    expect(result.summary.ok).toBe(false);
    expect(result.summary.cleanup.ok).toBe(false);
  }, 30_000);

  it("closes the listener after interrupt and does not leave it accepting traffic", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "augmentworks-demo-life-"));
    directories.push(cwd);
    let fire: (() => void) | undefined;
    let baseUrl: string | undefined;
    const result = await runDemo(
      {
        cwd,
        outputDirectory: join(cwd, "out"),
        handleSignals: true,
        mode: "full"
      },
      {
        stderr: { write: () => true },
        signals: {
          on(_event, listener) {
            fire = listener;
          },
          off() {
            fire = undefined;
          },
          exit() {
            throw new Error("forced exit should not run in this test");
          }
        },
        startTarget: async (options) => {
          const { startDemoTarget } = await import("../../src/demo/target.js");
          const target = await startDemoTarget(options);
          baseUrl = target.baseUrl;
          return target;
        },
        local: {
          onProgress(event) {
            if (event.type === "attempt_started") fire?.();
          }
        }
      }
    );
    expect(result.exitCode).toBe(EXIT.INTERRUPTED);
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    await expect(fetch(`${baseUrl!}/health`, { signal: AbortSignal.timeout(1_000) })).rejects.toBeTruthy();
  }, 30_000);
});
