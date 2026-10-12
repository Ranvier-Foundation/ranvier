// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {FeeWrapper} from "../src/FeeWrapper.sol";

/// @notice Golden values produced by the API's TypeScript signer (apps/api/src/domain/swap-quote.ts).
///         If the EIP-712 encoding drifts on either side, every swap would revert, so both
///         test suites assert the same digest and signature.
contract QuoteSigningCompatTest is Test {
    address constant WRAPPER = 0x000000000000000000000000000000000000FEE1;
    address constant SIGNER = 0xe05fcC23807536bEe418f142D19fa0d21BB0cfF7;
    bytes32 constant DIGEST = 0xc5c18c006aa73b004031c786d634987179d5325425f6632c4350925c89a0e276;
    bytes constant SIGNATURE =
        hex"e2b5fbde8e1861cd293e88340c35d39d0b498d7336cf651f504df0c242c99cd83f0cc31e6cb7edc8b3a86f47475b9f9ad441a104a51baba96992e80d5e47c1d81b";

    FeeWrapper wrapper;

    function setUp() public {
        vm.chainId(31337);
        deployCodeTo(
            "FeeWrapper.sol:FeeWrapper",
            abi.encode(address(this), makeAddr("collector"), SIGNER, makeAddr("guardian")),
            WRAPPER
        );
        wrapper = FeeWrapper(payable(WRAPPER));
    }

    function _goldenQuote() internal pure returns (FeeWrapper.SwapQuote memory) {
        return FeeWrapper.SwapQuote({
            user: 0x00000000000000000000000000000000000000AA,
            tokenIn: 0x00000000000000000000000000000000000000B1,
            tokenOut: 0x00000000000000000000000000000000000000c2,
            amountIn: 1_000_000_000,
            minAmountOut: 1e18,
            feeAmount: 1_234_567,
            router: 0x0000000000001fF3684f28c67538d4D072C22734,
            routerCalldataHash: keccak256(hex"1234"),
            nonce: 42,
            deadline: 1_800_000_000
        });
    }

    function test_digestMatchesTypeScript() public view {
        assertEq(wrapper.hashQuote(_goldenQuote()), DIGEST);
    }

    function test_signatureFromTypeScriptRecoversSigner() public view {
        assertEq(ECDSA.recover(wrapper.hashQuote(_goldenQuote()), SIGNATURE), SIGNER);
        assertEq(wrapper.feeSigner(), SIGNER);
    }
}
