import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { realDataError } from "../real-data/errors.js";
import {
  ActionIntentSchema,
  type ActionIntent,
  type IntentState
} from "./documents.js";

const LOCK_ATTEMPTS = 80;

export class ActionIntentLedger {
  constructor(private readonly directory: string) {}

  async read(intentId: string): Promise<ActionIntent | null> {
    return this.withLock(async () => this.readUnlocked(intentId));
  }

  async createPrepared(intent: ActionIntent): Promise<ActionIntent> {
    return this.withLock(async () => {
      const existing = await this.readUnlocked(intent.intentId);
      if (existing !== null) return existing;
      await this.writeUnlocked(intent);
      return intent;
    });
  }

  async claimDispatch(intentId: string, permit: ActionIntent["permit"]): Promise<{
    readonly won: boolean;
    readonly intent: ActionIntent;
  }> {
    return this.withLock(async () => {
      const existing = await this.readUnlocked(intentId);
      if (existing === null) {
        throw realDataError("ACTION_OUTCOME_INDETERMINATE", "The action intent ledger has no record to dispatch.");
      }
      if (existing.state !== "prepared" || existing.toolInvocations !== 0) {
        return { won: false, intent: existing };
      }
      const next: ActionIntent = { ...existing, state: "dispatching", permit };
      await this.writeUnlocked(next);
      return { won: true, intent: next };
    });
  }

  async transition(
    intentId: string,
    from: readonly IntentState[],
    next: ActionIntent
  ): Promise<ActionIntent> {
    return this.withLock(async () => {
      const existing = await this.readUnlocked(intentId);
      if (existing === null) {
        throw realDataError("ACTION_OUTCOME_INDETERMINATE", "The action intent ledger has no record to advance.");
      }
      if (!from.includes(existing.state)) return existing;
      if (next.intentId !== intentId) {
        throw realDataError("ACTION_NOT_ALLOWED", "An action intent cannot change its identity.");
      }
      if (next.toolInvocations < existing.toolInvocations) {
        throw realDataError("ACTION_NOT_ALLOWED", "An action intent cannot forget a tool invocation.");
      }
      await this.writeUnlocked(next);
      return next;
    });
  }

  async list(): Promise<readonly ActionIntent[]> {
    return this.withLock(async () => {
      await mkdir(this.directory, { recursive: true });
      const { readdir } = await import("node:fs/promises");
      const names = await readdir(this.directory);
      const intents: ActionIntent[] = [];
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const intentId = name.slice(0, -".json".length);
        const intent = await this.readUnlocked(intentId);
        if (intent !== null) intents.push(intent);
      }
      return intents;
    });
  }

  private async readUnlocked(intentId: string): Promise<ActionIntent | null> {
    try {
      const raw = await readFile(this.path(intentId), "utf8");
      return ActionIntentSchema.parse(JSON.parse(raw));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw error;
    }
  }

  private async writeUnlocked(intent: ActionIntent): Promise<void> {
    ActionIntentSchema.parse(intent);
    await mkdir(this.directory, { recursive: true });
    const destination = this.path(intent.intentId);
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(intent)}\n`, "utf8");
    await rename(temporary, destination);
  }

  private path(intentId: string): string {
    if (!/^[a-f0-9]{64}$/.test(intentId)) {
      throw realDataError("ACTION_NOT_ALLOWED", "The action intent id is not a SHA-256 digest.");
    }
    return join(this.directory, `${intentId}.json`);
  }

  private async withLock<T>(body: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const lock = join(this.directory, ".lock");
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      try {
        await mkdir(lock);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        await delay(5 + attempt);
        continue;
      }
      try {
        return await body();
      } finally {
        await rm(lock, { recursive: true, force: true });
      }
    }
    throw realDataError(
      "ACTION_OUTCOME_INDETERMINATE",
      "The action intent ledger is locked by another recovery."
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
