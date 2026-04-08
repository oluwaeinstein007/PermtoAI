#!/usr/bin/env node
import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { errorHandler } from "./middleware/errorHandler.js";
import toolsRouter from "./routes/tools.js";
import agentRouter from "./routes/agent.js";
import routingRouter from "./routes/routing.js";
import fraudRouter from "./routes/fraud.js";
import analyticsRouter from "./routes/analytics.js";

const app = new Hono();

// CORS — allow all origins
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

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
      "SIMOPS_CHECK",
    ],
  });
});

// Tool routes: direct 1:1 wrappers for each MCP tool
app.route("/api/v1/tools", toolsRouter);

// Agent routes: orchestrated multi-step workflows
app.route("/api/v1/agent", agentRouter);

// Routing routes: intelligent permit routing & pre-submission checks (Feature 1)
app.route("/api/v1/agent/routing", routingRouter);

// Alias routes: frontend calls /api/agent/permits/:id/... (no v1, permit ID in path)
// Delegate to the same routing handlers, ignoring the ID (it comes in the request body)
app.post("/api/agent/permits/:id/pre-submission-check", (c) =>
  routingRouter.fetch(
    new Request("http://localhost/pre-submission-check", {
      method: "POST",
      headers: c.req.raw.headers,
      body: c.req.raw.body,
    }),
    c.env
  )
);
app.post("/api/agent/permits/:id/recommend-routing", (c) =>
  routingRouter.fetch(
    new Request("http://localhost/recommend", {
      method: "POST",
      headers: c.req.raw.headers,
      body: c.req.raw.body,
    }),
    c.env
  )
);

// Fraud routes: behavioral anomaly detection & consistency checks (Feature 2)
app.route("/api/v1/agent/fraud", fraudRouter);

// Analytics routes: trends, predictions, incident correlation, compliance (Feature 3)
app.route("/api/v1/agent/analytics", analyticsRouter);

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
  console.log(`  POST http://localhost:${port}/api/v1/tools/simops-check`);
  console.log("\nAgent endpoints:");
  console.log(`  GET  http://localhost:${port}/api/v1/agent/tools`);
  console.log(`  POST http://localhost:${port}/api/v1/agent/full-assessment`);
  console.log(`  POST http://localhost:${port}/api/v1/agent/quick-assess`);
  console.log(`  POST http://localhost:${port}/api/v1/agent/simops-assess`);
  console.log("\nRouting endpoints (Feature 1 — Intelligent Permit Routing):");
  console.log(`  POST http://localhost:${port}/api/v1/agent/routing/recommend`);
  console.log(`  POST http://localhost:${port}/api/v1/agent/routing/pre-submission-check`);
  console.log("\nFraud endpoints (Feature 2 — Behavioral Anomaly Detection):");
  console.log(`  POST http://localhost:${port}/api/v1/agent/fraud/permit-check`);
  console.log(`  POST http://localhost:${port}/api/v1/agent/fraud/user-anomaly`);
  console.log(`  POST http://localhost:${port}/api/v1/agent/fraud/scan`);
  console.log("\nAnalytics endpoints (Feature 3 — Trend & Predictive Analytics):");
  console.log(`  POST http://localhost:${port}/api/v1/agent/analytics/trends`);
  console.log(`  POST http://localhost:${port}/api/v1/agent/analytics/predictions`);
  console.log(`  POST http://localhost:${port}/api/v1/agent/analytics/incident-correlation`);
  console.log(`  POST http://localhost:${port}/api/v1/agent/analytics/compliance-report`);
  console.log(
    "\nNote: MCP server runs separately on port 3000 (pnpm start --http)"
  );
});
