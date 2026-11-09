#!/usr/bin/env node
// Shows exactly what failed in a CI job, at the step that failed.
//
//   node .github/scripts/ci-report.cjs run --kind <tsc|eslint|jest|gitleaks|lines> --name "<step>" \
//     [--json <file>] [--path-prefix <dir>] -- <command> [args...]
//
// `run` streams the command's output to the job log and to
// $CI_ARTIFACTS/logs/<step>.log. If the command fails it parses that output,
// writes `::error file=…,line=…,col=…::` annotations (run summary and the pull
// request's Files changed view), a table of the failures to
// $GITHUB_STEP_SUMMARY, and a JSON report the "CI summary" job reads. Then it
// exits with the command's code.
//
//   node .github/scripts/ci-report.cjs summary --dir <downloaded artifacts>
//
// `summary` runs in the final job. NEEDS_JSON (`toJSON(needs)`) is final when
// that job starts, so a failed job is named even when it left no report
// (setup failure, timeout).
//
// No network, no tokens, Node built-ins only.
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const WORKSPACE = process.env.GITHUB_WORKSPACE || process.cwd();
const ARTIFACTS = process.env.CI_ARTIFACTS || path.join(process.env.RUNNER_TEMP || os.tmpdir(), "ci-artifacts");
const JOB_KEY = process.env.CI_JOB_KEY || process.env.GITHUB_JOB || "job";
const JOB_NAME = process.env.CI_JOB_NAME || JOB_KEY;
// GitHub shows at most 10 error annotations per step and 50 per job.
const MAX_ANNOTATIONS = 50;
const MAX_TABLE_ROWS = 30;
const TAIL_LINES = 40;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

const stripAnsi = (s) => String(s).replace(ANSI, "");
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "step";

const realOrSelf = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
// Tools print either the checkout path or its real path (/tmp vs /private/tmp on macOS).
const ROOTS = [...new Set([WORKSPACE, realOrSelf(WORKSPACE)])];

/** Repo-relative path, or null when the file is outside the checkout. */
function repoPath(file, base) {
  if (!file) return null;
  const abs = path.resolve(base || process.cwd(), file);
  for (const root of ROOTS) {
    const rel = path.relative(root, abs);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
  }
  return null;
}

// ------------------------------------------------------------------ parsers
// Each parser returns [{ file, line, col, message, title }] (file/line optional).

function parseTsc(text, base) {
  const out = [];
  let last = null;
  for (const raw of stripAnsi(text).split(/\r?\n/)) {
    let m = raw.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
    if (m) {
      last = { file: repoPath(m[1], base) || m[1], line: Number(m[2]), col: Number(m[3]), message: `${m[4]}: ${m[5]}`, title: `Typecheck ${m[4]}` };
      out.push(last);
      continue;
    }
    m = raw.match(/^error (TS\d+): (.*)$/);
    if (m) {
      last = { message: `${m[1]}: ${m[2]}`, title: `Typecheck ${m[1]}` };
      out.push(last);
      continue;
    }
    // tsc indents the rest of a multi-line message ("Type 'x' is not assignable…").
    if (last && /^\s{2,}\S/.test(raw)) last.message += `\n${raw.trim()}`;
    else last = null;
  }
  return out;
}

// ESLint's default "stylish" output: an absolute file path, then
// "  line:col  error  message  rule-id" rows.
function parseEslint(text) {
  const out = [];
  let file = null;
  for (const raw of stripAnsi(text).split(/\r?\n/)) {
    if (/^\//.test(raw) || /^[A-Za-z]:\\/.test(raw)) {
      file = repoPath(raw.trim());
      continue;
    }
    const m = raw.match(/^\s+(\d+):(\d+)\s+error\s+(.+?)(?:\s{2,}(\S+))?\s*$/);
    if (m && file) {
      out.push({ file, line: Number(m[1]), col: Number(m[2]), message: m[4] ? `${m[3]} (${m[4]})` : m[3], title: m[4] ? `ESLint ${m[4]}` : "ESLint" });
    } else if (!raw.trim()) {
      file = null;
    }
  }
  return out;
}

function firstMessageLines(message, max = 6) {
  const lines = [];
  for (const raw of stripAnsi(message).split(/\r?\n/)) {
    if (/^\s+at /.test(raw)) break;
    const t = raw.trim();
    if (t && t !== "● Test suite failed to run") lines.push(t);
    if (lines.length >= max) break;
  }
  return lines.join("\n");
}

function locateInStack(message, file) {
  const plain = stripAnsi(message);
  const esc = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = plain.match(new RegExp(`${esc}:(\\d+):(\\d+)`));
  return m ? { line: Number(m[1]), col: Number(m[2]) } : null;
}

// `jest --json --outputFile <file>`; `--testLocationInResults` adds the test's own line.
function parseJest(json) {
  const out = [];
  for (const suite of json.testResults || []) {
    if (suite.status !== "failed") continue;
    const file = repoPath(suite.name) || suite.name;
    const failed = (suite.assertionResults || []).filter((a) => a.status === "failed");
    if (!failed.length) {
      const msg = suite.message || suite.failureMessage || "Test suite failed to run";
      const loc = locateInStack(msg, suite.name) || { line: 1, col: 1 };
      out.push({ file, ...loc, message: firstMessageLines(msg, 8) || "Test suite failed to run", title: "Jest: suite failed to run" });
      continue;
    }
    for (const a of failed) {
      const msg = (a.failureMessages || []).join("\n") || "failed";
      const loc = locateInStack(msg, suite.name) || (a.location ? { line: a.location.line, col: a.location.column } : { line: 1, col: 1 });
      out.push({ file, ...loc, message: `${a.fullName}\n${firstMessageLines(msg)}`, title: `Jest: ${a.fullName}` });
    }
  }
  return out;
}

// gitleaks --report-format json. --redact keeps the secret out of the report;
// only the rule, file, line and commit are shown here.
function parseGitleaks(json) {
  return (Array.isArray(json) ? json : []).map((f) => ({
    file: f.File,
    line: f.StartLine,
    col: f.StartColumn,
    message: `${f.RuleID}: ${f.Description || "possible secret"} (commit ${String(f.Commit || "").slice(0, 10)})`,
    title: `Secret scan: ${f.RuleID}`,
  }));
}

const ERROR_LINE = /(\berror\b|\bERR!|\bfailed\b|\bfailure\b|problem\(s\)|refused|not allowed|\bdenied\b|✕|●)/i;
const NOT_AN_ERROR = /\b0 (errors?|problems?|failed)\b|--no-audit|^\s*npm (warn|notice)/i;
const FILE_LINE = /((?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z]{1,5}):(\d+)(?::(\d+))?/;

/** Lines that say what broke, for tools with no machine-readable output. */
function parseLines(text, base) {
  const out = [];
  const seen = new Set();
  const lines = stripAnsi(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].replace(/^#\d+ [\d.]+ /, "").trim(); // docker --progress=plain prefix
    if (!t || !ERROR_LINE.test(t) || NOT_AN_ERROR.test(t) || seen.has(t)) continue;
    // "[x] 2 problem(s):" heads an indented list; take the list with it.
    seen.add(t);
    const item = { message: t };
    const fl = t.match(FILE_LINE);
    if (fl) {
      const rel = repoPath(fl[1], base);
      if (rel && fs.existsSync(path.join(WORKSPACE, rel))) Object.assign(item, { file: rel, line: Number(fl[2]), col: fl[3] ? Number(fl[3]) : undefined });
    }
    out.push(item);
    for (let j = i + 1; /problem\(s\):\s*$/.test(t) && j < lines.length && /^\s{2,}\S/.test(lines[j]); j++) {
      const sub = lines[j].trim();
      if (!seen.has(sub)) {
        seen.add(sub);
        out.push({ message: sub });
      }
    }
    if (out.length >= MAX_TABLE_ROWS) break;
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`[ci-report] could not read ${file}: ${err && err.message}`);
    return null;
  }
}

function extract(kind, logText, opts) {
  const base = opts.pathPrefix ? path.join(WORKSPACE, opts.pathPrefix) : process.cwd();
  let errors = [];
  if (kind === "tsc") errors = parseTsc(logText, base);
  else if (kind === "eslint") errors = parseEslint(logText);
  else if (kind === "jest") {
    const json = opts.json && fs.existsSync(opts.json) ? readJson(opts.json) : null;
    if (json) errors = parseJest(json);
  } else if (kind === "gitleaks") {
    const json = opts.json && fs.existsSync(opts.json) ? readJson(opts.json) : null;
    if (json) errors = parseGitleaks(json);
  }
  // A crash before the tool printed its own format (missing module, out of
  // memory) still shows its lines. `npm run lint` also runs the license
  // boundary check after ESLint, so its lines are kept next to ESLint's rows.
  if (kind === "eslint") return errors.concat(parseLines(logText, base).filter((e) => !/^\d+:\d+\s+error\s/.test(e.message)));
  if (!errors.length) return parseLines(logText, base);
  return errors;
}

// ------------------------------------------------------------------ output

const escData = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escProp = (s) => escData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

function annotation(e, stepName) {
  const props = [];
  if (e.file) props.push(`file=${escProp(e.file)}`);
  if (e.file && e.line) props.push(`line=${e.line}`);
  if (e.file && e.line && e.col) props.push(`col=${e.col}`);
  props.push(`title=${escProp(e.title || stepName)}`);
  return `::error ${props.join(",")}::${escData(e.message)}`;
}

const cell = (s, max = 400) => {
  const one = String(s).replace(/\r?\n/g, " · ").replace(/\|/g, "\\|").replace(/</g, "&lt;");
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};
const where = (e) => (e.file ? `\`${e.file}${e.line ? `:${e.line}` : ""}${e.line && e.col ? `:${e.col}` : ""}\`` : "—");

function errorTable(errors, max = MAX_TABLE_ROWS) {
  if (!errors.length) return "";
  const rows = errors.slice(0, max).map((e) => `| ${where(e)} | ${cell(e.message)} |`);
  const more = errors.length > max ? `\n\n…and ${errors.length - max} more in the full log.` : "";
  return `| Where | What failed |\n| --- | --- |\n${rows.join("\n")}${more}\n`;
}

function fence(text) {
  return `\`\`\`text\n${String(text).replace(/```/g, "'''")}\n\`\`\``;
}

function appendSummary(md) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) fs.appendFileSync(file, `${md}\n`);
  else process.stdout.write(`\n----- step summary -----\n${md}\n`);
}

function stepMarkdown(r) {
  const n = r.errors.length;
  const how = typeof r.exit === "number" ? `exited with ${r.exit}` : `was stopped by ${r.exit} (job timeout or cancellation)`;
  const head = `### Failed: ${r.job} → ${r.step}\n\n\`${r.command}\` ${how}${n ? `, ${n} problem${n === 1 ? "" : "s"}` : ""}.\n`;
  const table = n ? `\n${errorTable(r.errors)}` : "\nNo error lines recognised; the end of the log is below.\n";
  const tail = `\n<details${n ? "" : " open"}><summary>Last ${r.tail.length} lines of the log</summary>\n\n${fence(r.tail.join("\n"))}\n\n</details>\n`;
  const art = `\nFull log: artifact **ci-logs-${JOB_KEY}** in this run's Artifacts section, available as soon as this job finishes.\n`;
  return head + table + tail + art;
}

// ------------------------------------------------------------------ run

function parseArgs(argv) {
  const opts = { cmd: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      opts.cmd = argv.slice(i + 1);
      break;
    }
    if (a.startsWith("--")) opts[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    else (opts._ = opts._ || []).push(a);
  }
  return opts;
}

function report(opts, exit, logText, logFile) {
  const errors = extract(opts.kind, logText, opts);
  // npm's update notices are noise at the end of every npm-run log.
  const lines = stripAnsi(logText).split(/\r?\n/).filter((l) => !/^npm notice\b/.test(l));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const r = {
    job: JOB_NAME,
    jobKey: JOB_KEY,
    step: opts.name,
    kind: opts.kind,
    command: opts.cmd.join(" ").slice(0, 200),
    exit,
    failedAt: new Date().toISOString(),
    log: path.basename(logFile),
    errors: errors.slice(0, 200),
    tail: lines.slice(-TAIL_LINES),
  };
  for (const e of errors.slice(0, MAX_ANNOTATIONS)) console.log(annotation(e, opts.name));
  if (!errors.length) console.log(annotation({ message: `${opts.name} ${typeof exit === "number" ? `failed (exit ${exit})` : `was stopped by ${exit}`}. Last line: ${r.tail[r.tail.length - 1] || "(no output)"}`, title: opts.name }, opts.name));
  appendSummary(stepMarkdown(r));
  const reportFile = path.join(ARTIFACTS, `report-${JOB_KEY}.json`);
  const prior = fs.existsSync(reportFile) ? readJson(reportFile) || [] : [];
  fs.writeFileSync(reportFile, JSON.stringify(prior.concat([r]), null, 2));
}

function run(opts) {
  if (!opts.kind || !opts.name || !opts.cmd.length) {
    console.error("usage: ci-report.cjs run --kind <tsc|eslint|jest|gitleaks|lines> --name <step> [--json file] [--path-prefix dir] -- <command…>");
    process.exit(2);
  }
  fs.mkdirSync(path.join(ARTIFACTS, "logs"), { recursive: true });
  const logFile = path.join(ARTIFACTS, "logs", `${slug(opts.name)}.log`);
  const log = fs.createWriteStream(logFile);
  let logText = "";
  // setup-node's tsc / eslint problem matchers would annotate the same lines
  // again (with paths relative to the wrong directory for the model server).
  for (const owner of ["tsc", "eslint-stylish", "eslint-compact"]) console.log(`::remove-matcher owner=${owner}::`);
  const child = spawn(opts.cmd[0], opts.cmd.slice(1), { stdio: ["inherit", "pipe", "pipe"], env: process.env });
  const tee = (stream) => (chunk) => {
    stream.write(chunk);
    log.write(chunk);
    logText += chunk.toString("utf8");
  };
  child.stdout.on("data", tee(process.stdout));
  child.stderr.on("data", tee(process.stderr));
  let stopped = null;
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      stopped = sig;
      child.kill(sig);
    });
  }
  child.on("error", (err) => {
    logText += `\n[ci-report] could not start ${opts.cmd[0]}: ${err.message}\n`;
  });
  child.on("close", (code, signal) => {
    log.end();
    const exit = code === null ? 1 : code;
    if (exit !== 0 || stopped || signal) {
      if (stopped) logText += `\n[ci-report] stopped by ${stopped} (job timeout or cancellation)\n`;
      try {
        report(opts, signal || stopped ? `${signal || stopped}` : exit, logText, logFile);
      } catch (err) {
        console.error("[ci-report] could not write the failure report", err);
      }
      process.exit(exit || 1);
    }
    process.exit(0);
  });
}

// ------------------------------------------------------------------ summary

function findReports(dir) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...findReports(p));
    else if (/^report-.*\.json$/.test(ent.name)) out.push(...(readJson(p) || []));
  }
  return out;
}

function summary(opts) {
  let needs = {};
  try {
    needs = JSON.parse(process.env.NEEDS_JSON || "{}");
  } catch (err) {
    console.error("[ci-report] NEEDS_JSON is not JSON", err);
  }
  const reports = findReports(opts.dir).sort((a, b) => String(a.failedAt).localeCompare(String(b.failedAt)));
  const results = Object.entries(needs).map(([id, n]) => ({ id, result: n && n.result }));
  const bad = results.filter((r) => r.result !== "success" && r.result !== "skipped");
  const runUrl = `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${process.env.GITHUB_REPOSITORY || ""}/actions/runs/${process.env.GITHUB_RUN_ID || ""}`;
  const md = [];

  if (!bad.length) {
    md.push(`## CI summary: all ${results.length} jobs passed\n`);
  } else {
    md.push(`## CI summary: ${bad.length} of ${results.length} jobs did not pass\n`);
    const first = reports[0];
    if (first) {
      md.push(`**First failure:** ${first.job} → step **${first.step}** (${first.errors.length || "no recognised"} problem${first.errors.length === 1 ? "" : "s"}, at ${first.failedAt.slice(11, 19)} UTC).\n`);
      md.push(first.errors.length ? errorTable(first.errors, 10) : fence(first.tail.slice(-15).join("\n")));
      md.push("");
    }
    for (const r of reports.slice(1)) {
      md.push(`#### Also failed: ${r.job} → ${r.step}\n`);
      md.push(r.errors.length ? errorTable(r.errors, 5) : fence(r.tail.slice(-10).join("\n")));
      md.push("");
    }
    const reported = new Set(reports.map((r) => r.jobKey.replace(/-\d+$/, "")));
    for (const b of bad) {
      if (reported.has(b.id)) continue;
      const why = b.result === "cancelled" ? "was cancelled (a newer push superseded this run, or it hit its time limit)" : "failed before any check step reported (checkout, Node setup or install)";
      md.push(`- **${b.id}** ${why}. Open it from the [run page](${runUrl}).`);
    }
  }
  md.push("\n| Job | Result |\n| --- | --- |");
  for (const r of results) md.push(`| ${r.id} | ${r.result === "success" ? "passed" : r.result || "unknown"} |`);
  md.push(`\nFull logs of failed jobs: the **ci-logs-*** artifacts on the [run page](${runUrl}).`);

  const text = md.join("\n");
  appendSummary(text);
  for (const r of reports) {
    const top = r.errors[0];
    console.log(`::error title=${escProp(`${r.job}: ${r.step}`)}::${escData(top ? `${top.file ? `${top.file}:${top.line || ""} ` : ""}${top.message}` : r.tail.slice(-3).join("\n"))}`);
  }
  if (bad.length) {
    console.log(`[ci-report] ${bad.map((b) => `${b.id}=${b.result}`).join(", ")}`);
    process.exit(1);
  }
}

if (require.main === module) {
  const [mode, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  if (mode === "run") run(opts);
  else if (mode === "summary") summary(opts);
  else {
    console.error("usage: ci-report.cjs run|summary …");
    process.exit(2);
  }
}

module.exports = { parseTsc, parseEslint, parseJest, parseGitleaks, parseLines };
