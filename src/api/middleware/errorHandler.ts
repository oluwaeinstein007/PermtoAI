import type { Context, Next } from "hono";
import { ZodError } from "zod";

export async function errorHandler(c: Context, next: Next) {
  try {
    await next();
  } catch (error) {
    if (error instanceof ZodError) {
      return c.json(
        {
          success: false,
          error: "Invalid request body",
          details: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
        },
        400
      );
    }
    const message =
      error instanceof Error ? error.message : "An unexpected error occurred";
    console.error("[API] Error:", message);
    return c.json({ success: false, error: message }, 500);
  }
}
