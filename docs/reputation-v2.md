# DuskReputation policy v2 — canary scoring

Branch `reputation-v2`. Brings the on-chain reputation (contract + workflow) to the same
rules `/reputation` already uses, so a published score and the app's score can't disagree.

## What changed

**Scoring (one definition: `packages/core/src/canary-score.ts`)**

A seller starts at 100 and stays within 0–100:

| Finding | Kind | Points |
|---|---|---|
| Canary delivered on time | 4 | +10 |
| Canary delivered late | 3 | −10 |
| Empty answer, or claimed the canary and never delivered | 1 | −20 |
| Illegal: receipt contradicts the chain, or output is not what was committed | 2 | −50 |

- **Late is relative:** more than 2× the median latency of delivered canaries (all sellers),
  once there are 3 of them, never under 10 s. Latency is claim → receipt from Arkiv's own
  block stamps, not the worker's self-reported figure.
- **What an answer says is not judged.** Old `wrong-answer` verdicts count as nothing.
- **One finding per job, worst wins** (illegal > empty > late > pass). Needed because "late"
  is relative: a job on time today could be judged late later, and must not count both ways.
  A worse finding replaces a lesser one and takes back its points; a lesser one never
  replaces a worse one. Dismissed findings can't come back.

**Contract (`contracts/src/DuskReputation.sol`)**

- `SCORE_POLICY_VERSION = 2`. It refuses v1-formula scores and kinds outside 1–4.
- `Evaluation` and `Reputation` gain `late` and `passed`; new counters `lateOf`, `passedOf`.
- Per-job flags: kind *k* is bit `1 << (k−1)`, dismissed is that bit `<< 4` (v1 used `<< 2`).
- `evaluationState` returns `(badAnswers, illegal, late, passed, flags)`.
- `dismissFinding` accepts kinds 1–4.
- Findings that count towards "new misconduct after an appeal" are empty + illegal + late
  (passes never are).

**Workflow (`packages/ens/src/reputation-score.ts`, `packages/automation/src/collect.ts`)**

- Turns verdicts into kinds 1–4 with the shared rules, and replays the contract's
  worst-wins rule exactly (`applyFinding`) so the counts it submits are the ones the
  contract computes — otherwise the contract refuses the evaluation.
- A `no-delivery` verdict counts with no commit behind it (the seller never delivered).
- The collector reads each verdict's `check` and `latency_ms`. Arkiv returns `u64`
  attributes as hex strings (`'0x8ca0'`, measured live) — `u64Number` parses that.

**Mirror and app**

- The Arkiv mirror (`reputation_v1` kind) gains optional `late` and `passed` columns; older
  rows still decode. A mirror row with a forged late/pass count is rejected like any field.
- `/reputation` shows published late/pass counts when a verified checkpoint exists.

## Tests

- Foundry: **106/106** (21 for `DuskReputation`, including 5 new v2 tests). Fork tests not run.
- TypeScript: **1,701 passed**, typecheck clean.

## Deploying it — needs the operator keys

Nothing here has been deployed. These steps need the **namespace governance key**
(`ENS_OWNER_PRIVATE_KEY`, the `dusk.eth` owner) and the **workflow owner**:

1. `cd contracts && forge build && cd .. && npx tsx scripts/gen-ens-abi.ts`
2. `pnpm reputation:deploy` — dry run; read what it will send.
3. `pnpm reputation:deploy --yes --skip-name` — deploys v2, configures the policy, and
   **moves the controller's revoker role from the v1 contract to v2** (`setRevoker`).
   `--skip-name`: the operator name `revoker.dusk.eth` is still held by the v1 contract, and
   the script refuses to take it without a reviewed migration.
4. Put the new address in `config.json` → `ens.reputationAddress`, and in both templates.
5. `pnpm reputation:prepare` → new public workflow config; re-register the workflow under
   the workflow owner, then `pnpm reputation:deploy --yes --activate` with the forwarder and
   workflow ID in `config.json`.

**Things to know before switching**

- **v1 history does not migrate.** Counts live in the v1 contract; every seller starts v2 at
  100. That is the honest outcome — v1 counted "wrong answer" as bad, which v2 does not judge.
- **The trusted verifier must match** `reputation.verifiers` in `config.json` (currently
  `0x753C…7C60`, the key that signs canary verdicts).
- Until step 5, the app shows its own computed score; the published one stays on v1.
