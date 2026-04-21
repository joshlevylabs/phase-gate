/**
 * Persists test plans as JSON in the output directory.
 * JSON is the single source of truth; all other formats are derived from it.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
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

/** Archive a plan snapshot as {phase}_v{version}_Test_Plan.json */
export function archivePlanVersion(outputDir: string, plan: PhaseTestPlan): string {
  const v = plan.version ?? 1;
  const name = `${plan.phase}_v${v}_Test_Plan.json`;
  const path = join(outputDir, name);
  writeFileSync(path, JSON.stringify(plan, null, 2), "utf8");
  return path;
}

/** List archived version snapshots for a phase, oldest first. */
export function listVersions(outputDir: string, phase: string): PhaseTestPlan[] {
  if (!existsSync(outputDir)) return [];
  const re = new RegExp(`^${phase}_v(\\d+)_Test_Plan\\.json$`);
  const matches: { v: number; file: string }[] = [];
  for (const f of readdirSync(outputDir)) {
    const m = f.match(re);
    if (m) matches.push({ v: parseInt(m[1], 10), file: f });
  }
  matches.sort((a, b) => a.v - b.v);
  const out: PhaseTestPlan[] = [];
  for (const { file } of matches) {
    try {
      out.push(JSON.parse(readFileSync(join(outputDir, file), "utf8")) as PhaseTestPlan);
    } catch {
      // skip
    }
  }
  return out;
}
