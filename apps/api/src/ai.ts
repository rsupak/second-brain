import Database from "better-sqlite3";
import { createInferenceLock, LOCK_NAME, type LockCallOptions } from "./inference-lock.js";

export class InferenceLockMissingError extends Error {
  constructor(dbPath: string) {
    super(
      `inference_lock table or '${LOCK_NAME}' row is missing in ${dbPath}. ` +
      `Run: BRAIN_DB=${dbPath} ./node_modules/.bin/tsx apps/api/src/migrate-inference-lock.ts`
    );
    this.name = "InferenceLockMissingError";
  }
}

let inferenceLock: ReturnType<typeof createInferenceLock> | undefined;
let lockHooks: Pick<LockCallOptions, "onAcquire" | "onRelease"> = {};

/** Optional instrumentation for tests. Does not change locking behavior. */
export function setInferenceLockHooks(hooks: Pick<LockCallOptions, "onAcquire" | "onRelease">) {
  lockHooks = hooks;
}

function getInferenceLock() {
  if (inferenceLock) return inferenceLock;
  const dbPath = process.env.BRAIN_DB ?? "./data/brain.sqlite";
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  const hasTable = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'inference_lock'`
  ).get();
  const hasRow = hasTable &&
    db.prepare(`SELECT 1 FROM inference_lock WHERE name = ?`).get(LOCK_NAME);
  if (!hasRow) {
    db.close();
    throw new InferenceLockMissingError(dbPath);
  }
  inferenceLock = createInferenceLock(db);
  return inferenceLock;
}

interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface GenerateOptions {
  format?: "json";
  temperature?: number;
  numPredict?: number;
  timeoutMs?: number;
  /** Optional context window; defaults to 2048 (unchanged behavior). */
  numCtx?: number;
  /** Optional model override; defaults to qwen3:4b (unchanged behavior). */
  model?: string;
  /** Optional Ollama think flag; defaults to false (unchanged behavior). */
  think?: boolean;
}

export async function generateResponse(
  messages: OllamaMessage[],
  options: GenerateOptions = {}
): Promise<string> {
  return getInferenceLock().withInferenceLock(
    lockSignal => callOllama(messages, options, lockSignal),
    lockHooks
  );
}

async function callOllama(
  messages: OllamaMessage[],
  options: GenerateOptions,
  lockSignal: AbortSignal
): Promise<string> {
  const response = await fetch(
    "http://127.0.0.1:11434/api/chat",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: options.model ?? "qwen3:4b",
        messages,
        stream: false,
        think: options.think ?? false,
        ...(options.format
          ? { format: options.format }
          : {}),
        options: {
          temperature: options.temperature ?? 0.2,
          num_ctx: options.numCtx ?? 2048,
          num_predict: options.numPredict ?? 700
        }
      }),
      signal: AbortSignal.any([
        lockSignal,
        AbortSignal.timeout(options.timeoutMs ?? 300000)
      ])
    }
  );

  if (!response.ok) {
    const details = await response.text();

    throw new Error(
      `Ollama request failed (${response.status}): ${details}`
    );
  }

  const data = await response.json() as {
    message?: {
      content?: string;
    };
    done_reason?: string;
  };

  const content = (data.message?.content ?? "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^[\s\S]*?<\/think>/, "")
    .trim();

  if (!content) {
    throw new Error(
      `Ollama returned empty content. Completion reason: ${
        data.done_reason ?? "unknown"
      }`
    );
  }

  if (
    options.format === "json" &&
    data.done_reason !== "stop"
  ) {
    throw new Error(
      `Ollama did not finish JSON generation. Reason: ${
        data.done_reason ?? "unknown"
      }. Output preview: ${content.slice(0, 250)}`
    );
  }

  return content;
}

/**
 * Embeddings through the same cross-process inference lock as generateResponse().
 * Returns one vector per input, in order.
 */
export async function embedTexts(
  inputs: string[],
  options: { model?: string; timeoutMs?: number } = {}
): Promise<number[][]> {
  if (inputs.length === 0) return [];
  return getInferenceLock().withInferenceLock(async lockSignal => {
    const response = await fetch("http://127.0.0.1:11434/api/embed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: options.model ?? "qwen3-embedding:0.6b", input: inputs }),
      signal: AbortSignal.any([lockSignal, AbortSignal.timeout(options.timeoutMs ?? 120000)])
    });
    if (!response.ok) {
      throw new Error(`Embedding failed (${response.status}): ${await response.text()}`);
    }
    const data = await response.json() as { embeddings?: number[][] };
    const vectors = data.embeddings ?? [];
    if (vectors.length !== inputs.length ||
        !vectors.every(v => v.length > 0 && v.every(Number.isFinite))) {
      throw new Error("Invalid embeddings returned by Ollama");
    }
    return vectors;
  }, lockHooks);
}
