import OpenAI from "openai";

try {
  process.loadEnvFile();
} catch {
  // no .env file; rely on real env vars
}

export const llm = new OpenAI({
  baseURL: process.env.OLLAMA_BASE_URL ?? "https://ollama.com/v1",
  apiKey: process.env.OLLAMA_API_KEY,
});

export const MODEL = process.env.OLLAMA_MODEL ?? "gpt-oss:120b";
