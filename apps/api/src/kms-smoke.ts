import { hashTypedData, recoverTypedDataAddress, type TypedDataDefinition } from 'viem';
import { errorMessage, KmsSigner, type KmsTransport } from './adapters/signers/kms.js';

/** Anvil/Hardhat chain ID: no fee wrapper on a real chain can accept this signature. */
export const SMOKE_CHAIN_ID = 31337;

/**
 * A fixed, clearly labelled test message. Its domain name and type differ from the fee
 * wrapper's `SwapQuote`, so the signature can never be a valid quote, on any chain.
 */
export const SMOKE_TYPED_DATA = {
  domain: {
    name: 'Ranvier KMS smoke test (not a quote)',
    version: '1',
    chainId: SMOKE_CHAIN_ID,
    verifyingContract: '0x0000000000000000000000000000000000000000',
  },
  types: {
    SmokeTest: [
      { name: 'purpose', type: 'string' },
      { name: 'counter', type: 'uint256' },
    ],
  },
  primaryType: 'SmokeTest',
  message: { purpose: 'Ranvier KMS signer smoke test. This is not a swap quote.', counter: 0n },
} as const satisfies TypedDataDefinition;

export interface KmsSmokeOptions {
  keyId: string;
  transport: KmsTransport;
  print: (line: string) => void;
}

/**
 * Live check of a KMS key with the API's own code path: checks the key, derives its address,
 * signs the fixed test message and verifies the signature. Prints the key ARN, spec and
 * address (never credentials) and PASS or FAIL. Returns true on PASS.
 */
export async function runKmsSmoke({ keyId, transport, print }: KmsSmokeOptions): Promise<boolean> {
  let signer: KmsSigner;
  try {
    signer = await KmsSigner.create({ keyId, transport, chainIds: [SMOKE_CHAIN_ID] });
  } catch (err: unknown) {
    print(`FAIL: ${errorMessage(err)}`);
    return false;
  }
  const { info } = signer;
  print(`key ARN:   ${info.keyArn}`);
  print(`key spec:  ${info.keySpec} / ${info.keyUsage} / ${info.keyState} / origin ${info.origin}`);
  print(`address:   ${info.address}`);
  const digest = hashTypedData(SMOKE_TYPED_DATA);
  print(`test digest (chain ${SMOKE_CHAIN_ID}, not a quote): ${digest}`);
  try {
    const signature = await signer.signTypedData(SMOKE_TYPED_DATA);
    const recovered = await recoverTypedDataAddress({ ...SMOKE_TYPED_DATA, signature });
    print(`signature: ${signature}`);
    print(`recovered: ${recovered}`);
    if (recovered !== info.address) {
      print('FAIL: the signature recovers to a different address');
      return false;
    }
  } catch (err: unknown) {
    print(`FAIL: ${errorMessage(err)}`);
    return false;
  }
  print('PASS: KMS signed the test message and the signature verifies as the address above.');
  print('Next: this address must equal FeeWrapper.feeSigner() on every chain the API signs for.');
  return true;
}
