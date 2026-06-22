// Thin deploy + mint + deposit wrapper around the VaultToken experiment contract
// (build/VaultToken). Used in two roles: A = minter (mint to wallet), B = vault
// (deposit / receiveShielded a coin into the contract).
import { randomBytes } from "node:crypto";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";
import { type CoinPublicKey, encodeCoinPublicKey } from "@midnight-ntwrk/ledger-v8";
// Compiler-generated experiment contract.
import { Contract } from "../build/VaultToken/contract/index.js";
import type { Providers } from "./providers.js";

export type ShieldedCoinInfo = { nonce: Uint8Array; color: Uint8Array; value: bigint };

export const PRIVATE_STATE_ID = "vaultTokenPrivateState";

const createCompiledContract = (zkConfigPath: string) => {
	const base = CompiledContract.make("VaultToken", Contract as never);
	const withWit = CompiledContract.withWitnesses(base, {} as never);
	return CompiledContract.withCompiledFileAssets(withWit, zkConfigPath);
};

const bytesToHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

const recipientForCoinPublicKey = (coinPublicKey: CoinPublicKey) => ({
	is_left: true,
	left: { bytes: encodeCoinPublicKey(coinPublicKey) },
	right: { bytes: new Uint8Array(32) },
});

export class VaultToken {
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
	): Promise<VaultToken> {
		logger.info("Deploying VaultToken...");
		const nonce = randomBytes(32);
		const domain = randomBytes(32);
		const deployedContract = await deployContract(providers as never, {
			compiledContract: createCompiledContract(zkConfigPath),
			privateStateId: PRIVATE_STATE_ID,
			initialPrivateState: {},
			args: [nonce, domain],
		} as never);
		const token = new VaultToken(deployedContract, logger);
		logger.info(`Deployed at contract address: ${token.addressHex}`);
		return token;
	}

	/** Mint `amount` to a coin public key (used to mint token A to the wallet). */
	async mint(coinPublicKey: CoinPublicKey, amount: bigint): Promise<ShieldedCoinInfo> {
		this.logger.info(`Minting ${amount} to wallet...`);
		const txData = await this.deployedContract.callTx.mint(
			recipientForCoinPublicKey(coinPublicKey),
			amount,
		);
		const coin: ShieldedCoinInfo = txData.private.result;
		this.logger.info(
			`Minted: color=${bytesToHex(coin.color)} value=${coin.value} (tx ${txData.public.txHash})`,
		);
		return coin;
	}

	/** Vault role: receive `coin` into this contract via receiveShielded. */
	async deposit(coin: ShieldedCoinInfo): Promise<string> {
		this.logger.info(`Depositing coin value=${coin.value} into ${this.addressHex}...`);
		const txData = await this.deployedContract.callTx.deposit(coin);
		this.logger.info(`Deposit accepted (tx ${txData.public.txHash})`);
		return txData.public.txHash as string;
	}
}
