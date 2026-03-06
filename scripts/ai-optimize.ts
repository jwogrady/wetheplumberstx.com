#!/usr/bin/env bun

import { readdir, stat, readFile, writeFile, appendFile, exists, mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { cpus } from "node:os";
import { parseArgs } from "node:util";

// ── CLI ─────────────────────────────────────────────────────────────────────
const { values: flags } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    concurrency: { type: "string", short: "c" },
    limit: { type: "string", short: "n" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (flags.help) {
  console.log(`Usage: bun run scripts/ai-optimize.ts [options]

Options:
  -c, --concurrency <n>  Max parallel workers (default: CPU cores)
  -n, --limit <n>        Only process the first N pages
      --dry-run           Show pages that would be optimized, don't run Claude
  -h, --help              Show this help`);
  process.exit(0);
}

// ── Config ──────────────────────────────────────────────────────────────────
const SITE_ROOT = join(import.meta.dir, "..");
const REPORTS_DIR = join(SITE_ROOT, "reports");
const LOG_FILE = join(REPORTS_DIR, "ai-optimization.log");
const FAILURES_LOG = join(REPORTS_DIR, "ai-optimization-failures.log");
const MANIFEST_FILE = join(REPORTS_DIR, ".optimize-manifest.json");
const SKIP_DIRS = new Set(["media", "scripts", "reports", "node_modules", ".git"]);
const TEMPLATE_ARTIFACTS = /\{\{mpg_\w+\}\}/g;
const CONCURRENCY = flags.concurrency ? parseInt(flags.concurrency, 10) : cpus().length;
const PAGE_LIMIT = flags.limit ? parseInt(flags.limit, 10) : Infinity;
const DRY_RUN = flags["dry-run"]!;
const PAGE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const OPTIMIZE_PROMPT = `Read content.html and meta.json in this directory. Optimize them for a local plumbing company website (We The Plumbers TX, Conroe, Texas). Apply these changes IN PLACE by editing the files directly:

content.html:
- Fix grammar, spelling, and awkward phrasing
- Tighten verbose or repetitive paragraphs
- Improve heading hierarchy (single H1, logical H2/H3 structure)
- Remove duplicate content or filler text
- Ensure local SEO keywords appear naturally (Conroe, Montgomery County, Texas)
- Preserve ALL Breakdance HTML structure, classes, and attributes exactly — only modify text content
- Do NOT add, remove, or restructure any HTML elements or Breakdance components

meta.json:
- Optimize the "title" field for SEO (60 chars max, include primary keyword + location)
- Do NOT modify id, slug, uri, or modified fields

Be concise and surgical. Only change what genuinely improves quality. Do not rewrite content that is already good.`;

// ── Types ───────────────────────────────────────────────────────────────────
interface PageResult {
  page: string;
  status: "optimized" | "skipped" | "failed" | "dry-run";
  duration: number;
  error?: string;
  stderr?: string;
  artifacts?: string[];
}

interface Manifest {
  optimized: Record<string, { timestamp: string; hash: string }>;
}

// ── Logging ─────────────────────────────────────────────────────────────────
let logBuffer: string[] = [];

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  logBuffer.push(line);
}

async function flushLog() {
  await mkdir(REPORTS_DIR, { recursive: true });
  await writeFile(LOG_FILE, logBuffer.join("\n") + "\n");
}

// ── Discovery ───────────────────────────────────────────────────────────────
async function discoverPages(dir: string): Promise<string[]> {
  const pages: string[] = [];

  // Check if this directory itself is a page
  const contentPath = join(dir, "content.html");
  if (await exists(contentPath)) {
    pages.push(dir);
  }

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const subPages = await discoverPages(join(dir, entry.name));
    pages.push(...subPages);
  }

  return pages;
}

// ── Template artifact detection ─────────────────────────────────────────────
async function detectArtifacts(pageDir: string): Promise<string[]> {
  const artifacts: string[] = [];
  for (const file of ["content.html", "meta.json"]) {
    const filePath = join(pageDir, file);
    if (await exists(filePath)) {
      const content = await readFile(filePath, "utf-8");
      const matches = content.match(TEMPLATE_ARTIFACTS);
      if (matches) {
        artifacts.push(...matches.map((m) => `${file}: ${m}`));
      }
    }
  }
  return artifacts;
}

// ── Content hash for resume detection ───────────────────────────────────────
async function hashPage(pageDir: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("md5");
  for (const file of ["content.html", "meta.json"]) {
    const filePath = join(pageDir, file);
    if (await exists(filePath)) {
      hasher.update(await readFile(filePath));
    }
  }
  return hasher.digest("hex");
}

// ── Manifest (resume support) ───────────────────────────────────────────────
async function loadManifest(): Promise<Manifest> {
  if (await exists(MANIFEST_FILE)) {
    return JSON.parse(await readFile(MANIFEST_FILE, "utf-8"));
  }
  return { optimized: {} };
}

async function saveManifest(manifest: Manifest) {
  await writeFile(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
}

// ── Optimize a single page ──────────────────────────────────────────────────
async function optimizePage(
  pageDir: string,
  manifest: Manifest
): Promise<PageResult> {
  const pageName = relative(SITE_ROOT, pageDir) || "(root)";
  const start = performance.now();

  // Resume check: skip if content hasn't changed since last optimization
  const hash = await hashPage(pageDir);
  const prev = manifest.optimized[pageName];
  if (prev && prev.hash === hash) {
    log(`SKIP ${pageName} (already optimized, content unchanged)`);
    return { page: pageName, status: "skipped", duration: 0 };
  }

  // Detect template artifacts
  const artifacts = await detectArtifacts(pageDir);
  if (artifacts.length > 0) {
    log(`ARTIFACTS ${pageName}: ${artifacts.join(", ")}`);
  }

  // Dry-run: report what would be optimized, don't spawn Claude
  if (DRY_RUN) {
    log(`DRY-RUN ${pageName}`);
    return { page: pageName, status: "dry-run", duration: 0, artifacts };
  }

  try {
    const proc = Bun.spawn(
      [
        "claude",
        "-p",
        OPTIMIZE_PROMPT,
        "--dangerously-skip-permissions",
      ],
      {
        cwd: pageDir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CLAUDECODE: "", CLAUDE_CODE_ENTRYPOINT: "" },
      }
    );

    // Race the process against a timeout
    const exitCode = await Promise.race([
      proc.exited,
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), PAGE_TIMEOUT_MS)
      ),
    ]);

    if (exitCode === "timeout") {
      proc.kill();
      const duration = performance.now() - start;
      const errMsg = `Timed out after ${PAGE_TIMEOUT_MS / 1000}s`;
      log(`FAIL ${pageName}: ${errMsg}`);
      return { page: pageName, status: "failed", duration, error: errMsg, artifacts };
    }

    const stderrText = await new Response(proc.stderr).text();
    const duration = performance.now() - start;

    if (exitCode !== 0) {
      const errMsg = stderrText.trim().slice(0, 500);
      log(`FAIL ${pageName} (exit ${exitCode}): ${errMsg}`);
      return { page: pageName, status: "failed", duration, error: errMsg, stderr: stderrText, artifacts };
    }

    // Record successful optimization
    manifest.optimized[pageName] = {
      timestamp: new Date().toISOString(),
      hash: await hashPage(pageDir), // re-hash after optimization
    };

    log(`OK   ${pageName} (${(duration / 1000).toFixed(1)}s)`);
    return { page: pageName, status: "optimized", duration, artifacts };
  } catch (err: any) {
    const duration = performance.now() - start;
    log(`FAIL ${pageName}: ${err.message}`);
    return {
      page: pageName,
      status: "failed",
      duration,
      error: err.message,
      artifacts,
    };
  }
}

// ── Bounded concurrency pool ────────────────────────────────────────────────
async function runPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

// ── Progress display ────────────────────────────────────────────────────────
function renderProgress(
  done: number,
  total: number,
  optimized: number,
  skipped: number,
  failed: number,
  activeTasks: Set<string>
) {
  const pct = ((done / total) * 100).toFixed(0);
  const bar = "█".repeat(Math.floor((done / total) * 30)).padEnd(30, "░");

  process.stdout.write(
    `\r\x1b[K` +
      `${bar} ${pct}% ` +
      `[${done}/${total}] ` +
      `\x1b[32m✓${optimized}\x1b[0m ` +
      `\x1b[33m⊘${skipped}\x1b[0m ` +
      `\x1b[31m✗${failed}\x1b[0m ` +
      `| active: ${activeTasks.size}`
  );
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const startTime = performance.now();

  console.log(`\x1b[1m\x1b[36m── AI Page Optimizer ──\x1b[0m`);
  console.log(`Site root:   ${SITE_ROOT}`);
  console.log(`Concurrency: ${CONCURRENCY} workers`);
  console.log(`Timeout:     ${PAGE_TIMEOUT_MS / 1000}s per page`);
  if (DRY_RUN) console.log(`Mode:        \x1b[33mDRY RUN\x1b[0m`);
  console.log();

  // Discover pages
  let pages = await discoverPages(SITE_ROOT);
  const totalDiscovered = pages.length;

  if (PAGE_LIMIT < pages.length) {
    pages = pages.slice(0, PAGE_LIMIT);
  }

  console.log(`Found ${totalDiscovered} pages, processing ${pages.length}\n`);

  if (pages.length === 0) {
    console.log("No pages found. Exiting.");
    return;
  }

  // Dry-run: just list pages and exit
  if (DRY_RUN) {
    const manifest = await loadManifest();
    let wouldOptimize = 0;
    let wouldSkip = 0;
    for (const pageDir of pages) {
      const pageName = relative(SITE_ROOT, pageDir) || "(root)";
      const hash = await hashPage(pageDir);
      const prev = manifest.optimized[pageName];
      if (prev && prev.hash === hash) {
        console.log(`  \x1b[33m⊘ ${pageName}\x1b[0m (unchanged, would skip)`);
        wouldSkip++;
      } else {
        const artifacts = await detectArtifacts(pageDir);
        const tag = artifacts.length > 0 ? ` \x1b[31m[has template artifacts]\x1b[0m` : "";
        console.log(`  \x1b[32m→ ${pageName}\x1b[0m${tag}`);
        wouldOptimize++;
      }
    }
    console.log(`\nDry run complete: ${wouldOptimize} to optimize, ${wouldSkip} to skip`);
    return;
  }

  // Load resume manifest
  const manifest = await loadManifest();

  // Track results
  const results: PageResult[] = [];
  let optimized = 0;
  let skipped = 0;
  let failed = 0;
  const activeTasks = new Set<string>();

  // Process pages with bounded concurrency
  await runPool(pages, CONCURRENCY, async (pageDir, idx) => {
    const pageName = relative(SITE_ROOT, pageDir) || "(root)";
    activeTasks.add(pageName);
    renderProgress(results.length, pages.length, optimized, skipped, failed, activeTasks);

    const result = await optimizePage(pageDir, manifest);
    results.push(result);

    if (result.status === "optimized") optimized++;
    else if (result.status === "skipped") skipped++;
    else failed++;

    activeTasks.delete(pageName);
    renderProgress(results.length, pages.length, optimized, skipped, failed, activeTasks);
  });

  // Save manifest for resume
  await saveManifest(manifest);

  // Flush logs
  await flushLog();

  // Write failures log
  const failures = results.filter((r) => r.status === "failed");
  if (failures.length > 0) {
    await mkdir(REPORTS_DIR, { recursive: true });
    const failLines = failures.map((r) => {
      const header = `== ${r.page} ==\nError: ${r.error ?? "unknown"}`;
      const stderr = r.stderr ? `\nStderr:\n${r.stderr}` : "";
      return header + stderr;
    });
    await writeFile(FAILURES_LOG, failLines.join("\n\n") + "\n");
  }

  // Final summary
  const totalTime = ((performance.now() - startTime) / 1000).toFixed(1);
  const artifactPages = results.filter((r) => r.artifacts && r.artifacts.length > 0);

  console.log(`\n\n\x1b[1m── Summary ──\x1b[0m`);
  console.log(`  Pages scanned:    ${pages.length}`);
  console.log(`  Pages optimized:  \x1b[32m${optimized}\x1b[0m`);
  console.log(`  Pages skipped:    \x1b[33m${skipped}\x1b[0m`);
  console.log(`  Failures:         \x1b[31m${failed}\x1b[0m`);
  console.log(`  Total runtime:    ${totalTime}s`);

  if (artifactPages.length > 0) {
    console.log(`\n\x1b[1m── Template Artifacts Found ──\x1b[0m`);
    for (const r of artifactPages) {
      console.log(`  \x1b[33m${r.page}\x1b[0m`);
      for (const a of r.artifacts!) {
        console.log(`    ${a}`);
      }
    }
  }

  if (failed > 0) {
    console.log(`\n\x1b[1m── Failures ──\x1b[0m`);
    for (const r of failures) {
      console.log(`  \x1b[31m${r.page}\x1b[0m: ${r.error?.slice(0, 200)}`);
    }
    console.log(`  Details: ${relative(SITE_ROOT, FAILURES_LOG)}`);
  }

  console.log(`\nLog written to: ${relative(SITE_ROOT, LOG_FILE)}`);
  console.log(`Manifest:       ${relative(SITE_ROOT, MANIFEST_FILE)}`);

  // Exit with error code if any failures
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(2);
});
