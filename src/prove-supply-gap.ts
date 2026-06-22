// Proof: a shielded token's contract `totalSupply()` cannot account for tokens
// removed from circulation by an off-circuit transfer to a burn address.
//
// The claim (the ERC20 analogy): in ERC20, sending tokens to 0x…dead with
// `transfer` removes them from circulation but leaves `totalSupply` untouched —
// the counter only moves when you call `burn`. The same is true for a Midnight
// shielded token: a holder can send coins to the all-zero coin public key with a
// plain wallet transfer (no `burn` circuit, no contract call at all), and the
// contract's `totalSupply()` counter does not move. So `totalSupply()` is an
// UPPER BOUND on circulating supply, never an exact measure.
//
// What this script does on one live local v8 stack:
//
//   1. deploy a ShieldedFungibleToken
//   2. mint M to self                          -> totalSupply() must read M
//   3. transfer B of it to the zero coin key   (a plain Zswap transfer; NO
//      contract call) — this is the off-circuit "send to burn address"
//   4. re-read totalSupply()                    -> must STILL read M (unchanged)
//
// It then decodes the off-circuit-burn tx straight from its on-wire bytes to
// confirm there is no ContractCall and the net zswap delta is 0 (the burned coin
// stays in the commitment pool as a dead coin), so neither the contract counter
// NOR an indexer's `-Σ deltas` fold can see the burn. The supply gap it leaves is
// exactly B: contract says M, truly circulating is M - B.
//
// Why the B tokens are gone for good (cryptographic unspendability): spending a
// shielded coin requires the coin secret key for its coin public key. The burn
// address is the all-zero coin public key, for which no secret key is known, so
// the coin can never be spent by anyone — including us. (The output reuses our
// ENCRYPTION key, which only governs who can detect/decrypt the output
// ciphertext, never who can spend it.)
//
// Run from the package root:  pnpm prove-supply-gap   (tsx src/prove-supply-gap.ts)
// Or against a self-managed stack:  bash scripts/run-prove-supply-gap.sh
// Env: MINT_AMOUNT (M), BURN_AMOUNT (B, sent off-circuit; must be <= M),
//      SOFT_ASSERT (default 0 = exit non-zero if the proof fails; 1 = always
//      exit 0 and just record the verdict), DEBUG_LEVEL.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unshieldedToken } from "@midnight-ntwrk/ledger-v8";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { ttlOneHour } from "@midnight-ntwrk/midnight-js-utils";
import { getTestEnvironment, LocalTestConfiguration } from "@midnight-ntwrk/testkit-js";
import {
	ShieldedAddress,
	ShieldedCoinPublicKey,
	type WalletFacade,
} from "@midnight-ntwrk/wallet-sdk";
import { pino } from "pino";
import * as Rx from "rxjs";
import { WebSocket } from "ws";
import { ShieldedFungibleToken } from "./contract.js";
import { type DecodedTx, decodeTx, formatDecode } from "./decode.js";
import { configureProviders } from "./providers.js";
import { deltaForType, foldSupply, type OrderedTx } from "./supply.js";
import { MidnightWalletProvider } from "./wallet-provider.js";
import { waitForShieldedToken, waitForUnshieldedFunds } from "./wallet-utils.js";

// Apollo (indexer subscriptions) needs a global WebSocket.
(globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const ZK_CONFIG_PATH = resolve(PKG_ROOT, "artifacts", "shielded-token", "ShieldedFungibleToken");
const OUT_DIR = resolve(PKG_ROOT, "out");

const GENESIS_SEED = "0000000000000000000000000000000000000000000000000000000000000001";
const TOKEN_NAME = process.env.TOKEN_NAME ?? "OZ Test Token";
const TOKEN_SYMBOL = process.env.TOKEN_SYMBOL ?? "OZT";
const MINT_AMOUNT = BigInt(process.env.MINT_AMOUNT ?? "1000000");
// Amount sent OFF-CIRCUIT to the burn address (no contract call). Must be <= M.
const BURN_AMOUNT = BigInt(process.env.BURN_AMOUNT ?? "400000");
// Strict by default: this is a proof, so a failed assertion should fail the run.
const SOFT_ASSERT = process.env.SOFT_ASSERT === "1";
const SYNC_TIMEOUT_MS = 180_000;

// The shielded burn address: the all-zero coin public key (32 zero bytes).
// Spending a coin needs the secret for its coin public key; nobody holds the
// secret for the zero key, so any coin sent here is destroyed. This is exactly
// what the contract's `shieldedBurnAddress()` resolves to.
const BURN_COIN_PUBLIC_KEY_HEX = "00".repeat(32);

const logger = pino({
	level: process.env.DEBUG_LEVEL ?? "info",
	transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
});

const hexOf = (u8: Uint8Array): string => Buffer.from(u8).toString("hex");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Measurement helpers (mirrored from verify-supply.ts so this stays standalone)
// ---------------------------------------------------------------------------

interface SpendableView {
	availableCoins: readonly { coin: { type: string; value: bigint } }[];
}

/** Values of the SPENDABLE coins of `colorHex` (available, owned, unspent). */
const spendableCoinValues = (sh: SpendableView, colorHex: string): bigint[] =>
	sh.availableCoins.filter((c) => c.coin.type === colorHex).map((c) => c.coin.value);

/**
 * Wait until a spendable coin of EXACTLY `changeValue` exists for `colorHex` —
 * the signal that the change from the off-circuit transfer has synced, so the
 * transfer has landed on-chain and the post-read of `totalSupply()` is meaningful.
 *
 * We key on the change coin's exact value rather than the spendable *sum*: the
 * burn output reuses our encryption key, so the wallet still detects (and lists)
 * that coin even though its zero coin key makes it unspendable, which would
 * otherwise inflate the sum.
 */
const waitForChangeCoin = async (
	wallet: WalletFacade,
	colorHex: string,
	changeValue: bigint,
	timeoutMs = SYNC_TIMEOUT_MS,
): Promise<void> => {
	logger.info(`Waiting for a spendable ${colorHex} coin == ${changeValue} (transfer landed)...`);
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const sh = (await Rx.firstValueFrom(wallet.shielded.state)) as unknown as SpendableView;
		const values = spendableCoinValues(sh, colorHex);
		logger.debug(`spendable ${colorHex} coins: [${values.join(", ")}] (want ${changeValue})`);
		if (values.includes(changeValue)) {
			logger.info(`Change coin ready: ${colorHex} has a ${changeValue} coin.`);
			return;
		}
		if (Date.now() > deadline) {
			throw new Error(
				`Timeout waiting for a spendable ${colorHex} coin == ${changeValue}; saw [${values.join(", ")}]`,
			);
		}
		await sleep(3_000);
	}
};

/**
 * Read the contract counter, polling until it reaches `expected` (or a short
 * timeout) to absorb indexer lag. Returns the last value read either way, so a
 * genuine mismatch still surfaces in the report.
 */
const readTotalSupplyStable = async (
	token: ShieldedFungibleToken,
	expected: bigint,
	timeoutMs = 30_000,
): Promise<bigint> => {
	const deadline = Date.now() + timeoutMs;
	let last = 0n;
	for (;;) {
		try {
			last = await token.totalSupply();
		} catch (e) {
			logger.warn(`totalSupply read failed: ${e instanceof Error ? e.message : String(e)}`);
		}
		if (last === expected || Date.now() > deadline) return last;
		await sleep(2_000);
	}
};

/** Decode all captured txs (in submission order) into the fold's input shape. */
const decodeCaptured = (wp: MidnightWalletProvider): OrderedTx[] =>
	wp.submittedTxs.map((t) => ({ index: t.index, kind: t.kind, tx: decodeTx(t.hex) }));

/** Count ContractCall actions across every intent of a decoded tx. */
const contractCallsOf = (tx: DecodedTx): number =>
	tx.intents.flatMap((i) => i.actions).filter((a) => a.kind === "ContractCall").length;

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

interface Check {
	id: string;
	claim: string;
	measured: string;
	expected: string;
	pass: boolean;
}

const check = (id: string, claim: string, measured: bigint | number | string, expected: bigint | number | string): Check => ({
	id,
	claim,
	measured: String(measured),
	expected: String(expected),
	pass: String(measured) === String(expected),
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

interface ReportArgs {
	contractAddress: string;
	colorHex: string;
	M: bigint;
	B: bigint;
	totalSupplyBefore: bigint;
	totalSupplyAfter: bigint;
	burnTx: DecodedTx;
	burnDelta: bigint;
	foldSupplyValue: bigint;
	checks: Check[];
}

const writeReport = (a: ReportArgs): string => {
	const allPass = a.checks.every((c) => c.pass);
	const circulating = a.M - a.B;
	const gap = a.totalSupplyAfter - circulating;
	const off = a.burnTx.guaranteedOffer ?? { inputs: [], outputs: [], transients: 0, deltas: [] };
	const calls = contractCallsOf(a.burnTx);

	const L: string[] = [];
	L.push("# Supply-gap proof — `totalSupply()` cannot see an off-circuit burn (auto-generated)");
	L.push("");
	L.push("Generated by `pnpm prove-supply-gap`. One local v8 stack run minted a");
	L.push("shielded token, then sent part of it to the burn address with a **plain wallet**");
	L.push("**transfer that never calls the contract**, and read the contract's");
	L.push("`totalSupply()` counter before and after. The burn tx is decoded from its raw");
	L.push("on-wire bytes, so every public fact below is what the chain/indexer actually sees.");
	L.push("");
	L.push("**Verdict: " + (allPass ? "PROVED ✅" : "NOT PROVED ❌") + ".** ");
	L.push("");
	L.push("## What the ERC20 analogy is");
	L.push("");
	L.push("In ERC20, `transfer(0x…dead, x)` removes `x` from circulation but leaves");
	L.push("`totalSupply` unchanged — only `burn()` decrements the counter. A Midnight");
	L.push("shielded token behaves the same way: a wallet → burn-address Zswap transfer");
	L.push("destroys coins without ever calling the contract, so `totalSupply()` cannot");
	L.push("decrement. The counter is therefore an **upper bound** on circulating supply.");
	L.push("");
	L.push("## Run parameters");
	L.push("");
	L.push("```");
	L.push(`Token            : ${TOKEN_NAME} (${TOKEN_SYMBOL})`);
	L.push(`Contract address : ${a.contractAddress}`);
	L.push(`Token color (tt) : ${a.colorHex}`);
	L.push(`Burn address     : coin public key = ${BURN_COIN_PUBLIC_KEY_HEX} (all-zero, unspendable)`);
	L.push(`M (minted)       : ${a.M}`);
	L.push(`B (sent to burn) : ${a.B}   (off-circuit: a plain wallet transfer, no contract call)`);
	L.push("```");
	L.push("");
	L.push("## The proof: `totalSupply()` before vs. after the off-circuit burn");
	L.push("");
	L.push("| | contract `totalSupply()` | truly circulating | gap (overstatement) |");
	L.push("|---|---|---|---|");
	L.push(`| after mint M | ${a.totalSupplyBefore} | ${a.M} | 0 |`);
	L.push(`| after sending B to burn address | **${a.totalSupplyAfter}** | ${circulating} | **${gap}** |`);
	L.push("");
	L.push(`The counter did not move (\`${a.totalSupplyBefore}\` → \`${a.totalSupplyAfter}\`), yet ${a.B}`);
	L.push(`tokens are now provably unspendable. The contract overstates circulating supply by **${gap}**.`);
	L.push("");
	L.push("## The off-circuit burn transaction (decoded from raw bytes)");
	L.push("");
	L.push("```");
	L.push(`transactionHash      : ${a.burnTx.transactionHash}`);
	L.push(`byteLength           : ${a.burnTx.byteLength}`);
	L.push(`ContractCall actions : ${calls}   <-- 0: the contract is never invoked`);
	L.push(`Zswap offer          : inputs=${off.inputs.length} outputs=${off.outputs.length} transients=${off.transients}`);
	off.deltas.forEach((x) => L.push(`  delta ${x.type} = ${x.delta}`));
	off.inputs.forEach((i, n) => L.push(`  input[${n}]  nullifier  = ${i.nullifier}`));
	off.outputs.forEach((o, n) => L.push(`  output[${n}] commitment = ${o.commitment}`));
	L.push("```");
	L.push("");
	L.push(`Net \`delta[tt] = ${a.burnDelta}\`: the spent coin's value re-enters the pool as the`);
	L.push("burn output + change, so the offer balances to zero. That means an indexer");
	L.push(`recomputing supply as \`-Σ deltas[tt]\` also stays at ${a.foldSupplyValue} — **neither** the`);
	L.push("contract counter nor the public delta-fold can observe this burn. The two output");
	L.push("commitments (the burn output and the change) are indistinguishable to the indexer:");
	L.push("the chain cannot even tell a burn happened.");
	L.push("");
	L.push("## Why the burned tokens are gone for good");
	L.push("");
	L.push("Spending a shielded coin requires the **coin secret key** matching the coin's");
	L.push("**coin public key**. The burn address is the all-zero coin public key, for which");
	L.push("no secret key is known to exist, so the coin can never be spent — by us or anyone.");
	L.push("(The output reuses our *encryption* public key, which only controls who can");
	L.push("detect/decrypt the output ciphertext, never who can spend it. So our wallet still");
	L.push("*sees* the coin, but it — and everyone — is cryptographically unable to spend it.)");
	L.push("");
	L.push("## Assertions");
	L.push("");
	L.push("| # | claim | measured | expected | result |");
	L.push("|---|---|---|---|---|");
	for (const c of a.checks) {
		L.push(`| ${c.id} | ${c.claim} | ${c.measured} | ${c.expected} | ${c.pass ? "✅ PASS" : "❌ FAIL"} |`);
	}
	L.push("");
	L.push("## Conclusion");
	L.push("");
	L.push("`totalSupply()` on a shielded token counts only contract-mediated mints and burns.");
	L.push("Any holder can remove tokens from circulation by transferring them to the burn");
	L.push("address outside the contract, and the counter — like an ERC20 `totalSupply` after a");
	L.push("`transfer` to a dead address — will not reflect it. **A shielded token's");
	L.push("`totalSupply()` is an upper bound on circulating supply, not an exact measure.**");
	L.push("");

	const reportPath = resolve(OUT_DIR, "SUPPLY-GAP-PROOF.md");
	writeFileSync(reportPath, L.join("\n"));
	return reportPath;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	mkdirSync(OUT_DIR, { recursive: true });
	logger.info(`zkConfigPath: ${ZK_CONFIG_PATH}`);
	logger.info(`Amounts: M=${MINT_AMOUNT} B=${BURN_AMOUNT} (soft=${SOFT_ASSERT})`);
	if (BURN_AMOUNT > MINT_AMOUNT) {
		throw new Error(`BURN_AMOUNT (${BURN_AMOUNT}) must be <= MINT_AMOUNT (${MINT_AMOUNT})`);
	}

	const M = MINT_AMOUNT;
	const B = BURN_AMOUNT;

	// If HB_*_PORT are set, an externally-managed stack is already up (see
	// scripts/run-prove-supply-gap.sh). Skip testkit's container management — its
	// testcontainers log-wait is flaky here — and point straight at the ports.
	const injected =
		process.env.HB_INDEXER_PORT && process.env.HB_NODE_PORT && process.env.HB_PS_PORT;
	const testEnv = injected ? undefined : getTestEnvironment(logger);
	const providersToStop: MidnightWalletProvider[] = [];

	try {
		let envConfig: Parameters<typeof MidnightWalletProvider.build>[1];
		if (injected) {
			setNetworkId("undeployed");
			envConfig = new LocalTestConfiguration({
				indexer: Number(process.env.HB_INDEXER_PORT),
				node: Number(process.env.HB_NODE_PORT),
				proofServer: Number(process.env.HB_PS_PORT),
			} as never) as never;
			logger.info(`Using injected stack: ${JSON.stringify(envConfig)}`);
		} else {
			logger.info("Starting local test environment (node + indexer + proof-server)...");
			envConfig = await testEnv!.start();
			logger.info(`Environment up: ${JSON.stringify(envConfig)}`);
		}

		const walletProvider = await MidnightWalletProvider.build(logger, envConfig, GENESIS_SEED);
		providersToStop.push(walletProvider);
		await walletProvider.start();
		await waitForUnshieldedFunds(logger, walletProvider.wallet, unshieldedToken());

		const providers = configureProviders(walletProvider, ZK_CONFIG_PATH);

		// 1) deploy + 2) mint M to self (through the vendored contract)
		const token = await ShieldedFungibleToken.deploy(
			providers,
			TOKEN_NAME,
			TOKEN_SYMBOL,
			ZK_CONFIG_PATH,
			logger,
		);
		const minted = await token.mint(walletProvider.getCoinPublicKey(), M);
		const colorHex = hexOf(minted.color);
		await waitForShieldedToken(logger, walletProvider.wallet, colorHex, M);

		// BEFORE: the counter reflects the mint.
		const totalSupplyBefore = await readTotalSupplyStable(token, M);
		logger.info(`totalSupply() after mint: ${totalSupplyBefore} (expected ${M})`);

		// 3) OFF-CIRCUIT BURN: transfer B to the zero coin key with a plain wallet
		//    transfer. No contract call is made — the contract never learns of it.
		const shieldedState = await Rx.firstValueFrom(walletProvider.wallet.shielded.state);
		const burnAddress = new ShieldedAddress(
			ShieldedCoinPublicKey.fromHexString(BURN_COIN_PUBLIC_KEY_HEX),
			shieldedState.address.encryptionPublicKey,
		);
		logger.info(`Sending ${B} of ${colorHex} to the burn address (off-circuit, no contract call)...`);
		const recipe = await walletProvider.wallet.transferTransaction(
			[
				{
					type: "shielded",
					outputs: [{ type: colorHex as never, receiverAddress: burnAddress, amount: B }],
				},
			],
			{ shieldedSecretKeys: walletProvider.zswapSecretKeys, dustSecretKey: walletProvider.dustSecretKey },
			{ ttl: ttlOneHour(), payFees: true },
		);
		const finalized = await walletProvider.wallet.finalizeRecipe(recipe as never);
		await walletProvider.submitTx(finalized);
		const last = walletProvider.submittedTxs.at(-1);
		if (last) last.kind = "off-circuit-burn";

		// Wait for the change (M - B) to sync, confirming the transfer landed.
		await waitForChangeCoin(walletProvider.wallet, colorHex, M - B);

		// 4) AFTER: the counter must be unchanged (still M).
		const totalSupplyAfter = await readTotalSupplyStable(token, M);
		logger.info(`totalSupply() after off-circuit burn: ${totalSupplyAfter} (expected unchanged = ${M})`);

		// Decode the off-circuit-burn tx and recompute the indexer's delta-fold.
		const ordered = decodeCaptured(walletProvider);
		const burnOrdered = ordered.find((o) => o.kind === "off-circuit-burn");
		if (!burnOrdered) throw new Error("off-circuit-burn tx was not captured");
		const burnTx = burnOrdered.tx;
		const burnDelta = deltaForType(burnTx, colorHex);
		const fold = foldSupply(ordered, colorHex);

		const circulating = M - B;
		const checks: Check[] = [
			check("A1", "`totalSupply()` reflects the mint", totalSupplyBefore, M),
			check("A2", "off-circuit burn makes 0 ContractCalls", contractCallsOf(burnTx), 0),
			check("A3", "`totalSupply()` is UNCHANGED after the burn", totalSupplyAfter, totalSupplyBefore),
			check("A4", "net zswap `delta[tt]` of the burn is 0 (indexer-blind)", burnDelta, 0n),
			check("A5", "indexer fold `-Σδ` also overstates", fold.supply, M),
			check("A6", "supply gap == the off-circuit-burned amount B", totalSupplyAfter - circulating, B),
		];

		// Persist artifacts: raw hex + full decode of every captured tx.
		for (const t of walletProvider.submittedTxs) {
			const d = decodeTx(t.hex);
			writeFileSync(resolve(OUT_DIR, `${t.index}-${t.kind}.hex`), t.hex);
			writeFileSync(resolve(OUT_DIR, `${t.index}-${t.kind}.decode.txt`), formatDecode(d));
		}

		const reportPath = writeReport({
			contractAddress: token.addressHex,
			colorHex,
			M,
			B,
			totalSupplyBefore,
			totalSupplyAfter,
			burnTx,
			burnDelta,
			foldSupplyValue: fold.supply,
			checks,
		});

		const allPass = checks.every((c) => c.pass);
		logger.info("==================================================================");
		logger.info(`DONE (supply-gap proof). Verdict: ${allPass ? "PROVED" : "NOT PROVED"}`);
		logger.info(`  contract            : ${token.addressHex}`);
		logger.info(`  totalSupply() before: ${totalSupplyBefore}`);
		logger.info(`  totalSupply() after : ${totalSupplyAfter}  (sent ${B} to burn address off-circuit)`);
		logger.info(`  truly circulating   : ${circulating}   gap = ${totalSupplyAfter - circulating}`);
		for (const c of checks) logger.info(`  ${c.id} ${c.pass ? "PASS" : "FAIL"}: ${c.claim}`);
		logger.info(`  report : ${reportPath}`);
		logger.info("==================================================================");

		if (!allPass && !SOFT_ASSERT) {
			throw new Error(`Supply-gap proof FAILED: ${checks.filter((c) => !c.pass).map((c) => c.id).join(", ")}`);
		}
	} catch (e) {
		logger.error(`Supply-gap proof failed: ${e instanceof Error ? e.message : String(e)}`);
		if (e instanceof Error && e.stack) logger.error(e.stack);
		throw e;
	} finally {
		for (const p of providersToStop) {
			try {
				await p.stop();
			} catch (e) {
				logger.warn(`stop wallet: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		try {
			if (testEnv) await testEnv.shutdown();
		} catch (e) {
			logger.warn(`shutdown: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}

main().then(
	() => process.exit(0),
	() => process.exit(1),
);
