import { GoogleGenAI } from "@google/genai";
import { env } from "../config.js";

let _genai: GoogleGenAI | null = null;
function getGenAI(): GoogleGenAI {
  if (!_genai) {
    _genai = new GoogleGenAI({ apiKey: env.GOOGLE_API_KEY });
  }
  return _genai;
}

/**
 * Embed a text string into a vector for Qdrant queries.
 */
export async function embedText(text: string): Promise<number[]> {
  const response = await getGenAI().models.embedContent({
    model: env.GOOGLE_EMBEDDING_MODEL,
    contents: text,
    config: {
      outputDimensionality: env.EMBEDDING_DIMENSIONS,
    },
  });

  const values = response.embeddings?.[0]?.values;
  if (!values) {
    throw new Error("No embedding returned from Gemini");
  }
  return values;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
}

/**
 * Call Gemini chat completion with structured JSON output.
 * Temperature is set to 0 for safety-critical consistency.
 */
export class AIUnavailableError extends Error {
  constructor(cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`AI service unavailable: ${msg}`);
    this.name = "AIUnavailableError";
  }
}

export async function chatCompletion(
  messages: ChatMessage[],
  jsonMode: boolean = true
): Promise<ChatCompletionResult> {
  const systemMsg = messages.find((m) => m.role === "system");
  const userMessages = messages.filter((m) => m.role !== "system");

  const contents = userMessages.map((m) => ({
    role: m.role === "assistant" ? ("model" as const) : ("user" as const),
    parts: [{ text: m.content }],
  }));

  try {
    const response = await getGenAI().models.generateContent({
      model: env.GEMINI_MODEL,
      contents,
      config: {
        systemInstruction: systemMsg?.content,
        temperature: env.AI_TEMPERATURE,
        responseMimeType: jsonMode ? "application/json" : undefined,
      },
    });

    const text = response.text;
    if (!text) {
      throw new Error("No text returned from Gemini");
    }

    return {
      content: text,
      promptTokens: response.usageMetadata?.promptTokenCount ?? 0,
      completionTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
    };
  } catch (err) {
    // Wrap network/fetch errors so callers can distinguish AI failures
    // from application errors and degrade gracefully.
    if (err instanceof AIUnavailableError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("fetch failed") ||
      msg.includes("ECONNREFUSED") ||
      msg.includes("ENOTFOUND") ||
      msg.includes("ETIMEDOUT") ||
      msg.includes("network") ||
      msg.includes("TypeError: fetch")
    ) {
      throw new AIUnavailableError(err);
    }
    throw err;
  }
}
