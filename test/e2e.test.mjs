#!/usr/bin/env node
// E2E test: drives the built MCP server (dist/index.js) over stdio against a
// throwaway KB git repo. Run: npm run build && node test/e2e.test.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "kbmcp-e2e-"));
const KB = path.join(TMP, "knowledge");
const EVIL = path.join(TMP, "knowledge-evil"); // sibling-prefix escape target
const CODE = path.join(TMP, "code-repo");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
}
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@test");
  git(dir, "config", "user.name", "test");
}

// ── fixtures ──
initRepo(KB);
fs.mkdirSync(path.join(KB, "systems"), { recursive: true });
fs.writeFileSync(path.join(KB, "README.md"), "# test kb\n");
git(KB, "add", "README.md");
git(KB, "commit", "-q", "-m", "init");
fs.mkdirSync(EVIL, { recursive: true });
fs.writeFileSync(path.join(EVIL, "secret.md"), "should never be readable\n");

initRepo(CODE);
fs.writeFileSync(path.join(CODE, "app.ts"), "v1\n");
git(CODE, "add", "app.ts");
git(CODE, "commit", "-q", "-m", "code v1");
const codeHead1 = git(CODE, "rev-parse", "HEAD");

const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(import.meta.dirname, "..", "dist", "index.js")],
  env: { ...process.env, KNOWLEDGE_DIR: KB },
});
const client = new Client({ name: "e2e", version: "0.0.0" });
await client.connect(transport);

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  return res.content[0].text;
}

// ── T1: kbPath escape (sibling prefix + parent traversal) ──
console.log("T1 kbPath escape");
const t1a = await call("kb_read", { path: "../knowledge-evil/secret.md" });
check("sibling-prefix dir blocked", t1a.startsWith("Error:") && !t1a.includes("never be readable"), t1a.slice(0, 80));
const t1b = await call("kb_read", { path: "../../etc/hosts" });
check("parent traversal blocked", t1b.startsWith("Error:"), t1b.slice(0, 80));

// ── T2: commit granularity — concurrent dirty file must NOT be swallowed ──
console.log("T2 commit granularity");
fs.writeFileSync(path.join(KB, "systems", "concurrent-wip.md"), "another session's uncommitted work\n");
const t2 = await call("kb_write", { path: "systems/doc-a.md", content: "# Doc A\n\nhello", mode: "replace" });
check("kb_write committed", t2.includes("Git: committed"), t2);
const lastFiles = git(KB, "log", "-1", "--name-only", "--format=");
check("commit contains only written file + index", lastFiles.split("\n").filter(Boolean).sort().join(",") === "_index.md,systems/doc-a.md", lastFiles);
const dirty = git(KB, "status", "--porcelain");
check("concurrent dirty file still uncommitted", dirty.includes("concurrent-wip.md"), dirty);

// ── T3: link doc, then replace WITHOUT frontmatter → fm inherited, baseline NOT moved ──
console.log("T3 replace inherits frontmatter, baseline frozen");
await call("kb_link_track", { path: "systems/doc-a.md", codeRepo: CODE, codeTracks: ["app.ts"] });
fs.writeFileSync(path.join(CODE, "app.ts"), "v2\n");
git(CODE, "add", "app.ts");
git(CODE, "commit", "-q", "-m", "code v2");
const codeHead2 = git(CODE, "rev-parse", "HEAD");
const t3 = await call("kb_write", { path: "systems/doc-a.md", content: "# Doc A rewritten\n\nno frontmatter in this content", mode: "replace" });
const docA = fs.readFileSync(path.join(KB, "systems", "doc-a.md"), "utf-8");
check("frontmatter survived full rewrite", docA.includes(`code-repo: ${CODE}`), docA.slice(0, 200));
check("baseline NOT refreshed by unverified replace", docA.includes(`last-verified-commit: ${codeHead1}`), docA.slice(0, 200));
check("response notes baseline unchanged", t3.includes("Drift baseline unchanged"), t3);

// ── T4: append never refreshes baseline; kb_drift reports the drift ──
console.log("T4 append ≠ verify");
const t4 = await call("kb_write", { path: "systems/doc-a.md", content: "appended log line", mode: "append" });
check("append notes baseline unchanged", t4.includes("Drift baseline unchanged"), t4);
const docA2 = fs.readFileSync(path.join(KB, "systems", "doc-a.md"), "utf-8");
check("baseline still v1 after append", docA2.includes(`last-verified-commit: ${codeHead1}`));
const t4d = await call("kb_drift", { path: "systems/doc-a.md" });
check("kb_drift sees 1 commit of drift", /1 commits? touched/.test(t4d), t4d);

// ── T5: replace with verified:true refreshes baseline ──
console.log("T5 verified replace re-stamps");
await call("kb_write", { path: "systems/doc-a.md", content: "# Doc A verified rewrite\n", mode: "replace", verified: true });
const docA3 = fs.readFileSync(path.join(KB, "systems", "doc-a.md"), "utf-8");
check("baseline moved to v2 HEAD", docA3.includes(`last-verified-commit: ${codeHead2}`), docA3.slice(0, 200));

// ── T6: unreachable baseline → ⚠️ not 🟢 ──
console.log("T6 no false green");
const bogus = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
fs.writeFileSync(
  path.join(KB, "systems", "doc-b.md"),
  `---\nlast-verified-commit: ${bogus}\nlast-verified-at: 2026-01-01T00:00:00.000Z\ncode-repo: ${CODE}\ncode-tracks: ["app.ts"]\n---\n# Doc B\n`,
);
const t6 = await call("kb_drift", { path: "systems/doc-b.md" });
check("kb_drift shows ⚠️ on unreachable baseline", t6.includes("⚠️") && t6.includes("git log failed"), t6);
check("kb_drift does not claim green", !t6.includes("🟢"), t6);
const t6all = await call("kb_drift_all", {});
check("kb_drift_all flags doc-b", t6all.includes("doc-b.md") && t6all.match(/doc-b\.md.*git log failed/), t6all);

// ── T7: kb_read pagination/outline ──
console.log("T7 kb_read slicing");
const bigBody = ["# Big Doc", "", "## Alpha Section", ...Array(1200).fill("alpha content line padded out to be much longer"), "## Beta Section", ...Array(1200).fill("beta content line padded out to be much longer"), "### Beta Sub", ...Array(200).fill("beta sub line")].join("\n");
fs.writeFileSync(path.join(KB, "systems", "big.md"), bigBody);
const t7a = await call("kb_read", { path: "systems/big.md" });
check("large file returns outline by default", t7a.includes("outline only") && t7a.includes("## Alpha Section") && !t7a.includes("alpha content line"), t7a.slice(0, 200));
const t7b = await call("kb_read", { path: "systems/big.md", section: "beta section" });
check("section read returns only that section", t7b.includes("beta content line") && !t7b.includes("alpha content line"), t7b.slice(0, 150));
check("section read includes subsection", t7b.includes("### Beta Sub"));
const t7c = await call("kb_read", { path: "systems/big.md", offset: 3, limit: 2 });
check("offset/limit slice", t7c.includes("showing lines 3-4") && t7c.includes("## Alpha Section"), t7c.slice(0, 150));
const t7d = await call("kb_read", { path: "systems/big.md", full: true });
check("full:true bypasses outline", t7d.includes("alpha content line") && t7d.includes("beta sub line"));
const t7e = await call("kb_read", { path: "systems/big.md", section: "no such heading" });
check("missing section lists headings", t7e.includes("not found") && t7e.includes("## Alpha Section"));

// ── T8: rotation warning ──
console.log("T8 rotation warning");
const t8 = await call("kb_write", { path: "systems/huge-log.md", content: Array(4500).fill("log entry").join("\n"), mode: "replace" });
check("oversize write warns rotation", t8.includes("⚠️") && t8.includes("rotation due"), t8.slice(-200));
const t8b = await call("kb_write", { path: "systems/small.md", content: "# Small\n", mode: "replace" });
check("small write has no warning", !t8b.includes("rotation due"));

// ── T9: index title extraction (frontmatter + banner + heading) ──
console.log("T9 index titles");
fs.writeFileSync(
  path.join(KB, "systems", "old-sys.md"),
  `---\ncode-repo: ${CODE}\n---\n> ⚠️ SUPERSEDED — see elsewhere\n\n# Old System Handbook\n\nbody\n`,
);
await call("kb_index", {});
const idx = fs.readFileSync(path.join(KB, "_index.md"), "utf-8");
check("title is real heading, not banner/---", idx.includes("- Old System Handbook [SUPERSEDED] — systems/old-sys.md"), idx);
check("no --- titles in index", !/^- --- /m.test(idx));

// ── T10: kb_index always rebuilds ──
console.log("T10 kb_index real rebuild");
fs.writeFileSync(path.join(KB, "_index.md"), "CORRUPTED INDEX\n");
const t10 = await call("kb_index", {});
check("kb_index regenerated corrupted index", t10.includes("Knowledge Base Index") && !t10.includes("CORRUPTED"), t10.slice(0, 100));

// ── T11: kb_search fixed-string + truncation note ──
console.log("T11 kb_search");
fs.writeFileSync(path.join(KB, "systems", "code-doc.md"), "# Code\n\ncall foo.bar(baz) here\n" + Array(60).fill("needle60 line").join("\n"));
const t11a = await call("kb_search", { query: "foo.bar(" });
check("fixed-string matches special chars", t11a.includes("foo.bar(baz)"), t11a.slice(0, 120));
const t11b = await call("kb_search", { query: "needle60" });
check("truncation note shows real total", t11b.includes("[showing 50 of 60 matching lines"), t11b.slice(-120));
const t11c = await call("kb_search", { query: "zzz-no-such-term-zzz" });
check("no matches handled", t11c === "No matches found.");
const t11d = await call("kb_search", { query: "needle60 l.ne", regex: true });
check("regex mode works when asked", t11d.includes("needle60 line"));

// ── T12: shell metacharacters in commit messages are inert ──
console.log("T12 injection inert");
const marker = path.join(TMP, "pwned");
await call("kb_log_decision", { title: `evil $(touch ${marker}) \`touch ${marker}\``, description: "injection probe" });
check("command substitution not executed", !fs.existsSync(marker));
const lastMsg = git(KB, "log", "-1", "--format=%s");
check("title stored literally in commit msg", lastMsg.includes("$(touch"), lastMsg);

// ── T13: decisions commit only touches decisions + index ──
console.log("T13 decision commit granularity");
const t13files = git(KB, "log", "-1", "--name-only", "--format=");
check("decision commit = decisions.md + _index.md", t13files.split("\n").filter(Boolean).sort().join(",") === "_index.md,decisions/decisions.md", t13files);

await client.close();
console.log(`\n${pass} passed, ${fail} failed${fail ? ": " + failures.join(", ") : ""}`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
