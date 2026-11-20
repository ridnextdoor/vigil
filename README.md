# Vigil

Two read-only tools in one project. **Neither can send a transaction**: there is no wallet, private key or order code.

1. **Wallet tracker** (`npm start`): follows one Solana wallet's pump.fun memecoin trades and shows its activity and habits.
2. **Paper trader** (`npm run paper`, or `npm run demo` for fake launches): simulates a launch-sniping strategy. See the end of this file.

## Wallet tracker

```
npm install
npm start
```

Open http://127.0.0.1:3000. The wallet defaults to `STorreSu8X6yPLmiEScNHSGDinqV7j84hWjmvH9SPwk`.
To track another wallet: `npm start -- --wallet <address>`.

### Load history from a Solscan export

On Solscan, open the wallet, go to the DeFi Activities tab, export the CSV, then:

```
npm start -- --import "C:\path\to\export.csv"
```

Trades are saved to `data/wallet-trades.jsonl`, so you only import once. Importing the same file again adds nothing new.
This project already includes the history from the export you gave me, so the dashboard opens with data.

### Follow the wallet live

Copy `.env.example` to `.env`, put a Solana RPC **websocket** URL in `RPC_WS_URL` (Helius, QuickNode and others
have free tiers), and run `npm start`. The tracker then:

- loads the wallet's last 50 transactions (change with `BACKFILL=100` in `.env`),
- picks up each new transaction as it lands,
- records token age and current liquidity for each trade,
- shows the wallet's SOL balance.

### What the dashboard shows

- Recent activity: each buy and sell, size, market cap implied by the trade's price, token age, liquidity.
- Tokens traded: per token, all buys and sells combined, cost, proceeds, PnL and hold time.
- Behavior patterns: typical entry market cap, hold-time and entry-size distributions, how often it adds to a position,
  win rate, average win and loss, activity over time.

### How trades are read, and the limits

- A buy or sell is a change in the wallet's balance of a pump.fun token. The value is the opposite change in
  its SOL and stablecoins. Routing through other tokens does not matter.
- Values are **estimates in USD** and include network fees and tips. PnL covers only tokens fully sold within the data.
- Tokens the wallet bought before your data starts are listed but left out of PnL.
- Not tracked: holder count, bundlers, dev holding at the time of each buy. These need an indexer API.
- **The live feed has not been tested against the real network** (my workspace cannot reach Solana). The transaction
  parser is unit-tested on built transactions, and the CSV import was run on a real export. Expect to debug the live
  connection on first run.

## Auto-update on GitHub (works while your PC is off)

A scheduled GitHub job checks the wallet about every 10 minutes, saves new trades, and republishes the dashboard as a
web page at `https://<your-username>.github.io/<repo-name>/`.

### One-time setup

1. **Make a free RPC URL.** Sign up at Helius (or QuickNode), create a key, and copy the **HTTPS** URL (not the wss one).
   Treat it like a password.
2. **Create a GitHub repository.** Make it **public**: GitHub Pages and the free Actions minutes are only included
   for public repositories on the free plan. Nothing secret is in the project, and the wallet's trades are public on-chain anyway.
3. **Upload this project.** In a terminal in the folder that contains `package.json`:
   ```
   git init
   git add .
   git commit -m "Vigil"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
   git push -u origin main
   ```
   (`.env` is excluded automatically, so your key is not uploaded. GitHub Desktop works too.)
4. **Add your RPC URL as a secret.** Repository > Settings > Secrets and variables > Actions > New repository secret.
   Name: `RPC_URL`. Value: the HTTPS URL from step 1.
5. **Turn on Pages.** Repository > Settings > Pages > Source: **GitHub Actions**.
6. **Run it once.** Actions tab > "Update wallet data" > Run workflow. After a minute or two the page is live.

Optional repository variables (same Settings page, Variables tab): `TRACK_WALLET` to track a different wallet,
`SOL_USD` to set the SOL price used for USD estimates, `KEEP_DAYS` for how many days of trades to keep (default 14).

### How it works

- Each run restores saved trades, fetches transactions newer than the last run (`npm run sync`), saves them, rebuilds
  the page (`npm run build-site`) and deploys it.
- Trades are stored on a branch called `data` that is **replaced** every run, so the repository does not grow.
- The first run starts from the history included in this project (`data/wallet-trades.jsonl`), then looks at the
  wallet's latest 1,000 transactions. If more than about 1,000 transactions happened between your CSV export and the
  first run (roughly two hours for this wallet), trades in that gap are missed. Re-import a newer CSV before pushing to avoid that.

### Limits to know about

- GitHub's schedule is not exact: runs can start several minutes late, so this is near-real-time, not instant.
- Scheduled workflows in public repositories pause after 60 days without repository activity. If updates stop,
  open the Actions tab and re-enable the workflow.
- Each run makes a handful of RPC calls (one per new transaction), well inside free tiers at this wallet's pace.
- Token age is recorded on the GitHub version. Liquidity is not, because it is only meaningful at the moment of a trade.
- **Not tested here:** the real GitHub run. I tested the sync against a mock RPC server, the page build on your real data,
  and the workflow file's syntax. Expect to fix small things on the first run, and tell me what the Actions log says.

## Paper trader

`npm run demo` runs it on synthetic launches (results mean nothing). With `RPC_WS_URL` set, `npm run paper` runs it on real
launches with simulated fills: real bonding-curve pricing, 1% fee, tips and a 400 ms landing delay. Rules are in
`src/config.ts`. It has its own dashboard on the same port, so run only one tool at a time.

## Tests

`npm run selftest`
