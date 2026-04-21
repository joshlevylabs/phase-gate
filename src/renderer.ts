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
  "AWAITING HUMAN": "#7c3aed",
};

const HUMAN_KIND_LABEL: Record<string, string> = {
  infrastructure: "🔌 Infra",
  usability: "👤 Usability",
  visual: "👁 Visual",
  hardware: "🔧 Hardware",
  "third-party": "🌐 3rd-Party",
  accessibility: "♿ A11y",
  "data-entry": "⌨ Data Entry",
  other: "✋ Manual",
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
      const badge = { PASS: "✅", FAIL: "❌", "NOT TESTED": "⬜", BLOCKED: "🚫", WARNING: "⚠️", "INFO ONLY": "ℹ️", "AWAITING HUMAN": "✋" }[tc.result] ?? "⬜";
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
      const header = `<tr class="section-header"><td colspan="10">${esc(cat)}</td></tr>`;
      const tests = plan.tests.filter((t) => t.category === cat).map((tc) => {
        const color = RESULT_COLOR[tc.result] ?? "#6b7280";
        const badge = tc.result === "NOT TESTED"
          ? `<span class="dim">—</span>`
          : `<span class="badge" style="background:${color}">${tc.result}</span>`;
        const actual = tc.actualOutput
          ? `<pre class="actual">${esc(tc.actualOutput)}</pre>`
          : `<span class="dim">—</span>`;
        const isHuman = tc.executor === "human";
        const typeKey = isHuman ? (tc.humanKind ?? "other") : "auto";
        const kindChip = isHuman
          ? `<div class="kind">${HUMAN_KIND_LABEL[tc.humanKind ?? "other"] ?? "✋ Manual"}</div>`
          : `<div class="kind auto">⚙ Auto</div>`;
        const priorityKey = tc.gating ? "required" : "optional";
        const necessity = tc.gating
          ? `<div class="req">REQUIRED</div>`
          : `<div class="opt">optional</div>`;
        const howCell = isHuman && tc.humanInstructions
          ? `<div class="howh">${esc(tc.humanInstructions)}</div>`
          : `<pre>${esc(tc.howToTest)}</pre>`;
        const facaBtn = tc.result === "FAIL"
          ? `<button class="vbtn faca" onclick="openFaca('${tc.id}')" title="Generate FACA + Claude Code fix prompt">⚡ FIX</button>`
          : "";
        const verdictCell = isHuman
          ? `<div class="verdict">${badge}<div class="btns">
              <button class="vbtn pass" onclick="mark('${tc.id}','PASS',this)">PASS</button>
              <button class="vbtn fail" onclick="mark('${tc.id}','FAIL',this)">FAIL</button>
              <button class="vbtn reset" onclick="mark('${tc.id}','AWAITING HUMAN',this)">↺</button>
              ${facaBtn}
            </div></div>`
          : `<div class="verdict">${badge}${facaBtn ? `<div class="btns">${facaBtn}</div>` : ""}</div>`;
        return `<tr data-result="${tc.result}" data-id="${tc.id}" data-executor="${tc.executor}" data-type="${typeKey}" data-priority="${priorityKey}"><td class="id">${tc.id}</td><td>${kindChip}</td><td>${necessity}</td><td>${esc(tc.category)}</td><td>${esc(tc.description)}</td><td>${howCell}</td><td>${esc(tc.expectedResult)}</td><td>${actual}</td><td class="vcell">${verdictCell}</td><td class="notes">${esc(tc.notes)}</td></tr>`;
      }).join("");
      return header + tests;
    }).join("");
  })();

  const awaitingHuman = plan.tests.filter((t) => t.executor === "human" && t.result === "AWAITING HUMAN").length;
  const humanTotal = plan.tests.filter((t) => t.executor === "human").length;

  writeFileSync(path, `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${plan.phase} Test Plan — Sonance</title>
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
  --human-bg:rgba(167,139,250,.08);
}
*{box-sizing:border-box}
body{margin:0;padding:0;font-family:'Montserrat',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased;font-weight:400;background-image:radial-gradient(ellipse at top,#1f262d 0%,var(--bg) 60%);min-height:100vh}
header{background:linear-gradient(135deg,#1f262d 0%,var(--bg) 100%);color:var(--fg);padding:28px 36px;border-bottom:1px solid var(--border);position:relative}
header::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:1px;background:linear-gradient(90deg,transparent,var(--beam) 20%,var(--beam) 80%,transparent);opacity:.6}
header .brand{font-size:10px;letter-spacing:.28em;text-transform:uppercase;color:var(--beam);font-weight:600;margin-bottom:8px}
header h1{margin:0 0 6px;font-size:24px;font-weight:300;letter-spacing:-.02em;color:var(--fg)}
header p{margin:0;color:var(--fg-muted);font-size:11px;letter-spacing:.02em}
.bar{display:flex;gap:10px;padding:22px 36px;background:var(--glass);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid var(--border-glass);align-items:center;flex-wrap:wrap}
.stat{padding:12px 20px;border-radius:12px;font-weight:500;font-size:9px;letter-spacing:.12em;text-transform:uppercase;display:flex;flex-direction:column;align-items:center;gap:4px;background:var(--bg-2);border:1px solid var(--border);color:var(--fg-muted);min-width:88px}
.stat span{font-size:26px;font-weight:300;letter-spacing:-.02em;line-height:1}
.stat.pass span{color:var(--pass)}
.stat.fail span{color:var(--fail)}
.stat.human span{color:var(--human)}
.stat.warn span{color:var(--warn)}
.stat.total span{color:var(--beam)}
.gate{margin-left:auto;font-weight:600;font-size:11px;letter-spacing:.12em;text-transform:uppercase;padding:12px 22px;border-radius:12px;border:1px solid var(--border)}
.gate.cleared{background:rgba(34,197,94,.1);color:var(--pass);border-color:rgba(34,197,94,.3);box-shadow:0 0 20px rgba(34,197,94,.15)}
.gate.locked{background:rgba(239,68,68,.1);color:var(--fail);border-color:rgba(239,68,68,.3);box-shadow:0 0 20px rgba(239,68,68,.15)}
main{padding:24px 36px 48px}
.banner{background:var(--human-bg);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid rgba(167,139,250,.2);border-left:3px solid var(--human);padding:16px 20px;border-radius:12px;margin-bottom:20px;font-size:12px;color:var(--fg-2);display:flex;align-items:center;gap:12px;line-height:1.5}
.banner strong{color:var(--human);font-weight:600}
.banner em{color:var(--fg-muted);font-style:normal;margin-left:auto;font-size:11px}
.banner code{font-family:'JetBrains Mono',monospace;background:var(--bg-2);padding:2px 7px;border-radius:6px;color:var(--beam);font-size:10px;border:1px solid var(--border)}
.filter-group{display:flex;align-items:center;gap:12px;margin-bottom:10px;flex-wrap:wrap}
.fg-label{font-size:9px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--fg-muted);min-width:68px}
.filters{display:flex;gap:6px;flex-wrap:wrap;flex:1}
.fbtn{padding:9px 18px;border-radius:12px;border:1px solid var(--border);background:var(--bg-2);cursor:pointer;font-size:10px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:var(--fg-2);transition:all .15s;font-family:inherit}
.fbtn:hover{border-color:var(--beam);color:var(--fg);background:var(--bg-3)}
.fbtn.active{background:var(--beam);color:#fff;border-color:var(--beam);box-shadow:0 0 20px var(--beam-glow)}
.table-wrap{background:var(--glass);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid var(--border-glass);border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.3)}
table{width:100%;border-collapse:collapse;background:transparent}
th{background:var(--bg-2);color:var(--fg-muted);padding:14px 14px;text-align:left;font-size:9px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;border-bottom:1px solid var(--border)}
td{padding:14px;border-bottom:1px solid var(--border-glass);vertical-align:top;font-size:12px;line-height:1.55;color:var(--fg-2)}
tbody tr:last-child td{border-bottom:none}
tr.section-header td{background:var(--bg-3);font-weight:600;color:var(--beam);font-size:10px;padding:11px 14px;letter-spacing:.16em;text-transform:uppercase;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
tr[data-executor="human"]{background:var(--human-bg)}
tr[data-executor="human"]:hover td{background:rgba(167,139,250,.12)}
tr:hover td{background:rgba(255,255,255,.03)}
td.id{font-family:'JetBrains Mono','SF Mono',Menlo,monospace;font-size:11px;color:var(--beam);white-space:nowrap;font-weight:500}
.kind{display:inline-block;padding:4px 9px;border-radius:8px;background:rgba(167,139,250,.15);color:var(--human);font-size:9px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap;border:1px solid rgba(167,139,250,.25)}
.kind.auto{background:rgba(0,163,225,.12);color:var(--beam);border-color:rgba(0,163,225,.25)}
.req{display:inline-block;margin-top:5px;padding:3px 8px;border-radius:8px;background:rgba(239,68,68,.12);color:#fca5a5;font-size:9px;font-weight:600;letter-spacing:.08em;border:1px solid rgba(239,68,68,.25)}
.opt{display:inline-block;margin-top:5px;padding:3px 8px;border-radius:8px;background:var(--bg-3);color:var(--fg-muted);font-size:9px;font-weight:500;letter-spacing:.06em;border:1px solid var(--border)}
pre{margin:0;font-family:'JetBrains Mono','SF Mono',Menlo,monospace;font-size:10px;white-space:pre-wrap;word-break:break-word;background:var(--bg);color:var(--fg-2);padding:10px 12px;border-radius:8px;line-height:1.6;border:1px solid var(--border)}
pre.actual{background:rgba(245,158,11,.08);border-color:rgba(245,158,11,.3);color:#fcd34d}
.howh{font-size:12px;line-height:1.55;color:var(--fg-2);white-space:pre-wrap}
.notes{font-size:11px;color:var(--fg-muted)}
.dim{color:var(--fg-muted);font-size:11px}
.badge{display:inline-block;padding:5px 11px;border-radius:8px;color:#fff;font-size:9px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;white-space:nowrap}
.vcell{min-width:150px}
.verdict{display:flex;flex-direction:column;gap:7px;align-items:flex-start}
.btns{display:flex;gap:4px}
.vbtn{padding:6px 11px;border:1px solid var(--border);background:var(--bg-2);color:var(--fg-2);border-radius:8px;cursor:pointer;font-size:9px;font-weight:600;letter-spacing:.1em;transition:all .15s;font-family:inherit}
.vbtn.pass:hover{background:var(--pass);color:#fff;border-color:var(--pass);box-shadow:0 0 16px rgba(34,197,94,.4)}
.vbtn.fail:hover{background:var(--fail);color:#fff;border-color:var(--fail);box-shadow:0 0 16px rgba(239,68,68,.4)}
.vbtn.reset:hover{background:var(--beam);color:#fff;border-color:var(--beam);box-shadow:0 0 16px var(--beam-glow)}
.toast{position:fixed;bottom:28px;right:28px;background:var(--bg-2);color:var(--fg);padding:14px 20px;border-radius:12px;font-size:12px;font-weight:500;box-shadow:0 12px 32px rgba(0,0,0,.5);transform:translateY(100px);opacity:0;transition:all .3s;border:1px solid var(--border);border-left:3px solid var(--beam);backdrop-filter:blur(12px)}
.toast.show{transform:translateY(0);opacity:1}
.toast.error{border-left-color:var(--fail);color:#fca5a5}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:8px}
::-webkit-scrollbar-thumb:hover{background:#4a5560}
.vchip{display:inline-block;padding:3px 10px;border-radius:8px;background:rgba(0,163,225,.15);color:var(--beam);font-size:11px;font-weight:600;letter-spacing:.06em;margin-left:8px;border:1px solid rgba(0,163,225,.3);vertical-align:middle;font-family:'JetBrains Mono',monospace}
.vbtn.faca{background:rgba(245,158,11,.15);color:var(--warn);border-color:rgba(245,158,11,.35);font-weight:700}
.vbtn.faca:hover{background:var(--warn);color:#1a1f24;border-color:var(--warn);box-shadow:0 0 16px rgba(245,158,11,.4)}
.fail-banner{border-left-color:var(--warn);background:rgba(245,158,11,.08);border-color:rgba(245,158,11,.2)}
.fail-banner strong{color:var(--warn)}
.btn-act{margin-left:auto;padding:10px 20px;background:var(--warn);color:#1a1f24;border:none;border-radius:10px;font-family:inherit;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;cursor:pointer;transition:all .15s;white-space:nowrap}
.btn-act:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(245,158,11,.35)}
.btn-act.alt{margin-left:10px;background:transparent;color:var(--beam);border:1px solid var(--beam)}
.btn-act.alt:hover{background:var(--beam);color:#fff;box-shadow:0 6px 20px var(--beam-glow)}
.history-strip{display:flex;align-items:center;gap:14px;padding:14px 18px;background:var(--glass);backdrop-filter:blur(12px);border:1px solid var(--border-glass);border-radius:12px;margin-bottom:18px;flex-wrap:wrap}
.hs-label{font-size:9px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--fg-muted)}
.hs-pills{display:flex;gap:8px;flex-wrap:wrap;flex:1;min-width:200px}
.hp{background:var(--bg-2);border:1px solid var(--border);border-radius:10px;padding:7px 11px;min-width:76px;display:flex;flex-direction:column;gap:4px;cursor:default}
.hp.pass{border-color:rgba(34,197,94,.35)}
.hp.fail{border-color:rgba(239,68,68,.35)}
.hp.warn{border-color:rgba(245,158,11,.35)}
.hpv{font-size:9px;font-weight:700;letter-spacing:.08em;color:var(--fg-muted);font-family:'JetBrains Mono',monospace}
.hpb{height:4px;background:var(--bg-3);border-radius:2px;overflow:hidden}
.hpbf{height:100%;background:var(--pass);border-radius:2px}
.hp.fail .hpbf{background:var(--fail)}
.hp.warn .hpbf{background:var(--warn)}
.hpn{font-size:10px;font-weight:500;color:var(--fg-2);font-family:'JetBrains Mono',monospace}
.delta{font-size:10px;font-weight:600;letter-spacing:.08em;padding:6px 12px;border-radius:8px;border:1px solid var(--border);background:var(--bg-2)}
.delta.up{color:var(--pass);border-color:rgba(34,197,94,.3)}
.delta.down{color:var(--fail);border-color:rgba(239,68,68,.3)}
.delta.flat{color:var(--fg-muted)}
.modal-bg{position:fixed;inset:0;background:rgba(10,15,20,.85);backdrop-filter:blur(8px);display:none;align-items:center;justify-content:center;z-index:100;padding:40px}
.modal-bg.show{display:flex}
.modal{background:var(--bg-2);border:1px solid var(--border);border-radius:20px;max-width:1100px;width:100%;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,.6)}
.modal-head{padding:22px 28px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:14px}
.modal-head h2{margin:0;font-size:16px;font-weight:500;letter-spacing:-.01em;color:var(--fg);flex:1}
.modal-head .close{background:transparent;border:1px solid var(--border);color:var(--fg-muted);width:34px;height:34px;border-radius:10px;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center}
.modal-head .close:hover{color:var(--fg);border-color:var(--fg-muted)}
.modal-tabs{display:flex;gap:4px;padding:14px 28px 0;background:var(--bg-2);border-bottom:1px solid var(--border)}
.mtab{padding:11px 20px;background:transparent;border:1px solid transparent;border-bottom:none;color:var(--fg-muted);border-radius:10px 10px 0 0;cursor:pointer;font-family:inherit;font-size:10px;font-weight:600;letter-spacing:.1em;text-transform:uppercase}
.mtab.active{background:var(--bg);color:var(--fg);border-color:var(--border);border-bottom:1px solid var(--bg);position:relative;top:1px}
.mtab.active::before{content:"";position:absolute;top:0;left:12px;right:12px;height:2px;background:var(--warn);border-radius:2px}
.modal-body{flex:1;overflow:auto;padding:24px 28px;background:var(--bg)}
.modal-body pre{white-space:pre-wrap;font-size:12px;line-height:1.65;color:var(--fg-2);background:transparent;border:none;padding:0;font-family:'JetBrains Mono',monospace}
.modal-foot{padding:16px 28px;border-top:1px solid var(--border);display:flex;gap:10px;align-items:center;background:var(--bg-2);border-radius:0 0 20px 20px}
.copy-btn{padding:11px 22px;background:var(--beam);color:#fff;border:none;border-radius:10px;font-family:inherit;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;cursor:pointer;transition:all .15s;margin-left:auto}
.copy-btn:hover{background:#0bb4f0;box-shadow:0 6px 20px var(--beam-glow)}
.copy-btn.ok{background:var(--pass)}
.loading{text-align:center;padding:80px 20px;color:var(--fg-muted);font-size:13px}
.loading .spinner-big{display:inline-block;width:44px;height:44px;border:3px solid var(--border);border-top-color:var(--warn);border-radius:50%;animation:spin 1s linear infinite;margin-bottom:18px}
</style></head><body>
<header>
  <div class="brand">Sonance · Phase Gate</div>
  <h1>${plan.phase}: ${esc(plan.title)} <span class="vchip">v${plan.version ?? 1}</span></h1>
  <p>Generated ${plan.generatedAt} · Last run ${plan.lastRunAt ?? "Never"} · ${(plan.history ?? []).length} run${(plan.history ?? []).length === 1 ? "" : "s"} recorded</p>
</header>
<div class="bar">
<div class="stat pass"><span>${s.pass}</span>Pass</div>
<div class="stat fail"><span>${s.fail}</span>Fail</div>
<div class="stat human"><span>${s.awaitingHuman}</span>Awaiting Human</div>
<div class="stat"><span>${s.notTested}</span>Not Tested</div>
<div class="stat warn"><span>${s.blocked}</span>Blocked</div>
<div class="stat total"><span>${s.total}</span>Total</div>
<div class="gate ${plan.gateCleared ? "cleared" : "locked"}">${plan.gateCleared ? "✓ Gate Cleared" : "✕ Gate Locked"}</div>
</div>
<main>
${renderHistoryStrip(plan)}
${humanTotal > 0 ? `<div class="banner">✋ <span><strong>${humanTotal} human test${humanTotal === 1 ? "" : "s"}</strong> in this plan${awaitingHuman > 0 ? ` — <strong>${awaitingHuman} still awaiting verdict</strong>. Required human tests must be marked PASS to clear the gate.` : "."}</span></div>` : ""}
${s.fail > 0 ? `<div class="banner fail-banner">⚡ <span><strong>${s.fail} failing test${s.fail === 1 ? "" : "s"}</strong> — generate a FACA report + Claude Code fix prompt, then advance to v${(plan.version ?? 1) + 1} to re-test.</span><button class="btn-act" onclick="openFaca()">⚡ FACA + Fix Prompt</button><button class="btn-act alt" onclick="newVersion()">↻ New Version</button></div>` : ""}
<div class="filter-group"><div class="fg-label">Result</div><div class="filters" data-fgroup="result">
<button class="fbtn active" data-val="ALL">All</button>
<button class="fbtn" data-val="PASS">Pass</button>
<button class="fbtn" data-val="FAIL">Fail</button>
<button class="fbtn" data-val="AWAITING HUMAN">Awaiting Human</button>
<button class="fbtn" data-val="NOT TESTED">Not Tested</button>
<button class="fbtn" data-val="BLOCKED">Blocked</button>
</div></div>
<div class="filter-group"><div class="fg-label">Type</div><div class="filters" data-fgroup="type">
<button class="fbtn active" data-val="ALL">All</button>
<button class="fbtn" data-val="auto">⚙ Auto</button>
<button class="fbtn" data-val="infrastructure">🔌 Infra</button>
<button class="fbtn" data-val="usability">👤 Usability</button>
<button class="fbtn" data-val="visual">👁 Visual</button>
<button class="fbtn" data-val="hardware">🔧 Hardware</button>
<button class="fbtn" data-val="third-party">🌐 3rd-Party</button>
<button class="fbtn" data-val="accessibility">♿ A11y</button>
<button class="fbtn" data-val="data-entry">⌨ Data Entry</button>
<button class="fbtn" data-val="other">✋ Other</button>
</div></div>
<div class="filter-group"><div class="fg-label">Priority</div><div class="filters" data-fgroup="priority">
<button class="fbtn active" data-val="ALL">All</button>
<button class="fbtn" data-val="required">Required</button>
<button class="fbtn" data-val="optional">Optional</button>
</div></div>
<div class="table-wrap"><table><thead><tr><th style="width:50px">ID</th><th style="width:100px">Type</th><th style="width:90px">Priority</th><th style="width:120px">Section</th><th style="width:180px">Description</th><th style="width:220px">How To Test</th><th style="width:170px">Expected</th><th style="width:180px">Actual Output</th><th style="width:140px">Result</th><th>Notes</th></tr></thead>
<tbody id="tb">${rows}</tbody></table></div></main>
<div id="toast" class="toast"></div>
<div id="facaModal" class="modal-bg" onclick="if(event.target===this)closeFaca()">
  <div class="modal">
    <div class="modal-head">
      <h2 id="facaTitle">FACA Report</h2>
      <button class="close" onclick="closeFaca()">×</button>
    </div>
    <div class="modal-tabs">
      <button class="mtab active" data-mtab="faca" onclick="switchMTab('faca')">FACA Report</button>
      <button class="mtab" data-mtab="prompt" onclick="switchMTab('prompt')">Claude Code Prompt</button>
    </div>
    <div class="modal-body">
      <div id="facaPane"><div class="loading"><div class="spinner-big"></div><div>Generating FACA — this can take 20–40 seconds…</div></div></div>
      <div id="promptPane" style="display:none"></div>
    </div>
    <div class="modal-foot">
      <button class="copy-btn" id="copyBtn" onclick="copyActive()">Copy to Clipboard</button>
    </div>
  </div>
</div>
<script>
const PHASE=${JSON.stringify(plan.phase)};
const active={result:'ALL',type:'ALL',priority:'ALL'};
document.querySelectorAll('.filters').forEach(group=>{
  const key=group.dataset.fgroup;
  group.querySelectorAll('.fbtn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      group.querySelectorAll('.fbtn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      active[key]=btn.dataset.val;
      applyFilters();
    });
  });
});
function applyFilters(){
  document.querySelectorAll('#tb tr').forEach(row=>{
    if(row.classList.contains('section-header')){row.style.display='';return}
    const r=row.dataset.result||'NOT TESTED';
    const t=row.dataset.type||'auto';
    const p=row.dataset.priority||'required';
    const show=(active.result==='ALL'||active.result===r)
            &&(active.type==='ALL'||active.type===t)
            &&(active.priority==='ALL'||active.priority===p);
    row.style.display=show?'':'none';
  });
  // Hide section headers whose tests are all hidden
  document.querySelectorAll('#tb tr.section-header').forEach(h=>{
    let sibling=h.nextElementSibling,anyVisible=false;
    while(sibling&&!sibling.classList.contains('section-header')){
      if(sibling.style.display!=='none'){anyVisible=true;break}
      sibling=sibling.nextElementSibling;
    }
    h.style.display=anyVisible?'':'none';
  });
}
function toast(msg,err){
  const t=document.getElementById('toast');
  t.textContent=msg;t.classList.toggle('error',!!err);t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2400);
}
async function mark(id,verdict,btn){
  const row=btn.closest('tr');
  const prev=row.dataset.result;
  row.dataset.result=verdict;
  // optimistic UI
  const badge=row.querySelector('.vcell .badge,.vcell .dim');
  const colors={PASS:'#16a34a',FAIL:'#dc2626','AWAITING HUMAN':'#7c3aed'};
  if(badge){
    badge.className='badge';badge.style.background=colors[verdict]||'#6b7280';badge.textContent=verdict;
  }
  try{
    const res=await fetch('/api/mark',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phase:PHASE,id,verdict})});
    if(!res.ok)throw new Error(await res.text());
    const j=await res.json();
    toast('Saved · '+id+' → '+verdict);
    if(j.gateCleared!==undefined){
      const g=document.querySelector('.gate');
      g.className='gate '+(j.gateCleared?'cleared':'locked');
      g.textContent=j.gateCleared?'✓ Gate Cleared':'✕ Gate Locked';
    }
  }catch(e){
    row.dataset.result=prev;
    toast('Save failed — open via "phase-gate serve '+PHASE+'" to enable saving',true);
  }
}
let facaData=null;
let activeMTab='faca';
async function openFaca(id){
  document.getElementById('facaModal').classList.add('show');
  document.getElementById('facaTitle').textContent='FACA — '+PHASE+(id?(' · Test '+id):' · All Failures');
  document.getElementById('facaPane').innerHTML='<div class="loading"><div class="spinner-big"></div><div>Generating FACA — this can take 20–40 seconds…</div></div>';
  document.getElementById('promptPane').innerHTML='';
  facaData=null;
  try{
    const r=await fetch('/api/faca',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phase:PHASE,id})});
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||'failed');
    facaData=j;
    document.getElementById('facaPane').innerHTML='<pre>'+escapeHtml(j.faca)+'</pre>';
    document.getElementById('promptPane').innerHTML='<pre>'+escapeHtml(j.prompt)+'</pre>';
  }catch(e){
    document.getElementById('facaPane').innerHTML='<div class="loading" style="color:#fca5a5">⚠ '+escapeHtml(e.message)+'</div>';
  }
}
function closeFaca(){document.getElementById('facaModal').classList.remove('show')}
function switchMTab(t){
  activeMTab=t;
  document.querySelectorAll('.mtab').forEach(m=>m.classList.toggle('active',m.dataset.mtab===t));
  document.getElementById('facaPane').style.display=t==='faca'?'':'none';
  document.getElementById('promptPane').style.display=t==='prompt'?'':'none';
}
async function copyActive(){
  if(!facaData)return;
  const text=activeMTab==='faca'?facaData.faca:facaData.prompt;
  try{
    await navigator.clipboard.writeText(text);
    const b=document.getElementById('copyBtn');
    const orig=b.textContent;b.textContent='✓ Copied!';b.classList.add('ok');
    setTimeout(()=>{b.textContent=orig;b.classList.remove('ok')},1800);
  }catch{toast('Copy failed',true)}
}
async function newVersion(){
  if(!confirm('Archive v'+${JSON.stringify(plan.version ?? 1)}+' and create a new version with all tests reset to NOT TESTED?\\n\\nYou\\'ll need to re-run the plan after fixes are applied.'))return;
  try{
    const r=await fetch('/api/new-version',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phase:PHASE})});
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||'failed');
    toast('Advanced to v'+j.version+' — reloading…');
    setTimeout(()=>location.reload(),900);
  }catch(e){toast('Failed: '+e.message,true)}
}
function escapeHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeFaca()});
</script>
</body></html>`, "utf8");
}

function renderHistoryStrip(plan: PhaseTestPlan): string {
  const h = plan.history ?? [];
  if (h.length === 0) return "";
  const latest = h[h.length - 1];
  const prev = h.length >= 2 ? h[h.length - 2] : null;
  const delta = prev ? latest.pass - prev.pass : 0;
  const deltaStr = prev
    ? (delta > 0 ? `<span class="delta up">▲ +${delta} pass vs v${prev.version}</span>`
      : delta < 0 ? `<span class="delta down">▼ ${delta} pass vs v${prev.version}</span>`
      : `<span class="delta flat">◇ no change vs v${prev.version}</span>`)
    : "";
  const pills = h.slice(-10).map((e) => {
    const pctPass = e.total > 0 ? Math.round((e.pass / e.total) * 100) : 0;
    const cls = e.gateCleared ? "hp pass" : e.fail > 0 ? "hp fail" : "hp warn";
    return `<div class="${cls}" title="v${e.version} · ${e.runAt}\n${e.pass}/${e.total} pass (${pctPass}%)\nGate: ${e.gateCleared ? "cleared" : "locked"}">
      <div class="hpv">v${e.version}</div>
      <div class="hpb"><div class="hpbf" style="width:${pctPass}%"></div></div>
      <div class="hpn">${e.pass}/${e.total}</div>
    </div>`;
  }).join("");
  return `<div class="history-strip"><div class="hs-label">Run History</div><div class="hs-pills">${pills}</div>${deltaStr}</div>`;
}

function esc(s: string): string {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function summary(plan: PhaseTestPlan) {
  const out = { total: 0, pass: 0, fail: 0, notTested: 0, blocked: 0, awaitingHuman: 0 };
  for (const t of plan.tests) {
    out.total++;
    if (t.result === "PASS") out.pass++;
    else if (t.result === "FAIL") out.fail++;
    else if (t.result === "NOT TESTED") out.notTested++;
    else if (t.result === "BLOCKED") out.blocked++;
    else if (t.result === "AWAITING HUMAN") out.awaitingHuman++;
  }
  return out;
}
