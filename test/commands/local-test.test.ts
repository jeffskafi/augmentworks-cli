import { describe, expect, it } from "vitest";

import { installLocalInterruptHandler } from "../../src/commands/local-test.js";

describe("local-test progress copy", () => {
  it("does not label cancellation cleanup as synthetic", () => {
    const chunks: string[] = [];
    const listeners = new Map<string, () => void>();
    const host = {
      on(event: "SIGINT", listener: () => void) {
        listeners.set(event, listener);
        return host;
      },
      off(event: "SIGINT") {
        listeners.delete(event);
        return host;
      },
      exit(): never {
        throw new Error("exit should not run on the first SIGINT");
      }
    };
    let cancelled = 0;
    const restore = installLocalInterruptHandler(
      { requestCancellation: () => {
        cancelled += 1;
      } },
      {
        host,
        stderr: {
          write(chunk) {
            chunks.push(String(chunk));
            return true;
          }
        }
      }
    );
    listeners.get("SIGINT")?.();
    restore();
    expect(cancelled).toBe(1);
    expect(chunks.join("")).toContain("draining cleanup");
    expect(chunks.join("")).not.toContain("synthetic");
  });
});
