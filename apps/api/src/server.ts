import Fastify from "fastify";
import { z } from "zod";
import {
  saveMemory,
  searchMemories,
  listMemories
} from "./database.js";
import { chat } from "./chat.js";
import {
  semanticSearch,
  reindexMemories,
  indexMemory
} from "./semantic-memory.js";
import {
  createOriginalIdea,
  listIdeas,
  getIdeaTree,
  getIdea,
  getJob
} from "./ideas.js";
import {
  queueEvaluations,
  listEvaluations
} from "./evaluations.js";
import Database from "better-sqlite3";
import { researchRoutes } from "./research-routes.js";

const app = Fastify({ logger: true });

app.get("/health", async () => ({
  status: "ok",
  service: "second-brain",
  version: "0.1.0"
}));

app.post("/memories", async (request, reply) => {
  const schema = z.object({
    category: z.string().min(1),
    content: z.string().min(1)
  });

  const result = schema.safeParse(request.body);

  if (!result.success) {
    return reply.code(400).send({
      error: "Invalid memory",
      details: result.error.issues
    });
  }

  const memory = saveMemory(
    result.data.category,
    result.data.content
  );
  
  try {
    await indexMemory(memory);
  } catch (error) {
    request.log.error(error, "Memory indexing failed");
  }
  
  return reply.code(201).send(memory);
});

app.get("/memories", async () => {
  return listMemories();
});

app.get("/memories/search", async (request, reply) => {
  const schema = z.object({
    q: z.string().min(1)
  });

  const result = schema.safeParse(request.query);

  if (!result.success) {
    return reply.code(400).send({
      error: "A search query is required"
    });
  }

  return searchMemories(result.data.q);
});

app.post("/chat", async (request, reply) => {
  const schema = z.object({
    sessionId: z.string().min(1).max(128),
    message: z.string().min(1).max(10000)
  });

  const result = schema.safeParse(request.body);

  if (!result.success) {
    return reply.code(400).send({
      error: "Invalid chat request",
      details: result.error.issues
    });
  }

  try {
    const response = await chat(
      result.data.sessionId,
      result.data.message
    );

    return {
      sessionId: result.data.sessionId,
      response
    };
  } catch (error) {
    request.log.error(error);

    return reply.code(503).send({
      error: "AI response unavailable"
    });
  }
});

app.post("/memories/reindex", async () => {
  return reindexMemories();
});

app.get("/memories/semantic-search", async (request, reply) => {
  const result = z.object({
    q: z.string().min(1)
  }).safeParse(request.query);

  if (!result.success) {
    return reply.code(400).send({
      error: "A search query is required"
    });
  }

  return semanticSearch(result.data.q);
});

app.post("/ideas", async (request, reply) => {
  const parsed = z.object({
    title: z.string().trim().min(1).max(200),
    content: z.string().trim().min(1).max(10000)
  }).safeParse(request.body);

  if (!parsed.success) {
    return reply.code(400).send({
      error: "Invalid idea",
      details: parsed.error.issues
    });
  }

  const result = createOriginalIdea(
    parsed.data.title,
    parsed.data.content
  );

  return reply.code(201).send(result);
});

app.get("/ideas", async () => listIdeas());

app.get("/ideas/:id/tree", async (request, reply) => {
  const { id } = request.params as { id: string };

  if (!getIdea(id)) {
    return reply.code(404).send({ error: "Idea not found" });
  }

  return getIdeaTree(id);
});

app.get("/jobs/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const job = getJob(id);

  if (!job) {
    return reply.code(404).send({ error: "Job not found" });
  }

  return job;
});

app.post("/evaluations/queue", async () => {
  return queueEvaluations();
});

app.get("/evaluations", async () => {
  return listEvaluations();
});

app.get("/evaluations/status", async () => {
  const Database = (await import("better-sqlite3")).default;
  const db = new Database("./data/brain.sqlite");

  try {
    return db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM evaluation_jobs
      GROUP BY status
    `).all();
  } finally {
    db.close();
  }
});

// Research API + dashboard (own connection; BRAIN_DB honoured, same default path).
const researchDb = new Database(process.env.BRAIN_DB ?? "./data/brain.sqlite");
researchDb.pragma("journal_mode = WAL");
researchDb.pragma("foreign_keys = ON");
researchDb.pragma("busy_timeout = 5000");
app.register(researchRoutes, { db: researchDb });

async function start() {
  try {
    await app.listen({
      port: 3333,
      host: "127.0.0.1"
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

start();
