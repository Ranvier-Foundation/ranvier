import { decodeFunctionData, encodeFunctionData, type Hex } from 'viem';

/**
 * 0x AllowanceHolder entry point, as in 0x-settler `src/allowanceholder/AllowanceHolderBase.sol`:
 * `exec(address operator, address token, uint256 amount, address payable target, bytes data)`,
 * selector 0x2213bc0b. It grants `operator` a transient allowance of `amount` of `token` from
 * the caller, then calls `target` with `data` and the call's value.
 */
export const ALLOWANCE_HOLDER_ABI = [
  {
    type: 'function',
    name: 'exec',
    stateMutability: 'payable',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'target', type: 'address' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [{ name: 'result', type: 'bytes' }],
  },
] as const;

/**
 * 0x Settler taker-submitted entry point:
 * `execute((address recipient, address buyToken, uint256 minAmountOut) slippage, bytes[] actions,
 * bytes32 zid)`, selector 0x1fff991f. Settler reverts unless `recipient` receives at least
 * `minAmountOut` of `buyToken` (0xeeee...eeee for the native coin).
 */
export const SETTLER_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'slippage',
        type: 'tuple',
        components: [
          { name: 'recipient', type: 'address' },
          { name: 'buyToken', type: 'address' },
          { name: 'minAmountOut', type: 'uint256' },
        ],
      },
      { name: 'actions', type: 'bytes[]' },
      { name: 'zid', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export const ALLOWANCE_HOLDER_EXEC_SELECTOR = '0x2213bc0b';
export const SETTLER_EXECUTE_SELECTOR = '0x1fff991f';

/**
 * How 0x encodes the native coin, verified against mainnet Settler transactions: as the
 * AllowanceHolder `token` for native input it is the zero address (with the amount sent as
 * value); as the Settler `buyToken` for native output it is 0xeeee...eeee.
 */
export const ZEROX_NATIVE_IN = '0x0000000000000000000000000000000000000000';
export const ZEROX_NATIVE_OUT = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

export interface AllowanceHolderExec {
  operator: string;
  token: string;
  amount: bigint;
  target: string;
  data: Hex;
}

export interface SettlerExecute {
  recipient: string;
  buyToken: string;
  minAmountOut: bigint;
}

const lower = (a: string): string => a.toLowerCase();

/**
 * Re-encoding the decoded arguments must reproduce the input byte for byte. This refuses
 * non-canonical calldata (dirty high bits in addresses, unusual offsets, trailing bytes) that
 * a lenient decoder accepts but that could be read differently on-chain.
 */
function requireCanonical(input: Hex, reencoded: Hex): void {
  if (input.toLowerCase() !== reencoded.toLowerCase()) throw new Error('non-canonical calldata');
}

/** Decodes canonical AllowanceHolder `exec` calldata; addresses are lowercased. Throws otherwise. */
export function decodeAllowanceHolderExec(data: Hex): AllowanceHolderExec {
  if (data.slice(0, 10).toLowerCase() !== ALLOWANCE_HOLDER_EXEC_SELECTOR) {
    throw new Error('not an AllowanceHolder exec call');
  }
  const { args } = decodeFunctionData({ abi: ALLOWANCE_HOLDER_ABI, data });
  requireCanonical(
    data,
    encodeFunctionData({ abi: ALLOWANCE_HOLDER_ABI, functionName: 'exec', args }),
  );
  const [operator, token, amount, target, inner] = args;
  return {
    operator: lower(operator),
    token: lower(token),
    amount,
    target: lower(target),
    data: inner,
  };
}

/** Decodes canonical Settler `execute` calldata; addresses are lowercased. Throws otherwise. */
export function decodeSettlerExecute(data: Hex): SettlerExecute {
  if (data.slice(0, 10).toLowerCase() !== SETTLER_EXECUTE_SELECTOR) {
    throw new Error('not a Settler execute call');
  }
  const { args } = decodeFunctionData({ abi: SETTLER_ABI, data });
  requireCanonical(data, encodeFunctionData({ abi: SETTLER_ABI, functionName: 'execute', args }));
  const [slippage] = args;
  return {
    recipient: lower(slippage.recipient),
    buyToken: lower(slippage.buyToken),
    minAmountOut: slippage.minAmountOut,
  };
}
