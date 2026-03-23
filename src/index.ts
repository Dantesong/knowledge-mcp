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
  "Write or append to a knowledge base document. Auto-commits to git. Path relative to ~/knowledge/.",
  {
    path: z.string().describe("Relative path (e.g. 'systems/my-doc.md')"),
    content: z.string().describe("Content to write"),
    mode: z.enum(["replace", "append"]).default("append").describe("Write mode"),
  },
  async ({ path: filePath, content, mode }) => {
    try {
      const fullPath = kbPath(filePath);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      if (mode === "append") {
        fs.appendFileSync(fullPath, "\n" + content);
      } else {
        fs.writeFileSync(fullPath, content);
      }

      rebuildIndex();
      const commitResult = gitCommit(`update ${filePath}`);
      return {
        content: [{ type: "text", text: `Written to ${filePath} (${mode}). Git: ${commitResult}` }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Error: ${e.message}` }] };
    }
  }
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
