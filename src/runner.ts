/**
 * Executes test cases and records results.
 * Supports three execution modes:
 *   1. autoCommand  — runs a shell command, uses LLM to judge pass/fail
 *   2. autoInspect  — greps a file for a pattern, simple pass/fail
 *   3. manual       — marks as NOT TESTED with instructions printed to console
 */
import { execSync } from "child_process";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";
import chalk from "chalk";
import type { TestCase, TestResult, RunSummary, PhaseTestPlan } from "./types.ts";

export async function runPlan(
  plan: PhaseTestPlan,
  apiKey: string,
  model: string,
  opts: { failedOnly?: boolean } = {}
): Promise<RunSummary> {
  const client = new Anthropic({ apiKey });
  const start = Date.now();

  const toRun = opts.failedOnly
    ? plan.tests.filter((t) => t.result === "FAIL" || t.result === "NOT TESTED")
    : plan.tests;

  let pass = 0, fail = 0, notTested = 0, blocked = 0;

  console.log(chalk.bold.cyan(`\n🔬 Running ${toRun.length} tests for phase ${plan.phase}\n`));

  for (const test of toRun) {
    process.stdout.write(chalk.gray(`  [${test.id}] ${test.description} ... `));

    let result: TestResult = "NOT TESTED";
    let notes = test.notes;

    try {
      if (test.autoInspect) {
        result = runInspect(test, plan.projectRoot);
      } else if (test.autoCommand) {
        result = await runCommand(test, plan.projectRoot, client, model);
      } else {
        result = "NOT TESTED";
        notes = notes || "Manual test — run steps in 'How To Test' column";
      }
    } catch (err) {
      result = "FAIL";
      notes = String(err).slice(0, 300);
    }

    test.result = result;
    test.notes = notes;
    test.lastRunAt = new Date().toISOString();
    test.runCount = (test.runCount || 0) + 1;

    const icon =
      result === "PASS" ? chalk.green("✅ PASS")
      : result === "FAIL" ? chalk.red("❌ FAIL")
      : result === "BLOCKED" ? chalk.yellow("🚫 BLOCKED")
      : chalk.gray("⬜ MANUAL");

    console.log(icon);
    if (result === "FAIL" && notes) console.log(chalk.red(`     → ${notes.slice(0, 120)}`));

    if (result === "PASS") pass++;
    else if (result === "FAIL") fail++;
    else if (result === "NOT TESTED") notTested++;
    else if (result === "BLOCKED") blocked++;
  }

  plan.lastRunAt = new Date().toISOString();

  // Check gate: all gating tests must PASS
  const gatingTests = plan.tests.filter((t) => t.gating);
  plan.gateCleared = gatingTests.length > 0 && gatingTests.every((t) => t.result === "PASS");

  const total = plan.tests.length;
  const durationMs = Date.now() - start;

  console.log(
    chalk.bold(
      `\n📊 Results: ${chalk.green(pass + " pass")} · ${chalk.red(fail + " fail")} · ${chalk.gray(notTested + " manual")} · ${chalk.yellow(blocked + " blocked")} / ${total} total`
    )
  );

  if (plan.gateCleared) {
    console.log(chalk.bold.green(`\n✅ Phase gate CLEARED — safe to proceed to next phase\n`));
  } else {
    const failingGating = gatingTests.filter((t) => t.result !== "PASS");
    console.log(
      chalk.bold.red(
        `\n🔒 Phase gate LOCKED — ${failingGating.length} gating test(s) not passing:\n` +
          failingGating.map((t) => `   • [${t.id}] ${t.description}`).join("\n") + "\n"
      )
    );
  }

  return {
    phase: plan.phase,
    total,
    pass,
    fail,
    notTested,
    blocked,
    gateCleared: plan.gateCleared,
    fixesApplied: 0,
    durationMs,
  };
}

function runInspect(test: TestCase, projectRoot: string): TestResult {
  const { file, pattern } = test.autoInspect!;
  const fullPath = join(projectRoot, file);
  if (!existsSync(fullPath)) return "FAIL";
  const content = readFileSync(fullPath, "utf8");
  const regex = new RegExp(pattern);
  return regex.test(content) ? "PASS" : "FAIL";
}

async function runCommand(
  test: TestCase,
  projectRoot: string,
  client: Anthropic,
  model: string
): Promise<TestResult> {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    stdout = execSync(test.autoCommand!, {
      cwd: projectRoot,
      timeout: 30000,
      encoding: "utf8",
      env: { ...process.env },
    });
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
    exitCode = e.status ?? 1;
  }

  const output = [stdout, stderr].filter(Boolean).join("\n").trim().slice(0, 2000);

  // Use LLM to judge pass/fail
  const judgment = await client.messages.create({
    model,
    max_tokens: 256,
    system:
      "You are a test result evaluator. Given a test's expected result and the actual command output, respond with exactly one word: PASS or FAIL. Nothing else.",
    messages: [
      {
        role: "user",
        content: `Expected result: ${test.expectedResult}\n\nActual output (exit code ${exitCode}):\n${output || "(no output)"}`,
      },
    ],
  });

  const verdict = (judgment.content[0] as { text: string }).text.trim().toUpperCase();
  if (verdict !== "PASS" && verdict !== "FAIL") return exitCode === 0 ? "PASS" : "FAIL";
  return verdict as TestResult;
}
