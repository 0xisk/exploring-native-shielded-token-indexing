// Thin deploy + mintToContract wrapper around the MintSendToken experiment
// contract (build/MintSendToken). MintSendToken mints a coin to itself and then
// forwards it to a recipient contract via sendImmediateShielded.
import { randomBytes } from "node:crypto";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";
// Compiler-generated experiment contract.
import { Contract } from "../build/MintSendToken/contract/index.js";
import type { Providers } from "./providers.js";

export type ShieldedCoinInfo = { nonce: Uint8Array; color: Uint8Array; value: bigint };
export type ShieldedSendResult = {
	change: { is_some: boolean; value: ShieldedCoinInfo };
	sent: ShieldedCoinInfo;
};

export const PRIVATE_STATE_ID = "mintSendTokenPrivateState";

const createCompiledContract = (zkConfigPath: string) => {
	const base = CompiledContract.make("MintSendToken", Contract as never);
	const withWit = CompiledContract.withWitnesses(base, {} as never);
	return CompiledContract.withCompiledFileAssets(withWit, zkConfigPath);
};

const bytesToHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/** Build the ContractAddress arg ({ bytes: Bytes<32> }) for a contract address hex. */
const contractAddressArg = (contractAddressHex: string) => ({
	bytes: Uint8Array.from(Buffer.from(contractAddressHex.replace(/^0x/, ""), "hex")),
});

export class MintSendToken {
	private constructor(
		private readonly deployedContract: any,
		private readonly logger: { info: (m: string) => void },
	) {}

	get addressHex(): string {
		return this.deployedContract.deployTxData.public.contractAddress;
	}

	static async deploy(
		providers: Providers,
		zkConfigPath: string,
		logger: { info: (m: string) => void },
	): Promise<MintSendToken> {
		logger.info("Deploying MintSendToken...");
		const nonce = randomBytes(32);
		const domain = randomBytes(32);
		const deployedContract = await deployContract(providers as never, {
			compiledContract: createCompiledContract(zkConfigPath),
			privateStateId: PRIVATE_STATE_ID,
			initialPrivateState: {},
			args: [nonce, domain],
		} as never);
		const token = new MintSendToken(deployedContract, logger);
		logger.info(`Deployed at contract address: ${token.addressHex}`);
		return token;
	}

	/**
	 * Mint `amount` to this contract, then forward it to `contractAddressHex` via
	 * sendImmediateShielded. Returns the ShieldedSendResult (sent coin + change).
	 */
	async mintToContract(contractAddressHex: string, amount: bigint): Promise<ShieldedSendResult> {
		this.logger.info(`Mint ${amount} -> self, then sendImmediateShielded -> ${contractAddressHex}...`);
		const txData = await this.deployedContract.callTx.mintToContract(
			contractAddressArg(contractAddressHex),
			amount,
		);
		const result: ShieldedSendResult = txData.private.result;
		const change = result.change.is_some ? result.change.value.value : 0n;
		this.logger.info(
			`Sent: value=${result.sent.value} change=${change} color=${bytesToHex(result.sent.color)} (tx ${txData.public.txHash})`,
		);
		return result;
	}
}
