// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// LOCAL TEST HARNESS ONLY (ADR 0013). Chain 31337 only. End-to-end approve + swap through the real
// FeeWrapper and the harness mocks on a plain anvil, after DeployHarness.s.sol:
//
//   run()    broadcasts as --sender (the user, anvil account 2): mint 1 hWETH, approve the wrapper
//            for exactly 1 hWETH, swap it for hUSDC with a quote signed here; then checks the result
//            and that replaying the same signed swap reverts NonceAlreadyUsed.
//   check()  reads the chain afterwards (no broadcast) and checks the same things against it.
//
// The quote is signed in memory with the fee signer key derived from the published anvil mnemonic
// (PUBLIC anvil key, chain 31337 only). No key literal is written anywhere.

import {Script, console} from "forge-std/Script.sol";
import {FeeWrapper} from "../../src/FeeWrapper.sol";
import {HarnessConfig} from "./HarnessConfig.sol";
import {HarnessToken, HarnessWETH} from "./HarnessTokens.sol";
import {MockAllowanceHolder, MockSettler} from "./ZeroXMocks.sol";

contract HarnessSmoke is Script {
    uint256 internal constant AMOUNT_IN = 1 ether; // hWETH
    uint256 internal constant FEE = 0.002 ether; // 20 bps
    uint256 internal constant ROUTED = AMOUNT_IN - FEE;
    uint256 internal constant EXPECTED_OUT = 2_994e6; // 0.998 hWETH at $3,000, in hUSDC
    uint256 internal constant MIN_OUT = 2_979_030_000; // ceil(2,994 * (1 - 0.5%)), as signedMinimum
    uint256 internal constant NONCE = uint256(keccak256("ranvier.harness.smoke"));
    /// @dev Fixed so `check()` can rebuild the identical signed transaction (2100-01-01).
    uint256 internal constant DEADLINE = 4_102_444_800;

    HarnessWETH internal constant HWETH = HarnessWETH(payable(HarnessConfig.HWETH));
    HarnessToken internal constant HUSDC = HarnessToken(HarnessConfig.HUSDC);

    error NotLocalChain(uint256 chainId);

    function run() external {
        address user = msg.sender;
        (FeeWrapper wrapper, FeeWrapper.SwapQuote memory q, bytes memory data, bytes memory sig) = _prepare(user);
        uint256 userOutBefore = HUSDC.balanceOf(user);
        uint256 userInBefore = HWETH.balanceOf(user);
        uint256 collectorBefore = HWETH.balanceOf(wrapper.feeCollector());

        vm.startBroadcast();
        HWETH.mint(user, AMOUNT_IN);
        HWETH.approve(address(wrapper), AMOUNT_IN);
        uint256 out = wrapper.swap(q, sig, data);
        vm.stopBroadcast();

        require(out == EXPECTED_OUT, "swap returned the wrong amount");
        require(HUSDC.balanceOf(user) - userOutBefore == EXPECTED_OUT, "user did not receive the output");
        require(HWETH.balanceOf(user) == userInBefore, "user input not fully spent");
        require(HWETH.balanceOf(wrapper.feeCollector()) - collectorBefore == FEE, "collector did not get the fee");
        _checkWrapperEmpty(wrapper);
        _checkReplayReverts(wrapper, user, q, data, sig);
        console.log("smoke ok: user received hUSDC", out);
    }

    /// @notice Against the chain after `run()` on a fresh anvil: absolute balances, nonce, replay.
    function check() external {
        address user = msg.sender;
        (FeeWrapper wrapper, FeeWrapper.SwapQuote memory q, bytes memory data, bytes memory sig) = _prepare(user);
        require(HUSDC.balanceOf(user) == EXPECTED_OUT, "user hUSDC balance");
        require(HWETH.balanceOf(user) == 0, "user hWETH balance");
        require(HWETH.balanceOf(wrapper.feeCollector()) == FEE, "collector hWETH balance");
        require(HWETH.balanceOf(HarnessConfig.SETTLER) == ROUTED, "settler hWETH balance");
        require(wrapper.nonceUsed(user, NONCE), "nonce not used");
        _checkWrapperEmpty(wrapper);
        _checkReplayReverts(wrapper, user, q, data, sig);
        console.log("check ok: user hUSDC", HUSDC.balanceOf(user));
        console.log("check ok: collector hWETH fee", HWETH.balanceOf(wrapper.feeCollector()));
    }

    function _prepare(address user)
        internal
        view
        returns (FeeWrapper wrapper, FeeWrapper.SwapQuote memory q, bytes memory data, bytes memory sig)
    {
        if (block.chainid != HarnessConfig.CHAIN_ID) revert NotLocalChain(block.chainid);
        wrapper = FeeWrapper(payable(vm.envOr("FEE_WRAPPER_ADDRESS", HarnessConfig.FEE_WRAPPER)));
        require(address(wrapper).code.length > 0, "no wrapper: run DeployHarness.s.sol first");
        require(wrapper.isRouterAllowed(HarnessConfig.ALLOWANCE_HOLDER), "mock holder not allowlisted");

        bytes memory inner = abi.encodeCall(
            MockSettler.execute,
            (MockSettler.AllowedSlippage(user, HarnessConfig.HUSDC, MIN_OUT), new bytes[](0), bytes32(0))
        );
        data = abi.encodeCall(
            MockAllowanceHolder.exec,
            (HarnessConfig.SETTLER, HarnessConfig.HWETH, ROUTED, payable(HarnessConfig.SETTLER), inner)
        );
        q = FeeWrapper.SwapQuote({
            user: user,
            tokenIn: HarnessConfig.HWETH,
            tokenOut: HarnessConfig.HUSDC,
            amountIn: AMOUNT_IN,
            minAmountOut: MIN_OUT,
            feeAmount: FEE,
            router: HarnessConfig.ALLOWANCE_HOLDER,
            routerCalldataHash: keccak256(data),
            nonce: NONCE,
            deadline: DEADLINE
        });

        // PUBLIC anvil key, chain 31337 only: anvil account 1, derived in memory, never printed.
        uint256 feeSignerKey = vm.deriveKey(HarnessConfig.ANVIL_MNEMONIC, HarnessConfig.FEE_SIGNER_INDEX);
        require(vm.addr(feeSignerKey) == wrapper.feeSigner(), "wrapper fee signer is not anvil account 1");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(feeSignerKey, wrapper.hashQuote(q));
        sig = abi.encodePacked(r, s, v);
    }

    function _checkWrapperEmpty(FeeWrapper wrapper) internal view {
        require(HWETH.balanceOf(address(wrapper)) == 0, "wrapper holds hWETH");
        require(HUSDC.balanceOf(address(wrapper)) == 0, "wrapper holds hUSDC");
        require(address(wrapper).balance == 0, "wrapper holds ETH");
        require(HWETH.allowance(address(wrapper), HarnessConfig.ALLOWANCE_HOLDER) == 0, "allowance not reset");
    }

    /// @dev Simulated only (not broadcast): the identical signed swap, sent again by the user.
    function _checkReplayReverts(
        FeeWrapper wrapper,
        address user,
        FeeWrapper.SwapQuote memory q,
        bytes memory data,
        bytes memory sig
    ) internal {
        vm.prank(user);
        try wrapper.swap(q, sig, data) {
            revert("replay was accepted");
        } catch (bytes memory err) {
            require(bytes4(err) == FeeWrapper.NonceAlreadyUsed.selector, "replay reverted for another reason");
        }
        console.log("replay reverts NonceAlreadyUsed (0x1fb09b80)");
    }
}
