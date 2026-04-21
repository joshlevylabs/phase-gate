/**
 * Local HTTP server that provides a unified web GUI for phase-gate:
 *   GET  /                  → dashboard (pick roadmap, phase, GO)
 *   POST /api/phases        → { roadmap } → detected phase IDs from the roadmap
 *   POST /api/go            → { roadmap, projectRoot, phase, mode } → generate + run, returns JSON summary
 *   GET  /report/:phase     → live rendered HTML report for a phase
 *   POST /api/mark          → { phase, id, verdict } → persist a human verdict
 */
import { createServer } from "http";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, resolve as pathResolve, dirname } from "path";
import chalk from "chalk";
import { loadPlan, savePlan, archivePlanVersion, listVersions } from "./store.ts";
import { render } from "./renderer.ts";
import { generatePlan } from "./generator.ts";
import { runPlan } from "./runner.ts";
import { generateFaca } from "./faca.ts";
import type { TestResult, OutputFormat, PhaseTestPlan } from "./types.ts";

const ALLOWED_VERDICTS: TestResult[] = ["PASS", "FAIL", "BLOCKED", "AWAITING HUMAN", "NOT TESTED"];

export interface ServeOptions {
  outputDir: string;
  port: number;
  formats: OutputFormat[];
  apiKey: string;
  model: string;
  defaultRoadmap?: string;
  defaultProjectRoot?: string;
}

export async function serve(opts: ServeOptions): Promise<void> {
  const { outputDir, port, formats, apiKey, model } = opts;

  const server = createServer(async (req, res) => {
    try {
      const url = req.url ?? "/";

      if (req.method === "GET" && (url === "/" || url.startsWith("/?"))) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderDashboard(opts));
        return;
      }

      // GET /report/<phase>
      const reportMatch = url.match(/^\/report\/([^/?]+)/);
      if (req.method === "GET" && reportMatch) {
        const phase = decodeURIComponent(reportMatch[1]);
        const htmlPath = join(outputDir, `${phase}_Test_Plan.html`);
        if (!existsSync(htmlPath)) {
          res.writeHead(404, { "Content-Type": "text/html" });
          res.end(`<p style="font-family:sans-serif;padding:24px">No report for <b>${phase}</b> yet. Generate it from the dashboard.</p>`);
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(readFileSync(htmlPath, "utf8"));
        return;
      }

      if (req.method === "POST" && url === "/api/phases") {
        const body = await readBody(req);
        const { roadmap } = JSON.parse(body) as { roadmap: string };
        const abs = pathResolve(roadmap);
        if (!existsSync(abs)) return json(res, 404, { error: `Roadmap not found: ${abs}` });
        const phases = detectPhases(readFileSync(abs, "utf8"));
        return json(res, 200, { roadmap: abs, phases });
      }

      if (req.method === "POST" && url === "/api/go") {
        const body = await readBody(req);
        const { roadmap, projectRoot, phase, mode } = JSON.parse(body) as {
          roadmap: string; projectRoot: string; phase: string; mode: "generate" | "run" | "both";
        };

        const absRoadmap = pathResolve(roadmap);
        const absProject = pathResolve(projectRoot);
        if (!existsSync(absRoadmap)) return json(res, 404, { error: `Roadmap not found: ${absRoadmap}` });
        if (!existsSync(absProject)) return json(res, 404, { error: `Project root not found: ${absProject}` });

        let plan: PhaseTestPlan | null = loadPlan(outputDir, phase);

        if (mode === "generate" || mode === "both" || !plan) {
          console.log(chalk.cyan(`\n⟳ Generating plan for ${chalk.bold(phase)} ...`));
          plan = await generatePlan(absRoadmap, phase, absProject, apiKey, model);
          plan.version = 1;
          plan.history = [];
          savePlan(outputDir, plan);
          await render(plan, formats, outputDir);
          console.log(chalk.green(`  ✓ Generated ${plan.tests.length} tests`));
        }

        if (mode === "run" || mode === "both") {
          if (!plan) plan = loadPlan(outputDir, phase);
          if (!plan) return json(res, 404, { error: `Plan not found for ${phase}` });
          console.log(chalk.cyan(`⟳ Running plan for ${chalk.bold(phase)} ...`));
          await runPlan(plan, apiKey, model, {});
          savePlan(outputDir, plan);
          await render(plan, formats, outputDir);
        }

        const finalPlan = loadPlan(outputDir, phase);
        return json(res, 200, {
          ok: true,
          phase,
          reportUrl: `/report/${encodeURIComponent(phase)}?t=${Date.now()}`,
          gateCleared: finalPlan?.gateCleared ?? false,
          total: finalPlan?.tests.length ?? 0,
        });
      }

      if (req.method === "POST" && url === "/api/mark") {
        const body = await readBody(req);
        const { phase, id, verdict } = JSON.parse(body) as { phase: string; id: string; verdict: TestResult };

        if (!ALLOWED_VERDICTS.includes(verdict)) return json(res, 400, { error: `Invalid verdict: ${verdict}` });

        const plan = loadPlan(outputDir, phase);
        if (!plan) return json(res, 404, { error: `Plan not found for ${phase}` });
        const test = plan.tests.find((t) => t.id === id);
        if (!test) return json(res, 404, { error: `Test ${id} not found` });

        test.result = verdict;
        test.lastRunAt = new Date().toISOString();
        test.runCount = (test.runCount || 0) + 1;
        if (verdict === "PASS" || verdict === "FAIL") {
          test.notes = `Marked ${verdict} by human via web UI`;
        }

        const gating = plan.tests.filter((t) => t.gating);
        plan.gateCleared = gating.length > 0 && gating.every((t) => t.result === "PASS");
        plan.lastRunAt = new Date().toISOString();

        savePlan(outputDir, plan);
        await render(plan, formats, outputDir);

        console.log(
          chalk.gray(`  · ${phase} ${id} → `) +
            (verdict === "PASS" ? chalk.green(verdict) : verdict === "FAIL" ? chalk.red(verdict) : chalk.yellow(verdict)) +
            chalk.gray(` · gate: ${plan.gateCleared ? "✓" : "✕"}`)
        );
        return json(res, 200, { ok: true, id, verdict, gateCleared: plan.gateCleared });
      }

      if (req.method === "POST" && url === "/api/faca") {
        const body = await readBody(req);
        const { phase, id } = JSON.parse(body) as { phase: string; id?: string };
        const plan = loadPlan(outputDir, phase);
        if (!plan) return json(res, 404, { error: `Plan not found for ${phase}` });
        console.log(chalk.cyan(`⟳ Generating FACA for ${chalk.bold(phase)}${id ? ` [${id}]` : ""} ...`));
        const result = await generateFaca(plan, apiKey, model, id);
        console.log(chalk.green(`  ✓ FACA generated for ${result.failures.length} failure(s)`));
        return json(res, 200, result);
      }

      if (req.method === "POST" && url === "/api/new-version") {
        const body = await readBody(req);
        const { phase } = JSON.parse(body) as { phase: string };
        const plan = loadPlan(outputDir, phase);
        if (!plan) return json(res, 404, { error: `Plan not found for ${phase}` });
        // Archive current version as immutable snapshot
        const currentV = plan.version ?? 1;
        plan.version = currentV;
        archivePlanVersion(outputDir, plan);
        // Bump version, reset all test results so user can re-run
        plan.version = currentV + 1;
        for (const t of plan.tests) {
          t.result = t.executor === "human" ? "AWAITING HUMAN" : "NOT TESTED";
          t.actualOutput = undefined;
          t.notes = "";
          t.lastRunAt = undefined;
          t.runCount = 0;
          t.fixAttempts = 0;
        }
        plan.gateCleared = false;
        plan.lastRunAt = undefined;
        savePlan(outputDir, plan);
        await render(plan, formats, outputDir);
        console.log(chalk.green(`  ✓ ${phase} advanced to v${plan.version}`));
        return json(res, 200, { ok: true, phase, version: plan.version });
      }

      if (req.method === "GET" && url.startsWith("/api/history/")) {
        const phase = decodeURIComponent(url.replace("/api/history/", "").split("?")[0]);
        const versions = listVersions(outputDir, phase);
        const current = loadPlan(outputDir, phase);
        const all = current ? [...versions.filter((v) => v.version !== current.version), current] : versions;
        const history = all.flatMap((p) => p.history ?? []);
        return json(res, 200, { phase, history, versions: all.map((p) => p.version ?? 1) });
      }

      if (req.method === "GET" && url === "/api/plans") {
        return json(res, 200, { plans: listPlansSummary(outputDir) });
      }

      if (req.method === "GET" && (url === "/overview" || url.startsWith("/overview?"))) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderOverview(outputDir));
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    } catch (err) {
      console.error(chalk.red(`Server error: ${err}`));
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });

  server.listen(port, () => {
    console.log(chalk.bold.cyan(`\n📊 Phase Gate dashboard running\n`));
    console.log(chalk.white(`   ${chalk.bold(`http://localhost:${port}/`)}\n`));
    console.log(chalk.gray(`   Output: ${outputDir}`));
    if (opts.defaultRoadmap) console.log(chalk.gray(`   Default roadmap: ${opts.defaultRoadmap}`));
    console.log(chalk.gray(`\n   Press Ctrl+C to stop.\n`));
  });
}

function json(res: import("http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: import("http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Pull phase IDs (M1, M2, Milestone 3, Phase 4…) out of a roadmap's headings. */
function detectPhases(roadmap: string): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = [];
  const seen = new Set<string>();
  const headingRe = /^#{1,4}\s+(.+)$/gm;
  const idRe = /\b(M\d+|Milestone\s*\d+|Phase\s*\d+)\b/i;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(roadmap))) {
    const heading = m[1].trim();
    const hit = heading.match(idRe);
    if (!hit) continue;
    const raw = hit[1].replace(/\s+/g, "");
    const normalized = /^M\d+$/i.test(raw)
      ? raw.toUpperCase()
      : "M" + raw.replace(/\D/g, "");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ id: normalized, title: heading });
  }
  return out.sort((a, b) => parseInt(a.id.slice(1), 10) - parseInt(b.id.slice(1), 10));
}

/** Dashboard HTML — single page, no bundler needed. */
function renderDashboard(opts: ServeOptions): string {
  const defaults = {
    roadmap: opts.defaultRoadmap ?? "",
    projectRoot: opts.defaultProjectRoot ?? (opts.defaultRoadmap ? dirname(dirname(opts.defaultRoadmap)) : ""),
    outputDir: opts.outputDir,
  };
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Phase Gate — Sonance</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<style>
:root{
  /* Sonance brand — dark mode semantic palette (from sonance-brand-mcp) */
  --charcoal:#333F48;
  --beam:#00A3E1;
  --beam-glow:rgba(0,163,225,.2);
  --bg:#1a1f24;
  --bg-2:#242a31;
  --bg-3:#2d343c;
  --card:#242a31;
  --fg:#FFFFFF;
  --fg-2:#D9D9D6;
  --fg-muted:#8f999f;
  --border:#3a444c;
  --border-glass:rgba(255,255,255,.08);
  --glass:rgba(255,255,255,.03);
  --pass:#22c55e;
  --fail:#ef4444;
  --warn:#f59e0b;
  --human:#a78bfa;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;height:100%;font-family:'Montserrat',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased;font-weight:400}
body{display:flex;flex-direction:column;height:100vh;overflow:hidden;background:radial-gradient(ellipse at top,#1f262d 0%,var(--bg) 60%)}
header{background:linear-gradient(135deg,#1f262d 0%,var(--bg) 100%);color:var(--fg);padding:22px 36px;border-bottom:1px solid var(--border);flex-shrink:0;position:relative}
header::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:1px;background:linear-gradient(90deg,transparent,var(--beam) 20%,var(--beam) 80%,transparent);opacity:.6}
header .brand{font-size:10px;letter-spacing:.28em;text-transform:uppercase;color:var(--beam);font-weight:600;margin-bottom:6px}
header h1{margin:0;font-size:22px;font-weight:300;letter-spacing:-.02em;color:var(--fg)}
.control{background:var(--glass);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid var(--border-glass);padding:22px 36px;flex-shrink:0}
.row{display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap}
.field{display:flex;flex-direction:column;gap:7px;flex:1;min-width:260px}
.field.narrow{flex:0 0 180px;min-width:160px}
.field label{font-size:9px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--fg-muted)}
.field input,.field select{padding:11px 13px;border:1px solid var(--border);border-radius:12px;font-size:12px;font-family:inherit;font-weight:400;background:var(--bg-2);color:var(--fg);transition:all .15s}
.field input::placeholder{color:var(--fg-muted)}
.field input:hover,.field select:hover{border-color:#4a5560}
.field input:focus,.field select:focus{outline:none;border-color:var(--beam);box-shadow:0 0 0 3px var(--beam-glow),0 0 20px var(--beam-glow)}
.field select{cursor:pointer;appearance:none;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'><path fill='%238f999f' d='M6 8L2 4h8z'/></svg>");background-repeat:no-repeat;background-position:right 12px center;padding-right:32px}
.btn{padding:13px 30px;border:none;border-radius:12px;font-family:inherit;font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;cursor:pointer;transition:all .18s;white-space:nowrap}
.btn.go{background:var(--beam);color:#fff;box-shadow:0 0 0 0 var(--beam-glow)}
.btn.go:hover:not(:disabled){background:#0bb4f0;transform:translateY(-1px);box-shadow:0 8px 24px var(--beam-glow),0 0 40px var(--beam-glow)}
.btn.go:active:not(:disabled){transform:translateY(0)}
.btn.go:disabled{opacity:.4;cursor:not-allowed}
.status{padding:12px 36px;background:var(--bg-2);border-bottom:1px solid var(--border-glass);color:var(--fg-2);font-family:'JetBrains Mono','SF Mono',Menlo,monospace;font-size:11px;flex-shrink:0;min-height:40px;display:flex;align-items:center;gap:12px}
.status.idle{display:none}
.status .spinner{width:13px;height:13px;border:2px solid var(--border);border-top-color:var(--beam);border-radius:50%;animation:spin .8s linear infinite;flex-shrink:0}
.status.err{background:rgba(239,68,68,.08);color:#fca5a5;border-left:3px solid var(--fail);padding-left:33px}
.status.ok{background:rgba(34,197,94,.08);color:#86efac;border-left:3px solid var(--pass);padding-left:33px}
@keyframes spin{to{transform:rotate(360deg)}}
.frame{flex:1;position:relative;background:var(--bg);overflow:hidden;padding:20px 36px 36px}
.frame iframe{width:100%;height:100%;border:none;background:var(--bg);border-radius:20px;border:1px solid var(--border-glass);box-shadow:0 8px 32px rgba(0,0,0,.4)}
.empty{position:absolute;inset:20px 36px 36px;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:10px;color:var(--fg-muted);font-size:13px;background:var(--glass);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid var(--border-glass);border-radius:20px}
.empty .big{font-size:48px;margin-bottom:8px;opacity:.4;color:var(--beam)}
.empty b{color:var(--fg-2);font-weight:500}
.muted{font-size:11px;color:var(--fg-muted);margin-top:8px;letter-spacing:.02em}
.muted code{color:var(--beam);font-family:'JetBrains Mono',monospace;font-size:10px}
.tabs{display:flex;gap:6px;padding:12px 36px 0;background:var(--bg);border-bottom:1px solid var(--border);overflow-x:auto;flex-shrink:0;scrollbar-width:thin}
.tabs::-webkit-scrollbar{height:6px}
.tabs::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px}
.tab{padding:11px 20px;border:1px solid var(--border);border-bottom:none;background:var(--bg-2);color:var(--fg-muted);border-radius:12px 12px 0 0;cursor:pointer;font-family:inherit;font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;white-space:nowrap;display:flex;align-items:center;gap:8px;transition:all .15s;position:relative;top:1px}
.tab:hover{color:var(--fg);background:var(--bg-3)}
.tab.active{background:var(--bg);color:var(--fg);border-color:var(--border);border-bottom:1px solid var(--bg);box-shadow:0 -2px 12px rgba(0,0,0,.2)}
.tab.active::before{content:"";position:absolute;top:0;left:12px;right:12px;height:2px;background:var(--beam);border-radius:2px;box-shadow:0 0 12px var(--beam-glow)}
.tab.overview{font-weight:700}
.tab .count{font-size:9px;padding:2px 7px;border-radius:6px;background:var(--bg-3);color:var(--fg-2);font-weight:600;letter-spacing:.04em;border:1px solid var(--border)}
.tab.active .count{background:var(--beam);color:#fff;border-color:var(--beam)}
.tab .pip{width:7px;height:7px;border-radius:50%;background:var(--fg-muted)}
.tab[data-gate="cleared"] .pip{background:var(--pass);box-shadow:0 0 8px rgba(34,197,94,.5)}
.tab[data-gate="locked"] .pip{background:var(--fail);box-shadow:0 0 8px rgba(239,68,68,.5)}
.tab[data-gate="none"] .pip{background:var(--fg-muted)}
</style></head><body>
<header>
  <div class="brand">Sonance · Phase Gate</div>
  <h1>AI-Powered Test Plan Dashboard</h1>
</header>
<div class="control">
  <div class="row">
    <div class="field">
      <label for="roadmap">Roadmap (.md file)</label>
      <input id="roadmap" type="text" value="${esc(defaults.roadmap)}" placeholder="/path/to/ROADMAP.md"/>
    </div>
    <div class="field">
      <label for="projectRoot">Project Root</label>
      <input id="projectRoot" type="text" value="${esc(defaults.projectRoot)}" placeholder="/path/to/repo"/>
    </div>
    <div class="field narrow">
      <label for="phase">Phase</label>
      <select id="phase"><option value="">— pick roadmap first —</option></select>
    </div>
    <div class="field narrow">
      <label for="mode">Mode</label>
      <select id="mode">
        <option value="both">Generate + Run</option>
        <option value="generate">Generate only</option>
        <option value="run">Run only</option>
      </select>
    </div>
    <button id="go" class="btn go">▶ GO</button>
  </div>
  <div class="muted">Output dir: ${esc(defaults.outputDir)}</div>
</div>
<div id="status" class="status idle"></div>
<div id="tabs" class="tabs"></div>
<div class="frame">
  <div id="empty" class="empty">
    <div class="big">⟲</div>
    <div>Pick a roadmap and phase, then hit <b>GO</b>.</div>
    <div class="muted">Existing plans load automatically when you select a phase.</div>
  </div>
  <iframe id="report" style="display:none"></iframe>
</div>
<script>
const $ = (id) => document.getElementById(id);
const roadmapEl = $("roadmap");
const projectEl = $("projectRoot");
const phaseEl = $("phase");
const modeEl = $("mode");
const goBtn = $("go");
const statusEl = $("status");
const iframe = $("report");
const empty = $("empty");

let knownPhases = [];
let planSummaries = [];
let knownPlans = new Set();
let activeTab = "overview";

function setStatus(msg, cls){
  statusEl.className = "status " + (cls || "");
  if (!msg) { statusEl.classList.add("idle"); statusEl.innerHTML = ""; return; }
  const spin = cls === "" || cls === undefined ? '<div class="spinner"></div>' : '';
  statusEl.innerHTML = spin + '<span>' + msg + '</span>';
}

async function loadPlans(){
  try {
    const r = await fetch("/api/plans");
    const j = await r.json();
    planSummaries = j.plans || [];
    knownPlans = new Set(planSummaries.map(p => p.phase));
    renderTabs();
  } catch {}
}
function renderTabs(){
  const tabs = document.getElementById("tabs");
  const overviewTab = '<div class="tab overview" data-tab="overview"><span class="pip" style="background:var(--beam);box-shadow:0 0 8px var(--beam-glow)"></span>Overview<span class="count">' + planSummaries.length + '</span></div>';
  const phaseTabs = planSummaries.map(p => {
    const gate = p.gateCleared ? "cleared" : "locked";
    return '<div class="tab" data-tab="' + p.phase + '" data-gate="' + gate + '"><span class="pip"></span>' + p.phase + '<span class="count">' + p.pass + '/' + p.total + '</span></div>';
  }).join("");
  tabs.innerHTML = overviewTab + phaseTabs;
  tabs.querySelectorAll(".tab").forEach(t => {
    t.classList.toggle("active", t.dataset.tab === activeTab);
    t.addEventListener("click", () => switchTab(t.dataset.tab));
  });
}
function switchTab(tab){
  activeTab = tab;
  document.querySelectorAll("#tabs .tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
  if (tab === "overview") showOverview();
  else showReport(tab);
}
function showOverview(){
  iframe.style.display = "block";
  empty.style.display = "none";
  iframe.src = "/overview?t=" + Date.now();
}

async function detectPhases(){
  const roadmap = roadmapEl.value.trim();
  if (!roadmap) return;
  setStatus("Scanning roadmap for phases…");
  try {
    const r = await fetch("/api/phases", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({roadmap})});
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "failed");
    knownPhases = j.phases || [];
    phaseEl.innerHTML = knownPhases.length
      ? knownPhases.map(p => {
          const has = knownPlans.has(p.id) ? " ✓" : "";
          return '<option value="' + p.id + '">' + p.id + ' — ' + escapeHtml(p.title.replace(new RegExp('^#+\\\\s*', ''), '').slice(0, 60)) + has + '</option>';
        }).join("")
      : '<option value="">(no phases detected)</option>';
    setStatus("Found " + knownPhases.length + " phase(s) in " + j.roadmap, "ok");
    setTimeout(() => setStatus(""), 2500);
    // Auto-load report for first phase if it exists
    if (knownPhases.length && knownPlans.has(knownPhases[0].id)) {
      showReport(knownPhases[0].id);
    }
  } catch (e) {
    setStatus("Failed to scan roadmap: " + e.message, "err");
  }
}

function showReport(phase){
  iframe.style.display = "block";
  empty.style.display = "none";
  iframe.src = "/report/" + encodeURIComponent(phase) + "?t=" + Date.now();
  activeTab = phase;
  document.querySelectorAll("#tabs .tab").forEach(t => t.classList.toggle("active", t.dataset.tab === phase));
}

function escapeHtml(s){return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}

phaseEl.addEventListener("change", () => {
  const p = phaseEl.value;
  if (p && knownPlans.has(p)) showReport(p);
});

roadmapEl.addEventListener("change", detectPhases);
roadmapEl.addEventListener("blur", detectPhases);

goBtn.addEventListener("click", async () => {
  const roadmap = roadmapEl.value.trim();
  const projectRoot = projectEl.value.trim();
  const phase = phaseEl.value;
  const mode = modeEl.value;
  if (!roadmap || !projectRoot || !phase) {
    setStatus("Roadmap, project root, and phase are all required.", "err");
    return;
  }
  goBtn.disabled = true;
  const label = mode === "generate" ? "Generating" : mode === "run" ? "Running" : "Generating + Running";
  setStatus(label + " tests for " + phase + " (this can take a minute)…");
  try {
    const r = await fetch("/api/go", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({roadmap,projectRoot,phase,mode})});
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "failed");
    await loadPlans();
    setStatus("✓ Done — " + j.total + " tests · gate " + (j.gateCleared ? "CLEARED" : "LOCKED"), "ok");
    setTimeout(() => setStatus(""), 3500);
    showReport(phase);
  } catch (e) {
    setStatus("Failed: " + e.message, "err");
  } finally {
    goBtn.disabled = false;
  }
});

// boot
(async () => {
  await loadPlans();
  if (planSummaries.length > 0) showOverview();
  if (roadmapEl.value.trim()) detectPhases();
})();
</script>
</body></html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface PlanSummary {
  phase: string;
  title: string;
  total: number;
  pass: number;
  fail: number;
  awaitingHuman: number;
  notTested: number;
  blocked: number;
  gateCleared: boolean;
  humanTotal: number;
  lastRunAt?: string;
}

function listPlansSummary(outputDir: string): PlanSummary[] {
  if (!existsSync(outputDir)) return [];
  const files = readdirSync(outputDir).filter((f) => f.endsWith("_Test_Plan.json"));
  const summaries: PlanSummary[] = [];
  for (const f of files) {
    const phase = f.replace("_Test_Plan.json", "");
    const plan = loadPlan(outputDir, phase);
    if (!plan) continue;
    const s: PlanSummary = {
      phase,
      title: plan.title,
      total: plan.tests.length,
      pass: 0, fail: 0, awaitingHuman: 0, notTested: 0, blocked: 0,
      gateCleared: plan.gateCleared,
      humanTotal: plan.tests.filter((t) => t.executor === "human").length,
      lastRunAt: plan.lastRunAt,
    };
    for (const t of plan.tests) {
      if (t.result === "PASS") s.pass++;
      else if (t.result === "FAIL") s.fail++;
      else if (t.result === "AWAITING HUMAN") s.awaitingHuman++;
      else if (t.result === "BLOCKED") s.blocked++;
      else if (t.result === "NOT TESTED") s.notTested++;
    }
    summaries.push(s);
  }
  // Sort by phase numerically if M<n>
  summaries.sort((a, b) => {
    const na = parseInt(a.phase.replace(/\D/g, ""), 10);
    const nb = parseInt(b.phase.replace(/\D/g, ""), 10);
    return (isNaN(na) ? 999 : na) - (isNaN(nb) ? 999 : nb);
  });
  return summaries;
}

function renderOverview(outputDir: string): string {
  const plans = listPlansSummary(outputDir);
  const agg = plans.reduce(
    (a, p) => {
      a.total += p.total; a.pass += p.pass; a.fail += p.fail;
      a.awaitingHuman += p.awaitingHuman; a.notTested += p.notTested; a.blocked += p.blocked;
      if (p.gateCleared) a.cleared++;
      return a;
    },
    { total: 0, pass: 0, fail: 0, awaitingHuman: 0, notTested: 0, blocked: 0, cleared: 0 }
  );
  const pct = (n: number) => (agg.total > 0 ? Math.round((n / agg.total) * 100) : 0);

  const rows = plans.map((p) => {
    const bar = (n: number, cls: string) => {
      const w = p.total > 0 ? (n / p.total) * 100 : 0;
      return w > 0 ? `<div class="seg ${cls}" style="width:${w}%" title="${cls}: ${n}"></div>` : "";
    };
    return `<tr>
      <td class="phase-cell"><a href="/report/${encodeURIComponent(p.phase)}" target="_top" class="phase-link">${esc(p.phase)}</a></td>
      <td>${esc(p.title)}</td>
      <td class="num">${p.total}</td>
      <td class="bar-cell"><div class="pbar">${bar(p.pass, "pass")}${bar(p.fail, "fail")}${bar(p.awaitingHuman, "human")}${bar(p.blocked, "warn")}${bar(p.notTested, "idle")}</div></td>
      <td class="num pass-n">${p.pass}</td>
      <td class="num fail-n">${p.fail}</td>
      <td class="num human-n">${p.awaitingHuman}</td>
      <td class="num">${p.notTested}</td>
      <td>${p.gateCleared ? '<span class="gpill cleared">✓ Cleared</span>' : '<span class="gpill locked">✕ Locked</span>'}</td>
      <td class="dim">${p.lastRunAt ? new Date(p.lastRunAt).toLocaleString() : "Never"}</td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/>
<title>Overview — Phase Gate</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<style>
:root{--beam:#00A3E1;--beam-glow:rgba(0,163,225,.2);--bg:#1a1f24;--bg-2:#242a31;--bg-3:#2d343c;--fg:#fff;--fg-2:#D9D9D6;--fg-muted:#8f999f;--border:#3a444c;--border-glass:rgba(255,255,255,.08);--glass:rgba(255,255,255,.03);--pass:#22c55e;--fail:#ef4444;--warn:#f59e0b;--human:#a78bfa}
*{box-sizing:border-box}
body{margin:0;padding:0;font-family:'Montserrat',sans-serif;font-size:13px;background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased;background-image:radial-gradient(ellipse at top,#1f262d 0%,var(--bg) 60%);min-height:100vh}
header{padding:28px 36px 20px;border-bottom:1px solid var(--border);position:relative}
header::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:1px;background:linear-gradient(90deg,transparent,var(--beam) 20%,var(--beam) 80%,transparent);opacity:.6}
.brand{font-size:10px;letter-spacing:.28em;text-transform:uppercase;color:var(--beam);font-weight:600;margin-bottom:8px}
h1{margin:0;font-size:24px;font-weight:300;letter-spacing:-.02em}
p.sub{margin:6px 0 0;color:var(--fg-muted);font-size:11px;letter-spacing:.02em}
main{padding:28px 36px 48px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:28px}
.card{background:var(--glass);backdrop-filter:blur(12px);border:1px solid var(--border-glass);border-radius:16px;padding:20px 22px}
.card .lbl{font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--fg-muted);font-weight:600;margin-bottom:8px}
.card .val{font-size:34px;font-weight:300;letter-spacing:-.02em;line-height:1}
.card .pct{font-size:11px;color:var(--fg-muted);margin-top:4px}
.card.pass .val{color:var(--pass)} .card.fail .val{color:var(--fail)} .card.human .val{color:var(--human)} .card.warn .val{color:var(--warn)} .card.beam .val{color:var(--beam)}
.table-wrap{background:var(--glass);backdrop-filter:blur(12px);border:1px solid var(--border-glass);border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.3)}
table{width:100%;border-collapse:collapse}
th{background:var(--bg-2);color:var(--fg-muted);padding:14px;text-align:left;font-size:9px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;border-bottom:1px solid var(--border)}
td{padding:14px;border-bottom:1px solid var(--border-glass);font-size:12px;color:var(--fg-2);vertical-align:middle}
tbody tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(255,255,255,.03)}
td.num{font-variant-numeric:tabular-nums;font-weight:500;text-align:right;width:54px}
td.pass-n{color:var(--pass)} td.fail-n{color:var(--fail)} td.human-n{color:var(--human)}
.phase-cell{width:70px}
.phase-link{color:var(--beam);text-decoration:none;font-family:'JetBrains Mono',monospace;font-weight:600;padding:5px 10px;border-radius:8px;background:rgba(0,163,225,.1);border:1px solid rgba(0,163,225,.3);transition:all .15s;display:inline-block}
.phase-link:hover{background:var(--beam);color:#fff;box-shadow:0 0 16px var(--beam-glow)}
.bar-cell{min-width:200px}
.pbar{display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--bg-3);border:1px solid var(--border)}
.seg.pass{background:var(--pass)} .seg.fail{background:var(--fail)} .seg.human{background:var(--human)} .seg.warn{background:var(--warn)} .seg.idle{background:var(--bg-3)}
.gpill{display:inline-block;padding:5px 11px;border-radius:8px;font-size:9px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;border:1px solid var(--border)}
.gpill.cleared{background:rgba(34,197,94,.12);color:var(--pass);border-color:rgba(34,197,94,.3)}
.gpill.locked{background:rgba(239,68,68,.12);color:var(--fail);border-color:rgba(239,68,68,.3)}
.dim{color:var(--fg-muted);font-size:11px}
.empty{padding:60px 20px;text-align:center;color:var(--fg-muted);font-size:13px}
::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-track{background:var(--bg)}::-webkit-scrollbar-thumb{background:var(--border);border-radius:8px}
</style></head><body>
<header>
  <div class="brand">Sonance · Phase Gate</div>
  <h1>Program Overview</h1>
  <p class="sub">${plans.length} phase${plans.length === 1 ? "" : "s"} · ${agg.cleared}/${plans.length} gates cleared · ${agg.total} total tests</p>
</header>
<main>
${plans.length === 0 ? `<div class="empty">No test plans yet. Generate one from the dashboard.</div>` : `
<div class="cards">
  <div class="card beam"><div class="lbl">Phases</div><div class="val">${plans.length}</div><div class="pct">${agg.cleared} cleared</div></div>
  <div class="card"><div class="lbl">Total Tests</div><div class="val">${agg.total}</div></div>
  <div class="card pass"><div class="lbl">Pass</div><div class="val">${agg.pass}</div><div class="pct">${pct(agg.pass)}%</div></div>
  <div class="card fail"><div class="lbl">Fail</div><div class="val">${agg.fail}</div><div class="pct">${pct(agg.fail)}%</div></div>
  <div class="card human"><div class="lbl">Awaiting Human</div><div class="val">${agg.awaitingHuman}</div><div class="pct">${pct(agg.awaitingHuman)}%</div></div>
  <div class="card warn"><div class="lbl">Blocked</div><div class="val">${agg.blocked}</div><div class="pct">${pct(agg.blocked)}%</div></div>
  <div class="card"><div class="lbl">Not Tested</div><div class="val">${agg.notTested}</div><div class="pct">${pct(agg.notTested)}%</div></div>
</div>
<div class="table-wrap"><table>
<thead><tr><th>Phase</th><th>Title</th><th style="text-align:right">Tests</th><th>Progress</th><th style="text-align:right">✓</th><th style="text-align:right">✕</th><th style="text-align:right">✋</th><th style="text-align:right">—</th><th>Gate</th><th>Last Run</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>
`}
</main>
</body></html>`;
}
