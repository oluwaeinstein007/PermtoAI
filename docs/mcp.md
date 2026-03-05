# MCP Integration Guide

PermitoAI is an **MCP (Model Context Protocol) server** that exposes its tools natively to Claude and other MCP-compatible clients.

---

## Transport options

### Stdio (default)

Used for local Claude integrations (Claude Desktop, `claude-code` CLI). No HTTP server is started.

```bash
pnpm start
# or: npx tsx src/index.ts
```

### HTTP Stream

Used for remote or custom MCP clients.

```bash
pnpm start:http
# or: PORT=3000 npx tsx src/index.ts --http
```

MCP endpoint: `http://localhost:3000/mcp`

---

## Claude Desktop configuration

Add to `claude_desktop_config.json`:

**Stdio (recommended for local use):**

```json
{
  "mcpServers": {
    "permito": {
      "command": "npx",
      "args": ["tsx", "/path/to/PermitoAI/src/index.ts"],
      "env": {
        "GOOGLE_API_KEY": "your_gemini_api_key",
        "QDRANT_URL": "http://localhost:6333"
      }
    }
  }
}
```

**HTTP stream:**

```json
{
  "mcpServers": {
    "permito": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

---

## claude-code CLI configuration

Add to your project's `.claude/settings.json` or the global Claude settings:

```json
{
  "mcpServers": {
    "permito": {
      "command": "pnpm",
      "args": ["start"],
      "cwd": "/path/to/PermitoAI"
    }
  }
}
```

---

## Available tools

Once connected, Claude can invoke these tools by name:

| Tool | When to use |
|---|---|
| `HAZARD_SUGGEST` | Identify hazards for a new permit scenario |
| `RISK_ASSESS` | Score a list of hazards with risk matrix |
| `COMPLIANCE_CHECK` | Check DPR/ISO/IOGP compliance |
| `PERMIT_VALIDATE` | Full 4-layer permit validation |
| `ANOMALY_DETECT` | Check for copy-paste or suspicious patterns |

---

## Available prompts

The server registers two Claude prompts for chat-based permit workflows.

### `permit-chat`

Interactive permit assistant. Claude follows the full workflow: hazard suggest → risk assess → compliance check → validate → anomaly detect.

**Arguments:**
- `query` (required) — permit scenario, job description, or safety question

**Example usage in Claude:**
> "Use the permit-chat prompt to help me assess a hot work permit for Warri Refinery."

### `hazard-analysis`

Deep hazard analysis for a specific job type.

**Arguments:**
- `jobType` (required) — e.g. `"Confined Space Entry"`
- `location` (required) — e.g. `"Escravos Gas Plant"`
- `environment` (required) — e.g. `"Offshore platform, H₂S present"`

---

## Tool input/output

### HAZARD_SUGGEST

Input matches `JobContext` schema:

```json
{
  "jobType": "Hot Work",
  "location": "Bonny Terminal",
  "environment": "Onshore crude processing facility",
  "equipment": ["Welding machine", "Gas detector"],
  "contractor": { "name": "SafeWeld Ltd", "tier": 2 },
  "description": "Welding repair on pipeline flange"
}
```

Output (JSON string):

```json
{
  "success": true,
  "hazardCount": 7,
  "hazards": [...],
  "metadata": { "regulationsUsed": 5, "incidentsUsed": 3, "promptTokens": 1240, "completionTokens": 890 }
}
```

### RISK_ASSESS

Input:

```json
{
  "hazards": [
    {
      "name": "H2S Exposure",
      "category": "chemical",
      "likelihood": 3,
      "severity": 2,
      "recommendedControls": ["H2S monitor", "SCBA"],
      "dprReference": "DPR EGASPIN Section 4.1.2",
      "explanation": "Sour gas environment."
    }
  ]
}
```

Output (JSON string):

```json
{
  "success": true,
  "summary": { "critical": 0, "high": 1, "medium": 0, "low": 0 },
  "rulesApplied": 1,
  "scoredHazards": [...]
}
```

### COMPLIANCE_CHECK

Input:

```json
{
  "jobContext": { ... },
  "hazards": [ ... ]
}
```

Output (JSON string):

```json
{
  "success": true,
  "overallCompliant": false,
  "standards": [
    { "standard": "DPR EGASPIN", "compliant": true, "findings": [], "recommendations": [] },
    { "standard": "ISO 45001", "compliant": false, "findings": [...], "recommendations": [...] },
    { "standard": "IOGP", "compliant": true, "findings": [], "recommendations": [] }
  ]
}
```

### PERMIT_VALIDATE

Input:

```json
{
  "jobContext": { ... },
  "hazards": [ ... ]
}
```

Output (JSON string):

```json
{
  "success": true,
  "recommendation": "Flag for Review",
  "allPassed": false,
  "totalIssues": 2,
  "layers": [
    { "layer": "rule_based", "passed": true, "issueCount": 0, "issues": [], "confidence": 1.0 },
    { "layer": "semantic", "passed": false, "issueCount": 1, "issues": [...], "confidence": 0.85 },
    { "layer": "compliance", "passed": true, "issueCount": 0, "issues": [], "confidence": 0.9 },
    { "layer": "anomaly", "passed": true, "issueCount": 0, "issues": [], "confidence": 0.9 }
  ]
}
```

### ANOMALY_DETECT

Input:

```json
{
  "hazards": [ ... ]
}
```

Output (JSON string):

```json
{
  "success": true,
  "anomaliesDetected": true,
  "issueCount": 2,
  "issues": ["All hazards have identical likelihood and severity ratings — possible copy-paste."],
  "confidence": 0.9
}
```

---

## Recommended Claude workflow

When Claude receives a permit-to-work request, the optimal tool call sequence is:

```
1. HAZARD_SUGGEST(jobContext)
      ↓
2. RISK_ASSESS(hazards from step 1)
      ↓
3a. COMPLIANCE_CHECK(jobContext + hazards)    ┐  run in
3b. PERMIT_VALIDATE(jobContext + hazards)     ┘  parallel
      ↓
4. ANOMALY_DETECT(hazards)          ← if step 3b flags concerns
```

This is equivalent to `POST /api/v1/agent/full-assessment` in the REST API.

---

## System instruction

The server registers this instruction for Claude:

> You are Permito, an AI assistant for safety-critical permit-to-work management in Nigerian oil & gas operations. You are trained on IOGP safety standards and Nigerian DPR regulations (EGASPIN).
>
> Core principle: AI assists, rules constrain, humans decide, logs remember.
>
> Always provide clear, safety-focused responses. Never finalize high-risk permits without human review.
