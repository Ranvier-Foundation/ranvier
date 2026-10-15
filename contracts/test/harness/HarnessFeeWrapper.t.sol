// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {FeeWrapper} from "../../src/FeeWrapper.sol";
import {HarnessFixture} from "./HarnessFixture.sol";
import {IHarnessTokenHook} from "./HarnessTokens.sol";
import {MockAllowanceHolder, MockSettler} from "./ZeroXMocks.sol";

/// @dev A user contract whose ERC-777-style send hook re-enters the wrapper mid-swap.
contract HookReentrantUser is IHarnessTokenHook {
    FeeWrapper internal immutable wrapper;

    constructor(FeeWrapper wrapper_) {
        wrapper = wrapper_;
    }

    function call(address target, bytes calldata data) external {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    function swap(FeeWrapper.SwapQuote calldata q, bytes calldata sig, bytes calldata data) external {
        wrapper.swap(q, sig, data);
    }

    function tokensToSend(address, address, address, uint256) external {
        FeeWrapper.SwapQuote memory empty;
        wrapper.swap(empty, "", "");
    }

    function tokensReceived(address, address, address, uint256) external {}
}

/// @notice The real FeeWrapper against every harness router behaviour and token quirk (ADR 0013,
///         section 3). Each test passes only because a specific wrapper guard holds.
contract HarnessFeeWrapperTest is HarnessFixture {
    // ------------------------------------------------------------ happy paths

    /// The spike's swap: 1 hWETH at 20 bps for hUSDC at $3,000, minimum at 50 bps slippage.
    function test_happy_hwethToHusdc() public {
        m.hweth.mint(user, 1 ether);
        vm.prank(user);
        m.hweth.approve(address(wrapper), 1 ether);
        (FeeWrapper.SwapQuote memory q, bytes memory data, bytes memory sig) =
            _quote(address(m.hweth), address(m.husdc), 1 ether, 2_979_030_000, 20);

        assertEq(_swap(q, data, sig), 2_994e6);
        assertEq(m.husdc.balanceOf(user), 2_994e6);
        assertEq(m.hweth.balanceOf(collector), 0.002 ether);
        assertEq(m.hweth.balanceOf(address(m.settler)), 0.998 ether);
        assertEq(m.hweth.balanceOf(user), 0);
        _assertWrapperEmpty(address(m.hweth));
        _assertWrapperEmpty(address(m.husdc));
    }

    function test_happy_husdcToNative_paidByRouter() public {
        m.husdc.mint(user, 3_000e6);
        vm.prank(user);
        m.husdc.approve(address(wrapper), 3_000e6);
        (FeeWrapper.SwapQuote memory q, bytes memory data, bytes memory sig) =
            _quote(address(m.husdc), NATIVE, 3_000e6, 0.99 ether, 20);
        uint256 before = user.balance;
        assertEq(_swap(q, data, sig), 0.998 ether);
        assertEq(user.balance, before + 0.998 ether);
        assertEq(m.husdc.balanceOf(collector), 6e6);
        _assertWrapperEmpty(address(m.husdc));
    }

    // ------------------------------------------------------------ (e) native input

    function test_e_nativeIn_forwardsExactlyAmountMinusFee() public {
        (FeeWrapper.SwapQuote memory q, bytes memory data, bytes memory sig) =
            _quote(NATIVE, address(m.husdc), 1 ether, 2_979_030_000, 20);
        uint256 settlerBefore = address(m.settler).balance;
        uint256 userBefore = user.balance;
        // The holder refuses any value other than its `amount`, so this proves the forwarded value.
        vm.expectCall(address(m.holder), 0.998 ether, data);
        assertEq(_swap(q, data, sig), 2_994e6);
        assertEq(address(m.settler).balance, settlerBefore + 0.998 ether);
        assertEq(collector.balance, 0.002 ether);
        assertEq(user.balance, userBefore - 1 ether);
        _assertWrapperEmpty(NATIVE);
    }

    function test_e_nativeIn_amountNotForwardedValue_reverts() public {
        // Calldata names the gross amount, but the wrapper forwards amount - fee: the holder refuses.
        bytes memory inner = abi.encodeCall(
            MockSettler.execute, (MockSettler.AllowedSlippage(user, address(m.husdc), 1), new bytes[](0), bytes32(0))
        );
        bytes memory data = abi.encodeCall(
            MockAllowanceHolder.exec, (address(m.settler), NATIVE, 1 ether, payable(address(m.settler)), inner)
        );
        FeeWrapper.SwapQuote memory q = FeeWrapper.SwapQuote({
            user: user,
            tokenIn: NATIVE,
            tokenOut: address(m.husdc),
            amountIn: 1 ether,
            minAmountOut: 1,
            feeAmount: 0.002 ether,
            router: address(m.holder),
            routerCalldataHash: keccak256(data),
            nonce: 99,
            deadline: block.timestamp + 60
        });
        _expectSwapRevert(
            q,
            data,
            _sign(q),
            abi.encodeWithSelector(MockAllowanceHolder.NativeValueMismatch.selector, 0.998 ether, 1 ether)
        );
    }

    // ------------------------------------------------------------ (a) underpays

    function test_a_underpay_wrapperRevertsInsufficientOutput() public {
        m.husdc.mint(user, 1_000e6);
        vm.prank(user);
        m.husdc.approve(address(wrapper), 1_000e6);
        (FeeWrapper.SwapQuote memory q, bytes memory data, bytes memory sig) =
            _quote(address(m.husdc), address(m.hunder), 1_000e6, 993e6, 20);
        _expectSwapRevert(q, data, sig, abi.encodeWithSelector(FeeWrapper.InsufficientOutput.selector));
    }

    // ------------------------------------------------------------ (b) pays the wrapper

    function test_b_paysWrapper_outputForwardedToUser() public {
        m.husdc.mint(user, 1_000e6);
        vm.prank(user);
        m.husdc.approve(address(wrapper), 1_000e6);
        (FeeWrapper.SwapQuote memory q, bytes memory data, bytes memory sig) =
            _quote(address(m.husdc), address(m.hpaywrap), 1_000e6, 998e6, 20);
        assertEq(_swap(q, data, sig), 998e6);
        assertEq(m.hpaywrap.balanceOf(user), 998e6);
        _assertWrapperEmpty(address(m.hpaywrap));
        _assertWrapperEmpty(address(m.husdc));
    }

    // ------------------------------------------------------------ (c) spends less than amount

    function test_c_spendsLess_refundsInputAndResetsApproval() public {
        m.husdc.mint(user, 1_000e6);
        vm.prank(user);
        m.husdc.approve(address(wrapper), 1_000e6);
        (FeeWrapper.SwapQuote memory q, bytes memory data, bytes memory sig) =
            _quote(address(m.husdc), address(m.hspend), 1_000e6, 499e6, 20);
        assertEq(_swap(q, data, sig), 499e6);
        // 1,000 in, 2 fee, 998 routed, 499 spent: 499 comes back.
        assertEq(m.husdc.balanceOf(user), 499e6);
        assertEq(m.husdc.balanceOf(address(m.settler)), 499e6);
        assertEq(m.husdc.balanceOf(collector), 2e6);
        _assertWrapperEmpty(address(m.husdc));
    }

    function test_c_nativeSpendsLess_refundsNative() public {
        (FeeWrapper.SwapQuote memory q, bytes memory data, bytes memory sig) =
            _quote(NATIVE, address(m.hspend), 1 ether, 1_497e6, 20);
        uint256 before = user.balance;
        assertEq(_swap(q, data, sig), 1_497e6);
        assertEq(user.balance, before - 0.002 ether - 0.499 ether);
        _assertWrapperEmpty(NATIVE);
    }

    // ------------------------------------------------------------ (d) pulls as the holder

    function test_d_holderPullsFromWrapperToSettler() public {
        m.hweth.mint(user, 1 ether);
        vm.prank(user);
        m.hweth.approve(address(wrapper), 1 ether);
        (FeeWrapper.SwapQuote memory q, bytes memory data, bytes memory sig) =
            _quote(address(m.hweth), address(m.husdc), 1 ether, 1, 20);
        // The wrapper approves exactly what it routes, to the router it calls...
        vm.expectCall(address(m.hweth), abi.encodeWithSignature("approve(address,uint256)", m.holder, 0.998 ether));
        // ...and the input moves wrapper -> settler, spent through that approval by the holder.
        vm.expectCall(
            address(m.hweth),
            abi.encodeWithSignature("transferFrom(address,address,uint256)", wrapper, m.settler, 0.998 ether)
        );
        _swap(q, data, sig);
        _assertWrapperEmpty(address(m.hweth));
    }

    // ------------------------------------------------------------ (f) router reverts

    function test_f_revertData_bubblesUnchanged() public {
        m.husdc.mint(user, 1_000e6);
        vm.prank(user);
        m.husdc.approve(address(wrapper), 1_000e6);
        (FeeWrapper.SwapQuote memory q, bytes memory data, bytes memory sig) =
            _quote(address(m.husdc), address(m.hrevert), 1_000e6, 1, 20);
        _expectSwapRevert(
            q, data, sig, abi.encodeWithSelector(MockSettler.MockSettlerFailed.selector, m.husdc, m.hrevert, 998e6)
        );
    }

    function test_f_hugeRevert_bubblesWholePayload() public {
        m.husdc.mint(user, 1_000e6);
        vm.prank(user);
        m.husdc.approve(address(wrapper), 1_000e6);
        (FeeWrapper.SwapQuote memory q, bytes memory data, bytes memory sig) =
            _quote(address(m.husdc), address(m.hbigrev), 1_000e6, 1, 20);

        uint256 size = m.settler.HUGE_REVERT_BYTES();
        bytes memory expected = new bytes(size);
        bytes4 selector = MockSettler.MockSettlerHugeRevert.selector;
        assembly ("memory-safe") {
            mstore(add(expected, 0x20), selector)
        }

        vm.prank(user);
        uint256 gasBefore = gasleft();
        (bool ok, bytes memory ret) = address(wrapper).call(abi.encodeCall(FeeWrapper.swap, (q, sig, data)));
        uint256 gasUsed = gasBefore - gasleft();
        console.log("gas for a 1 MiB router revert through the wrapper", gasUsed);

        assertFalse(ok);
        assertEq(ret.length, size);
        assertEq(keccak256(ret), keccak256(expected));
        // The caller pays for the copies; it stays well inside a block.
        assertLt(gasUsed, 15_000_000);
    }

    // ------------------------------------------------------------ (g) re-entry

    function test_g_routerReentersSwap_blockedByNonReentrant() public {
        m.husdc.mint(user, 1_000e6);
        vm.prank(user);
        m.husdc.approve(address(wrapper), 1_000e6);
        (FeeWrapper.SwapQuote memory q, bytes memory data, bytes memory sig) =
            _quote(address(m.husdc), address(m.hreenter), 1_000e6, 1, 20);
        _expectSwapRevert(q, data, sig, abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
    }

    // ------------------------------------------------------------ under the oracle

    /// The wrapper does not price routes: a route 10% under the oracle executes if it meets the
    /// signed minimum. Refusing it is vetRoute's job (below_oracle_value), before anything is signed.
    function test_underOracle_executesAtNinetyPercent() public {
        m.husdc.mint(user, 1_000e6);
        vm.prank(user);
        m.husdc.approve(address(wrapper), 1_000e6);
        (FeeWrapper.SwapQuote memory q, bytes memory data, bytes memory sig) =
            _quote(address(m.husdc), address(m.horacle), 1_000e6, 898.2e6, 20);
        assertEq(_swap(q, data, sig), 898.2e6);
        _assertWrapperEmpty(address(m.husdc));
    }

    // ------------------------------------------------------------ token quirks

    /// No return values anywhere, and approve from non-zero reverts: only forceApprove works.
    function test_usdtStyle_inAndOut_twice() public {
        m.husdt.mint(user, 2_000e6);
        vm.prank(user);
        m.husdt.approve(address(wrapper), 2_000e6);
        (FeeWrapper.SwapQuote memory q, bytes memory data, bytes memory sig) =
            _quote(address(m.husdt), address(m.husdc), 1_000e6, 998e6, 20);
        assertEq(_swap(q, data, sig), 998e6);
        _assertWrapperEmpty(address(m.husdt));
        (q, data, sig) = _quote(address(m.husdt), address(m.husdc), 1_000e6, 998e6, 20);
        assertEq(_swap(q, data, sig), 998e6);
        assertEq(m.husdt.balanceOf(collector), 4e6);
        _assertWrapperEmpty(address(m.husdt));

        // hUSDT as output: the router mints it to the user.
        m.husdc.mint(user, 100e6);
        vm.prank(user);
        m.husdc.approve(address(wrapper), 100e6);
        (q, data, sig) = _quote(address(m.husdc), address(m.husdt), 100e6, 99.8e6, 20);
        assertEq(_swap(q, data, sig), 99.8e6);
    }

    function test_falseReturningToken_refused() public {
        m.hfalse.mint(user, 1_000e6);
        vm.prank(user);
        m.hfalse.approve(address(wrapper), 1_000e6);
        (FeeWrapper.SwapQuote memory q, bytes memory data, bytes memory sig) =
            _quote(address(m.hfalse), address(m.husdc), 1_000e6, 1, 20);
        _expectSwapRevert(q, data, sig, abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, m.hfalse));
    }

    function test_feeOnTransferToken_refusedUnsupported() public {
        m.htax.mint(user, 1_000e6);
        vm.prank(user);
        m.htax.approve(address(wrapper), 1_000e6);
        (FeeWrapper.SwapQuote memory q, bytes memory data, bytes memory sig) =
            _quote(address(m.htax), address(m.husdc), 1_000e6, 1, 20);
        _expectSwapRevert(q, data, sig, abi.encodeWithSelector(FeeWrapper.UnsupportedToken.selector));
    }

    function test_hookToken_withoutHook_swaps() public {
        m.hhook.mint(user, 1_000e6);
        vm.prank(user);
        m.hhook.approve(address(wrapper), 1_000e6);
        (FeeWrapper.SwapQuote memory q, bytes memory data, bytes memory sig) =
            _quote(address(m.hhook), address(m.husdc), 1_000e6, 998e6, 20);
        assertEq(_swap(q, data, sig), 998e6);
        _assertWrapperEmpty(address(m.hhook));
    }

    function test_hookToken_sendHookReentersSwap_blocked() public {
        HookReentrantUser attacker = new HookReentrantUser(wrapper);
        m.hhook.mint(address(attacker), 1_000e6);
        attacker.call(address(m.hhook), abi.encodeWithSignature("approve(address,uint256)", wrapper, 1_000e6));
        attacker.call(address(m.hhook), abi.encodeWithSignature("setHook(address)", attacker));
        (FeeWrapper.SwapQuote memory q, bytes memory data, bytes memory sig) =
            _quoteFor(address(attacker), address(m.hhook), address(m.husdc), 1_000e6, 1, 20);
        vm.expectRevert(abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector));
        attacker.swap(q, sig, data);
    }

    /// The wrapper approves the router it calls. A caller that has not approved the holder (here
    /// the test contract, holding the input) cannot be pulled from.
    function test_d_unapprovedHolder_cannotPull() public {
        m.husdc.mint(address(this), 10e6);
        bytes memory inner = abi.encodeCall(
            MockSettler.execute,
            (MockSettler.AllowedSlippage(address(this), address(m.hweth), 1), new bytes[](0), bytes32(0))
        );
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, m.holder, 0, 10e6));
        m.holder.exec(address(m.settler), address(m.husdc), 10e6, payable(address(m.settler)), inner);
    }
}
