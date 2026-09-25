# Soleil Mirror

A separate adversarial hedge lab for Soleil treasuries. Red search finds damaging SOL expiry scenarios; Blue optimization compares fresh executable devnet puts against a premium budget and loss target; an independent Auditor recomputes the result. The lab shows the fraction of a treasury that maker liquidity can actually cover, then hands one selected put to the existing wallet-gated devnet trade desk. It does **not** change the original `../soleil` app or program.

## Why it exists

An options ticket can tell a treasury *what* to buy. Mirror answers *whether that hedge survives the scenario it was bought for* and where the settlement assumptions break. Its unprotected and hedged outcomes share the same SOL price scenarios. The attack and defense searches are deterministic and reproducible; model-produced narration, when available, never supplies the payoff math. A larger simulated treasury is never presented as fully executable from a smaller maker quote.

## What the demo does

1. Enter a SOL treasury size, premium budget, and tolerated drawdown. Mirror uses a fresh SOL/USD reference and the existing Soleil maker gateway's **executable** 7, 10 or 14 day put asks. It states how much of the treasury the available quote can cover.
2. Run the adversarial search. Red evaluates severe downside, upside regret, and the quote-reserve boundary. Blue ranks size- and budget-matched puts by crash protection per premium and checks the target floor. The chart compares unprotected and protected expiry outcomes from the same price scenarios.
3. The independent Auditor recomputes premium, payoff, coverage, floor, and reserve requirements from the source quote. It flags when the contractual payout could require more pooled SOL than the quote itself reserves. The model never calls that a guaranteed settlement.
4. Review the chosen single-leg hedge in the wallet-gated devnet trade desk. Its graph exposes controls to refresh spot, change strikes, check market and quote accounts, and read the resulting on-chain position. The client re-fetches the quote and checks the market, wallet balance, and duplicate positions before the owner signs. Only a confirmed transaction produces a proof link.

The showcase path is a 0.1 SOL protective put for the next week. It selects an actual maker quote, shows a downside scenario and exact premium, and lets the user verify the market and quote accounts on devnet before choosing to sign. Mirror uses Soleil's dark and lavender visual theme while staying in this separate folder.

Microphone input uses browser speech recognition where available. Typed input always works. The browser can speak replies; ElevenLabs TTS takes over when its server-side credentials are configured and a request succeeds.

## Local run

```powershell
cd 'C:\Users\Debojyoti De Majumde\Downloads\soleilauto'
npm install
npm run agent
```

In another terminal:

```powershell
npm run dev
```

Open [http://127.0.0.1:4174/](http://127.0.0.1:4174/). This machine's `.env.local` already contains the public Soleil devnet program ID and RPC URL. For another machine, copy `.env.example` to `.env.local` and fill in `VITE_SOLEIL_PROGRAM_ID`. The agent proxies the maker gateway at `/api/quotes` through `SOLEIL_MAKER_QUOTES_URL` (default `http://127.0.0.1:8787/quotes`). Set `SOLEIL_LOCAL_GATEWAY_WORKSPACE` to the sibling Soleil folder to have the agent start and monitor its gateway automatically; otherwise run that gateway as a separate service. This machine is configured for automatic local startup. The gateway and program need maker funds and active on-chain quotes for execution. Missing liquidity blocks the order, visibly.

The app's **server** reads `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `SNOWFLAKE_TOKEN`, and `SNOWFLAKE_CORTEX_SEARCH_URL` from its environment. Never prefix secrets with `VITE_`. Without these keys, the capability strip labels the local parser, browser voice, and local trace. Merely configuring a key reads **READY**; **LIVE** appears only after a successful API response. The local parser keeps basic ordering usable when Gemini is unavailable.

## Snowflake evidence

The evidence panel searches Soleil product and architecture docs through a configured Cortex Search service. It is a separate research surface; a Snowflake failure never turns an unsafe quote into an executable one.

1. In Snowflake, create `SOLEIL_EVIDENCE` from [`snowflake/setup.sql`](snowflake/setup.sql), replacing `SOLEIL_SEARCH_WH` with your warehouse. The script also creates the Cortex Search service.
2. Generate inserts from the separate Soleil docs folder, then run them in Snowflake:

   ```powershell
   $env:SOLEIL_DOCS_BASE_URL='https://your-public-docs-domain'
   node scripts/build-evidence-sql.mjs 'C:\Users\Debojyoti De Majumde\Downloads\soleil docs' > snowflake/seed.sql
   ```

3. Set a Snowflake programmatic access token and the full `/api/v2/databases/.../cortex-search-services/SOLEIL_EVIDENCE_SEARCH:query` URL in the agent server environment. The server calls Cortex Search with a strict query length, selected public fields, a result limit of four, and no wallet data.

## Vultr deployment

The Dockerfile builds the web app, then serves the static site and agent API from one Node process on port 8788. Deploy that image to Vultr with HTTPS in front, the public program ID as a build arg, and server secrets as runtime environment variables. The maker gateway must be reachable from this service; for a public deployment, do **not** leave `SOLEIL_MAKER_QUOTES_URL` at localhost unless the gateway is in the same container/network.

```powershell
docker build --build-arg VITE_SOLEIL_PROGRAM_ID=YOUR_PUBLIC_DEVNET_PROGRAM_ID -t soleil-control-room .
docker run -p 8788:8788 -e SOLEIL_MAKER_QUOTES_URL=http://YOUR_GATEWAY:8787/quotes soleil-control-room
```

No Vultr instance, Snowflake service, Gemini key, or ElevenLabs key is provisioned by this repository alone. The current local demo runs with the real Soleil gateway and Solana devnet path; sponsor labels stay honest until those optional services answer.

## Verify

`npm run build`, `npm test`, and `npm run test:agent` cover the app and intent logic. In the browser, use the first suggested prompt or the Intent node's Route button; you should see Market Scout and Quote Router change status, five or another nonzero number of real maker matches, and a wallet-gated ticket. Select Solana executor → Check devnet accounts to inspect the real market and quote PDAs. Signing is a separate user wallet action.

Devnet only. This is a hackathon prototype, not a mainnet trading venue. The original Soleil client remains separate; `src/domain.ts`, `src/quotes.ts`, `src/settlement.ts`, and `src/solana.ts` are copies of its current instruction path and should be updated if the protocol changes.
