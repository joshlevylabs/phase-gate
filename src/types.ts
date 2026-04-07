export type TestResult = "PASS" | "FAIL" | "NOT TESTED" | "BLOCKED" | "WARNING" | "INFO ONLY";

export type TestCategory = string;

export interface TestCase {
  id: string;
  category: TestCategory;
  description: string;
  /** Copy-pasteable steps and commands */
  howToTest: string;
  /** Exact observable outcome constituting PASS */
  expectedResult: string;
  result: TestResult;
  notes: string;
  /** Optional shell command for automatic execution */
  autoCommand?: string;
  /** Optional file+pattern for code inspection */
  autoInspect?: { file: string; pattern: string };
  /** Must PASS for phase gate to clear */
  gating: boolean;
  /** Actual output captured during the last run (for trust-but-verify) */
  actualOutput?: string;
  lastRunAt?: string;
  runCount: number;
  /** Auto-generated fix attempt count */
  fixAttempts: number;
}

export interface PhaseTestPlan {
  phase: string;
  title: string;
  roadmapFile: string;
  projectRoot: string;
  generatedAt: string;
  lastRunAt?: string;
  gateCleared: boolean;
  tests: TestCase[];
}

export type OutputFormat = "xlsx" | "md" | "html" | "json";

export interface RunSummary {
  phase: string;
  total: number;
  pass: number;
  fail: number;
  notTested: number;
  blocked: number;
  gateCleared: boolean;
  fixesApplied: number;
  durationMs: number;
}

export interface PhaseGateConfig {
  /** Path to the roadmap .md file */
  roadmapFile: string;
  /** Absolute path to the project being tested */
  projectRoot: string;
  /** Anthropic API key (or uses ANTHROPIC_API_KEY env) */
  apiKey?: string;
  /** Model to use for generation and fixing */
  model?: string;
  /** Output directory for test plans */
  outputDir?: string;
}
