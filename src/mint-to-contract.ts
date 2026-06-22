// Experiment: can contract A mint its shielded token directly to *contract B*?
//
// Two ShieldedFungibleToken contracts are deployed on one local v8 stack:
//   A — the token being minted
//   B — the intended recipient (a contract address, not a wallet coin pk)
// We then call A.mint() with the recipient Either selecting the ContractAddress
// (right) variant set to B's address, and submit it. The question is purely
// empirical: does the node ACCEPT a mint whose output coin is owned by a
// contract that does not participate in the transaction (no `receiveShielded`)?
//
//   - if the mint tx is accepted -> EXPERIMENT PASSED (mint-to-contract works)
//   - if it is rejected at build / prove / submit -> EXPERIMENT FAILED (+ reason)
//
// Either way we capture and decode every tx so the raw bytes explain the result.
//
// Run: tsx src/mint-to-contract.ts   (or bash scripts/run-mint-to-contract.sh)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unshieldedToken } from "@midnight-ntwrk/ledger-v8";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { getTestEnvironment, LocalTestConfiguration } from "@midnight-ntwrk/testkit-js";
import { pino } from "pino";
import { WebSocket } from "ws";
import { ShieldedFungibleToken } from "./contract.js";
import { type DecodedTx, decodeTx, formatDecode } from "./decode.js";
import { configureProviders } from "./providers.js";
import { MidnightWalletProvider } from "./wallet-provider.js";
import { waitForUnshieldedFunds } from "./wallet-utils.js";

(globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const ZK_CONFIG_PATH = resolve(PKG_ROOT, "artifacts", "shielded-token", "ShieldedFungibleToken");
const OUT_DIR = resolve(PKG_ROOT, "out");

const GENESIS_SEED = "0000000000000000000000000000000000000000000000000000000000000001";
const MINT_AMOUNT = BigInt(process.env.MINT_AMOUNT ?? "1000000");

const logger = pino({
	level: process.env.DEBUG_LEVEL ?? "info",
	transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
});

const hexOf = (u8: Uint8Array): string => Buffer.from(u8).toString("hex");

async function main(): Promise<void> {
	mkdirSync(OUT_DIR, { recursive: true });
	logger.info(`zkConfigPath: ${ZK_CONFIG_PATH}`);

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

		const unshielded = await waitForUnshieldedFunds(logger, walletProvider.wallet, unshieldedToken());
		logger.info(`NIGHT balance: ${unshielded.balances[unshieldedToken().raw]}`);

		const providers = configureProviders(walletProvider, ZK_CONFIG_PATH);

		// Deploy contract A (the token to mint) and contract B (the recipient).
		const tokenA = await ShieldedFungibleToken.deploy(
			providers, "Token A", "TKA", ZK_CONFIG_PATH, logger,
		);
		const tokenB = await ShieldedFungibleToken.deploy(
			providers, "Token B", "TKB", ZK_CONFIG_PATH, logger,
		);
		logger.info(`A (token)     : ${tokenA.addressHex}`);
		logger.info(`B (recipient) : ${tokenB.addressHex}`);

		// The experiment: mint A's token straight to contract B's address.
		let passed = false;
		let mintError: string | undefined;
		let mintedColor: string | undefined;
		try {
			const minted = await tokenA.mintToContract(tokenB.addressHex, MINT_AMOUNT);
			mintedColor = hexOf(minted.color);
			passed = true;
			logger.info(`Mint-to-contract ACCEPTED: color=${mintedColor} value=${minted.value}`);
		} catch (e) {
			mintError = e instanceof Error ? (e.stack ?? e.message) : String(e);
			logger.error(`Mint-to-contract REJECTED: ${e instanceof Error ? e.message : String(e)}`);
		}

		// Decode + persist every tx we managed to submit (deploy A, deploy B, mint?).
		const decoded: (DecodedTx & { index: number; kind: string })[] = [];
		for (const tx of walletProvider.submittedTxs) {
			const d = { index: tx.index, kind: tx.kind, ...decodeTx(tx.hex) };
			decoded.push(d);
			writeFileSync(resolve(OUT_DIR, `mtc-${tx.index}-${tx.kind}.hex`), tx.hex);
			writeFileSync(resolve(OUT_DIR, `mtc-${tx.index}-${tx.kind}.decode.txt`), formatDecode(d));
		}

		logger.info("==================================================================");
		logger.info(`EXPERIMENT: mint token A -> recipient contract B  =>  ${passed ? "PASSED" : "FAILED"}`);
		logger.info(`  A (token)     : ${tokenA.addressHex}`);
		logger.info(`  B (recipient) : ${tokenB.addressHex}`);
		if (mintedColor) logger.info(`  minted color  : ${mintedColor}`);
		if (mintError) logger.info(`  reject reason : ${mintError.split("\n")[0]}`);
		for (const tx of walletProvider.submittedTxs) {
			logger.info(`  tx #${tx.index} ${tx.kind.padEnd(6)} ${tx.byteLength} bytes  ${tx.transactionHash}`);
		}
		logger.info(`  raw hex + decodes (mtc-*) in: ${OUT_DIR}`);
		logger.info("==================================================================");

		writeFileSync(
			resolve(OUT_DIR, "MINT-TO-CONTRACT.md"),
			[
				"# Experiment: mint token A -> recipient contract B",
				"",
				`Result: **${passed ? "PASSED" : "FAILED"}** (mint to a contract address ${passed ? "accepted" : "rejected"} by the node).`,
				"",
				`- contract A (token)     : \`${tokenA.addressHex}\``,
				`- contract B (recipient) : \`${tokenB.addressHex}\``,
				`- mint amount            : ${MINT_AMOUNT}`,
				mintedColor ? `- minted color           : \`${mintedColor}\`` : "",
				mintError ? `\n## Reject reason\n\n\`\`\`\n${mintError}\n\`\`\`` : "",
				"",
				"## Transactions",
				"",
				...walletProvider.submittedTxs.map(
					(tx) => `- #${tx.index} ${tx.kind} — ${tx.byteLength} bytes — \`${tx.transactionHash}\``,
				),
			].join("\n"),
		);

		if (!passed) throw new Error(`mint-to-contract failed: ${mintError?.split("\n")[0]}`);
	} catch (e) {
		logger.error(`Run failed: ${e instanceof Error ? e.message : String(e)}`);
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
