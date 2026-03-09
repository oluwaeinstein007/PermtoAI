#!/usr/bin/env node
import "dotenv/config";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { errorHandler } from "./middleware/errorHandler.js";
import toolsRouter from "./routes/tools.js";
import agentRouter from "./routes/agent.js";

const app = new Hono();

// Global error handling
app.use("*", errorHandler);

// Health check
app.get("/api/v1/health", (c) => {
  return c.json({
    success: true,
    status: "ok",
    service: "PermitoAI REST API",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    tools: [
      "HAZARD_SUGGEST",
      "RISK_ASSESS",
      "COMPLIANCE_CHECK",
      "PERMIT_VALIDATE",
      "ANOMALY_DETECT",
    ],
  });
});

// Tool routes: direct 1:1 wrappers for each MCP tool
app.route("/api/v1/tools", toolsRouter);

// Agent routes: orchestrated multi-step workflows
app.route("/api/v1/agent", agentRouter);

// 404 fallback
app.notFound((c) => {
  return c.json({ success: false, error: `Route not found: ${c.req.path}` }, 404);
});

const port = parseInt(process.env.API_PORT ?? "4000", 10);

serve({ fetch: app.fetch, port }, () => {
  console.log(`\nPermitoAI REST API running on http://localhost:${port}`);
  console.log("\nTool endpoints:");
  console.log(`  GET  http://localhost:${port}/api/v1/health`);
  console.log(`  POST http://localhost:${port}/api/v1/tools/hazard-suggest`);
  console.log(`  POST http://localhost:${port}/api/v1/tools/risk-assess`);
  console.log(`  POST http://localhost:${port}/api/v1/tools/compliance-check`);
  console.log(`  POST http://localhost:${port}/api/v1/tools/permit-validate`);
  console.log(`  POST http://localhost:${port}/api/v1/tools/anomaly-detect`);
  console.log("\nAgent endpoints:");
  console.log(`  GET  http://localhost:${port}/api/v1/agent/tools`);
  console.log(`  POST http://localhost:${port}/api/v1/agent/full-assessment`);
  console.log(`  POST http://localhost:${port}/api/v1/agent/quick-assess`);
  console.log(
    "\nNote: MCP server runs separately on port 3000 (pnpm start --http)"
  );
});
