#!/usr/bin/env node
/**
 * phase-gate CLI
 *
 * Commands:
 *   generate  — Generate a test plan for a phase from a roadmap .md
 *   run       — Execute tests for a phase (auto-runnable ones)
 *   fix       — Attempt to fix failing tests using Claude
 *   render    — Re-render the test plan to xlsx/md/html
 *   gate      — Check if a phase gate is cleared (exit 0 = cleared, 1 = locked)
 *   status    — Print a summary of all phases
 */
import "dotenv/config";
import { Command } from "commander";
import { resolve } from "path";
import { existsSync, mkdirSync } from "fs";
import chalk from "chalk";
import ora from "ora";

import { generatePlan } from "./generator.ts";
import { runPlan } from "./runner.ts";
import { fixFailures } from "./fixer.ts";
import { render } from "./renderer.ts";
import { savePlan, loadPlan } from "./store.ts";
import type { OutputFormat } from "./types.ts";

const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_OUTPUT_DIR = "docs/test-plans";

const program = new Command();

program
  .name("phase-gate")
  .description("AI-powered phase-gated test plan generator and executor")
  .version("1.0.0");

// ─── generate ─────────────────────────────────────────────────────────────────

program
  .command("generate <phase>")
  .description("Generate a test plan for a phase from a roadmap .md file")
  .requiredOption("-r, --roadmap <path>", "Path to the roadmap .md file")
  .option("-p, --project <path>", "Path to the project being tested", process.cwd())
  .option("-o, --output <dir>", "Output directory", DEFAULT_OUTPUT_DIR)
  .option("-f, --format <formats>", "Output formats: xlsx,md,html,json (comma-separated)", "xlsx,md,html,json")
  .option("--model <model>", "Claude model to use", DEFAULT_MODEL)
  .option("--overwrite", "Overwrite existing plan (default: merge new tests)", false)
  .action(async (phase: string, opts) => {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.CORTEX_API_KEY;
    if (!apiKey) {
      console.error(chalk.red("Error: ANTHROPIC_API_KEY or CORTEX_API_KEY env var required"));
      process.exit(1);
    }

    const roadmapPath = resolve(opts.roadmap);
    if (!existsSync(roadmapPath)) {
      console.error(chalk.red(`Roadmap file not found: ${roadmapPath}`));
      process.exit(1);
    }

    const projectRoot = resolve(opts.project);
    const outputDir = resolve(opts.output);
    const formats = opts.format.split(",").map((f: string) => f.trim()) as OutputFormat[];

    // Check if plan already exists
    const existing = loadPlan(outputDir, phase);
    if (existing && !opts.overwrite) {
      console.log(chalk.yellow(`Plan for ${phase} already exists. Use --overwrite to regenerate, or run 'phase-gate run ${phase}' to execute it.`));
      process.exit(0);
    }

    const spinner = ora(`Generating test plan for ${chalk.bold(phase)}...`).start();

    try {
      const plan = await generatePlan(roadmapPath, phase, projectRoot, apiKey, opts.model);
      savePlan(outputDir, plan);
      await render(plan, formats, outputDir);
      spinner.succeed(`Generated ${plan.tests.length} test cases for ${chalk.bold(phase)}`);
      console.log(chalk.gray(`  📁 ${outputDir}/`));
      formats.forEach((f) => console.log(chalk.gray(`     ${plan.phase}_Test_Plan.${f}`)));
    } catch (err) {
      spinner.fail(`Generation failed: ${err}`);
      process.exit(1);
    }
  });

// ─── run ──────────────────────────────────────────────────────────────────────

program
  .command("run <phase>")
  .description("Execute auto-runnable tests for a phase and update results")
  .option("-o, --output <dir>", "Output directory", DEFAULT_OUTPUT_DIR)
  .option("-f, --format <formats>", "Output formats to render after run", "xlsx,md,html,json")
  .option("--failed-only", "Only run tests that are FAIL or NOT TESTED", false)
  .option("--fix", "Auto-fix failures after running", false)
  .option("--gate", "Exit with code 1 if phase gate is not cleared", false)
  .option("--model <model>", "Claude model for LLM judgment", DEFAULT_MODEL)
  .action(async (phase: string, opts) => {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.CORTEX_API_KEY;
    if (!apiKey) {
      console.error(chalk.red("Error: ANTHROPIC_API_KEY or CORTEX_API_KEY env var required"));
      process.exit(1);
    }

    const outputDir = resolve(opts.output);
    const formats = opts.format.split(",").map((f: string) => f.trim()) as OutputFormat[];

    const plan = loadPlan(outputDir, phase);
    if (!plan) {
      console.error(chalk.red(`No test plan found for ${phase}. Run 'phase-gate generate ${phase}' first.`));
      process.exit(1);
    }

    const summary = await runPlan(plan, apiKey, opts.model, { failedOnly: opts.failedOnly });

    if (opts.fix && summary.fail > 0) {
      const fixes = await fixFailures(plan, apiKey, opts.model);
      summary.fixesApplied = fixes;

      if (fixes > 0) {
        console.log(chalk.cyan(`\n🔄 Re-running tests after ${fixes} fix(es)...`));
        await runPlan(plan, apiKey, opts.model, { failedOnly: true });
      }
    }

    savePlan(outputDir, plan);
    await render(plan, formats, outputDir);
    console.log(chalk.gray(`\n📁 Updated: ${outputDir}/${phase}_Test_Plan.*`));

    if (opts.gate && !plan.gateCleared) process.exit(1);
  });

// ─── fix ──────────────────────────────────────────────────────────────────────

program
  .command("fix <phase>")
  .description("Attempt to auto-fix failing tests using Claude")
  .option("-o, --output <dir>", "Output directory", DEFAULT_OUTPUT_DIR)
  .option("-f, --format <formats>", "Output formats", "xlsx,md,html,json")
  .option("--model <model>", "Claude model to use", DEFAULT_MODEL)
  .action(async (phase: string, opts) => {
    const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.CORTEX_API_KEY;
    if (!apiKey) {
      console.error(chalk.red("Error: ANTHROPIC_API_KEY or CORTEX_API_KEY env var required"));
      process.exit(1);
    }

    const outputDir = resolve(opts.output);
    const formats = opts.format.split(",").map((f: string) => f.trim()) as OutputFormat[];
    const plan = loadPlan(outputDir, phase);

    if (!plan) {
      console.error(chalk.red(`No plan found for ${phase}.`));
      process.exit(1);
    }

    const fixes = await fixFailures(plan, apiKey, opts.model);

    if (fixes > 0) {
      console.log(chalk.cyan(`\n🔄 Re-running tests after fixes...`));
      await runPlan(plan, apiKey, opts.model, { failedOnly: true });
      savePlan(outputDir, plan);
      await render(plan, formats, outputDir);
      console.log(chalk.gray(`\n📁 Updated: ${outputDir}/${phase}_Test_Plan.*`));
    } else {
      console.log(chalk.gray("No fixes applied."));
    }
  });

// ─── render ───────────────────────────────────────────────────────────────────

program
  .command("render <phase>")
  .description("Re-render an existing test plan to the specified formats")
  .option("-o, --output <dir>", "Output directory", DEFAULT_OUTPUT_DIR)
  .option("-f, --format <formats>", "Output formats", "xlsx,md,html")
  .action(async (phase: string, opts) => {
    const outputDir = resolve(opts.output);
    const formats = opts.format.split(",").map((f: string) => f.trim()) as OutputFormat[];
    const plan = loadPlan(outputDir, phase);

    if (!plan) {
      console.error(chalk.red(`No plan found for ${phase}.`));
      process.exit(1);
    }

    await render(plan, formats, outputDir);
    console.log(chalk.green(`✓ Rendered ${phase} to: ${formats.join(", ")}`));
  });

// ─── gate ─────────────────────────────────────────────────────────────────────

program
  .command("gate <phase>")
  .description("Check if a phase gate is cleared (exit 0 = cleared, 1 = locked)")
  .option("-o, --output <dir>", "Output directory", DEFAULT_OUTPUT_DIR)
  .action((phase: string, opts) => {
    const outputDir = resolve(opts.output);
    const plan = loadPlan(outputDir, phase);

    if (!plan) {
      console.log(chalk.red(`❌ No test plan found for ${phase}`));
      process.exit(1);
    }

    const gating = plan.tests.filter((t) => t.gating);
    const passing = gating.filter((t) => t.result === "PASS");

    console.log(chalk.bold(`Phase ${phase} gate: ${passing.length}/${gating.length} gating tests pass`));

    if (plan.gateCleared) {
      console.log(chalk.green("✅ CLEARED — safe to proceed to next phase"));
      process.exit(0);
    } else {
      const failing = gating.filter((t) => t.result !== "PASS");
      console.log(chalk.red("🔒 LOCKED — failing gating tests:"));
      failing.forEach((t) => console.log(chalk.red(`  • [${t.id}] ${t.description} (${t.result})`)));
      process.exit(1);
    }
  });

// ─── status ───────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("Print a summary of all phases")
  .option("-o, --output <dir>", "Output directory", DEFAULT_OUTPUT_DIR)
  .action(async (opts) => {
    const outputDir = resolve(opts.output);
    mkdirSync(outputDir, { recursive: true });

    const { readdirSync } = await import("node:fs");
    const files = readdirSync(outputDir).filter((f: string) => f.endsWith("_Test_Plan.json"));

    if (files.length === 0) {
      console.log(chalk.gray("No test plans found. Run phase-gate generate <phase> to create one."));
      return;
    }

    console.log(chalk.bold("\n📋 Phase Gate Status\n"));
    for (const file of files.sort()) {
      const phase = file.replace("_Test_Plan.json", "");
      const plan = loadPlan(outputDir, phase);
      if (!plan) continue;

      const pass = plan.tests.filter((t) => t.result === "PASS").length;
      const fail = plan.tests.filter((t) => t.result === "FAIL").length;
      const total = plan.tests.length;
      const gate = plan.gateCleared ? chalk.green("✅ CLEARED") : chalk.red("🔒 LOCKED");

      console.log(`  ${chalk.bold(phase.padEnd(6))} ${gate}  ${chalk.green(pass + "✓")} ${chalk.red(fail + "✗")} / ${total} tests`);
    }
    console.log();
  });

program.parse();
