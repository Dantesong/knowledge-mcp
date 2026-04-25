import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";

const KB_DIR = process.env.KNOWLEDGE_DIR || path.join(os.homedir(), "knowledge");

function kbPath(relative: string): string {
  const resolved = path.resolve(KB_DIR, relative);
  if (!resolved.startsWith(KB_DIR)) {
    throw new Error(`Path escapes knowledge base: ${relative}`);
  }
  return resolved;
}

function gitCommit(message: string): string {
  try {
    execSync(`git add -A && git commit -m "kb: ${message}"`, {
      cwd: KB_DIR,
      stdio: "pipe",
      timeout: 10000,
    });
    return "committed";
  } catch {
    return "no changes to commit";
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
): { commits: string; count: number } {
  const pathArgs =
    trackPaths.length > 0
      ? "-- " + trackPaths.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(" ")
      : "";
  try {
    const out = execSync(
      `git log --oneline -n ${limit + 1} ${sinceCommit}..HEAD ${pathArgs}`,
      { cwd: repoPath, stdio: "pipe", timeout: 8000 },
    ).toString();
    const lines = out.split("\n").filter(Boolean);
    return { commits: lines.slice(0, limit).join("\n"), count: lines.length };
  } catch {
    return { commits: "", count: 0 };
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

  for (const section of ["systems", "ops", "decisions"]) {
    const dir = path.join(KB_DIR, section);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    if (files.length === 0) continue;

    lines.push(`## ${section.toUpperCase()}`, "");
    for (const file of files) {
      const firstLine = fs.readFileSync(path.join(dir, file), "utf-8").split("\n")[0];
      const title = firstLine.replace(/^#+ */, "") || file;
      lines.push(`- ${title} — ${section}/${file}`);
    }
    lines.push("");
  }

  fs.writeFileSync(indexPath, lines.join("\n"));
}

// ── Server ──

const server = new McpServer({
  name: "knowledge-mcp",
  version: "1.0.0",
});

// 1. kb_search
server.tool(
  "kb_search",
  "Search the knowledge base for a keyword or phrase. Returns matching lines with file paths.",
  { query: z.string().describe("Search term (case-insensitive grep)") },
  async ({ query }) => {
    try {
      const output = execSync(
        `grep -rni "${query.replace(/"/g, '\\"')}" --include="*.md" .`,
        { cwd: KB_DIR, stdio: "pipe", timeout: 5000 }
      ).toString();
      const trimmed = output.split("\n").slice(0, 50).join("\n");
      return { content: [{ type: "text", text: trimmed || "No matches found." }] };
    } catch {
      return { content: [{ type: "text", text: "No matches found." }] };
    }
  }
);

// 2. kb_read
server.tool(
  "kb_read",
  "Read a knowledge base document. Path is relative to ~/knowledge/ (e.g. 'systems/hotel-automation.md').",
  { path: z.string().describe("Relative path to .md file") },
  async ({ path: filePath }) => {
    try {
      const content = fs.readFileSync(kbPath(filePath), "utf-8");
      return { content: [{ type: "text", text: content }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

// 3. kb_write
server.tool(
  "kb_write",
  "Write or append to a knowledge base document. Auto-commits to git. Path relative to ~/knowledge/. Optionally pass `codeRepo` (absolute path to source repo) so the doc's frontmatter records last-verified-commit + last-verified-at — used by kb_drift to detect staleness vs source code.",
  {
    path: z.string().describe("Relative path (e.g. 'systems/my-doc.md')"),
    content: z.string().describe("Content to write"),
    mode: z.enum(["replace", "append"]).default("append").describe("Write mode"),
    codeRepo: z
      .string()
      .optional()
      .describe(
        "Absolute path to source repo this doc tracks (e.g. '/Users/dante/develop/auto-hotelier'). When set, frontmatter records last-verified-commit (current HEAD) and last-verified-at (now).",
      ),
    codeTracks: z
      .array(z.string())
      .optional()
      .describe(
        "Optional list of paths within codeRepo that this doc tracks (e.g. ['packages/db/prisma','apps/core/src/services']). Used by kb_drift to scope git log diff.",
      ),
  },
  async ({ path: filePath, content, mode, codeRepo, codeTracks }) => {
    try {
      const fullPath = kbPath(filePath);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      // Build the candidate full content
      let finalContent: string;
      if (mode === "append" && fs.existsSync(fullPath)) {
        finalContent = fs.readFileSync(fullPath, "utf-8") + "\n" + content;
      } else {
        finalContent = content;
      }

      // Frontmatter: inject/update if codeRepo provided OR doc already has frontmatter
      const { fm: existingFm } = parseFrontmatter(finalContent);
      const hasExistingFm = Object.keys(existingFm).length > 0;
      const updates: Partial<Frontmatter> = {};

      if (codeRepo) {
        const head = getRepoHead(codeRepo);
        if (head) {
          updates.lastVerifiedCommit = head;
          updates.lastVerifiedAt = new Date().toISOString();
          updates.codeRepo = codeRepo;
        }
      } else if (hasExistingFm && existingFm.codeRepo) {
        // Doc already linked to a repo → refresh stamps to current HEAD
        const head = getRepoHead(existingFm.codeRepo);
        if (head) {
          updates.lastVerifiedCommit = head;
          updates.lastVerifiedAt = new Date().toISOString();
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
      const commitResult = gitCommit(`update ${filePath}`);
      const fmNote =
        Object.keys(updates).length > 0
          ? ` Frontmatter: ${Object.keys(updates).join(", ")}.`
          : "";
      return {
        content: [
          {
            type: "text",
            text: `Written to ${filePath} (${mode}).${fmNote} Git: ${commitResult}`,
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
      const commitResult = gitCommit(`decision: ${title}`);
      return {
        content: [{ type: "text", text: `Decision logged: ${title}. Git: ${commitResult}` }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

// 5. kb_index
server.tool(
  "kb_index",
  "Show the knowledge base index — list of all documents organized by category.",
  {},
  async () => {
    try {
      const indexPath = path.join(KB_DIR, "_index.md");
      if (!fs.existsSync(indexPath)) {
        rebuildIndex();
      }
      const content = fs.readFileSync(indexPath, "utf-8");
      return { content: [{ type: "text", text: content }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
);

// 6. kb_init
server.tool(
  "kb_init",
  "Scan for CLAUDE.md files across all projects, extract key info, and import into the knowledge base. Run once after install to bootstrap your KB from existing projects.",
  {
    scan_dirs: z
      .string()
      .default("~,~/dev,~/projects,~/src,~/work")
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
    for (const { project, claudeMdPath, summary } of found) {
      if (project === "_global") {
        // Global rules → ops/global-rules.md
        const target = path.join(KB_DIR, "ops", "global-rules.md");
        if (!fs.existsSync(target)) {
          fs.writeFileSync(target, summary);
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
      results.push(`  systems/${safeName}.md ← ${claudeMdPath} (imported)`);
    }

    rebuildIndex();
    const commitResult = gitCommit(`init: imported ${found.length} project docs`);

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
  "Set a doc's source-code tracking metadata. After this call, the doc's frontmatter has `code-repo` + `code-tracks` set, plus `last-verified-commit` stamped to the repo's current HEAD. Use kb_drift afterwards to detect when source diverges.",
  {
    path: z.string().describe("Relative path to the doc (e.g. 'systems/my-doc.md')"),
    codeRepo: z
      .string()
      .describe("Absolute path to source repo (e.g. '/Users/dante/develop/auto-hotelier')"),
    codeTracks: z
      .array(z.string())
      .describe(
        "Paths within codeRepo this doc tracks. Use directories OR specific files (e.g. ['packages/db/prisma/schema.prisma','apps/core/src/services/booking']). Empty array means whole repo.",
      ),
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
  "Report drift between a KB doc and its tracked source code. Reads the doc's frontmatter (code-repo + last-verified-commit + code-tracks) and runs `git log <last-verified>..HEAD -- <code-tracks>` in the source repo. Output: list of commits the doc may not yet reflect, plus a summary line. Pass `bump=true` to also reset last-verified-commit to current HEAD (use only when you've manually verified the doc still matches HEAD).",
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
          gitCommit(`drift-bump ${filePath} ${currentHead.slice(0, 7)}`);
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
      const { commits, count } = gitLogSince(fm.codeRepo, fm.lastVerifiedCommit, tracks);

      const status = count === 0 ? "🟢" : count <= 5 ? "🟡" : "🔴";
      const summary =
        count === 0
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
        gitCommit(`drift-bump ${filePath} → ${currentHead.slice(0, 7)}`);
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
  "Drift dashboard across all KB docs that have a code-repo set. Outputs one line per doc with status (🟢 OK / 🟡 minor / 🔴 major) + commit count. Use this at session start or before phase boundaries to spot stale docs quickly. Pass `repoFilter` to only check docs tracking a specific repo path.",
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
          const { count } = gitLogSince(fm.codeRepo, fm.lastVerifiedCommit, tracks, 100);
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
