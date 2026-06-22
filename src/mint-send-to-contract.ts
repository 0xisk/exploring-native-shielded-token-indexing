// Experiment (variant 2): mint a shielded token to a contract via
// sendImmediateShielded, instead of via the mint recipient.
//
// src/mint-to-contract.ts minted straight to a ContractAddress recipient and the
// node rejected it. This variant asks whether the standard-library
// `sendImmediateShielded` path makes any difference. Contract A (MintSendToken)
// mints a coin to itself, then forwards it to contract B with
// sendImmediateShielded. B (also a MintSendToken instance) is passive — it never
// calls receiveShielded.
//
//   - mint+send accepted  -> EXPERIMENT PASSED
//   - rejected at build / prove / submit -> EXPERIMENT FAILED (+ reason)
//
// Run: tsx src/mint-send-to-contract.ts  (or bash scripts/run-mint-send-to-contract.sh)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unshieldedToken } from "@midnight-ntwrk/ledger-v8";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { getTestEnvironment, LocalTestConfiguration } from "@midnight-ntwrk/testkit-js";
import { pino } from "pino";
import { WebSocket } from "ws";
import { type DecodedTx, decodeTx, formatDecode } from "./decode.js";
import { MintSendToken } from "./mint-send-contract.js";
import { configureProviders } from "./providers.js";
import { MidnightWalletProvider } from "./wallet-provider.js";
import { waitForUnshieldedFunds } from "./wallet-utils.js";

(globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const ZK_CONFIG_PATH = resolve(PKG_ROOT, "build", "MintSendToken");
const OUT_DIR = resolve(PKG_ROOT, "out");

const GENESIS_SEED = "0000000000000000000000000000000000000000000000000000000000000001";
const MINT_AMOUNT = BigInt(process.env.MINT_AMOUNT ?? "1000000");

const logger = pino({
	level: process.env.DEBUG_LEVEL ?? "info",
	transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
});

/** Walk the error `cause` chain and return the deepest message — the node's
 * RpcError (e.g. "1010: Invalid Transaction: Custom error: 186"), which is what
 * the generic top-level "Transaction submission error" hides. */
const deepestCause = (e: unknown): string | undefined => {
	let cur = e as { message?: unknown; cause?: unknown } | undefined;
	let msg: string | undefined;
	while (cur) {
		if (typeof cur.message === "string" && cur.message) msg = cur.message;
		cur = cur.cause as typeof cur;
	}
	return msg;
};

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

		// Deploy contract A (mints + sends) and contract B (passive recipient).
		const tokenA = await MintSendToken.deploy(providers, ZK_CONFIG_PATH, logger);
		const tokenB = await MintSendToken.deploy(providers, ZK_CONFIG_PATH, logger);
		logger.info(`A (mint+send) : ${tokenA.addressHex}`);
		logger.info(`B (recipient) : ${tokenB.addressHex}`);

		// The experiment: A mints to itself, then sendImmediateShielded -> B.
		let passed = false;
		let mintError: string | undefined;
		let ledgerErr: string | undefined;
		let sentValue: bigint | undefined;
		try {
			const res = await tokenA.mintToContract(tokenB.addressHex, MINT_AMOUNT);
			sentValue = res.sent.value;
			passed = true;
			logger.info(`Mint+send-to-contract ACCEPTED: sent=${sentValue}`);
		} catch (e) {
			mintError = e instanceof Error ? (e.stack ?? e.message) : String(e);
			ledgerErr = deepestCause(e);
			logger.error(`Mint+send-to-contract REJECTED: ${ledgerErr ?? (e instanceof Error ? e.message : String(e))}`);
		}

		const txs = walletProvider.submittedTxs;
		const decoded: (DecodedTx & { index: number; kind: string })[] = [];
		for (const tx of txs) {
			const d = { index: tx.index, kind: tx.kind, ...decodeTx(tx.hex) };
			decoded.push(d);
			// Annotate the rejected tx (the last one submitted on failure) with the
			// node's verdict, since the decode itself only shows the tx bytes.
			const banner =
				!passed && ledgerErr && tx === txs[txs.length - 1]
					? `=== SUBMISSION RESULT: REJECTED BY NODE ===\nledger error: ${ledgerErr}\n\n`
					: "";
			writeFileSync(resolve(OUT_DIR, `msc-${tx.index}-${tx.kind}.hex`), tx.hex);
			writeFileSync(resolve(OUT_DIR, `msc-${tx.index}-${tx.kind}.decode.txt`), banner + formatDecode(d));
		}

		logger.info("==================================================================");
		logger.info(`EXPERIMENT: mint A -> self -> sendImmediateShielded -> B  =>  ${passed ? "PASSED" : "FAILED"}`);
		logger.info(`  A (mint+send) : ${tokenA.addressHex}`);
		logger.info(`  B (recipient) : ${tokenB.addressHex}`);
		if (sentValue !== undefined) logger.info(`  sent value    : ${sentValue}`);
		if (mintError) logger.info(`  reject reason : ${mintError.split("\n")[0]}`);
		for (const tx of walletProvider.submittedTxs) {
			logger.info(`  tx #${tx.index} ${tx.kind.padEnd(6)} ${tx.byteLength} bytes  ${tx.transactionHash}`);
		}
		logger.info(`  raw hex + decodes (msc-*) in: ${OUT_DIR}`);
		logger.info("==================================================================");

		writeFileSync(
			resolve(OUT_DIR, "MINT-SEND-TO-CONTRACT.md"),
			[
				"# Experiment: mint A -> self -> sendImmediateShielded -> recipient contract B",
				"",
				`Result: **${passed ? "PASSED" : "FAILED"}**${!passed && ledgerErr ? ` — node rejected with ledger error \`${ledgerErr}\`` : ""}.`,
				"",
				`- contract A (mint+send) : \`${tokenA.addressHex}\``,
				`- contract B (recipient) : \`${tokenB.addressHex}\``,
				`- mint amount            : ${MINT_AMOUNT}`,
				sentValue !== undefined ? `- sent value             : ${sentValue}` : "",
				!passed && ledgerErr ? `- ledger error           : \`${ledgerErr}\`` : "",
				mintError ? `\n## Reject reason (full stack)\n\n\`\`\`\n${mintError}\n\`\`\`` : "",
				"",
				"## Transactions",
				"",
				...walletProvider.submittedTxs.map(
					(tx) => `- #${tx.index} ${tx.kind} — ${tx.byteLength} bytes — \`${tx.transactionHash}\``,
				),
			].join("\n"),
		);

		if (!passed) throw new Error(`mint-send-to-contract failed: ${mintError?.split("\n")[0]}`);
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
