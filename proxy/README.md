# Dusk OpenAI-compatible proxy

Point any OpenAI client at Dusk. Each request is posted as a Dusk job from the buyer wallet in
`config.json` / `.env`. The proxy escrows payment, authorises whichever worker claims the job,
then verifies the delivered output against the hash committed on chain before returning it.

From the repo root, after `pnpm install` and filling `buyer.*` in `config.json`:

```sh
pnpm exec tsx proxy/src/main.ts   # http://127.0.0.1:8787/v1
```

Keep it running until your requests return. While a job is open, the proxy writes the grant
that lets a worker get paid, so stopping it strands open jobs. Reclaim their escrow with
`pnpm reclaim --mine` once the deadline passes.

```sh
curl http://127.0.0.1:8787/v1/models
curl http://127.0.0.1:8787/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"0gm-1.0-35b-a3b","max_tokens":512,"messages":[{"role":"user","content":"What is the capital of France?"}]}'
```

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="unused-unless-DUSK_PROXY_API_KEY-is-set", timeout=900)
r = client.chat.completions.create(model="0gm-1.0-35b-a3b", messages=[{"role": "user", "content": "Summarise: ..."}])
```

Answers are slow (a few seconds to minutes) because each request is a market job, so give the
client a long timeout. Some models (for example `0gm-1.0-35b-a3b`) return their reasoning as part
of the reply, and that reasoning counts against `max_tokens`, so leave headroom.

## Endpoints

| Route | Notes |
| --- | --- |
| `GET /v1/models` | Models with live workers (or listed in `DUSK_PROXY_MODELS`), with their asks under `dusk`. |
| `POST /v1/chat/completions` | `stream: true` works, but the whole answer arrives in one chunk once a worker delivers. Until then the proxy sends SSE keep-alive comments. |
| `POST /v1/completions` | Legacy text completions, one prompt per request. |
| `GET /health` | Needs no auth. |

## Pricing

The bid is set per 1k output tokens, in wei. The first of these that is set wins:

1. `max_price_per_1k_out` in the request body, or the `X-Dusk-Max-Price` header
2. `DUSK_PROXY_PRICE`
3. **Automatic:** the proxy fetches the live worker ads for the model and bids the **highest** ask,
   so every provider can take the job. In `verified` trust mode it only counts TEE-capable workers.
   If the highest ask is above the `DUSK_PROXY_MAX_PRICE` cap, the proxy bids the cap instead,
   which still reaches every worker asking at or below it.

Every response carries `x-dusk-bid`, `x-dusk-bid-source` (`request` / `env` / `market-max`),
`x-dusk-job-id` and `x-dusk-max-tokens` headers, plus a `dusk` object in the body.

## Request mapping

- A Dusk job is one prompt string, so a single user message is sent as is. A system message
  plus one user message becomes `Instructions: … + prompt`. Multi-turn chats are flattened into a
  `User: / Assistant:` transcript.
- Images are supported as base64 `data:` URLs (PNG/JPEG/WebP). Workers cannot fetch remote URLs.
- `max_tokens` / `max_completion_tokens` above the operator cap are clamped, not rejected. A
  clamped answer can come back with `finish_reason: "length"`.
- Ignored: `temperature`, `top_p`, `stop` and other sampling options, because workers do not
  take them. Rejected: `tools`, `functions`, `n > 1`.
- Extra body fields: `deadline_seconds`, `visibility` (`private` | `public`) and
  `trust_mode` (`standard` | `verified`).

## Errors

The proxy returns OpenAI-shaped `{"error": {...}}` bodies:

- `400`: a bad request, or a bid under every ask. Nothing is posted.
- `401`: a missing or wrong API key.
- `503 no_worker`: nobody serves the model. Nothing is posted.
- `502`: a market or posting failure.
- `504 job_expired`: no delivery before the deadline. The escrow is refundable with
  `pnpm reclaim --mine`.

## Configuration (env)

| Var | Default | |
| --- | --- | --- |
| `DUSK_PROXY_HOST` / `DUSK_PROXY_PORT` | `127.0.0.1` / `8787` | Binding off loopback requires `DUSK_PROXY_API_KEY`. |
| `DUSK_PROXY_API_KEY` | unset | When set, requests need `Authorization: Bearer <key>`. |
| `DUSK_PROXY_PRICE` | unset (auto) | Fixed bid in wei per 1k output tokens. |
| `DUSK_PROXY_DEFAULT_MAX_TOKENS` | `1024` | Used when the request has no `max_tokens`. |
| `DUSK_PROXY_DEADLINE_SEC` | `600` | Default job deadline. |
| `DUSK_PROXY_VISIBILITY` / `DUSK_PROXY_TRUST_MODE` | `private` / `standard` | |
| `DUSK_PROXY_MAX_TOKENS`, `DUSK_PROXY_MAX_PRICE`, `DUSK_PROXY_MAX_ESCROW_WEI`, `DUSK_PROXY_MAX_DEADLINE_SEC`, `DUSK_PROXY_MODELS` | same as the MCP server's `DUSK_MCP_*` | Operator caps. Defaults: 2048 tokens, 10,000,000 wei/1k, 10^15 wei/job, 3600 s. |

The job, escrow and verification logic is shared with the MCP server (`mcp/src/service.ts`), so
both behave the same way.
