#!/usr/bin/env node
import 'dotenv/config';
import { FastMCP } from "fastmcp";
import { HazardSuggestTool } from "./tools/hazard_suggest.js";
import { RiskAssessTool } from "./tools/risk_assess.js";
import { ComplianceCheckTool } from "./tools/compliance_check.js";
import { PermitValidateTool } from "./tools/permit_validate.js";
import { AnomalyDetectTool } from "./tools/anomaly_detect.js";
import { SimopsCheckTool } from "./tools/simops_check.js";

async function main() {
	console.log("Initializing Permito MCP Server...");

	const server = new FastMCP({
		name: "Permito MCP Server",
		version: "0.1.0",
		instructions: `You are Permito, an AI assistant for safety-critical permit-to-work management in Nigerian oil & gas operations.

You are trained on IOGP safety standards and Nigerian DPR regulations (EGASPIN).

Core principle: AI assists, rules constrain, humans decide, logs remember.

Use the available tools to:
- HAZARD_SUGGEST: Identify workplace hazards for a permit scenario using AI + historical incident data
- RISK_ASSESS: Score hazards against the risk matrix with rule-based severity constraints
- COMPLIANCE_CHECK: Validate permits against DPR EGASPIN, ISO 45001, and IOGP standards
- PERMIT_VALIDATE: Run multi-layer validation (rule-based → semantic → compliance → anomaly)
- ANOMALY_DETECT: Detect copy-pasted assessments, duplicate permits, and suspicious patterns

Always provide clear, safety-focused responses. Never finalize high-risk permits without human review.`
	});

	// Register all tools
	server.addTool(HazardSuggestTool);
	server.addTool(RiskAssessTool);
	server.addTool(ComplianceCheckTool);
	server.addTool(PermitValidateTool);
	server.addTool(AnomalyDetectTool);
	server.addTool(SimopsCheckTool);

	// Permit assistant prompt for chat integration
	server.addPrompt({
		name: "permit-chat",
		description: "Interactive permit assistant for hazard identification and regulatory compliance",
		arguments: [
			{
				name: "query",
				description: "Permit scenario, job description, or safety-related question",
				required: true
			}
		],
		load: async (args) => {
			return `Help the user with their permit-to-work query: "${args.query}"

Workflow:
1. Use HAZARD_SUGGEST to identify hazards for the job scenario
2. Use RISK_ASSESS to score the identified hazards
3. Use COMPLIANCE_CHECK to verify regulatory compliance
4. Use PERMIT_VALIDATE for full multi-layer validation
5. Use ANOMALY_DETECT if you suspect copy-pasted or duplicate assessments

Always explain your reasoning and cite DPR/IOGP references where applicable.
Flag any high-risk items that require human review.`;
		}
	});

	// Hazard analysis prompt
	server.addPrompt({
		name: "hazard-analysis",
		description: "Deep hazard analysis for a specific job type",
		arguments: [
			{
				name: "jobType",
				description: "Type of job, e.g. 'Hot Work', 'Confined Space Entry'",
				required: true
			},
			{
				name: "location",
				description: "Work location",
				required: true
			},
			{
				name: "environment",
				description: "Environmental conditions",
				required: true
			}
		],
		load: async (args) => {
			return `Perform a comprehensive hazard analysis for:
- Job Type: ${args.jobType}
- Location: ${args.location}
- Environment: ${args.environment}

Steps:
1. Use HAZARD_SUGGEST with the provided context to identify all potential hazards
2. Use RISK_ASSESS to score each hazard and identify critical risks
3. Use COMPLIANCE_CHECK to verify DPR/ISO/IOGP compliance
4. Summarize findings with an overall risk level and key recommendations

Prioritize H₂S exposure, confined space, hot work, SIMOPS, and dropped object hazards.`;
		}
	});

	// Determine transport type from environment/args
	const useHttp = process.argv.includes("--http") || process.env.USE_HTTP === "true";
	const port = parseInt(process.env.PORT || "3000", 10);
	const host = process.env.HOST || '0.0.0.0';

	try {
		if (useHttp) {
			await server.start({
				httpStream: { port, host },
				transportType: "httpStream"
			});
			console.log(`Permito MCP Server started on http://${host}:${port}`);
			console.log(`  MCP endpoint: http://${host}:${port}/mcp`);
		} else {
			await server.start({ transportType: "stdio" });
			console.log("Permito MCP Server started successfully over stdio.");
			console.log("You can now connect to it using an MCP client.");
		}

		console.log("Registered tools: HAZARD_SUGGEST, RISK_ASSESS, COMPLIANCE_CHECK, PERMIT_VALIDATE, ANOMALY_DETECT, SIMOPS_CHECK");
	} catch (error) {
		console.error("Failed to start Permito MCP Server:", error);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error("An unexpected error occurred:", error);
	process.exit(1);
});
