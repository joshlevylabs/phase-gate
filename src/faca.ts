/**
 * Generates a FACA (Failure Analysis & Corrective Action) report and a
 * ready-to-paste Claude Code prompt for failing tests in a phase plan.
 */
import { makeClient } from "./client.ts";
import type { PhaseTestPlan, TestCase } from "./types.ts";

const SYSTEM_PROMPT = `You are a senior engineer producing a FACA (Failure Analysis & Corrective Action) report for failing phase-gate tests.

Respond with a single JSON object with exactly these two keys:
- "faca": a markdown-formatted FACA report. For each failure include these sections:
    ## [TEST_ID] — description
    ### Observed Failure
    ### Root Cause Hypothesis
    ### Impact / Severity  (Low / Medium / High / Critical)
    ### Corrective Action
    ### Verification Steps
  End the report with an "## Overall Risk Assessment" section.

- "prompt": a single ready-to-paste Claude Code prompt instructing a fresh Claude Code instance (with full tool access) to diagnose and fix every failure. The prompt must:
    • State the project root and phase
    • List every failing test id, description, how-to-test, expected result, and actual output
    • Instruct Claude to read relevant files, implement fixes, and re-run the failing commands
    • Request a concise summary of changes at the end
    • Be fully self-contained — the receiving Claude Code instance will have no prior context

Respond with ONLY the JSON object — no markdown fences, no extra prose.`;

export interface FacaResult {
  faca: string;
  prompt: string;
  failures: Array<{ id: string; description: string }>;
}

export async function generateFaca(
  plan: PhaseTestPlan,
  apiKey: string,
  model: string,
  onlyId?: string
): Promise<FacaResult> {
  const failing = plan.tests.filter((t) => t.result === "FAIL" && (!onlyId || t.id === onlyId));

  if (failing.length === 0) {
    return { faca: "_No failing tests._", prompt: "", failures: [] };
  }

  const payload = failing.map((t: TestCase) => ({
    id: t.id,
    category: t.category,
    description: t.description,
    howToTest: t.howToTest,
    expectedResult: t.expectedResult,
    actualOutput: t.actualOutput ?? "(not captured)",
    notes: t.notes ?? "",
    autoCommand: t.autoCommand ?? null,
    autoInspect: t.autoInspect ?? null,
  }));

  const client = makeClient(apiKey);
  const response = await client.messages.create({
    model,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Project root: ${plan.projectRoot}
Phase: ${plan.phase} — ${plan.title} (v${plan.version ?? 1})
Roadmap: ${plan.roadmapFile}

Failing tests (${failing.length}):
${JSON.stringify(payload, null, 2)}

Produce the FACA report and the Claude Code prompt.`,
      },
    ],
  });

  const content = response.content[0];
  if (content.type !== "text") throw new Error("Unexpected response type from Claude");
  const raw = content.text.replace(/^```json?\n?/m, "").replace(/\n?```$/m, "").trim();

  let parsed: { faca: string; prompt: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { faca: raw, prompt: buildFallbackPrompt(plan, failing) };
  }

  return {
    faca: parsed.faca,
    prompt: parsed.prompt || buildFallbackPrompt(plan, failing),
    failures: failing.map((t) => ({ id: t.id, description: t.description })),
  };
}

function buildFallbackPrompt(plan: PhaseTestPlan, failing: TestCase[]): string {
  return `You are Claude Code working in the repository at ${plan.projectRoot}.

Phase: ${plan.phase} — ${plan.title} (v${plan.version ?? 1})

The following phase-gate tests are FAILING and must be fixed:

${failing
  .map(
    (t) => `## ${t.id} — ${t.description}
- **Category:** ${t.category}
- **How to test:** ${t.howToTest}
- **Expected:** ${t.expectedResult}
- **Actual output:**
\`\`\`
${t.actualOutput ?? "(not captured)"}
\`\`\`
- **Notes:** ${t.notes ?? "(none)"}
`
  )
  .join("\n")}

Please:
1. Read the relevant source files to understand current behavior.
2. Diagnose the root cause of each failure.
3. Implement fixes directly in the codebase.
4. Re-run the failing commands to confirm they now pass.
5. Provide a concise summary of changes at the end.
`;
}
