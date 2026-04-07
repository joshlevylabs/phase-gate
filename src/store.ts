/**
 * Persists test plans as JSON in the output directory.
 * JSON is the single source of truth; all other formats are derived from it.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { PhaseTestPlan } from "./types.ts";

export function getPlanPath(outputDir: string, phase: string): string {
  return join(outputDir, `${phase}_Test_Plan.json`);
}

export function savePlan(outputDir: string, plan: PhaseTestPlan): void {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(getPlanPath(outputDir, plan.phase), JSON.stringify(plan, null, 2), "utf8");
}

export function loadPlan(outputDir: string, phase: string): PhaseTestPlan | null {
  const path = getPlanPath(outputDir, phase);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PhaseTestPlan;
  } catch {
    return null;
  }
}
