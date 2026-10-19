const MODEL = "qwen3-embedding:0.6b";

export async function embed(text: string): Promise<number[]> {
  const response = await fetch(
    "http://127.0.0.1:11434/api/embed",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        input: text
      }),
      signal: AbortSignal.timeout(120000)
    }
  );

  if (!response.ok) {
    throw new Error(`Embedding failed: ${response.status}`);
  }

  const data = await response.json() as {
    embeddings?: number[][];
  };

  const vector = data.embeddings?.[0];

  if (!vector?.length || !vector.every(Number.isFinite)) {
    throw new Error("Invalid embedding returned by Ollama");
  }

  return vector;
}

export function cosineSimilarity(
  a: number[],
  b: number[]
): number {
  if (a.length !== b.length || a.length === 0) return -1;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (!normA || !normB) return -1;

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
