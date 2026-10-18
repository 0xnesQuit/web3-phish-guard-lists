# Web3 Phish Guard lists

Machine-generated data files consumed by the Web3 Phish Guard browser extension: brand -> official domain mappings (DefiLlama, CoinMarketCap, OpenSea), bait-word, free-host, TLD and trusted-infrastructure lists. Refreshed daily by a GitHub Action. JSON only, no code.

## Upstream submissions (MetaMask)

`.github/workflows/upstream.yml` runs every Monday and opens (or extends) a PR against
[MetaMask/eth-phishing-detect](https://github.com/MetaMask/eth-phishing-detect) from the fork
`0xnesQuit/eth-phishing-detect`, branch `w3pg-submissions`. Only domains a human approved in the
moderation panel are sent; AI auto-listed domains never are. Domains MetaMask already has are skipped,
and their `yarn test:config` must pass or nothing is submitted. `data/upstream-submitted.json` remembers
what was sent.

Secrets: `ADMIN_TOKEN` (same value as the Worker's admin token, for `/admin/export`) and `MM_PR_TOKEN`
(classic PAT with `public_repo`, to push to the fork and open the PR). Without them the job skips.
Dry run locally: `YARN="npx -y yarn@1" node scripts/submit-upstream.mjs --dry-run` with a sample export in `tmp/export.json`.
