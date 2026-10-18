#!/usr/bin/env node
/**
 * Weekly upstream submission: open (or extend) a PR against MetaMask/eth-phishing-detect with the
 * domains a human approved in our moderation panel since the last run.
 *
 * Only `approved` entries go upstream. Auto-listed (AI-confirmed) domains never do: MetaMask's
 * false-positive policy gives contributors two strikes, so a person must have looked at each one.
 *
 * Three phases so that MetaMask's code never runs in a step that holds a secret:
 *   --phase export    API_BASE + ADMIN_TOKEN  -> tmp/export.json
 *   --phase prepare   (no secrets) clone fork, add domains, run their tests, commit -> tmp/pr.json
 *   --phase publish   MM_PR_TOKEN             -> push, open or extend the PR, update data/upstream-submitted.json
 * No --phase runs all three (local use). --dry-run stops before publish and prints the PR body.
 *
 * env: FORK (owner/repo, default 0xnesQuit/eth-phishing-detect), YARN (default "yarn")
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const UPSTREAM = "MetaMask/eth-phishing-detect";
const FORK = process.env.FORK || "0xnesQuit/eth-phishing-detect";
const BRANCH = "w3pg-submissions";
const STATE = "data/upstream-submitted.json";
const MAX_PER_RUN = 100;
const YARN = process.env.YARN || "yarn";
const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const phaseArg = args[args.indexOf("--phase") + 1];
const phases = args.includes("--phase") ? [phaseArg] : ["export", "prepare", dry ? null : "publish"].filter(Boolean);
const sh = (cmd, opts = {}) => (execSync(cmd, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...opts }) ?? "").trim();
const work = path.resolve("tmp/upstream");
const g = (cmd) => sh(`git ${cmd}`, { cwd: work });
const loadState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { submitted: {} });
mkdirSync("tmp", { recursive: true });

// ---- export --------------------------------------------------------------------------------------
if (phases.includes("export")) {
  if (!process.env.API_BASE || !process.env.ADMIN_TOKEN) {
    if (dry && existsSync("tmp/export.json")) console.log("export: using existing tmp/export.json");
    else { console.error("API_BASE/ADMIN_TOKEN not set"); process.exit(1); }
  } else {
    const r = await fetch(`${process.env.API_BASE}/admin/export?since=0`, { headers: { "x-admin-token": process.env.ADMIN_TOKEN } });
    if (!r.ok) { console.error(`export failed: ${r.status}`); process.exit(1); }
    writeFileSync("tmp/export.json", JSON.stringify(await r.json()));
    console.log("export: ok");
  }
}

// ---- prepare -------------------------------------------------------------------------------------
if (phases.includes("prepare")) {
  const exported = JSON.parse(readFileSync("tmp/export.json", "utf8"));
  const state = loadState();
  const candidates = exported.items
    .filter((i) => i.kind === "approved" && !state.submitted[i.domain])
    .filter((i) => /^[a-z0-9.-]+\.[a-z0-9-]+(\/.*)?$/i.test(i.domain))
    .slice(0, MAX_PER_RUN);
  console.log(`approved: ${exported.items.filter((i) => i.kind === "approved").length}, not yet submitted: ${candidates.length}`);
  rmSync("tmp/pr.json", { force: true });
  if (!candidates.length) { console.log("nothing to submit"); }
  else {
    rmSync(work, { recursive: true, force: true });
    sh(`git clone -q --depth 50 https://github.com/${FORK}.git "${work}"`);
    g(`remote add upstream https://github.com/${UPSTREAM}.git`);
    g(`fetch -q upstream main`);
    g(`config user.name "w3pg-bot"`);
    g(`config user.email "w3pg-bot@users.noreply.github.com"`);

    // an open PR from our branch? extend it instead of opening a second one (public read, no token needed)
    const prs = await fetch(`https://api.github.com/repos/${UPSTREAM}/pulls?state=open&head=${FORK.split("/")[0]}:${BRANCH}`, { headers: { accept: "application/vnd.github+json", "user-agent": "w3pg-submit" } }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    const openPr = prs[0] ? { number: prs[0].number, html_url: prs[0].html_url } : null;
    if (openPr) {
      g(`fetch -q origin ${BRANCH}`);
      g(`checkout -q -B ${BRANCH} origin/${BRANCH}`);
      try { g(`merge -q --no-edit upstream/main`); } catch { console.error("merge with upstream failed; resolve by hand"); process.exit(1); }
    } else {
      g(`checkout -q -B ${BRANCH} upstream/main`);
    }

    const cfgPath = path.join(work, "src/config.json");
    const config = JSON.parse(readFileSync(cfgPath, "utf8"));
    const have = new Set([...config.blacklist, ...config.whitelist].map((d) => d.toLowerCase()));
    const fresh = candidates.filter((c) => !have.has(c.domain.toLowerCase()));
    const alreadyUpstream = candidates.filter((c) => have.has(c.domain.toLowerCase())).map((c) => c.domain);
    console.log(`new for upstream: ${fresh.length}`);

    if (fresh.length) {
      // Their `add:blocklist` CLI re-serializes the whole file and currently rewrites unrelated entries
      // (ipfs gateways), which would bloat the PR; append to the end of the blacklist array verbatim instead.
      const text = readFileSync(cfgPath, "utf8");
      const end = text.lastIndexOf("\n  ]\n}");
      if (end < 0) { console.error("unexpected config.json layout"); process.exit(1); }
      const lines = fresh.map((c) => `    ${JSON.stringify(c.domain.toLowerCase())}`).join(",\n");
      writeFileSync(cfgPath, text.slice(0, end) + ",\n" + lines + text.slice(end));
      JSON.parse(readFileSync(cfgPath, "utf8")); // must still be valid JSON
      // third-party code, run without lifecycle scripts and (in CI) without any secret in the environment
      sh(`${YARN} install --frozen-lockfile --ignore-scripts --silent`, { cwd: work, stdio: ["ignore", "inherit", "inherit"] });
      try {
        sh(`${YARN} --silent test:config`, { cwd: work, stdio: ["ignore", "inherit", "inherit"] });
      } catch {
        console.error("upstream config tests failed: one of the domains hits their safeguards (allowlist / top sites). Not submitting; review by hand.");
        process.exit(1);
      }
      const today = new Date().toISOString().slice(0, 10);
      g(`add src/config.json`);
      g(`commit -q -m "Add ${fresh.length} phishing domain(s) reported by Web3 Phish Guard (${today})"`);

      // PR text: domain, where it was first seen (path only, no query), signals and approval date. Moderator notes
      // stay private: they may name reporters or carry links we do not want in a public PR.
      const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ");
      const seen = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return ""; } };
      const row = (c) => `| \`${c.domain}\` | ${cell(seen(c.url))} | ${(c.signals || []).slice(0, 4).map(cell).join(", ")} | ${c.at ? new Date(c.at).toISOString().slice(0, 10) : ""} |`;
      const table = ["| Domain | First seen at | Signals | Approved |", "|---|---|---|---|", ...fresh.map(row)].join("\n");
      const body = [
        "Phishing domains detected by [Web3 Phish Guard](https://github.com/0xnesQuit/web3-phish-guard) and reviewed by a human before submission.",
        "",
        "Each entry was flagged by the extension's heuristics (fresh domain + brand impersonation + claim/mint bait, wallet-drainer behaviour, X poster mismatch, etc.) and then approved manually in our moderation queue. Auto-detected entries without human review are never included.",
        "",
        table,
        "",
        "`yarn test:config` passes.",
      ].join("\n");
      writeFileSync("tmp/pr.json", JSON.stringify({ fresh: fresh.map((c) => c.domain), alreadyUpstream, openPr, today, table, body, title: `Add ${fresh.length} phishing domains reported by Web3 Phish Guard (${today})` }, null, 2));
      console.log(g(`diff --stat HEAD~1`) || "(no diff)");
      if (dry) { console.log("\n--- DRY RUN: would push and open this PR ---\n"); console.log(body); }
    } else {
      // everything was already upstream: remember that so it is not re-checked every week
      writeFileSync("tmp/pr.json", JSON.stringify({ fresh: [], alreadyUpstream, openPr: null }, null, 2));
    }
  }
}

// ---- publish -------------------------------------------------------------------------------------
if (phases.includes("publish")) {
  if (!existsSync("tmp/pr.json")) { console.log("nothing prepared"); process.exit(0); }
  const pr = JSON.parse(readFileSync("tmp/pr.json", "utf8"));
  const state = loadState();
  for (const d of pr.alreadyUpstream ?? []) state.submitted[d] = { at: Date.now(), note: "already upstream" };
  if (pr.fresh.length) {
    const token = process.env.MM_PR_TOKEN || "";
    if (!token) { console.error("MM_PR_TOKEN not set"); process.exit(1); }
    g(`push -q https://x-access-token:${token}@github.com/${FORK}.git HEAD:${BRANCH}`);
    const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "w3pg-submit" };
    let prUrl;
    if (pr.openPr) {
      await fetch(`https://api.github.com/repos/${UPSTREAM}/issues/${pr.openPr.number}/comments`, { method: "POST", headers, body: JSON.stringify({ body: `Added ${pr.fresh.length} more on ${pr.today}:\n\n${pr.table}` }) });
      prUrl = pr.openPr.html_url;
    } else {
      const r = await fetch(`https://api.github.com/repos/${UPSTREAM}/pulls`, { method: "POST", headers, body: JSON.stringify({ title: pr.title, head: `${FORK.split("/")[0]}:${BRANCH}`, base: "main", body: pr.body, maintainer_can_modify: true }) });
      if (!r.ok) { console.error(`PR creation failed: ${r.status} ${await r.text()}`); process.exit(1); }
      prUrl = (await r.json()).html_url;
    }
    for (const d of pr.fresh) state.submitted[d] = { at: Date.now(), pr: prUrl };
    console.log(`submitted ${pr.fresh.length} -> ${prUrl}`);
  } else {
    console.log("nothing new for upstream");
  }
  writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
}
