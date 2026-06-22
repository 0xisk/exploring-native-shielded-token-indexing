# Midnight ShieldedFungibleToken — indexer-view reproducer

A self-contained TypeScript project that, with **one command**, deploys a
shielded token on a local Midnight v8 stack, mints it, burns part of it, and
**decodes every raw transaction** to show exactly what a public observer (the
chain indexer) can and cannot see.

It uses OpenZeppelin's `ShieldedFungibleToken.compact` as the example contract.
The compiled contract + ZK keys are vendored, so no Compact compiler is needed:
`install` then `run`.

```
deploy ──▶ mint (1,000,000) ──▶ burn (400,000, change 600,000) ──▶ decode all 3 txs ──▶ out/INDEXER-VIEW.md
```

## TL;DR — can you hide the burnt amount of a shielded token?

**Yes, but only if you burn *outside* the contract.** A contract-mediated burn
always reveals the amount to the indexer. A direct wallet → burn-address Zswap
transfer hides it inside a Pedersen commitment. We proved both ends on a live
local v8 stack and decoded the raw bytes.

| | Mint (via contract) | Contract `burn` | Direct wallet burn |
|---|---|---|---|
| Path | `mint` circuit | `burn` circuit | plain Zswap transfer to the zero coin key |
| Amount visible to indexer | **yes** (`shieldedMints` effect) | **yes** (`disclose`d into the public VM transcript) | **no** (only a Pedersen commitment) |
| Coin owner / recipient | hidden | hidden | hidden |
| Contract can count it (`totalBurned`) | n/a | yes | **no** (invisible to the contract) |
| `disclose` required in Compact | yes | yes | n/a (no contract code runs) |

**Why a contract can't hide it.** Spending or receiving a shielded coin inside a
contract (`receiveShielded`, `sendImmediateShielded`, `sendShielded`) builds a
public commitment/nullifier from the coin and writes its value into the public VM
transcript. The Compact compiler *forces* `disclose` on all three. Removing the
total-supply counter does not change this. We tried, and it fails to compile with
53 disclosure errors (see
[the experiment below](#experiment-can-removing-total-supply-let-us-drop-disclose-from-burn)).

**The trade-off.** A hidden burn never touches the contract, so `totalBurned` can
only ever be a lower bound on circulating supply.

Evidence: [`out/HIDDEN-BURN-VIEW.md`](./out/HIDDEN-BURN-VIEW.md) (amount hidden,
`pnpm hidden-burn`) vs [`out/INDEXER-VIEW.md`](./out/INDEXER-VIEW.md) (contract
burn, amount leaks, `pnpm reproduce`).

## Supply auditability: does the fold match the contract counter?

A second question: can a public indexer **recompute** a shielded token's supply,
and does it agree with the contract's own `totalSupply()` counter? `pnpm
verify-supply` runs one stack through deploy → mint → contract burn → hidden burn
→ protocol burn and, after each step, compares three numbers:

- **contract `totalSupply()`** — the contract's own counter (a ledger cell),
- **fold `−Σ deltas[tt]`** — what an indexer recomputes from public zswap deltas,
- **true circulating** — what is actually spendable, by construction of the run.

| Step | tx `delta[tt]` | fold `−Σδ` | contract `totalSupply()` | true circulating |
|---|---|---|---|---|
| mint 1,000,000 | −1,000,000 | 1,000,000 | 1,000,000 | 1,000,000 |
| contract burn 400,000 | 0 | **1,000,000** | 600,000 | 600,000 |
| hidden burn 200,000 | 0 | **1,000,000** | 600,000 | 400,000 |
| protocol burn 400,000 | **+400,000** | 600,000 | 600,000 | 0 |

All rows verified **PASS** on a live stack. Three findings:

1. **Supply = `−Σ deltas[tt]`.** After the mint, the indexer fold equals the
   minted amount. (The `shieldedMints` effect carries the mint amount too — but
   keyed by a *different* token type than the zswap color; see note below.)
2. **A "protocol burn" is public and real.** A hand-built one-input / zero-output
   zswap offer (a positive imbalance) is *accepted* by the node; the surplus is
   destroyed and the burned amount is plaintext in `deltas[tt] = +P` — no contract
   call, no record of who. This is the one burn the fold actually sees.
3. **Dead-coin burns are invisible to the fold.** Both the contract burn and the
   hidden burn leave the coin sitting in the pool (net delta 0), so the fold stays
   at 1,000,000 while the contract counter and the real circulating supply move.
   Neither the fold nor `totalSupply()` tracks real circulating supply — each is an
   upper bound that misses a *different* set of burns.

> **Two token-type keys.** `rawTokenType(domain, contractAddress)` equals the coin
> **color** (the zswap delta key). The `shieldedMints` mint effect is keyed by a
> separate derived value. The supply fold keys on the color; the mint cross-check
> sums `shieldedMints`. The report prints both.

Output: [`out/SUPPLY-AUDIT.md`](./out/SUPPLY-AUDIT.md) (committed sample:
[`SAMPLE-SUPPLY-AUDIT.md`](./SAMPLE-SUPPLY-AUDIT.md)).

## Proof: `totalSupply()` can't see an off-circuit burn

A focused, single-claim proof of the ERC20 analogy: in ERC20, `transfer(0x…dead,
x)` removes `x` from circulation but never moves `totalSupply` (only `burn()`
does). A shielded token is the same. `pnpm prove-supply-gap` runs one stack
through deploy → mint `M` → **send `B` to the burn address with a plain wallet
transfer (no contract call)** and reads the contract's `totalSupply()` before and
after:

| | contract `totalSupply()` | truly circulating | gap |
|---|---|---|---|
| after mint M = 1,000,000 | 1,000,000 | 1,000,000 | 0 |
| after sending B = 400,000 to burn address | **1,000,000** | 600,000 | **400,000** |

The counter does not move, yet `B` tokens are now provably unspendable. The
script asserts six facts and writes a PASS/FAIL verdict:

- **A1** `totalSupply()` reads `M` after the mint.
- **A2** the burn tx makes **0** `ContractCall`s (the contract is never invoked).
- **A3** `totalSupply()` is **unchanged** after the burn.
- **A4** the burn's net zswap `delta[tt]` is **0** — the coin stays in the pool as
  a dead coin, so an indexer's `−Σ deltas` fold is blind to it too.
- **A5** that fold still reads `M` (both public measures overstate).
- **A6** the supply gap equals exactly `B`.

**Why the tokens are gone.** The burn address is the all-zero coin public key.
Spending a coin needs the coin secret key for its coin public key; no secret key
is known for the zero key, so the coin can never be spent. (The output reuses our
*encryption* key, which only governs who can detect/decrypt the output, never who
can spend it — so the wallet still *sees* a coin it can never move.)

**Conclusion: a shielded token's `totalSupply()` is an upper bound on circulating
supply, not an exact measure.** Output:
[`out/SUPPLY-GAP-PROOF.md`](./out/SUPPLY-GAP-PROOF.md) (committed sample:
[`SAMPLE-SUPPLY-GAP-PROOF.md`](./SAMPLE-SUPPLY-GAP-PROOF.md)). Tune with `MINT_AMOUNT`
(`M`) and `BURN_AMOUNT` (`B`, sent off-circuit; must be ≤ `M`); `SOFT_ASSERT=1`
keeps the run from exiting non-zero on a failed assertion.

## Prerequisites

- **Docker** running (the script brings up node + indexer + proof-server as
  containers on random host ports via testcontainers).
- **Node.js >= 20**.
- **pnpm** (or npm). All dependencies come from the **public npm registry** —
  no private registry, no auth token. The `@midnight-ntwrk/*` packages
  (ledger-v8, testkit-js, midnight-js-*, wallet-sdk, compact-js,
  compact-runtime) are published there.
- ~3 GB free disk for Docker images (proof-server, indexer, node) on first run,
  plus the 24 MB of ZK keys vendored in this repo.

## Quick start

```bash
pnpm install
pnpm reproduce
```

(or `npm install && npm run reproduce`)

Other entry points (same vendored contract + local stack):

```bash
pnpm hidden-burn      # mint via contract, then burn outside it (amount stays hidden)
pnpm verify-supply    # the supply-auditability scenario (5 steps, PASS/FAIL matrix)
pnpm prove-supply-gap # proof: totalSupply() can't see an off-circuit burn-address transfer
```

If testkit's container log-wait is flaky in your environment (it can report
"Log stream ended … Started not received" within ~1s on a healthy stack), run the
self-managed variants instead, which bring the stack up with plain `docker compose`:

```bash
bash scripts/run-hidden-burn.sh      # -> pnpm hidden-burn
bash scripts/run-verify-supply.sh    # -> pnpm verify-supply
bash scripts/run-prove-supply-gap.sh # -> pnpm prove-supply-gap
```

The first run pulls the Docker images (a few minutes). A full run takes roughly
8–12 minutes: container startup, wallet sync, then one ZK proof per transaction.
When it finishes you get a summary like:

```
DONE. Summary:
  contract : c6d82f32118e89bb562dc085458358d367b8a2651433888844d60dc5ffcedd60
  tx #1 deploy  15313 bytes  f28df45643f65aeb81356bf412182124469ed70adb606efe43f7041d58a1efa1
  tx #2 mint    14415 bytes  d725650e4ce26cf4032ba37e9762a01e21203b71415f5445ced9e81596299f36
  tx #3 burn    44295 bytes  579cc29ccdc4563cc51a9d7459f5df81871f6a31ce7f97d886ffabdca3175a85
  minted 1000000, burned 400000, change 600000
  report : .../out/INDEXER-VIEW.md
```

(Addresses and hashes differ every run — the contract uses a random nonce/domain;
byte sizes are roughly stable.) A committed example of the generated report is in
[`SAMPLE-OUTPUT.md`](./SAMPLE-OUTPUT.md).

## What you get (in `out/`)

| File | Contents | Written by |
|---|---|---|
| `INDEXER-VIEW.md` | Per-tx public view + a public-vs-hidden summary | `reproduce` |
| `HIDDEN-BURN-VIEW.md` | The direct (amount-hidden) burn, decoded | `hidden-burn` |
| `SUPPLY-AUDIT.md` | Supply PASS/FAIL matrix + per-tx delta fold + protocol-burn finding | `verify-supply` |
| `SUPPLY-GAP-PROOF.md` | Before/after `totalSupply()` + six assertions proving an off-circuit burn is invisible | `prove-supply-gap` |
| `<n>-<kind>.hex` | The exact raw bytes submitted on-chain (deploy/mint/burn/hidden-burn/protocol-burn/off-circuit-burn) | all |
| `*.decode.txt` | Full structured decode of each tx (transcript effects, Zswap offers, ledger dump) | all |

Re-decode any captured tx on its own:

```bash
pnpm decode -- out/3-burn.hex      # or: npx tsx src/decode.ts out/3-burn.hex
```

## What's public vs hidden (the point of this repo)

Decoding the raw bytes shows what an indexer ingests. For this archived
`ShieldedERC20`:

| Always public | Always hidden |
|---|---|
| Contract address + entry point (`mint` / `burn`) | Coin owners / recipient public keys |
| Token color (type) | Which output commitment belongs to whom |
| New coin commitments, spent-coin nullifiers | The value sealed inside a commitment |
| Public VM transcript + gas | Dust balance (only a nullifier + commitment) |
| A ZK proof is attached | What the proof proves |

**Amount visibility depends on the circuit.** In this contract:

- **mint** publishes the amount in the transcript's `shieldedMints` effect.
- **burn** calls `disclose(coin)` / `disclose(amount)`, so the coin value
  (1,000,000) and change (600,000) appear as literals in the public transcript —
  the burned amount (400,000) is therefore derivable.

So both mint and burn leak the *amount* here; only the coin *owners* stay
hidden. A future amount-private burn would need to avoid disclosing the coin
value and change to the public transcript.

## Experiment: can removing total supply let us drop `disclose` from burn?

Short answer: **no.** The `disclose` on the burn is not there for the supply
counter. It is forced by the shielded coin operations themselves.

Reproduce it with a tiny standalone probe,
[`contracts/experiments/disclose-probe.compact`](./contracts/experiments/disclose-probe.compact),
which calls each coin spend/receive primitive on a witness value (a circuit
parameter) WITHOUT `disclose`, using the normal compact command:

```bash
pnpm compile:disclose-probe
# = compact compile +0.31.0 --skip-zk contracts/experiments/disclose-probe.compact build/disclose-probe
```

The compiler **rejects** it (`exit 255`). All three coin spend/receive
primitives fail the same way — `receiveShielded`, `sendImmediateShielded`, and
`sendShielded`:

```
Exception: disclose-probe.compact line 19 char 3:
  potential witness-value disclosure must be declared but is not:
    witness value potentially disclosed:
      the value of parameter coin of exported circuit probeReceive
    nature of the disclosure:
      the call to standard-library circuit receiveShielded might disclose a link between a
      coin receive and the coin with the commitment given by a hash of the witness value

Exception: disclose-probe.compact line 27 char 3:
    witness value: parameter coin of circuit probeSendImmediate
    nature of the disclosure:
      the call to standard-library circuit sendImmediateShielded might disclose a link between
      a claim of nullifier and the coin with the nullifier given by a hash of the witness value

Exception: disclose-probe.compact line 35 char 3:
    witness value: parameter coin of circuit probeSendShielded
    nature of the disclosure:
      the call to standard-library circuit sendShielded might disclose a link between a claim
      of nullifier and the coin with the nullifier given by a hash of the witness value
```

The same holds inside the real `ShieldedERC20.burn`: removing `_totalSupply`
(the ledger field, its `totalSupply()` circuit, and the `_totalSupply = …`
writes) and then dropping `disclose` from the coin ops makes it fail to compile
with 53 such disclosure errors. The committed `contracts/` are left as the
working originals; only the standalone probe is kept, as a minimal repro.

**Why.** Spending or receiving a shielded coin inside a contract produces a
public commitment and nullifier that are a hash *of the coin* — including its
value. The compiler makes you `disclose` that the public commitment/nullifier is
derived from the (private) coin. And the operation writes the coin value into
the public VM transcript regardless: in the baseline burn the *change*-send
carries no `disclose` yet `600000` still shows up as a literal. So in any
contract-mediated burn the amount is public. **Total-supply accounting is
irrelevant to it.**

**The only way to hide a burnt amount** is to burn *outside* the contract: a
plain wallet → burn-address Zswap transfer, where the value lives only inside a
Pedersen commitment (hidden, like any user-to-user transfer). The trade-off is
that the contract can no longer see or count it. `src/hidden-burn.ts` runs
exactly that and decodes the result; see [`out/HIDDEN-BURN-VIEW.md`](./out/HIDDEN-BURN-VIEW.md).

## How it works

| File | Role |
|---|---|
| `src/reproduce.ts` | Orchestrator: start local stack → wallet → deploy → mint → burn → decode → report |
| `src/hidden-burn.ts` | Variant orchestrator: mint via the contract, then burn by a direct wallet → burn-address transfer (amount stays hidden). Decodes to `out/HIDDEN-BURN-VIEW.md` |
| `src/verify-supply.ts` | Supply-audit orchestrator: deploy → mint → contract burn → hidden burn → protocol burn; per-step PASS/FAIL matrix to `out/SUPPLY-AUDIT.md` |
| `src/prove-supply-gap.ts` | Single-claim proof: deploy → mint → off-circuit burn-address transfer; before/after `totalSupply()` + six assertions to `out/SUPPLY-GAP-PROOF.md` |
| `src/supply.ts` | Pure delta-fold: `deltaForType`, `shieldedMintsForType`, `foldSupply` over decoded txs (also a CLI for offline folding of captured `.hex`) |
| `scripts/run-hidden-burn.sh` | Brings the `compose.yml` stack up with plain `docker compose`, injects ports, runs `hidden-burn` (avoids testkit's flaky log-wait) |
| `scripts/run-verify-supply.sh` | Same self-managed-stack wrapper, for `verify-supply` |
| `scripts/run-prove-supply-gap.sh` | Same self-managed-stack wrapper, for `prove-supply-gap` |
| `src/wallet-provider.ts` | `WalletProvider`/`MidnightProvider` (balance + submit); captures each submitted tx's raw bytes |
| `src/providers.ts` | Assembles the midnight-js providers (indexer, proof, zk-config, private-state) |
| `src/contract.ts` | Deploy / join / mint / burn + `totalSupply()` read against the vendored contract |
| `src/wallet-utils.ts` | Fund/sync waits, incl. waiting for a minted coin to become spendable before burn |
| `src/decode.ts` | Deserializes raw tx bytes into the public/indexer view (also a standalone CLI) |
| `compose.yml` | The local v8 stack testkit brings up (public Docker Hub images) |
| `artifacts/.../ShieldedFungibleToken/` | Vendored compiled contract + ZK keys (no compiler needed) |
| `contracts/*.compact` | The Compact source closure, for reference / optional rebuild |

The local stack is started by testkit's `LocalTestEnvironment`, which reads
`./compose.yml` and assigns random host ports, so it never clashes with other
local stacks. The wallet is built from a prefunded dev-preset genesis seed
(`00…01`), so no faucet is needed.

### Config (env vars)

| Var | Default | Meaning |
|---|---|---|
| `TOKEN_NAME` | `OZ Test Token` | token name |
| `TOKEN_SYMBOL` | `OZT` | token symbol |
| `MINT_AMOUNT` | `1000000` | amount to mint |
| `BURN_AMOUNT` | `400000` | amount to (contract-)burn (must be ≤ mint) |
| `HIDDEN_BURN_AMOUNT` | `200000` | `verify-supply` only: hidden-burn amount (must satisfy `B + H ≤ M`) |
| `SOFT_ASSERT` | `1` | `verify-supply` only: collect FAILs into the report (`0` = exit non-zero on a measured-cell miss) |
| `DEBUG_LEVEL` | `info` | pino log level (`debug` for sync detail) |

```bash
MINT_AMOUNT=5000 BURN_AMOUNT=5000 pnpm reproduce              # full burn, no change
MINT_AMOUNT=900 BURN_AMOUNT=300 HIDDEN_BURN_AMOUNT=300 \
  bash scripts/run-verify-supply.sh                           # protocol burn P = 300
```

## Rebuilding the contract from source (optional)

The vendored `artifacts/` were produced by compiling `contracts/*.compact` with
the Compact compiler. You do **not** need this to run the reproducer. To rebuild
them you need the Compact toolchain (`compact`) matching `compact-runtime`
`0.16.0`. The import closure is:

```
ShieldedFungibleToken.compact → ShieldedERC20.compact → Utils.compact
```

The sources are stored flat, but their imports assume a structured layout
(`shielded-token/` + `openzeppelin/`), so `pnpm compile` stages them into that
layout and runs the normal compact command:

```bash
pnpm compile               # full build (TS + zkir + proving keys) -> build/ShieldedFungibleToken
pnpm compile -- --skip-zk  # fast: TS + zkir only, no proving keys
```

To use a rebuild at runtime, point `ZK_CONFIG_PATH` (in `src/reproduce.ts` /
`src/hidden-burn.ts`) at `build/ShieldedFungibleToken`, or copy it over
`artifacts/shielded-token/ShieldedFungibleToken`.

## Troubleshooting

- **Docker not running** → start Docker; the script fails fast at "Starting
  local test environment".
- **Image pull denied** → the `compose.yml` images are public Docker Hub tags;
  the gated `ghcr.io/midnight-ntwrk/*` tags are intentionally not used.
- **`Timeout waiting for shielded token`** → the minted coin had not synced
  before the burn; re-run, or raise the timeout in `src/wallet-utils.ts`.
- **Leftover containers** → with `TESTCONTAINERS_RYUK_DISABLED=true` testkit may
  leave containers after a crash; remove stale `node_*` / `indexer_*` /
  `proof-server_*` containers manually.
