# phase-gate

AI-powered phase-gated test plan generator and executor.

## Usage

`/phase-gate <command> [args]`

## Commands

### generate
Generate a test plan for a phase from a roadmap `.md` file:
```
pnpm dev generate <phase> -r <roadmap.md> [-p <project-path>] [--overwrite]
```
- `<phase>` — phase name (e.g. `M1`, `Phase-2`, `auth`)
- `-r` — path to your roadmap `.md` file (required)
- `-p` — path to the project being tested (default: cwd)
- `--overwrite` — regenerate even if a plan already exists

### run
Execute all auto-runnable tests and update results:
```
pnpm dev run <phase> [--failed-only] [--fix] [--gate]
```
- `--failed-only` — only re-run FAIL or NOT_TESTED tests
- `--fix` — auto-fix failures after running, then re-run
- `--gate` — exit code 1 if phase gate is not cleared

### fix
Auto-fix failing tests using Claude:
```
pnpm dev fix <phase>
```

### gate
Check if a phase gate is cleared (exit 0 = cleared, 1 = locked):
```
pnpm dev gate <phase>
```

### status
Print a summary of all phases:
```
pnpm dev status
```

### render
Re-render an existing test plan to xlsx/md/html:
```
pnpm dev render <phase> [-f xlsx,md,html]
```

## How this works

When you run `/phase-gate generate M1 -r docs/ROADMAP.md`:

1. Claude reads the roadmap `.md` and extracts the relevant phase section
2. Claude scans the project directory structure and key files
3. Claude generates a structured test plan with test cases that have:
   - `autoCommand` — shell commands that can be run and pass/fail automatically
   - `autoInspect` — patterns to search for in files (e.g. "does this function exist?")
   - `manual` — steps for the human to perform and report result
4. The plan is saved as JSON (source of truth) and rendered to xlsx/md/html
5. Running `/phase-gate run M1` executes all auto-runnable tests and updates the plan
6. The phase gate is "cleared" when all gating tests pass

## Environment

Requires `ANTHROPIC_API_KEY` in your `.env` or environment.

## Output

Test plans are saved to `docs/test-plans/` by default:
- `<phase>_Test_Plan.json` — source of truth
- `<phase>_Test_Plan.xlsx` — Excel spreadsheet
- `<phase>_Test_Plan.md` — Markdown summary
- `<phase>_Test_Plan.html` — Interactive HTML with filters

---

When a user invokes `/phase-gate`, interpret their request and run the appropriate `pnpm dev` command from the `/Users/sonanceguest/Documents/phase-gate` directory. If they provide a phase name and roadmap path, run `generate`. If they ask to run tests, use `run`. If they ask about status, use `status` or `gate`.
