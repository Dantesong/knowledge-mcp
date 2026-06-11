import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync, execFileSync } from "child_process";

const KB_DIR = process.env.KNOWLEDGE_DIR || path.join(os.homedir(), "knowledge");

function kbPath(relative: string): string {
  const resolved = path.resolve(KB_DIR, relative);
  // Require a path separator after KB_DIR — a bare prefix check would let
  // sibling dirs like ~/knowledge-evil pass.
  if (resolved !== KB_DIR && !resolved.startsWith(KB_DIR + path.sep)) {
    throw new Error(`Path escapes knowledge base: ${relative}`);
  }
  return resolved;
}

// Stage ONLY the files this tool wrote — never `git add -A`. Concurrent
// sessions routinely leave uncommitted work in the KB working tree; a blanket
// add would swallow it into an unrelated commit. execFileSync (argv array)
// keeps user-supplied text (decision titles, paths) out of shell parsing.
function gitCommit(message: string, files: string[]): string {
  try {
    execFileSync("git", ["add", "--", ...files], {
      cwd: KB_DIR,
      stdio: "pipe",
      timeout: 10000,
    });
    const staged = execFileSync(
      "git",
      ["diff", "--cached", "--name-only", "--", ...files],
      { cwd: KB_DIR, stdio: "pipe", timeout: 10000 },
    )
      .toString()
      .trim();
    if (!staged) return "no changes to commit";
    // Commit restricted to these paths, so anything another session staged
    // stays staged and untouched.
    execFileSync("git", ["commit", "-m", `kb: ${message}`, "--", ...files], {
      cwd: KB_DIR,
      stdio: "pipe",
      timeout: 10000,
    });
    return "committed";
  } catch (e: any) {
    const detail = (e.stderr?.toString() || e.message || "unknown git failure")
      .trim()
      .split("\n")[0];
    return `git error: ${detail}`;
  }
}

// ── Frontmatter (drift-tracking metadata) ──
//
// Each KB doc may carry a YAML-ish frontmatter block at the very top:
//
//   ---
//   last-verified-commit: a60044b
//   last-verified-at: 2026-04-25T13:45:00.000Z
//   code-repo: /Users/dante/develop/auto-hotelier
//   code-tracks: ["packages/db/prisma/schema.prisma","apps/core/src/services"]
//   ---
//
// `kb_write` injects/updates these fields automatically when the caller
// passes `codeRepo`. `kb_drift` uses them to diff code since last verify.
//
// We intentionally roll our own micro-parser instead of pulling a YAML
// dependency: the schema is fixed and small, and we want zero new deps.

interface Frontmatter {
  lastVerifiedCommit?: string;
  lastVerifiedAt?: string;
  codeRepo?: string;
  codeTracks?: string[];
  [extra: string]: unknown;
}

function parseFrontmatter(content: string): { fm: Frontmatter; body: string } {
  if (!content.startsWith("---\n")) return { fm: {}, body: content };
  const endIdx = content.indexOf("\n---\n", 4);
  if (endIdx < 0) return { fm: {}, body: content };
  const fmStr = content.slice(4, endIdx);
  const body = content.slice(endIdx + 5);
  const fm: Frontmatter = {};
  for (const line of fmStr.split("\n")) {
    const m = line.match(/^([a-z][a-z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim();
    if (key === "last-verified-commit") fm.lastVerifiedCommit = val;
    else if (key === "last-verified-at") fm.lastVerifiedAt = val;
    else if (key === "code-repo") fm.codeRepo = val;
    else if (key === "code-tracks") {
      // Accept JSON array or [a, b] without quotes
      try {
        fm.codeTracks = JSON.parse(val) as string[];
      } catch {
        fm.codeTracks = val
          .replace(/[\[\]]/g, "")
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
      }
    } else {
      fm[key] = val;
    }
  }
  return { fm, body };
}

function serializeFrontmatter(fm: Frontmatter): string {
  const lines: string[] = ["---"];
  if (fm.lastVerifiedCommit) lines.push(`last-verified-commit: ${fm.lastVerifiedCommit}`);
  if (fm.lastVerifiedAt) lines.push(`last-verified-at: ${fm.lastVerifiedAt}`);
  if (fm.codeRepo) lines.push(`code-repo: ${fm.codeRepo}`);
  if (fm.codeTracks && fm.codeTracks.length > 0) {
    lines.push(`code-tracks: ${JSON.stringify(fm.codeTracks)}`);
  }
  // Preserve any unknown keys (forward-compat)
  for (const k of Object.keys(fm)) {
    if (
      ["lastVerifiedCommit", "lastVerifiedAt", "codeRepo", "codeTracks"].includes(k)
    ) {
      continue;
    }
    const v = fm[k];
    if (typeof v === "string") lines.push(`${k}: ${v}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

function upsertFrontmatter(content: string, updates: Partial<Frontmatter>): string {
  const { fm, body } = parseFrontmatter(content);
  // Merge: explicit undefined in updates means "leave existing alone"
  const merged: Frontmatter = { ...fm };
  for (const k of Object.keys(updates)) {
    const v = (updates as Record<string, unknown>)[k];
    if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
  }
  return serializeFrontmatter(merged) + body;
}

function getRepoHead(repoPath: string): string | null {
  try {
    return execSync("git rev-parse HEAD", {
      cwd: repoPath,
      stdio: "pipe",
      timeout: 3000,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function getRepoTopLevel(somePath: string): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", {
      cwd: somePath,
      stdio: "pipe",
      timeout: 3000,
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function gitLogSince(
  repoPath: string,
  sinceCommit: string,
  trackPaths: string[],
  limit: number = 50,
): { commits: string; count: number; error?: string } {
  const args = ["log", "--oneline", "-n", String(limit + 1), `${sinceCommit}..HEAD`];
  if (trackPaths.length > 0) args.push("--", ...trackPaths);
  try {
    const out = execFileSync("git", args, {
      cwd: repoPath,
      stdio: "pipe",
      timeout: 8000,
    }).toString();
    const lines = out.split("\n").filter(Boolean);
    return { commits: lines.slice(0, limit).join("\n"), count: lines.length };
  } catch (e: any) {
    // A failed git log is NOT "zero drift" — most commonly the baseline commit
    // became unreachable after a rebase/amend. Surface the error so callers
    // show ⚠️ instead of a false 🟢.
    const detail = (e.stderr?.toString() || e.message || "git log failed")
      .trim()
      .split("\n")[0];
    return { commits: "", count: -1, error: detail };
  }
}

function rebuildIndex(): void {
  const indexPath = path.join(KB_DIR, "_index.md");
  const lines: string[] = [
    "# Knowledge Base Index",
    "",
    `Last updated: ${new Date().toLocaleString("en-AU", { timeZone: "Australia/Brisbane" })}`,
    "",
  ];

  for (const section of ["systems", "ops", "decisions", "inbox"]) {
    const dir = path.join(KB_DIR, section);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    if (files.length === 0) continue;

    lines.push(`## ${section.toUpperCase()}`, "");
    for (const file of files) {
      // Skip frontmatter, then prefer the first markdown heading — the first
      // non-empty line is often a SUPERSEDED banner or blockquote, not a title.
      const fileContent = fs.readFileSync(path.join(dir, file), "utf-8");
      const { body } = parseFrontmatter(fileContent);
      const bodyLines = body.split("\n");
      const heading = bodyLines.find((l) => /^#{1,6}\s+\S/.test(l));
      const firstNonEmpty = bodyLines.find((l) => l.trim().length > 0) || "";
      const title =
        (heading || firstNonEmpty).replace(/^#+\s*/, "").trim() || file;
      const supersededTag = bodyLines
        .slice(0, 10)
        .some((l) => /SUPERSEDED/i.test(l))
        ? " [SUPERSEDED]"
        : "";
      lines.push(`- ${title}${supersededTag} — ${section}/${file}`);
    }
    lines.push("");
  }

  fs.writeFileSync(indexPath, lines.join("\n"));
}

// Heading outline for large docs: h1-h3 with line ranges, so callers can pick
// a section instead of pulling the whole file into context.
function buildOutline(lines: string[]): string {
  const out: string[] = [];
  let prev: { text: string; line: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,3}\s+\S/.test(lines[i])) {
      if (prev) out.push(`  ${prev.text}  (lines ${prev.line}-${i})`);
      prev = { text: lines[i], line: i + 1 };
    }
  }
  if (prev) out.push(`  ${prev.text}  (lines ${prev.line}-${lines.length})`);
  return out.length > 0 ? out.join("\n") : "  (no headings found)";
}

const OUTLINE_THRESHOLD_BYTES = 40 * 1024;
const ROTATION_LINE_THRESHOLD = 4000;
const ROTATION_KB_THRESHOLD = 200;

function rotationWarning(filePath: string, content: string): string {
  const lineCount = content.split("\n").length;
  const sizeKb = Buffer.byteLength(content) / 1024;
  if (lineCount <= ROTATION_LINE_THRESHOLD && sizeKb <= ROTATION_KB_THRESHOLD) {
    return "";
  }
  return `\n⚠️ ${filePath} is ${lineCount} lines / ${sizeKb.toFixed(0)}KB (threshold ${ROTATION_LINE_THRESHOLD} lines / ${ROTATION_KB_THRESHOLD}KB) — rotation due: move the oldest entries to an archive file (see systems/archive/ for the pattern).`;
}

// ── Server ──

const server = new McpServer({
  name: "knowledge-mcp",
  version: "1.1.1",
});

// 1. kb_search
server.tool(
  "kb_search",
  "Search all KB .md files (case-insensitive). Fixed-string by default; regex=true for patterns.",
  {
    query: z.string().describe("Search term (case-insensitive, fixed-string by default)"),
    regex: z
      .boolean()
      .default(false)
      .describe("Treat query as an extended regular expression instead of a fixed string"),
  },
  async ({ query, regex }) => {
    try {
      let output = "";
      try {
        output = execFileSync(
          "grep",
          ["-rni", regex ? "-E" : "-F", "--include=*.md", "--", query, "."],
          { cwd: KB_DIR, stdio: "pipe", timeout: 5000 },
        ).toString();
      } catch (e: any) {
        // grep exit 1 = no matches; anything else is a real error
        if (e.status === 1) {
          return { content: [{ type: "text", text: "No matches found." }] };
        }
        throw e;
      }
      const all = output.split("\n").filter(Boolean);
      const shown = all.slice(0, 50).join("\n");
      const note =
        all.length > 50
          ? `\n[showing 50 of ${all.length} matching lines — narrow your query]`
          : "";
      return {
        content: [{ type: "text", text: (shown || "No matches found.") + note }],
      };
    } catch (e: any) {
      const detail = (e.stderr?.toString() || e.message || "").trim().split("\n")[0];
      return { content: [{ type: "text", text: `Search error: ${detail}` }] };
    }
  }
);

// 2. kb_read
server.tool(
  "kb_read",
  "Read a KB doc (path relative to ~/knowledge/). Files >40KB return a heading outline — slice with {section} or {offset,limit}, force whole file with {full:true}.",
  {
    path: z.string().describe("Relative path to .md file"),
    section: z
      .string()
      .optional()
      .describe(
        "Return only the section whose heading contains this text (case-insensitive), up to the next same-or-higher-level heading",
      ),
    offset: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("1-based line number to start reading from"),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Max lines to return (combine with offset)"),
    full: z
      .boolean()
      .default(false)
      .describe("Force whole-file read even when the file exceeds the outline threshold"),
  },
  async ({ path: filePath, section, offset, limit, full }) => {
    try {
      const content = fs.readFileSync(kbPath(filePath), "utf-8");
      const lines = content.split("\n");
      const meta = `[${filePath}: ${lines.length} lines / ${(Buffer.byteLength(content) / 1024).toFixed(0)}KB]`;

      if (section) {
        const needle = section.toLowerCase();
        const startIdx = lines.findIndex(
          (l) => /^#{1,6}\s/.test(l) && l.toLowerCase().includes(needle),
        );
        if (startIdx < 0) {
          return {
            content: [
              {
                type: "text",
                text: `${meta}\nSection "${section}" not found. Headings:\n${buildOutline(lines)}`,
              },
            ],
          };
        }
        const level = (lines[startIdx].match(/^#+/) as RegExpMatchArray)[0].length;
        let endIdx = lines.length;
        for (let i = startIdx + 1; i < lines.length; i++) {
          const m = lines[i].match(/^(#{1,6})\s/);
          if (m && m[1].length <= level) {
            endIdx = i;
            break;
          }
        }
        return {
          content: [
            {
              type: "text",
              text: `${meta} — section at lines ${startIdx + 1}-${endIdx}\n${lines.slice(startIdx, endIdx).join("\n")}`,
            },
          ],
        };
      }

      if (offset || limit) {
        const start = (offset ?? 1) - 1;
        const slice = lines.slice(start, limit ? start + limit : undefined);
        return {
          content: [
            {
              type: "text",
              text: `${meta} — showing lines ${start + 1}-${start + slice.length}\n${slice.join("\n")}`,
            },
          ],
        };
      }

      if (!full && Buffer.byteLength(content) > OUTLINE_THRESHOLD_BYTES) {
        return {
          content: [
            {
              type: "text",
              text: `${meta} — large file, outline only (re-call with {section} or {offset,limit} for a slice, {full:true} to force the whole file):\n${buildOutline(lines)}`,
            },
          ],
        };
      }

      return { content: [{ type: "text", text: content }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

// 3. kb_write
server.tool(
  "kb_write",
  "Write or append to a KB doc (auto git commit, stages only the written file). Writing ≠ verifying: the drift baseline moves only with codeRepo or verified:true on a replace.",
  {
    path: z.string().describe("Relative path (e.g. 'systems/my-doc.md')"),
    content: z.string().describe("Content to write"),
    mode: z.enum(["replace", "append"]).default("append").describe("Write mode"),
    verified: z
      .boolean()
      .default(false)
      .describe(
        "Declare the doc verified against its linked repo's current HEAD. Only honored with mode=replace — appending a log line is not verification.",
      ),
    codeRepo: z
      .string()
      .optional()
      .describe(
        "Absolute path to the source repo this doc tracks. Sets code-repo and stamps the drift baseline to current HEAD.",
      ),
    codeTracks: z
      .array(z.string())
      .optional()
      .describe("Paths within codeRepo this doc tracks (scopes kb_drift's git log)."),
  },
  async ({ path: filePath, content, mode, verified, codeRepo, codeTracks }) => {
    try {
      const fullPath = kbPath(filePath);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const fileExists = fs.existsSync(fullPath);

      // Build the candidate full content
      let finalContent: string;
      if (mode === "append" && fileExists) {
        finalContent = fs.readFileSync(fullPath, "utf-8") + "\n" + content;
      } else if (mode === "replace" && fileExists) {
        // Inherit the existing frontmatter when the new content doesn't carry
        // its own — otherwise a full rewrite silently drops drift-tracking
        // metadata and the doc vanishes from the kb_drift_all dashboard.
        const { fm: oldFm } = parseFrontmatter(fs.readFileSync(fullPath, "utf-8"));
        const { fm: newFm } = parseFrontmatter(content);
        if (Object.keys(oldFm).length > 0 && Object.keys(newFm).length === 0) {
          finalContent = serializeFrontmatter(oldFm) + content;
        } else {
          finalContent = content;
        }
      } else {
        finalContent = content;
      }

      const { fm: existingFm } = parseFrontmatter(finalContent);
      const updates: Partial<Frontmatter> = {};
      let baselineNote = "";

      if (codeRepo) {
        // Explicit (re-)link — caller declares this doc verified against HEAD
        const head = getRepoHead(codeRepo);
        if (head) {
          updates.lastVerifiedCommit = head;
          updates.lastVerifiedAt = new Date().toISOString();
          updates.codeRepo = codeRepo;
        }
      } else if (existingFm.codeRepo) {
        // Linked doc: writing is not verifying. A routine append must never
        // refresh the drift baseline — that was silently erasing real drift.
        if (mode === "replace" && verified) {
          const head = getRepoHead(existingFm.codeRepo);
          if (head) {
            updates.lastVerifiedCommit = head;
            updates.lastVerifiedAt = new Date().toISOString();
          }
        } else {
          baselineNote =
            " Drift baseline unchanged (pass verified:true on a replace to re-stamp).";
        }
      }

      if (codeTracks && codeTracks.length > 0) {
        updates.codeTracks = codeTracks;
      }

      if (Object.keys(updates).length > 0) {
        finalContent = upsertFrontmatter(finalContent, updates);
      }

      fs.writeFileSync(fullPath, finalContent);

      rebuildIndex();
      const commitResult = gitCommit(`update ${filePath}`, [filePath, "_index.md"]);
      const fmNote =
        Object.keys(updates).length > 0
          ? ` Frontmatter: ${Object.keys(updates).join(", ")}.`
          : "";
      return {
        content: [
          {
            type: "text",
            text: `Written to ${filePath} (${mode}).${fmNote}${baselineNote} Git: ${commitResult}${rotationWarning(filePath, finalContent)}`,
          },
        ],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  },
);

// 4. kb_log_decision
server.tool(
  "kb_log_decision",
  "Log a technical decision to the knowledge base. Appends to decisions/decisions.md with timestamp.",
  {
    title: z.string().describe("Decision title"),
    description: z.string().describe("Why this decision was made"),
  },
  async ({ title, description }) => {
    try {
      const decisionsPath = kbPath("decisions/decisions.md");
      const dir = path.dirname(decisionsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      if (!fs.existsSync(decisionsPath)) {
        fs.writeFileSync(decisionsPath, "# Technical Decisions Log\n");
      }

      const now = new Date().toLocaleString("en-AU", {
        timeZone: "Australia/Brisbane",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });

      const entry = `\n## [${now}] ${title}\n${description}\n\n---\n`;
      fs.appendFileSync(decisionsPath, entry);

      rebuildIndex();
      const commitResult = gitCommit(`decision: ${title}`, [
        "decisions/decisions.md",
        "_index.md",
      ]);
      const finalContent = fs.readFileSync(decisionsPath, "utf-8");
      return {
        content: [
          {
            type: "text",
            text: `Decision logged: ${title}. Git: ${commitResult}${rotationWarning("decisions/decisions.md", finalContent)}`,
          },
        ],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

// 5. kb_index
server.tool(
  "kb_index",
  "Rebuild _index.md from current files, commit, and return it.",
  {},
  async () => {
    try {
      rebuildIndex();
      const content = fs.readFileSync(path.join(KB_DIR, "_index.md"), "utf-8");
      const commitResult = gitCommit("rebuild index", ["_index.md"]);
      return {
        content: [{ type: "text", text: `${content}\n\n(Git: ${commitResult})` }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

// 6. kb_init
server.tool(
  "kb_init",
  "Bootstrap: scan projects for CLAUDE.md files and import them into the KB. Skips files that already exist.",
  {
    scan_dirs: z
      .string()
      .default("~,~/dev,~/develop,~/projects,~/src,~/work")
      .describe("Comma-separated directories to scan for projects with CLAUDE.md"),
  },
  async ({ scan_dirs }) => {
    const home = os.homedir();
    const dirs = scan_dirs.split(",").map((d) => d.trim().replace("~", home));
    const found: { project: string; claudeMdPath: string; summary: string }[] = [];

    // Scan for CLAUDE.md files
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const claudeMd = path.join(dir, entry.name, "CLAUDE.md");
          if (fs.existsSync(claudeMd)) {
            const content = fs.readFileSync(claudeMd, "utf-8");
            found.push({
              project: entry.name,
              claudeMdPath: claudeMd,
              summary: content,
            });
          }
        }
      } catch {
        // skip inaccessible dirs
      }
    }

    // Also check ~/.claude/CLAUDE.md (global)
    const globalClaude = path.join(home, ".claude", "CLAUDE.md");
    if (fs.existsSync(globalClaude)) {
      found.push({
        project: "_global",
        claudeMdPath: globalClaude,
        summary: fs.readFileSync(globalClaude, "utf-8"),
      });
    }

    if (found.length === 0) {
      return {
        content: [{ type: "text", text: "No CLAUDE.md files found in scanned directories." }],
      };
    }

    // Ensure KB dirs exist
    for (const d of ["systems", "ops", "decisions", "inbox"]) {
      const p = path.join(KB_DIR, d);
      if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    }

    // Import each project
    const results: string[] = [];
    const written: string[] = ["_index.md"];
    for (const { project, claudeMdPath, summary } of found) {
      if (project === "_global") {
        // Global rules → ops/global-rules.md
        const target = path.join(KB_DIR, "ops", "global-rules.md");
        if (!fs.existsSync(target)) {
          fs.writeFileSync(target, summary);
          written.push("ops/global-rules.md");
          results.push(`  ops/global-rules.md ← ${claudeMdPath} (new)`);
        } else {
          results.push(`  ops/global-rules.md ← already exists, skipped`);
        }
        continue;
      }

      // Project → systems/<project>.md
      const safeName = project.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const target = path.join(KB_DIR, "systems", `${safeName}.md`);

      if (fs.existsSync(target)) {
        results.push(`  systems/${safeName}.md ← already exists, skipped`);
        continue;
      }

      // Extract first 200 lines as summary (full CLAUDE.md can be huge)
      const lines = summary.split("\n").slice(0, 200);
      const trimmed = lines.join("\n");
      const header = `# ${project}\n\n> Imported from ${claudeMdPath}\n> Run kb_init again to refresh (will skip existing files — delete first to reimport)\n\n`;

      fs.writeFileSync(target, header + trimmed);
      written.push(`systems/${safeName}.md`);
      results.push(`  systems/${safeName}.md ← ${claudeMdPath} (imported)`);
    }

    rebuildIndex();
    const commitResult = gitCommit(`init: imported ${found.length} project docs`, written);

    const report = [
      `Scanned: ${dirs.join(", ")}`,
      `Found ${found.length} CLAUDE.md files:`,
      "",
      ...results,
      "",
      `Git: ${commitResult}`,
    ].join("\n");

    return { content: [{ type: "text", text: report }] };
  }
);

// 7. kb_link_track
server.tool(
  "kb_link_track",
  "Link a doc to a source repo + tracked paths (frontmatter), stamping the drift baseline to the repo's current HEAD.",
  {
    path: z.string().describe("Relative path to the doc (e.g. 'systems/my-doc.md')"),
    codeRepo: z.string().describe("Absolute path to the source repo"),
    codeTracks: z
      .array(z.string())
      .describe("Paths within codeRepo to track (dirs or files); empty array = whole repo"),
  },
  async ({ path: filePath, codeRepo, codeTracks }) => {
    try {
      const fullPath = kbPath(filePath);
      if (!fs.existsSync(fullPath)) {
        return {
          content: [{ type: "text", text: `Error: ${filePath} does not exist` }],
        };
      }
      const head = getRepoHead(codeRepo);
      if (!head) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${codeRepo} is not a git repo or HEAD unreadable`,
            },
          ],
        };
      }
      const content = fs.readFileSync(fullPath, "utf-8");
      const updated = upsertFrontmatter(content, {
        lastVerifiedCommit: head,
        lastVerifiedAt: new Date().toISOString(),
        codeRepo,
        codeTracks,
      });
      fs.writeFileSync(fullPath, updated);
      const commitResult = gitCommit(
        `link-track ${filePath} → ${codeRepo} (${head.slice(0, 7)})`,
        [filePath],
      );
      return {
        content: [
          {
            type: "text",
            text: `Linked ${filePath} → ${codeRepo} @ ${head.slice(0, 7)} tracking [${codeTracks.join(", ")}]. Git: ${commitResult}`,
          },
        ],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  },
);

// 8. kb_drift
server.tool(
  "kb_drift",
  "List commits a doc's tracked code gained since last verify. bump=true re-stamps the baseline to HEAD — only after manually confirming the doc still matches.",
  {
    path: z.string().describe("Relative path to the doc"),
    bump: z
      .boolean()
      .default(false)
      .describe("If true, after reporting drift, update last-verified-commit to current HEAD"),
  },
  async ({ path: filePath, bump }) => {
    try {
      const fullPath = kbPath(filePath);
      if (!fs.existsSync(fullPath)) {
        return { content: [{ type: "text", text: `Error: ${filePath} does not exist` }] };
      }
      const content = fs.readFileSync(fullPath, "utf-8");
      const { fm } = parseFrontmatter(content);

      if (!fm.codeRepo) {
        return {
          content: [
            {
              type: "text",
              text: `${filePath}: no code-repo set. Use kb_link_track first.`,
            },
          ],
        };
      }
      const currentHead = getRepoHead(fm.codeRepo);
      if (!currentHead) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${fm.codeRepo} HEAD unreadable (repo missing or corrupt?)`,
            },
          ],
        };
      }

      if (!fm.lastVerifiedCommit) {
        // First-time drift: stamp current HEAD and report no drift
        if (bump) {
          const updated = upsertFrontmatter(content, {
            lastVerifiedCommit: currentHead,
            lastVerifiedAt: new Date().toISOString(),
          });
          fs.writeFileSync(fullPath, updated);
          gitCommit(`drift-bump ${filePath} ${currentHead.slice(0, 7)}`, [filePath]);
        }
        return {
          content: [
            {
              type: "text",
              text: `${filePath}: no last-verified-commit. ${bump ? "Stamped HEAD." : "Run with bump=true to baseline."}`,
            },
          ],
        };
      }

      if (fm.lastVerifiedCommit === currentHead) {
        return {
          content: [
            {
              type: "text",
              text: `🟢 ${filePath} is at HEAD (${currentHead.slice(0, 7)}) — no drift.`,
            },
          ],
        };
      }

      const tracks = fm.codeTracks ?? [];
      const { commits, count, error } = gitLogSince(
        fm.codeRepo,
        fm.lastVerifiedCommit,
        tracks,
      );

      const status = error ? "⚠️" : count === 0 ? "🟢" : count <= 5 ? "🟡" : "🔴";
      const summary = error
        ? `git log failed: ${error} — last-verified-commit ${fm.lastVerifiedCommit.slice(0, 7)} likely unreachable (rebase/amend?). NOT zero drift. After manually confirming the doc matches HEAD, re-baseline with bump=true.`
        : count === 0
          ? `tracked paths unchanged (full-repo HEAD moved ${fm.lastVerifiedCommit.slice(0, 7)} → ${currentHead.slice(0, 7)})`
          : `${count}${count > 50 ? "+" : ""} commits touched tracked paths since ${fm.lastVerifiedCommit.slice(0, 7)}`;

      let report = `${status} ${filePath}\n  repo: ${fm.codeRepo}\n  tracks: ${tracks.length === 0 ? "(whole repo)" : tracks.join(", ")}\n  ${summary}\n`;
      if (commits) {
        report += `\nCommits since last verify:\n${commits}\n`;
      }

      if (bump) {
        const updated = upsertFrontmatter(content, {
          lastVerifiedCommit: currentHead,
          lastVerifiedAt: new Date().toISOString(),
        });
        fs.writeFileSync(fullPath, updated);
        gitCommit(`drift-bump ${filePath} → ${currentHead.slice(0, 7)}`, [filePath]);
        report += `\n→ Stamped last-verified-commit = ${currentHead.slice(0, 7)}.`;
      }

      return { content: [{ type: "text", text: report }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  },
);

// 9. kb_drift_all
server.tool(
  "kb_drift_all",
  "Drift dashboard: one status line (🟢/🟡/🔴/⚠️) per linked doc. Optional repoFilter narrows to one repo.",
  {
    repoFilter: z
      .string()
      .optional()
      .describe(
        "Optional absolute repo path. When set, only docs with this code-repo are checked.",
      ),
  },
  async ({ repoFilter }) => {
    try {
      const lines: string[] = ["# KB Drift Dashboard", ""];
      let totalChecked = 0;
      let totalDrifted = 0;

      for (const section of ["systems", "ops", "decisions"]) {
        const sectionDir = path.join(KB_DIR, section);
        if (!fs.existsSync(sectionDir)) continue;
        const docs = fs
          .readdirSync(sectionDir)
          .filter((f) => f.endsWith(".md"))
          .sort();

        const sectionLines: string[] = [];
        for (const doc of docs) {
          const docPath = path.join(sectionDir, doc);
          const content = fs.readFileSync(docPath, "utf-8");
          const { fm } = parseFrontmatter(content);
          if (!fm.codeRepo) continue;
          if (repoFilter && fm.codeRepo !== repoFilter) continue;
          totalChecked++;

          const currentHead = getRepoHead(fm.codeRepo);
          if (!currentHead) {
            sectionLines.push(`  ⚠️  ${doc}: code-repo unreachable (${fm.codeRepo})`);
            continue;
          }
          if (!fm.lastVerifiedCommit) {
            sectionLines.push(
              `  ⚪ ${doc}: linked but never verified (run kb_drift with bump=true)`,
            );
            continue;
          }
          if (fm.lastVerifiedCommit === currentHead) {
            sectionLines.push(`  🟢 ${doc}: at HEAD (${currentHead.slice(0, 7)})`);
            continue;
          }

          const tracks = fm.codeTracks ?? [];
          const { count, error } = gitLogSince(
            fm.codeRepo,
            fm.lastVerifiedCommit,
            tracks,
            100,
          );
          if (error) {
            totalDrifted++;
            sectionLines.push(
              `  ⚠️ ${doc}: git log failed (${error}) — baseline ${fm.lastVerifiedCommit.slice(0, 7)} likely unreachable, re-baseline with kb_drift bump=true`,
            );
            continue;
          }
          if (count === 0) {
            sectionLines.push(
              `  🟢 ${doc}: tracked paths unchanged (HEAD ${fm.lastVerifiedCommit.slice(0, 7)} → ${currentHead.slice(0, 7)})`,
            );
            continue;
          }
          totalDrifted++;
          const status = count <= 5 ? "🟡" : "🔴";
          sectionLines.push(
            `  ${status} ${doc}: ${count}${count > 100 ? "+" : ""} commits touched tracked paths since ${fm.lastVerifiedCommit.slice(0, 7)}`,
          );
        }

        if (sectionLines.length > 0) {
          lines.push(`## ${section.toUpperCase()}`);
          lines.push(...sectionLines);
          lines.push("");
        }
      }

      lines.push(
        `Summary: ${totalChecked} docs checked, ${totalDrifted} drifted${repoFilter ? ` (filter: ${repoFilter})` : ""}.`,
      );

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  },
);

// ── Start ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`knowledge-mcp running (KB_DIR=${KB_DIR})`);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
