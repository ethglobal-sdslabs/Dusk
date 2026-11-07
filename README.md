# Dusk

The market for compute that expires tonight.

Holders of 0G compute credits that reset daily run workers that serve LLM jobs for a small bid,
instead of letting the credits lapse. Buyers post a prompt with a bid; payment sits in escrow on
0G Galileo, the job and receipt live on Arkiv, and the delivered output is checked against the
hash the worker committed on chain before it is released. Participants are identified by
`*.dusk.eth` names on Sepolia, and an on-chain reputation score is built from canary jobs.

## Layout

| Path | What it is |
| --- | --- |
| `apps/web` | Next.js app: buy, earn, market, history, reputation |
| `worker` | Worker that claims jobs and serves them with 0G inference |
| `mcp` | MCP server so agents can buy inference (`dusk_market`, `dusk_submit`, `dusk_result`, `dusk_jobs`) |
| `proxy` | OpenAI-compatible proxy over the market (see [`proxy/README.md`](proxy/README.md)) |
| `contracts` | Solidity: escrow, admission, ENS identity controller, reputation (Foundry) |
| `packages/*` | Shared libraries: core, escrow, arkiv, og, ens, swarm, crypto, signer, buyer, automation |
| `scripts` | Deploy, demo, canary, verifier bot and probe scripts |
| `docs` | [Agent API](docs/agent-api.md), [reputation v2](docs/reputation-v2.md) |

## Quick start

```sh
pnpm install
cp config.user.example.json config.json   # fill buyer.* and/or worker.* + og.computeKey; never commit
pnpm ens:register <label> --party buyer   # or --party worker
pnpm dev:web
```

Use separate wallets for buying and earning. Each wallet needs Sepolia ETH (ENS name), Arkiv
Rabdi GLM (writes) and Galileo 0G (escrow); a buyer also needs Galileo 0G to fund jobs.

## Common commands

```sh
pnpm worker                       # serve jobs with your 0G credits
pnpm --silent mcp                 # MCP server for agents (declared in .mcp.json)
pnpm exec tsx proxy/src/main.ts   # OpenAI-compatible API at http://127.0.0.1:8787/v1
pnpm post-job                     # post a job from the CLI
pnpm reclaim --mine               # reclaim escrow from expired jobs
pnpm demo                         # end-to-end demo
pnpm test && pnpm typecheck
```

## License

[MIT](LICENSE)
