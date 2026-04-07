/**
 * Renders a PhaseTestPlan to xlsx, md, and/or html.
 */
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { PhaseTestPlan, TestResult, OutputFormat } from "./types.ts";

const RESULT_COLOR: Record<TestResult, string> = {
  PASS: "#16a34a",
  FAIL: "#dc2626",
  "NOT TESTED": "#6b7280",
  BLOCKED: "#d97706",
  WARNING: "#ca8a04",
  "INFO ONLY": "#2563eb",
};

export async function render(
  plan: PhaseTestPlan,
  formats: OutputFormat[],
  outputDir: string
): Promise<void> {
  mkdirSync(outputDir, { recursive: true });
  for (const fmt of formats) {
    if (fmt === "json") continue;
    if (fmt === "xlsx") await renderXlsx(plan, outputDir);
    if (fmt === "md") renderMd(plan, outputDir);
    if (fmt === "html") renderHtml(plan, outputDir);
  }
}

// ─── XLSX ─────────────────────────────────────────────────────────────────────

async function renderXlsx(plan: PhaseTestPlan, outputDir: string): Promise<void> {
  const XLSX = (await import("xlsx")).default;
  const path = join(outputDir, `${plan.phase}_Test_Plan.xlsx`);

  const wb = XLSX.utils.book_new();
  const categories = [...new Set(plan.tests.map((t) => t.category))];

  const HEADERS = [
    "Test ID", "Section", "Description",
    "How To Test (Steps & Commands)", "Expected Result",
    "Pass/Fail", "Notes / Observations",
  ];

  const rows: unknown[][] = [];
  for (const cat of categories) {
    rows.push(["", cat, "", "", "", "", ""]);
    for (const tc of plan.tests.filter((t) => t.category === cat)) {
      rows.push([
        tc.id, tc.category, tc.description, tc.howToTest,
        tc.expectedResult,
        tc.result === "NOT TESTED" ? "" : tc.result,
        tc.notes,
      ]);
    }
    rows.push(["", "", "", "", "", "", ""]);
  }

  const ws = XLSX.utils.aoa_to_sheet([HEADERS, ...rows]);
  ws["!cols"] = [
    { wch: 11 }, { wch: 26 }, { wch: 44 },
    { wch: 80 }, { wch: 70 }, { wch: 14 }, { wch: 40 },
  ];
  (ws as Record<string, unknown>)["!freeze"] = {
    xSplit: 2, ySplit: 1, topLeftCell: "C2", activeCell: "C2", sqref: "C2",
  };

  XLSX.utils.book_append_sheet(wb, ws, `${plan.phase} Test Cases`);
  XLSX.writeFile(wb, path);
}

// ─── Markdown ─────────────────────────────────────────────────────────────────

function renderMd(plan: PhaseTestPlan, outputDir: string): void {
  const path = join(outputDir, `${plan.phase}_Test_Plan.md`);
  const s = summary(plan);

  const lines = [
    `# ${plan.phase}: ${plan.title} — Test Plan`,
    ``,
    `**Generated:** ${plan.generatedAt} | **Last Run:** ${plan.lastRunAt ?? "Never"} | **Gate:** ${plan.gateCleared ? "✅ CLEARED" : "🔒 LOCKED"}`,
    ``,
    `| Total | Pass | Fail | Not Tested | Blocked |`,
    `|-------|------|------|------------|---------|`,
    `| ${s.total} | ${s.pass} | ${s.fail} | ${s.notTested} | ${s.blocked} |`,
    ``,
    `---`,
  ];

  const categories = [...new Set(plan.tests.map((t) => t.category))];
  for (const cat of categories) {
    lines.push(``, `## ${cat}`);
    for (const tc of plan.tests.filter((t) => t.category === cat)) {
      const badge = { PASS: "✅", FAIL: "❌", "NOT TESTED": "⬜", BLOCKED: "🚫", WARNING: "⚠️", "INFO ONLY": "ℹ️" }[tc.result] ?? "⬜";
      lines.push(
        ``, `### ${tc.id} — ${tc.description} ${badge}`,
        ``, `**Expected:** ${tc.expectedResult}`,
        ``, `\`\`\`bash`, tc.howToTest, `\`\`\``
      );
      if (tc.notes) lines.push(``, `> **Notes:** ${tc.notes}`);
    }
  }

  writeFileSync(path, lines.join("\n"), "utf8");
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

function renderHtml(plan: PhaseTestPlan, outputDir: string): void {
  const path = join(outputDir, `${plan.phase}_Test_Plan.html`);
  const s = summary(plan);

  const rows = (() => {
    const categories = [...new Set(plan.tests.map((t) => t.category))];
    return categories.map((cat) => {
      const header = `<tr class="section-header"><td colspan="7">${esc(cat)}</td></tr>`;
      const tests = plan.tests.filter((t) => t.category === cat).map((tc) => {
        const color = RESULT_COLOR[tc.result] ?? "#6b7280";
        const badge = tc.result === "NOT TESTED" ? "" : `<span class="badge" style="background:${color}">${tc.result}</span>`;
        return `<tr><td class="id">${tc.id}</td><td>${esc(tc.category)}</td><td>${esc(tc.description)}</td><td><pre>${esc(tc.howToTest)}</pre></td><td>${esc(tc.expectedResult)}</td><td>${badge}</td><td>${esc(tc.notes)}</td></tr>`;
      }).join("");
      return header + tests;
    }).join("");
  })();

  writeFileSync(path, `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${plan.phase} Test Plan</title>
<style>
:root{--charcoal:#333F48;--beam:#00A3E1;--silver:#D9D9D6}
body{margin:0;padding:0;font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;background:#f5f5f4}
header{background:var(--charcoal);color:#fff;padding:20px 32px}
header h1{margin:0 0 4px;font-size:20px}header p{margin:0;opacity:.65;font-size:12px}
.bar{display:flex;gap:12px;padding:14px 32px;background:#fff;border-bottom:1px solid var(--silver);align-items:center;flex-wrap:wrap}
.stat{padding:6px 14px;border-radius:8px;font-weight:700;font-size:12px;display:flex;flex-direction:column;align-items:center}
.stat span{font-size:20px}
.gate{margin-left:auto;font-weight:700;font-size:13px}
main{padding:20px 32px}
.filters{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.fbtn{padding:4px 14px;border-radius:20px;border:1px solid var(--silver);background:#fff;cursor:pointer;font-size:12px;font-weight:500}
.fbtn.active{background:var(--charcoal);color:#fff;border-color:var(--charcoal)}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)}
th{background:var(--charcoal);color:#fff;padding:9px 11px;text-align:left;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
td{padding:9px 11px;border-bottom:1px solid #f0f0ef;vertical-align:top}
tr.section-header td{background:#f0f4f8;font-weight:700;color:var(--charcoal);font-size:12px;padding:7px 11px;letter-spacing:.02em}
tr:hover td{background:#fafaf9}
td.id{font-family:monospace;font-size:12px;color:var(--beam);white-space:nowrap}
pre{margin:0;font-size:11px;white-space:pre-wrap;word-break:break-word;background:#f6f8fa;padding:7px;border-radius:4px;border:1px solid #e1e4e8}
.badge{display:inline-block;padding:2px 9px;border-radius:10px;color:#fff;font-size:11px;font-weight:700;letter-spacing:.04em}
</style></head><body>
<header><h1>${plan.phase}: ${esc(plan.title)} — Test Plan</h1><p>Generated ${plan.generatedAt} · Last run: ${plan.lastRunAt ?? "Never"}</p></header>
<div class="bar">
<div class="stat" style="background:#f0fdf4;color:#16a34a"><span>${s.pass}</span>PASS</div>
<div class="stat" style="background:#fef2f2;color:#dc2626"><span>${s.fail}</span>FAIL</div>
<div class="stat" style="background:#f9fafb;color:#6b7280"><span>${s.notTested}</span>NOT TESTED</div>
<div class="stat" style="background:#fffbeb;color:#d97706"><span>${s.blocked}</span>BLOCKED</div>
<div class="stat" style="background:#f0f9ff;color:#0369a1"><span>${s.total}</span>TOTAL</div>
<div class="gate">${plan.gateCleared ? "✅ Gate: CLEARED" : "🔒 Gate: LOCKED"}</div>
</div>
<main>
<div class="filters">
<button class="fbtn active" onclick="filter('ALL',this)">All</button>
<button class="fbtn" onclick="filter('PASS',this)">Pass</button>
<button class="fbtn" onclick="filter('FAIL',this)">Fail</button>
<button class="fbtn" onclick="filter('NOT TESTED',this)">Not Tested</button>
<button class="fbtn" onclick="filter('BLOCKED',this)">Blocked</button>
</div>
<table><thead><tr><th style="width:70px">ID</th><th style="width:130px">Section</th><th style="width:200px">Description</th><th style="width:260px">How To Test</th><th style="width:200px">Expected</th><th style="width:90px">Result</th><th>Notes</th></tr></thead>
<tbody id="tb">${rows}</tbody></table></main>
<script>
function filter(r,btn){
  document.querySelectorAll('.fbtn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('#tb tr').forEach(row=>{
    if(row.classList.contains('section-header')){row.style.display='';return}
    const b=row.querySelector('.badge');
    const v=b?b.textContent.trim():'NOT TESTED';
    row.style.display=(r==='ALL'||v===r)?'':'none';
  });
}
</script>
</body></html>`, "utf8");
}

function esc(s: string): string {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function summary(plan: PhaseTestPlan) {
  const out = { total: 0, pass: 0, fail: 0, notTested: 0, blocked: 0 };
  for (const t of plan.tests) {
    out.total++;
    if (t.result === "PASS") out.pass++;
    else if (t.result === "FAIL") out.fail++;
    else if (t.result === "NOT TESTED") out.notTested++;
    else if (t.result === "BLOCKED") out.blocked++;
  }
  return out;
}
