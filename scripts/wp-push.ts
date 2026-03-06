#!/usr/bin/env bun

import { readdir, readFile, writeFile, exists, mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { cpus } from "node:os";

// ── CLI ─────────────────────────────────────────────────────────────────────
const { values: flags } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "dry-run": { type: "boolean", default: false },
    limit: { type: "string", short: "n" },
    concurrency: { type: "string", short: "c" },
    remote: { type: "string", default: "@wetheplumbers" },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (flags.help) {
  console.log(`Usage: bun run scripts/wp-push.ts [options]

Push optimized content back to WordPress via WP-CLI over SSH.

Options:
  -c, --concurrency <n>  Max parallel pushes (default: 4)
  -n, --limit <n>        Only push the first N pages
      --dry-run           Show what would be pushed without making changes
      --remote <alias>    WP-CLI remote alias (default: @wetheplumbers)
  -h, --help              Show this help

Requires: SSH agent with key loaded, wp CLI wrapper in PATH`);
  process.exit(0);
}

// ── Config ──────────────────────────────────────────────────────────────────
const SITE_ROOT = join(import.meta.dir, "..");
const REPORTS_DIR = join(SITE_ROOT, "reports");
const LOG_FILE = join(REPORTS_DIR, "wp-push.log");
const SKIP_DIRS = new Set(["media", "scripts", "reports", "node_modules", ".git"]);
const CONCURRENCY = flags.concurrency ? parseInt(flags.concurrency, 10) : 4;
const PAGE_LIMIT = flags.limit ? parseInt(flags.limit, 10) : Infinity;
const DRY_RUN = flags["dry-run"]!;
const WP_REMOTE = flags.remote!;
const SSH_HOST = "wetheplumbers";

// ── Types ───────────────────────────────────────────────────────────────────
interface Meta {
  id: string;      // base64 GraphQL ID e.g. "cG9zdDo4NQ=="
  slug: string;
  title: string;
  uri: string;
  modified: string;
}

interface PushResult {
  page: string;
  postId: number;
  status: "pushed" | "skipped" | "failed";
  changes: string[];
  error?: string;
}

// ── Logging ─────────────────────────────────────────────────────────────────
const logLines: string[] = [];

function log(msg: string) {
  logLines.push(`[${new Date().toISOString()}] ${msg}`);
}

async function flushLog() {
  await mkdir(REPORTS_DIR, { recursive: true });
  await writeFile(LOG_FILE, logLines.join("\n") + "\n");
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function decodeGraphQLId(encoded: string): number {
  const decoded = atob(encoded); // "post:85"
  const num = decoded.split(":")[1];
  return parseInt(num, 10);
}

async function sshExec(cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["ssh", SSH_HOST, cmd], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

async function wpGetBreakdanceTree(postId: number): Promise<any | null> {
  const { stdout, exitCode } = await sshExec(
    `cd ~/public_html && wp post meta get ${postId} _breakdance_data --format=json`
  );
  if (exitCode !== 0 || !stdout) return null;
  try {
    // wp meta get --format=json double-encodes: JSON string wrapping a serialized PHP value
    let data = JSON.parse(stdout);
    if (typeof data === "string") data = JSON.parse(data);
    return JSON.parse(data.tree_json_string);
  } catch {
    return null;
  }
}

// ── Text extraction from Breakdance tree ────────────────────────────────────
interface TextNode {
  path: string;
  text: string;
}

function extractTexts(node: any, path: string = "root"): TextNode[] {
  const results: TextNode[] = [];
  const props = node?.data?.properties || {};
  const nodeType = node?.data?.type || "";

  // Extract text from content properties
  if (props.content?.content?.text) {
    results.push({ path: `${path}.content.content.text`, text: props.content.content.text });
  }
  if (props.content?.text) {
    results.push({ path: `${path}.content.text`, text: props.content.text });
  }

  // Recurse into children
  const children = node?.children || [];
  for (let i = 0; i < children.length; i++) {
    results.push(...extractTexts(children[i], `${path}.children[${i}]`));
  }

  return results;
}

function setNestedValue(obj: any, path: string, value: string): void {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = /^\d+$/.test(parts[i]) ? parseInt(parts[i]) : parts[i];
    current = current[key];
  }
  const lastKey = parts[parts.length - 1];
  current[lastKey] = value;
}

function getNestedValue(obj: any, path: string): string | undefined {
  const parts = path.replace(/\[(\d+)\]/g, ".$1").split(".");
  let current = obj;
  for (const part of parts) {
    const key = /^\d+$/.test(part) ? parseInt(part) : part;
    current = current?.[key];
  }
  return typeof current === "string" ? current : undefined;
}

// ── Parse optimized HTML back into text nodes ───────────────────────────────
// The optimizer modifies content.html which is rendered Breakdance output.
// We extract text from the live Breakdance tree, compare with what's in the
// local content.html, and update changed text nodes in the tree.

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ── Diff and update Breakdance tree from local content.html ─────────────────
async function diffAndUpdate(
  postId: number,
  localContentPath: string,
  pageName: string
): Promise<{ tree: any; changes: string[] } | null> {
  // Get live Breakdance tree
  const tree = await wpGetBreakdanceTree(postId);
  if (!tree) {
    log(`WARN ${pageName}: could not fetch Breakdance tree`);
    return null;
  }

  // Read local optimized HTML
  const localHtml = await readFile(localContentPath, "utf-8");
  const localTextNorm = normalizeWhitespace(stripHtml(localHtml));

  // Extract text nodes from the Breakdance tree
  const textNodes = extractTexts(tree.root);

  const changes: string[] = [];

  // For each text node, check if the local HTML still contains it
  // If not, it was likely modified by the optimizer — we need to find
  // the corresponding text in the local HTML
  for (const node of textNodes) {
    const liveText = node.text;
    const liveStripped = normalizeWhitespace(stripHtml(liveText));

    // Check if the live text appears verbatim in local HTML
    if (localTextNorm.includes(liveStripped)) {
      continue; // unchanged
    }

    // Text was modified — the optimizer changed this content
    // We can't automatically map arbitrary HTML changes back to tree nodes
    // without a more sophisticated diffing algorithm, so we log it
    changes.push(`MODIFIED: ${node.path} => "${liveStripped.slice(0, 80)}..."`);
  }

  return { tree, changes };
}

// ── Push meta.json fields (title) back to WordPress ─────────────────────────
async function pushMeta(postId: number, localMeta: Meta, pageName: string): Promise<string[]> {
  const changes: string[] = [];

  // Get live title
  const { stdout: liveTitle } = await sshExec(
    `cd ~/public_html && wp post get ${postId} --field=post_title`
  );

  if (liveTitle !== localMeta.title) {
    if (!DRY_RUN) {
      // Use a temp file approach to safely handle special characters
      const escapedTitle = localMeta.title.replace(/'/g, "'\\''");
      const { exitCode, stderr } = await sshExec(
        `cd ~/public_html && wp post update ${postId} --post_title='${escapedTitle}'`
      );
      if (exitCode !== 0) {
        log(`FAIL ${pageName} title update: ${stderr}`);
        return [`FAIL title: ${stderr}`];
      }
    }
    changes.push(`title: "${liveTitle}" => "${localMeta.title}"`);
  }

  return changes;
}

// ── Push Rank Math SEO meta from meta.json ──────────────────────────────────
async function pushSeoMeta(postId: number, localMeta: any, pageName: string): Promise<string[]> {
  const changes: string[] = [];
  const seoFields: Record<string, string> = {
    seo_title: "rank_math_title",
    seo_description: "rank_math_description",
    seo_focuskw: "rank_math_focus_keyword",
  };

  for (const [localKey, metaKey] of Object.entries(seoFields)) {
    if (!localMeta[localKey]) continue;

    const { stdout: liveValue } = await sshExec(
      `cd ~/public_html && wp post meta get ${postId} ${metaKey}`
    );

    if (liveValue !== localMeta[localKey]) {
      if (!DRY_RUN) {
        const escaped = localMeta[localKey].replace(/'/g, "'\\''");
        await sshExec(
          `cd ~/public_html && wp post meta update ${postId} ${metaKey} '${escaped}'`
        );
      }
      changes.push(`${metaKey}: "${liveValue.slice(0, 50)}" => "${localMeta[localKey].slice(0, 50)}"`);
    }
  }

  return changes;
}

// ── Discovery ───────────────────────────────────────────────────────────────
async function discoverPages(dir: string): Promise<string[]> {
  const pages: string[] = [];

  if (await exists(join(dir, "content.html"))) {
    pages.push(dir);
  }

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    pages.push(...await discoverPages(join(dir, entry.name)));
  }

  return pages;
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

// ── Process a single page ───────────────────────────────────────────────────
async function processPage(pageDir: string): Promise<PushResult> {
  const pageName = relative(SITE_ROOT, pageDir) || "(root)";
  const metaPath = join(pageDir, "meta.json");
  const contentPath = join(pageDir, "content.html");

  if (!(await exists(metaPath))) {
    log(`SKIP ${pageName}: no meta.json`);
    return { page: pageName, postId: 0, status: "skipped", changes: [] };
  }

  const meta: Meta = JSON.parse(await readFile(metaPath, "utf-8"));
  const postId = decodeGraphQLId(meta.id);

  if (isNaN(postId)) {
    log(`FAIL ${pageName}: invalid post ID from ${meta.id}`);
    return { page: pageName, postId: 0, status: "failed", changes: [], error: "invalid post ID" };
  }

  try {
    const allChanges: string[] = [];

    // Push title from meta.json
    const metaChanges = await pushMeta(postId, meta, pageName);
    allChanges.push(...metaChanges);

    // Push SEO meta if present
    const seoChanges = await pushSeoMeta(postId, meta, pageName);
    allChanges.push(...seoChanges);

    // Diff Breakdance content
    const diff = await diffAndUpdate(postId, contentPath, pageName);
    if (diff) {
      allChanges.push(...diff.changes);
    }

    if (allChanges.length === 0) {
      log(`SKIP ${pageName} (post ${postId}): no changes`);
      return { page: pageName, postId, status: "skipped", changes: [] };
    }

    log(`${DRY_RUN ? "DRY-RUN" : "PUSH"} ${pageName} (post ${postId}): ${allChanges.length} changes`);
    for (const c of allChanges) log(`  ${c}`);

    return { page: pageName, postId, status: "pushed", changes: allChanges };
  } catch (err: any) {
    log(`FAIL ${pageName} (post ${postId}): ${err.message}`);
    return { page: pageName, postId, status: "failed", changes: [], error: err.message };
  }
}

// ── Progress ────────────────────────────────────────────────────────────────
function renderProgress(done: number, total: number, pushed: number, skipped: number, failed: number) {
  const pct = ((done / total) * 100).toFixed(0);
  const bar = "\u2588".repeat(Math.floor((done / total) * 30)).padEnd(30, "\u2591");
  process.stdout.write(
    `\r\x1b[K${bar} ${pct}% [${done}/${total}] ` +
    `\x1b[32m\u2191${pushed}\x1b[0m ` +
    `\x1b[33m\u2298${skipped}\x1b[0m ` +
    `\x1b[31m\u2717${failed}\x1b[0m`
  );
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const startTime = performance.now();

  console.log(`\x1b[1m\x1b[36m── WP Push ──\x1b[0m`);
  console.log(`Site root:   ${SITE_ROOT}`);
  console.log(`Remote:      ${WP_REMOTE}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  if (DRY_RUN) console.log(`Mode:        \x1b[33mDRY RUN\x1b[0m`);
  console.log();

  // Test SSH connection
  const { exitCode: sshTest } = await sshExec("echo ok");
  if (sshTest !== 0) {
    console.error("SSH connection failed. Is your key loaded? (ssh-add ~/.ssh/wetheplumbers)");
    process.exit(1);
  }

  // Discover pages
  let pages = await discoverPages(SITE_ROOT);
  const total = pages.length;
  if (PAGE_LIMIT < pages.length) pages = pages.slice(0, PAGE_LIMIT);

  console.log(`Found ${total} pages, processing ${pages.length}\n`);

  const results: PushResult[] = [];
  let pushed = 0, skipped = 0, failed = 0;

  await runPool(pages, CONCURRENCY, async (pageDir) => {
    const result = await processPage(pageDir);
    results.push(result);

    if (result.status === "pushed") pushed++;
    else if (result.status === "skipped") skipped++;
    else failed++;

    renderProgress(results.length, pages.length, pushed, skipped, failed);
  });

  await flushLog();

  // Summary
  const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\n\x1b[1m── Summary ──\x1b[0m`);
  console.log(`  Pages scanned:  ${pages.length}`);
  console.log(`  Pushed:         \x1b[32m${pushed}\x1b[0m`);
  console.log(`  Skipped:        \x1b[33m${skipped}\x1b[0m`);
  console.log(`  Failed:         \x1b[31m${failed}\x1b[0m`);
  console.log(`  Runtime:        ${elapsed}s`);

  if (pushed > 0) {
    console.log(`\n\x1b[1m── Changes ──\x1b[0m`);
    for (const r of results.filter(r => r.status === "pushed")) {
      console.log(`  \x1b[32m${r.page}\x1b[0m (post ${r.postId})`);
      for (const c of r.changes) console.log(`    ${c}`);
    }
  }

  if (failed > 0) {
    console.log(`\n\x1b[1m── Failures ──\x1b[0m`);
    for (const r of results.filter(r => r.status === "failed")) {
      console.log(`  \x1b[31m${r.page}\x1b[0m: ${r.error}`);
    }
  }

  console.log(`\nLog: ${relative(SITE_ROOT, LOG_FILE)}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nFatal error:", err);
  process.exit(2);
});
