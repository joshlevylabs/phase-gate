/**
 * LLM-powered failure fixer.
 * Given a failing test case and the project context, asks Claude to diagnose
 * and apply a fix, then signals the runner to re-run the test.
 */
import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import chalk from "chalk";
import type { TestCase, PhaseTestPlan } from "./types.ts";

const MAX_FIX_ATTEMPTS = 3;

export async function fixFailures(
  plan: PhaseTestPlan,
  apiKey: string,
  model: string
): Promise<number> {
  const client = new Anthropic({ apiKey });
  const failing = plan.tests.filter(
    (t) => t.result === "FAIL" && t.fixAttempts < MAX_FIX_ATTEMPTS
  );

  if (failing.length === 0) return 0;

  console.log(chalk.bold.yellow(`\n🔧 Attempting to fix ${failing.length} failing test(s)...\n`));
  let fixesApplied = 0;

  for (const test of failing) {
    console.log(chalk.yellow(`  Fixing [${test.id}] ${test.description}...`));
    test.fixAttempts = (test.fixAttempts || 0) + 1;

    try {
      const fixed = await attemptFix(test, plan, client, model);
      if (fixed) {
        fixesApplied++;
        test.notes += `\n[Fix attempt ${test.fixAttempts}] Applied fix.`;
        console.log(chalk.green(`    ✓ Fix applied`));
      } else {
        test.notes += `\n[Fix attempt ${test.fixAttempts}] No fix found.`;
        console.log(chalk.gray(`    ~ No fix found`));
      }
    } catch (err) {
      test.notes += `\n[Fix attempt ${test.fixAttempts}] Error: ${String(err).slice(0, 200)}`;
      console.log(chalk.red(`    ✗ Fix error: ${String(err).slice(0, 80)}`));
    }
  }

  return fixesApplied;
}

async function attemptFix(
  test: TestCase,
  plan: PhaseTestPlan,
  client: Anthropic,
  model: string
): Promise<boolean> {
  // Gather relevant file context if autoInspect is set
  let fileContext = "";
  if (test.autoInspect) {
    const filePath = join(plan.projectRoot, test.autoInspect.file);
    if (existsSync(filePath)) {
      fileContext = `\n\nRelevant file (${test.autoInspect.file}):\n\`\`\`\n${readFileSync(filePath, "utf8").slice(0, 3000)}\n\`\`\``;
    }
  }

  // Gather command output if autoCommand is set
  let commandOutput = "";
  if (test.autoCommand) {
    try {
      commandOutput = execSync(test.autoCommand, {
        cwd: plan.projectRoot,
        timeout: 15000,
        encoding: "utf8",
        env: { ...process.env },
      });
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string };
      commandOutput = [e.stdout, e.stderr].filter(Boolean).join("\n");
    }
  }

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: `You are an expert software engineer fixing a failing test.
When you identify a fix:
1. If it's a code change: respond with the file path on the first line, then the complete new file content (no markdown fences, just the raw content).
   Format: FILE_PATH: src/some/file.ts
   CONTENT:
   <full file content>

2. If it's a shell command to run: respond with COMMAND: followed by the command.
   Format: COMMAND: pnpm install some-package

3. If no fix is possible: respond with NO_FIX: followed by the reason.

Be precise and conservative. Only change what is necessary to fix this specific test.`,
    messages: [
      {
        role: "user",
        content: `A test is failing. Please diagnose and fix it.

Test: [${test.id}] ${test.description}
Expected: ${test.expectedResult}
Notes/Error: ${test.notes}
${test.autoCommand ? `Command that failed: ${test.autoCommand}\nOutput:\n${commandOutput.slice(0, 1000)}` : ""}
${fileContext}

Project root: ${plan.projectRoot}`,
      },
    ],
  });

  const text = (response.content[0] as { text: string }).text.trim();

  if (text.startsWith("NO_FIX:")) return false;

  if (text.startsWith("COMMAND:")) {
    const command = text.replace("COMMAND:", "").trim();
    execSync(command, { cwd: plan.projectRoot, stdio: "pipe" });
    return true;
  }

  if (text.startsWith("FILE_PATH:")) {
    const lines = text.split("\n");
    const filePath = lines[0].replace("FILE_PATH:", "").trim();
    const contentStart = lines.findIndex((l) => l.trim() === "CONTENT:") + 1;
    if (contentStart > 0 && filePath) {
      const content = lines.slice(contentStart).join("\n");
      const fullPath = join(plan.projectRoot, filePath);
      writeFileSync(fullPath, content, "utf8");
      return true;
    }
  }

  return false;
}
