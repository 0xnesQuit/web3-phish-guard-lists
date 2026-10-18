#!/usr/bin/env node
/**
 * Weekly upstream submission: open (or extend) a PR against MetaMask/eth-phishing-detect with the
 * domains a human approved in our moderation panel since the last run.
 *
 * Only `approved` entries go upstream. Auto-listed (AI-confirmed) domains never do: MetaMask's
 * false-positive policy gives contributors two strikes, so a person must have looked at each one.
 *
 * env:  API_BASE, ADMIN_TOKEN (export endpoint), MM_PR_TOKEN (classic PAT, public_repo: push to the
 *       fork + open the PR), FORK (owner/repo, default 0xnesQuit/eth-phishing-detect)
 * args: --dry-run   do everything except push/PR, using ./tmp/export.json if API is not configured
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const UPSTREAM = "MetaMask/eth-phishing-detect";
const FORK = process.env.FORK || "0xnesQuit/eth-phishing-detect";
const BRANCH = "w3pg-submissions";
const STATE = "data/upstream-submitted.json";
const MAX_PER_RUN = 100;
const dry = process.argv.includes("--dry-run");
const YARN = process.env.YARN || "yarn"; // runners have yarn classic; locally: YARN="npx -y yarn@1"
const sh = (cmd, opts = {}) => (execSync(cmd, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...opts }) ?? "").trim();

// ---- 1. what did a human approve? ---------------------------------------------------------------
let exported;
if (process.env.API_BASE && process.env.ADMIN_TOKEN) {
  const r = await fetch(`${process.env.API_BASE}/admin/export?since=0`, { headers: { "x-admin-token": process.env.ADMIN_TOKEN } });
  if (!r.ok) { console.error(`export failed: ${r.status}`); process.exit(1); }
  exported = await r.json();
} else if (dry && existsSync("tmp/export.json")) {
  exported = JSON.parse(readFileSync("tmp/export.json", "utf8"));
} else { console.error("API_BASE/ADMIN_TOKEN not set"); process.exit(1); }

const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { submitted: {} };
const candidates = exported.items
  .filter((i) => i.kind === "approved" && !state.submitted[i.domain])
  .filter((i) => /^[a-z0-9.-]+\.[a-z0-9-]+(\/.*)?$/i.test(i.domain))
  .slice(0, MAX_PER_RUN);
console.log(`approved: ${exported.items.filter((i) => i.kind === "approved").length}, not yet submitted: ${candidates.length}`);
if (!candidates.length) { console.log("nothing to submit"); process.exit(0); }

// ---- 2. fork checkout, synced with upstream -----------------------------------------------------
const work = path.resolve("tmp/upstream");
rmSync(work, { recursive: true, force: true });
mkdirSync(path.dirname(work), { recursive: true });
const token = process.env.MM_PR_TOKEN || "";
const forkUrl = token ? `https://x-access-token:${token}@github.com/${FORK}.git` : `https://github.com/${FORK}.git`;
sh(`git clone -q --depth 50 ${forkUrl} "${work}"`);
const g = (cmd) => sh(`git ${cmd}`, { cwd: work });
g(`remote add upstream https://github.com/${UPSTREAM}.git`);
g(`fetch -q upstream main`);
g(`config user.name "w3pg-bot"`);
g(`config user.email "w3pg-bot@users.noreply.github.com"`);

// an open PR from our branch? extend it instead of opening a second one
let openPr = null;
if (token) {
  const prs = await fetch(`https://api.github.com/repos/${UPSTREAM}/pulls?state=open&head=${FORK.split("/")[0]}:${BRANCH}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } }).then((r) => (r.ok ? r.json() : []));
  openPr = prs[0] ?? null;
}
if (openPr) {
  g(`fetch -q origin ${BRANCH}`);
  g(`checkout -q -B ${BRANCH} origin/${BRANCH}`);
  try { g(`merge -q --no-edit upstream/main`); } catch { console.error("merge with upstream failed; resolve by hand"); process.exit(1); }
} else {
  g(`checkout -q -B ${BRANCH} upstream/main`);
}

// ---- 3. skip what MetaMask already has ----------------------------------------------------------
const config = JSON.parse(readFileSync(path.join(work, "src/config.json"), "utf8"));
const have = new Set([...config.blacklist, ...config.whitelist].map((d) => d.toLowerCase()));
const fresh = candidates.filter((c) => !have.has(c.domain.toLowerCase()));
for (const c of candidates) if (have.has(c.domain.toLowerCase())) state.submitted[c.domain] = { at: Date.now(), note: "already upstream" };
console.log(`new for upstream: ${fresh.length}`);

// ---- 4. append to their blocklist and run their config tests ----------------------------------------
if (fresh.length) {
  sh(`${YARN} install --frozen-lockfile --silent`, { cwd: work, stdio: ["ignore", "inherit", "inherit"] });
  // Their `add:blocklist` CLI re-serializes the whole file and currently rewrites unrelated entries
  // (ipfs gateways), which would bloat the PR; append to the end of the blacklist array verbatim instead.
  const cfgPath = path.join(work, "src/config.json");
  const text = readFileSync(cfgPath, "utf8");
  const end = text.lastIndexOf("\n  ]\n}");
  if (end < 0) { console.error("unexpected config.json layout"); process.exit(1); }
  const lines = fresh.map((c) => `    ${JSON.stringify(c.domain.toLowerCase())}`).join(",\n");
  writeFileSync(cfgPath, text.slice(0, end) + ",\n" + lines + text.slice(end));
  JSON.parse(readFileSync(cfgPath, "utf8")); // must still be valid JSON
  try {
    sh(`${YARN} --silent test:config`, { cwd: work, stdio: ["ignore", "inherit", "inherit"] });
  } catch {
    console.error("upstream config tests failed: one of the domains hits their safeguards (allowlist / top sites). Not submitting; review by hand.");
    process.exit(1);
  }
  console.log(g(`diff --stat`) || "(no diff)");
}

// ---- 5. commit, push, PR ------------------------------------------------------------------------
const today = new Date().toISOString().slice(0, 10);
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ");
const row = (c) => `| \`${c.domain}\` | ${cell(c.url)} | ${(c.signals || []).slice(0, 4).map(cell).join(", ")} | ${cell(c.note).slice(0, 120)} | ${c.at ? new Date(c.at).toISOString().slice(0, 10) : ""} |`;
const table = ["| Domain | First seen at | Signals | Note | Approved |", "|---|---|---|---|---|", ...fresh.map(row)].join("\n");
const body = [
  "Phishing domains detected by [Web3 Phish Guard](https://github.com/0xnesQuit/web3-phish-guard-lists) and reviewed by a human before submission.",
  "",
  "Each entry was flagged by the extension's heuristics (fresh domain + brand impersonation + claim/mint bait, wallet-drainer behaviour, X poster mismatch, etc.) and then approved manually in our moderation queue. Auto-detected entries without human review are never included.",
  "",
  table,
  "",
  "`yarn test:config` passes.",
].join("\n");

if (dry) {
  console.log("\n--- DRY RUN: would commit/push the following PR ---\n");
  console.log(body);
  process.exit(0);
}
if (!fresh.length) { writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n"); console.log("nothing new for upstream"); process.exit(0); }
if (!token) { console.error("MM_PR_TOKEN not set"); process.exit(1); }

g(`add src/config.json`);
g(`commit -q -m "Add ${fresh.length} phishing domain(s) reported by Web3 Phish Guard (${today})"`);
g(`push -q origin ${BRANCH}`);
const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" };
let prUrl;
if (openPr) {
  await fetch(`https://api.github.com/repos/${UPSTREAM}/issues/${openPr.number}/comments`, { method: "POST", headers, body: JSON.stringify({ body: `Added ${fresh.length} more on ${today}:\n\n${table}` }) });
  prUrl = openPr.html_url;
} else {
  const r = await fetch(`https://api.github.com/repos/${UPSTREAM}/pulls`, { method: "POST", headers, body: JSON.stringify({ title: `Add ${fresh.length} phishing domains reported by Web3 Phish Guard (${today})`, head: `${FORK.split("/")[0]}:${BRANCH}`, base: "main", body, maintainer_can_modify: true }) });
  if (!r.ok) { console.error(`PR creation failed: ${r.status} ${await r.text()}`); process.exit(1); }
  prUrl = (await r.json()).html_url;
}
for (const c of fresh) state.submitted[c.domain] = { at: Date.now(), pr: prUrl };
writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
console.log(`submitted ${fresh.length} -> ${prUrl}`);
