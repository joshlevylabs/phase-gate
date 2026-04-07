/**
 * LLM-powered test plan generator.
 * Reads a roadmap .md file, extracts the specified phase/milestone,
 * and generates structured test cases using Claude.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import type { PhaseTestPlan, TestCase } from "./types.ts";

const SYSTEM_PROMPT = `You are a senior QA engineer. Given a section of an implementation roadmap, you generate a comprehensive, executable test plan.

For each test case you generate:
- id: sequential within the phase, e.g. "1.1", "1.2", "2.1"
- category: group related tests (e.g. "Environment Setup", "Config Loader", "HTTP Server", "Build", "Type Safety", "Regression")
- description: one clear sentence of what is being verified
- howToTest: exact copy-pasteable shell commands or numbered steps. Use real commands like: pnpm athena:dev, curl http://localhost:3978/healthz, grep -n "pattern" src/file.ts
- expectedResult: the exact observable outcome that constitutes PASS (specific log lines, HTTP codes, file names, output text)
- gating: true if this test MUST pass before progressing to the next phase, false for nice-to-have tests
- autoCommand: if the test can be verified by running a single shell command and checking its output, provide that command here
- autoInspect: if the test is a code inspection (checking a pattern exists in a file), provide { file, pattern }

Categories should include at minimum: Environment Setup, then feature-specific categories per milestone section, then Build, Type Safety, and Cleanup.

Respond ONLY with a valid JSON array of TestCase objects. No markdown, no explanation — just the JSON array.`;

export async function generatePlan(
  roadmapFile: string,
  phase: string,
  projectRoot: string,
  apiKey: string,
  model: string
): Promise<PhaseTestPlan> {
  const roadmapContent = readFileSync(roadmapFile, "utf8");
  const phaseSection = extractPhaseSection(roadmapContent, phase);

  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Generate a complete test plan for the following milestone section of an implementation roadmap.

Phase/Milestone ID: ${phase}
Project root: ${projectRoot}

--- ROADMAP SECTION ---
${phaseSection}
--- END SECTION ---

Generate test cases that cover:
1. Environment and prerequisite checks
2. Every task listed in the roadmap section (verification criteria)
3. Integration/end-to-end validation
4. Build and type safety checks
5. Cleanup

Use real shell commands appropriate for a Node.js/TypeScript project using pnpm.
For commands that require env vars, show them inline: ENV_VAR=value command`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== "text") throw new Error("Unexpected response type from Claude");

  let tests: TestCase[];
  try {
    // Strip possible markdown code fences
    const json = content.text.replace(/^```json?\n?/m, "").replace(/\n?```$/m, "").trim();
    tests = JSON.parse(json) as TestCase[];
  } catch (err) {
    throw new Error(`Failed to parse Claude response as JSON: ${err}\n\nRaw:\n${content.text}`);
  }

  // Normalize fields
  tests = tests.map((t) => ({
    ...t,
    result: "NOT TESTED" as const,
    notes: "",
    runCount: 0,
    fixAttempts: 0,
    gating: t.gating ?? true,
  }));

  // Extract phase title from roadmap
  const titleMatch = phaseSection.match(/^#+ .*(Milestone \d+|M\d+)[:\s–-]+(.+)$/m);
  const title = titleMatch ? titleMatch[2].trim() : `Phase ${phase}`;

  return {
    phase,
    title,
    roadmapFile,
    projectRoot,
    generatedAt: new Date().toISOString(),
    gateCleared: false,
    tests,
  };
}

/**
 * Extracts the section of the roadmap relevant to the given phase.
 * Looks for headings containing the phase ID (e.g., "M1", "Milestone 1").
 */
function extractPhaseSection(roadmap: string, phase: string): string {
  const lines = roadmap.split("\n");
  const phasePattern = new RegExp(
    `\\b(${phase}|Milestone\\s*${phase.replace(/^M/, "")}|Phase\\s*${phase.replace(/^M/, "")})\\b`,
    "i"
  );

  let startIdx = -1;
  let startLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const headingMatch = lines[i].match(/^(#{1,4})\s+(.+)/);
    if (headingMatch && phasePattern.test(headingMatch[2])) {
      startIdx = i;
      startLevel = headingMatch[1].length;
      break;
    }
  }

  if (startIdx === -1) {
    // Fallback: return entire roadmap
    return roadmap;
  }

  // Find the next heading at the same or higher level
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const headingMatch = lines[i].match(/^(#{1,4})\s+/);
    if (headingMatch && headingMatch[1].length <= startLevel) {
      endIdx = i;
      break;
    }
  }

  return lines.slice(startIdx, endIdx).join("\n");
}
