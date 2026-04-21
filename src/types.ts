export type TestResult = "PASS" | "FAIL" | "NOT TESTED" | "BLOCKED" | "WARNING" | "INFO ONLY" | "AWAITING HUMAN";

export type TestExecutor = "auto" | "human";

export type HumanTestKind =
  | "infrastructure"
  | "usability"
  | "visual"
  | "hardware"
  | "third-party"
  | "accessibility"
  | "data-entry"
  | "other";

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
  /** Who runs this test: a shell command/inspection (auto) or a human (human) */
  executor: TestExecutor;
  /** When executor=human, what kind of human work this is */
  humanKind?: HumanTestKind;
  /** When executor=human, plain-language instructions for the tester */
  humanInstructions?: string;
  /** Actual output captured during the last run (for trust-but-verify) */
  actualOutput?: string;
  lastRunAt?: string;
  runCount: number;
  /** Auto-generated fix attempt count */
  fixAttempts: number;
}

export interface RunHistoryEntry {
  version: number;
  runAt: string;
  total: number;
  pass: number;
  fail: number;
  awaitingHuman: number;
  blocked: number;
  notTested: number;
  gateCleared: boolean;
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
  /** Current version number of this plan (1-based) */
  version?: number;
  /** Chronological history of runs; latest first or last — latest pushed last */
  history?: RunHistoryEntry[];
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
