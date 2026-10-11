// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {FeeWrapper} from "../src/FeeWrapper.sol";
import {FeeOnTransferToken, MockERC20, MockRouter, ReentrantRouter, RejectsNative} from "./mocks/Mocks.sol";

contract FeeWrapperTest is Test {
    address constant NATIVE = address(0);

    FeeWrapper wrapper;
    MockRouter router;
    MockERC20 usdc;
    MockERC20 weth;

    address owner = makeAddr("owner");
    address collector = makeAddr("collector");
    address guardian = makeAddr("guardian");
    address user = makeAddr("user");
    uint256 signerKey = 0xA11CE;
    address signer = vm.addr(signerKey);

    function setUp() public {
        wrapper = new FeeWrapper(owner, collector, signer, guardian);
        router = new MockRouter();
        usdc = new MockERC20("USDC");
        weth = new MockERC20("WETH");
        vm.prank(owner);
        wrapper.setRouter(address(router), true);

        usdc.mint(user, 1_000_000e6);
        vm.prank(user);
        usdc.approve(address(wrapper), type(uint256).max);
        vm.deal(user, 1_000 ether);
        vm.deal(address(router), 1_000 ether);
    }

    // ------------------------------------------------------------ helpers

    function _routerCall(address tokenIn, address tokenOut, uint256 spend, uint256 out, address recipient)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(MockRouter.swap, (tokenIn, tokenOut, spend, out, recipient));
    }

    function _quote(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint16 feeBps,
        bytes memory data
    ) internal view returns (FeeWrapper.SwapQuote memory) {
        return FeeWrapper.SwapQuote({
            user: user,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: minOut,
            feeBps: feeBps,
            router: address(router),
            routerCalldataHash: keccak256(data),
            nonce: 1,
            deadline: block.timestamp + 60
        });
    }

    function _sign(FeeWrapper.SwapQuote memory q) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, wrapper.hashQuote(q));
        return abi.encodePacked(r, s, v);
    }

    /// @dev Standard USDC -> WETH swap: 1,000 USDC in at 20 bps, router spends all of the rest.
    function _usdcToWeth() internal view returns (FeeWrapper.SwapQuote memory q, bytes memory data) {
        data = _routerCall(address(usdc), address(weth), 998e6, 1 ether, user);
        q = _quote(address(usdc), address(weth), 1_000e6, 1 ether, 20, data);
    }

    function _expectRevert(FeeWrapper.SwapQuote memory q, bytes memory sig, bytes memory data, bytes4 err) internal {
        vm.prank(user);
        vm.expectRevert(err);
        wrapper.swap(q, sig, data);
    }

    // ------------------------------------------------------------ happy paths

    function test_erc20ToErc20_takesFeeAndDeliversOutput() public {
        (FeeWrapper.SwapQuote memory q, bytes memory data) = _usdcToWeth();
        vm.expectEmit(address(wrapper));
        emit FeeWrapper.SwapExecuted(user, address(usdc), address(weth), 1_000e6, 1 ether, 2e6, 20, address(router), 1);
        bytes memory sig1 = _sign(q);
        vm.prank(user);
        uint256 out = wrapper.swap(q, sig1, data);

        assertEq(out, 1 ether);
        assertEq(weth.balanceOf(user), 1 ether);
        assertEq(usdc.balanceOf(collector), 2e6);
        assertEq(usdc.balanceOf(address(router)), 998e6);
        assertEq(usdc.balanceOf(address(wrapper)), 0);
        assertEq(usdc.allowance(address(wrapper), address(router)), 0);
        assertTrue(wrapper.nonceUsed(user, 1));
    }

    function test_nativeIn_takesFeeInNative() public {
        bytes memory data = _routerCall(NATIVE, address(usdc), 0.998 ether, 2_000e6, user);
        FeeWrapper.SwapQuote memory q = _quote(NATIVE, address(usdc), 1 ether, 2_000e6, 20, data);
        uint256 before = user.balance;
        bytes memory sig2 = _sign(q);
        vm.prank(user);
        wrapper.swap{value: 1 ether}(q, sig2, data);

        assertEq(collector.balance, 0.002 ether);
        assertEq(user.balance, before - 1 ether);
        assertEq(address(wrapper).balance, 0);
    }

    function test_nativeOut_paidToWrapper_isForwarded() public {
        bytes memory data = _routerCall(address(usdc), NATIVE, 998e6, 0.5 ether, address(wrapper));
        FeeWrapper.SwapQuote memory q = _quote(address(usdc), NATIVE, 1_000e6, 0.5 ether, 20, data);
        uint256 before = user.balance;
        bytes memory sig3 = _sign(q);
        vm.prank(user);
        uint256 out = wrapper.swap(q, sig3, data);

        assertEq(out, 0.5 ether);
        assertEq(user.balance, before + 0.5 ether);
        assertEq(address(wrapper).balance, 0);
    }

    function test_erc20Out_paidToWrapper_isForwarded() public {
        bytes memory data = _routerCall(address(usdc), address(weth), 998e6, 1 ether, address(wrapper));
        FeeWrapper.SwapQuote memory q = _quote(address(usdc), address(weth), 1_000e6, 1 ether, 20, data);
        bytes memory sig4 = _sign(q);
        vm.prank(user);
        wrapper.swap(q, sig4, data);
        assertEq(weth.balanceOf(user), 1 ether);
        assertEq(weth.balanceOf(address(wrapper)), 0);
    }

    function test_unspentInput_isReturned() public {
        bytes memory data = _routerCall(address(usdc), address(weth), 500e6, 1 ether, user);
        FeeWrapper.SwapQuote memory q = _quote(address(usdc), address(weth), 1_000e6, 1 ether, 20, data);
        bytes memory sig5 = _sign(q);
        vm.prank(user);
        wrapper.swap(q, sig5, data);
        assertEq(usdc.balanceOf(user), 1_000_000e6 - 2e6 - 500e6);
        assertEq(usdc.balanceOf(address(wrapper)), 0);
    }

    function test_unspentNativeInput_isReturned() public {
        bytes memory data = _routerCall(NATIVE, address(usdc), 0.5 ether, 1_000e6, user);
        FeeWrapper.SwapQuote memory q = _quote(NATIVE, address(usdc), 1 ether, 1_000e6, 20, data);
        uint256 before = user.balance;
        bytes memory sig6 = _sign(q);
        vm.prank(user);
        wrapper.swap{value: 1 ether}(q, sig6, data);
        assertEq(user.balance, before - 0.002 ether - 0.5 ether);
        assertEq(address(wrapper).balance, 0);
    }

    function test_zeroFee_sendsNothingToCollector() public {
        bytes memory data = _routerCall(address(usdc), address(weth), 1_000e6, 1 ether, user);
        FeeWrapper.SwapQuote memory q = _quote(address(usdc), address(weth), 1_000e6, 1 ether, 0, data);
        bytes memory sig7 = _sign(q);
        vm.prank(user);
        wrapper.swap(q, sig7, data);
        assertEq(usdc.balanceOf(collector), 0);

        bytes memory nativeData = _routerCall(NATIVE, address(usdc), 1 ether, 1, user);
        FeeWrapper.SwapQuote memory nq = _quote(NATIVE, address(usdc), 1 ether, 1, 0, nativeData);
        nq.nonce = 2;
        bytes memory sig8 = _sign(nq);
        vm.prank(user);
        wrapper.swap{value: 1 ether}(nq, sig8, nativeData);
        assertEq(collector.balance, 0);
    }

    function test_positiveSlippage_staysWithUser() public {
        bytes memory data = _routerCall(address(usdc), address(weth), 998e6, 1.1 ether, user);
        FeeWrapper.SwapQuote memory q = _quote(address(usdc), address(weth), 1_000e6, 1 ether, 20, data);
        bytes memory sig9 = _sign(q);
        vm.prank(user);
        assertEq(wrapper.swap(q, sig9, data), 1.1 ether);
    }

    function test_preexistingBalance_isNotPaidToUser() public {
        usdc.mint(address(wrapper), 5e6);
        (FeeWrapper.SwapQuote memory q, bytes memory data) = _usdcToWeth();
        bytes memory sig10 = _sign(q);
        vm.prank(user);
        wrapper.swap(q, sig10, data);
        assertEq(usdc.balanceOf(address(wrapper)), 5e6);
    }

    // ------------------------------------------------------------ quote validation

    function test_revert_notQuoteUser() public {
        (FeeWrapper.SwapQuote memory q, bytes memory data) = _usdcToWeth();
        bytes memory sig = _sign(q);
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(FeeWrapper.NotQuoteUser.selector);
        wrapper.swap(q, sig, data);
    }

    function test_revert_expired() public {
        (FeeWrapper.SwapQuote memory q, bytes memory data) = _usdcToWeth();
        bytes memory sig = _sign(q);
        vm.warp(q.deadline + 1);
        _expectRevert(q, sig, data, FeeWrapper.QuoteExpired.selector);
    }

    function test_revert_feeAboveCap() public {
        (FeeWrapper.SwapQuote memory q, bytes memory data) = _usdcToWeth();
        q.feeBps = 31;
        _expectRevert(q, _sign(q), data, FeeWrapper.FeeAboveCap.selector);
    }

    function test_revert_routerNotAllowed() public {
        (FeeWrapper.SwapQuote memory q, bytes memory data) = _usdcToWeth();
        q.router = address(usdc);
        _expectRevert(q, _sign(q), data, FeeWrapper.RouterNotAllowed.selector);
    }

    function test_revert_sameToken() public {
        bytes memory data = _routerCall(address(usdc), address(usdc), 1, 1, user);
        FeeWrapper.SwapQuote memory q = _quote(address(usdc), address(usdc), 1_000e6, 0, 20, data);
        _expectRevert(q, _sign(q), data, FeeWrapper.SameToken.selector);
    }

    function test_revert_calldataMismatch() public {
        (FeeWrapper.SwapQuote memory q,) = _usdcToWeth();
        bytes memory other = _routerCall(address(usdc), address(weth), 998e6, 1 ether, makeAddr("thief"));
        _expectRevert(q, _sign(q), other, FeeWrapper.CalldataMismatch.selector);
    }

    function test_revert_nonceReplay() public {
        (FeeWrapper.SwapQuote memory q, bytes memory data) = _usdcToWeth();
        bytes memory sig = _sign(q);
        vm.prank(user);
        wrapper.swap(q, sig, data);
        _expectRevert(q, sig, data, FeeWrapper.NonceAlreadyUsed.selector);
    }

    function test_revert_wrongSigner() public {
        (FeeWrapper.SwapQuote memory q, bytes memory data) = _usdcToWeth();
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, wrapper.hashQuote(q));
        _expectRevert(q, abi.encodePacked(r, s, v), data, FeeWrapper.InvalidSignature.selector);
    }

    function test_revert_malformedSignature() public {
        (FeeWrapper.SwapQuote memory q, bytes memory data) = _usdcToWeth();
        _expectRevert(q, hex"1234", data, FeeWrapper.InvalidSignature.selector);
    }

    function test_revert_tamperedFee() public {
        (FeeWrapper.SwapQuote memory q, bytes memory data) = _usdcToWeth();
        bytes memory sig = _sign(q);
        q.feeBps = 0;
        _expectRevert(q, sig, data, FeeWrapper.InvalidSignature.selector);
    }

    function test_revert_valueMismatch() public {
        (FeeWrapper.SwapQuote memory q, bytes memory data) = _usdcToWeth();
        bytes memory sig = _sign(q);
        vm.prank(user);
        vm.expectRevert(FeeWrapper.InvalidValue.selector);
        wrapper.swap{value: 1}(q, sig, data);

        bytes memory nativeData = _routerCall(NATIVE, address(usdc), 0.998 ether, 1, user);
        FeeWrapper.SwapQuote memory nq = _quote(NATIVE, address(usdc), 1 ether, 1, 20, nativeData);
        bytes memory nsig = _sign(nq);
        vm.prank(user);
        vm.expectRevert(FeeWrapper.InvalidValue.selector);
        wrapper.swap{value: 0.5 ether}(nq, nsig, nativeData);
    }

    // ------------------------------------------------------------ execution safety

    function test_revert_insufficientOutput() public {
        bytes memory data = _routerCall(address(usdc), address(weth), 998e6, 0.9 ether, user);
        FeeWrapper.SwapQuote memory q = _quote(address(usdc), address(weth), 1_000e6, 1 ether, 20, data);
        _expectRevert(q, _sign(q), data, FeeWrapper.InsufficientOutput.selector);
    }

    function test_revert_routerFailureBubbles() public {
        bytes memory data = abi.encodeCall(MockRouter.fail, ());
        FeeWrapper.SwapQuote memory q = _quote(address(usdc), address(weth), 1_000e6, 0, 20, data);
        bytes memory sig = _sign(q);
        vm.prank(user);
        vm.expectRevert("router failed");
        wrapper.swap(q, sig, data);
    }

    function test_revert_feeOnTransferToken() public {
        FeeOnTransferToken tax = new FeeOnTransferToken();
        tax.mint(user, 1_000e18);
        vm.prank(user);
        tax.approve(address(wrapper), type(uint256).max);
        bytes memory data = _routerCall(address(tax), address(weth), 1, 1, user);
        FeeWrapper.SwapQuote memory q = _quote(address(tax), address(weth), 100e18, 0, 20, data);
        _expectRevert(q, _sign(q), data, FeeWrapper.UnsupportedToken.selector);
    }

    function test_revert_reentrancy() public {
        ReentrantRouter attacker = new ReentrantRouter();
        vm.prank(owner);
        wrapper.setRouter(address(attacker), true);

        (FeeWrapper.SwapQuote memory inner, bytes memory innerData) = _usdcToWeth();
        inner.nonce = 2;
        bytes memory innerSig = _sign(inner);
        bytes memory data = abi.encodeCall(ReentrantRouter.attack, (wrapper, inner, innerSig, innerData));
        FeeWrapper.SwapQuote memory q = _quote(address(usdc), address(weth), 1_000e6, 0, 20, data);
        q.router = address(attacker);
        _expectRevert(q, _sign(q), data, ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
    }

    function test_revert_nativeFeeTransferFails() public {
        RejectsNative badCollector = new RejectsNative();
        FeeWrapper w = new FeeWrapper(owner, address(badCollector), signer, guardian);
        vm.prank(owner);
        w.setRouter(address(router), true);
        bytes memory data = _routerCall(NATIVE, address(usdc), 0.998 ether, 1, user);
        FeeWrapper.SwapQuote memory q = _quote(NATIVE, address(usdc), 1 ether, 1, 20, data);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, w.hashQuote(q));
        vm.prank(user);
        vm.expectRevert(FeeWrapper.NativeTransferFailed.selector);
        w.swap{value: 1 ether}(q, abi.encodePacked(r, s, v), data);
    }

    function test_revert_directNativeTransfer() public {
        vm.prank(user);
        (bool ok, bytes memory ret) = address(wrapper).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(bytes4(ret), FeeWrapper.UnexpectedNative.selector);
    }

    // ------------------------------------------------------------ admin

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(FeeWrapper.ZeroAddress.selector);
        new FeeWrapper(owner, address(0), signer, guardian);
        vm.expectRevert(FeeWrapper.ZeroAddress.selector);
        new FeeWrapper(owner, collector, address(0), guardian);
        vm.expectRevert(FeeWrapper.ZeroAddress.selector);
        new FeeWrapper(owner, collector, signer, address(0));
    }

    function test_admin_onlyOwner() public {
        address stranger = makeAddr("stranger");
        bytes memory err = abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger);
        vm.startPrank(stranger);
        vm.expectRevert(err);
        wrapper.setRouter(stranger, true);
        vm.expectRevert(err);
        wrapper.setFeeSigner(stranger);
        vm.expectRevert(err);
        wrapper.setGuardian(stranger);
        vm.expectRevert(err);
        wrapper.unpause();
        vm.stopPrank();
    }

    function test_admin_setters() public {
        address next = makeAddr("next");
        vm.startPrank(owner);
        wrapper.setRouter(next, true);
        wrapper.setFeeSigner(next);
        wrapper.setGuardian(next);
        vm.expectRevert(FeeWrapper.ZeroAddress.selector);
        wrapper.setRouter(address(0), true);
        vm.expectRevert(FeeWrapper.ZeroAddress.selector);
        wrapper.setFeeSigner(address(0));
        vm.expectRevert(FeeWrapper.ZeroAddress.selector);
        wrapper.setGuardian(address(0));
        vm.expectRevert(FeeWrapper.RenounceDisabled.selector);
        wrapper.renounceOwnership();
        vm.stopPrank();
        assertTrue(wrapper.isRouterAllowed(next));
        assertEq(wrapper.feeSigner(), next);
        assertEq(wrapper.guardian(), next);
    }

    function test_rotatedSigner_invalidatesOldQuotes() public {
        (FeeWrapper.SwapQuote memory q, bytes memory data) = _usdcToWeth();
        bytes memory sig = _sign(q);
        vm.prank(owner);
        wrapper.setFeeSigner(makeAddr("newSigner"));
        _expectRevert(q, sig, data, FeeWrapper.InvalidSignature.selector);
    }

    function test_pause_guardianCanPauseButNotUnpause() public {
        vm.prank(guardian);
        wrapper.pause();
        (FeeWrapper.SwapQuote memory q, bytes memory data) = _usdcToWeth();
        _expectRevert(q, _sign(q), data, Pausable.EnforcedPause.selector);

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, guardian));
        wrapper.unpause();

        vm.prank(owner);
        wrapper.unpause();
        bytes memory sig11 = _sign(q);
        vm.prank(user);
        wrapper.swap(q, sig11, data);
    }

    function test_pause_ownerCanPause_strangerCannot() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(FeeWrapper.NotGuardianOrOwner.selector);
        wrapper.pause();
        vm.prank(owner);
        wrapper.pause();
        assertTrue(wrapper.paused());
    }

    // ------------------------------------------------------------ fuzz: invariants

    /// Fee never exceeds the cap, the collector gets exactly the fee, and the wrapper keeps nothing.
    function testFuzz_feeAndNoRetainedFunds(uint256 amountIn, uint16 feeBps, uint256 spendPct) public {
        amountIn = bound(amountIn, 1, 1_000_000e6);
        feeBps = uint16(bound(feeBps, 0, wrapper.MAX_FEE_BPS()));
        spendPct = bound(spendPct, 0, 100);
        uint256 fee = (amountIn * feeBps) / 10_000;
        uint256 spend = ((amountIn - fee) * spendPct) / 100;

        bytes memory data = _routerCall(address(usdc), address(weth), spend, 1, user);
        FeeWrapper.SwapQuote memory q = _quote(address(usdc), address(weth), amountIn, 1, feeBps, data);
        bytes memory sig12 = _sign(q);
        vm.prank(user);
        wrapper.swap(q, sig12, data);

        assertLe(usdc.balanceOf(collector) * 10_000, amountIn * wrapper.MAX_FEE_BPS());
        assertEq(usdc.balanceOf(collector), fee);
        assertEq(usdc.balanceOf(address(wrapper)), 0);
        assertEq(weth.balanceOf(address(wrapper)), 0);
        assertEq(usdc.allowance(address(wrapper), address(router)), 0);
        assertEq(usdc.balanceOf(user), 1_000_000e6 - fee - spend);
    }

    function testFuzz_nativeNoRetainedFunds(uint256 amountIn, uint16 feeBps) public {
        amountIn = bound(amountIn, 1, 100 ether);
        feeBps = uint16(bound(feeBps, 0, wrapper.MAX_FEE_BPS()));
        uint256 fee = (amountIn * feeBps) / 10_000;
        bytes memory data = _routerCall(NATIVE, address(usdc), (amountIn - fee) / 2, 1, user);
        FeeWrapper.SwapQuote memory q = _quote(NATIVE, address(usdc), amountIn, 1, feeBps, data);
        bytes memory sig13 = _sign(q);
        vm.prank(user);
        wrapper.swap{value: amountIn}(q, sig13, data);
        assertEq(address(wrapper).balance, 0);
        assertEq(collector.balance, fee);
    }

    function testFuzz_feeAboveCapAlwaysReverts(uint16 feeBps) public {
        feeBps = uint16(bound(feeBps, uint256(wrapper.MAX_FEE_BPS()) + 1, type(uint16).max));
        (FeeWrapper.SwapQuote memory q, bytes memory data) = _usdcToWeth();
        q.feeBps = feeBps;
        _expectRevert(q, _sign(q), data, FeeWrapper.FeeAboveCap.selector);
    }
}
