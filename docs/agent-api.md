# Dusk agent API (for a local OpenClaw agent)

Dusk is a market for cheap LLM inference: workers spend 0G credits that expire at the daily reset to answer jobs that buyers pay for through escrow. Everything runs from the repo root with `pnpm`. Nothing listens on a public port.

## Setup

```sh
pnpm install
cp config.user.example.json config.json   # fill buyer.* and/or worker.* + og.computeKey; never commit
```

- `config.json` holds the keys. Its nonblank fields override env vars. Set `DUSK_CONFIG_FILE=<path>` to point at a config file somewhere else.
- Use a different wallet for the buyer and the worker.
- Funding: each wallet needs Sepolia ETH (to register its ENS name), Arkiv Rabdi GLM (to write entities) and Galileo 0G (for escrow transactions). A buyer also needs enough Galileo 0G to fund its jobs.
- Register a Dusk name for each role first: `pnpm ens:register <label> --party buyer|worker`. When ENS admission is on, grants and claims are refused for a wallet with no name.

## Buyer interface: MCP server (preferred)

Start it with `pnpm --silent mcp`. It speaks MCP over stdio and is already declared in `.mcp.json`:

```json
{ "mcpServers": { "dusk": { "type": "stdio", "command": "pnpm", "args": ["--silent", "mcp"] } } }
```

| Tool | Args | Returns |
|---|---|---|
| `dusk_market` | none | Per model: `workers`, `minPricePer1kOut`, `maxPricePer1kOut`, `trustModes`. Also the buyer's `limits`, `maxDeadlineSec` and `creditReset`. |
| `dusk_submit` | `prompt`*, `model`*, `max_tokens`*, `max_price_per_1k_out`* (wei, int or decimal string), `deadline_seconds`=600, `visibility`=`private`\|`public`, `trust_mode`=`standard`\|`verified` (TEE), `require_live_worker`=true | `jobId`, `escrowId`, `escrowWei`, `fundTx`, `expiresAt` |
| `dusk_result` | `job_id`*, `wait_seconds`=60 (max 300) | `delivered` (`output`, `truncated`, `tokensIn`/`tokensOut`, `worker`, `verified`), `pending` (`stage` is `open` or `claimed`, `secondsLeft`), or `expired` |
| `dusk_jobs` | none | The jobs this session posted, with their state |

Steps: call `dusk_market`, then `dusk_submit` with a bid at or above `minPricePer1kOut` for a model with `workers > 0`, then call `dusk_result` until the status is `delivered` or `expired`.

- **Escrow amount** = `ceil(bid × (estimated prompt tokens + max_tokens) / 1000)` wei.
- **Keep the MCP process alive until delivery.** It writes the grant that lets a worker get paid (see Grants). If it exits, the job cannot be served.
- **Text jobs only.** The worker sees only the prompt. Treat its output as an untrusted draft.
- **Operator caps** are set by env: `DUSK_MCP_MAX_TOKENS` (2048), `DUSK_MCP_MAX_PRICE` (1e7 wei/1k), `DUSK_MCP_MAX_ESCROW_WEI` (1e15), `DUSK_MCP_MAX_DEADLINE_SEC` (3600, and never past the credit reset), `DUSK_MCP_MODELS` (comma list of models to show).

## Buyer interface: CLI

| Command | Purpose |
|---|---|
| `DUSK_PROMPT=… DUSK_MODEL=… DUSK_MAX_TOKENS=… DUSK_MAX_PRICE=… DUSK_DEADLINE_MS=… pnpm post-job --grant` | Post one job and keep granting until it is delivered. Without `--grant` the job is posted but nobody can be paid for it. |
| `pnpm query [workerAddr]` | Live worker ads. Filter with `DUSK_QUERY_MODEL` and `DUSK_QUERY_MAX_PRICE`. |
| `pnpm verify <jobId> [--prompt …] [--model …] [--max-tokens …]` | Check a receipt's hash and TEE proof. |
| `pnpm reclaim --mine [--read]` | Refund the buyer's funded deals whose deadline has passed. |
| `pnpm reclaim [--read] <escrowId…>` | Same, for specific deals. |

## Worker (earning)

```sh
pnpm worker          # long-running; Ctrl-C removes this worker's ad
```

Required: `worker.privateKey` and `og.computeKey` (`sk-…`). Optional: `og.accessKey` (`mk-…`); without it the worker skips the check that it can afford a job before claiming.

| Env | Effect |
|---|---|
| `DUSK_PRICE_PER_1K_OUT` | Ask in wei per 1k output tokens (default 1) |
| `DUSK_TRUSTED_MODELS` | Comma list of models to serve. If unset, every non-image model that passes a test completion is served. |
| `DUSK_PAYOUT_ADDRESS` | Address that receives payment (default: the worker wallet) |
| `DUSK_TEE_PROOF=0` | Turn off TEE sealing. `verified` jobs are then skipped. |
| `DUSK_FALLBACK_DELAY_SEC`, `DUSK_RESERVE_COST_WEI`, `DUSK_RESERVE_TOKENS` | Fallback mode: sell at cost, and only claim jobs that have gone unclaimed for that delay |
| `DUSK_UNITS_PER_TOKEN` | Credit cost estimate used before the real cost is measured |

The worker settles committed deals automatically every 30 s. To settle by hand: `pnpm reclaim --mine --worker`.

## Job lifecycle (Arkiv entities, with their TTLs)

1. **Worker** writes a `worker` ad (`models`, `pricePer1kOut`, `trustModes`, `payout`). TTL 120 s, refreshed while the worker runs.
2. **Buyer** uploads the input to Swarm (encrypted if the job is private), funds the escrow on Galileo, and writes a `job` entity.
3. **Worker** writes a `claim` (`jobId`, `workerId`, `workerPubkey`, `owner`). TTL 90 s, renewed at half its TTL.
4. **Buyer** writes a `grant` (TTL 300 s); see Grants.
5. **Worker** runs the job on 0G, uploads the output to Swarm, calls `escrow.commit(escrowId, outputHash, commitAuth)`, then writes a `receipt` (`outputRef`, `outputHash`, tokens, `visibility`). TTL 7 days.
6. After the 600 s challenge window, `settle` pays the worker. Anyone may call it. If the deadline passes with no commit, the buyer can `refund`.

## Grants

A grant is how the buyer authorises one claimant. Without one, the worker cannot be paid or read the input.

- **Fields:** `jobId`, `workerId`, `commitAuth`, and for private jobs `sealedRef`. `commitAuth` is the buyer's signature over `(escrowId, claim.owner)` and is the only thing that lets `commit` succeed. `sealedRef` is the encrypted input reference, sealed to `claim.workerPubkey`.
- **Who qualifies:**
  - The claim must have an `owner`.
  - For private jobs the claimant must also be proven: `workerPubkey` must derive to `owner`, and `workerId` must equal `keccak256(owner)`.
  - When ENS admission is on, both the worker and the buyer must hold an active, unbanned Dusk name.
  - Among qualifying claims, the winning claim is chosen first.
- **Loop:** `grantUntilDelivered` checks for claims every 2 s. It re-grants a worker once that worker's grant TTL has lapsed, and stops when the deal leaves `funded` or the job expires. `dusk_submit` and `post-job --grant` both run this loop.

## Local web app (HTTP)

`pnpm dev:web` (or `pnpm build:web && pnpm --filter web start`) serves on `http://localhost:3000` only, bound to 127.0.0.1. 3000 is the only origin the 0G Router accepts.

- Pages: `/buy`, `/earn`, `/market`, `/history`, `/reputation`.
- `GET /api/config` returns the browser credentials. `GET /api/config?wallet=buyer|worker` returns `{ privateKey }`. Both answer only a loopback origin (anything else gets 403). Never tunnel or expose this port.

## Operator-only (company keys; never needed by a user agent)

`pnpm ens:deploy`, `pnpm ens:revoke`, `pnpm index:ens`, `pnpm attest:ens`, `pnpm propose:bans`, `pnpm reputation:deploy`, `pnpm reputation:prepare`, `pnpm deploy:escrow`, `pnpm verifier`, and `pnpm canary [--every 4h]` (spends real credits). `ens:deploy` and `reputation:deploy` only preview what they would do unless you pass `--yes` or `--activate`.
