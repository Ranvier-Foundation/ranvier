// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {FeeWrapper} from "../../src/FeeWrapper.sol";
import {DeployHarness} from "./DeployHarness.s.sol";
import {HarnessFixture} from "./HarnessFixture.sol";
import {IHarnessTokenHook} from "./HarnessTokens.sol";
import {MockAllowanceHolder, MockSettler} from "./ZeroXMocks.sol";

contract RecordingHook is IHarnessTokenHook {
    uint256 public sent;
    uint256 public received;

    function tokensToSend(address, address, address, uint256 amount) external {
        sent += amount;
    }

    function tokensReceived(address, address, address, uint256 amount) external {
        received += amount;
    }
}

/// @notice The mocks themselves: ABI, holder rules, every settler mode, every token quirk.
///         The test contract plays the taker (the wrapper's role) and approves the holder.
contract HarnessMocksTest is HarnessFixture {
    // ------------------------------------------------------------ ABI

    function test_abi_selectorsMatch0x() public pure {
        assertEq(MockAllowanceHolder.exec.selector, bytes4(0x2213bc0b));
        assertEq(MockSettler.execute.selector, bytes4(0x1fff991f));
    }

    /// Byte-identical to the signatures the API decodes (apps/api/src/domain/allowance-holder.ts).
    function test_abi_calldataIdenticalTo0xSignatures() public view {
        bytes memory inner = abi.encodeWithSignature(
            "execute((address,address,uint256),bytes[],bytes32)",
            user,
            address(m.hweth),
            uint256(5),
            new bytes[](0),
            bytes32(0)
        );
        bytes memory outer = abi.encodeWithSignature(
            "exec(address,address,uint256,address,bytes)",
            address(m.settler),
            address(m.husdc),
            uint256(7),
            address(m.settler),
            inner
        );
        assertEq(outer, _zeroX(address(m.husdc), 7, address(m.hweth), user, 5));
    }

    // ------------------------------------------------------------ holder

    function _fundSelf(uint256 amount) internal {
        m.husdc.mint(address(this), amount);
        m.husdc.approve(address(m.holder), amount);
    }

    function test_holder_pullsAsHolder_fromCallerToSettler() public {
        _fundSelf(10e6);
        m.holder
            .exec(
                address(m.settler),
                address(m.husdc),
                10e6,
                payable(address(m.settler)),
                _settle(address(m.hweth), user, 1)
            );
        assertEq(m.husdc.balanceOf(address(m.settler)), 10e6);
        assertEq(m.husdc.allowance(address(this), address(m.holder)), 0);
        (address operator, address token, address owner_, uint256 allowance) = m.holder.execContext();
        assertEq(operator, address(0));
        assertEq(token, address(0));
        assertEq(owner_, address(0));
        assertEq(allowance, 0);
    }

    /// (d) An approval to anyone but the holder (here: the settler) does not let the holder pull.
    function test_holder_approvalToWrongSpender_fails() public {
        m.husdc.mint(address(this), 10e6);
        m.husdc.approve(address(m.settler), 10e6);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, m.holder, 0, 10e6));
        m.holder
            .exec(
                address(m.settler),
                address(m.husdc),
                10e6,
                payable(address(m.settler)),
                _settle(address(m.hweth), user, 1)
            );
    }

    /// The operator gets the allowance; a target that is not the operator cannot spend it.
    function test_holder_operatorNotTarget_fails() public {
        _fundSelf(10e6);
        vm.expectRevert(MockSettler.NotOperator.selector);
        m.holder
            .exec(
                makeAddr("operator"),
                address(m.husdc),
                10e6,
                payable(address(m.settler)),
                _settle(address(m.hweth), user, 1)
            );
    }

    function test_holder_transferFrom_outsideExec_fails() public {
        vm.expectRevert(MockAllowanceHolder.NotOperator.selector);
        m.holder.transferFrom(address(m.husdc), address(this), address(this), 1);
    }

    function test_holder_transferFrom_aboveAllowance_fails() public {
        _fundSelf(10e6);
        PullTooMuch greedy = new PullTooMuch(m.holder);
        vm.expectRevert(abi.encodeWithSelector(MockAllowanceHolder.AllowanceExceeded.selector, 10e6, 10e6 + 1));
        m.holder.exec(address(greedy), address(m.husdc), 10e6, payable(address(greedy)), "");
    }

    /// (e) Native input: the value must equal the amount.
    function test_holder_nativeValueMustEqualAmount() public {
        bytes memory inner = _settle(address(m.husdc), user, 1);
        vm.expectRevert(abi.encodeWithSelector(MockAllowanceHolder.NativeValueMismatch.selector, 1 ether, 2 ether));
        m.holder.exec{value: 1 ether}(address(m.settler), NATIVE, 2 ether, payable(address(m.settler)), inner);

        uint256 before = address(m.settler).balance;
        m.holder.exec{value: 1 ether}(address(m.settler), NATIVE, 1 ether, payable(address(m.settler)), inner);
        assertEq(address(m.settler).balance, before + 1 ether);
        assertEq(m.husdc.balanceOf(user), 3_000e6);
    }

    function test_holder_valueWithErc20_refused() public {
        vm.expectRevert(MockAllowanceHolder.UnexpectedValue.selector);
        m.holder.exec{value: 1}(address(m.settler), address(m.husdc), 1, payable(address(m.settler)), "");
    }

    // ------------------------------------------------------------ settler

    function _settle(address buyKey, address recipient, uint256 minOut) internal pure returns (bytes memory) {
        return abi.encodeCall(
            MockSettler.execute, (MockSettler.AllowedSlippage(recipient, buyKey, minOut), new bytes[](0), bytes32(0))
        );
    }

    function _execUsdc(address buyKey, uint256 amount, uint256 minOut) internal returns (bool ok, bytes memory ret) {
        _fundSelf(amount);
        return address(m.holder)
            .call(
                abi.encodeCall(
                    MockAllowanceHolder.exec,
                    (
                        address(m.settler),
                        address(m.husdc),
                        amount,
                        payable(address(m.settler)),
                        _settle(buyKey, user, minOut)
                    )
                )
            );
    }

    function test_settler_onlyThroughHolder() public {
        vm.expectRevert(MockSettler.NotViaAllowanceHolder.selector);
        m.settler.execute(MockSettler.AllowedSlippage(user, address(m.hweth), 0), new bytes[](0), bytes32(0));
    }

    function test_settler_unknownPair_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(MockSettler.PairNotConfigured.selector, m.husdc, m.htax));
        this.execUsdcStrict(address(m.htax), 1e6, 0);
    }

    function execUsdcStrict(address buyKey, uint256 amount, uint256 minOut) external {
        (bool ok, bytes memory ret) = _execUsdc(buyKey, amount, minOut);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    function test_settler_pay_fixedRate() public {
        _execUsdc(address(m.hweth), 3_000e6, 0);
        assertEq(m.hweth.balanceOf(user), 1 ether);
    }

    /// (a) Pays one unit under the minimum and does not revert: it never checks minAmountOut.
    function test_settler_underpay_doesNotCheckMinimum() public {
        (bool ok,) = _execUsdc(address(m.hunder), 100e6, 99e6);
        assertTrue(ok);
        assertEq(m.hunder.balanceOf(user), 99e6 - 1);
    }

    /// (b) Pays the taker, not the recipient.
    function test_settler_payTaker() public {
        _execUsdc(address(m.hpaywrap), 100e6, 0);
        assertEq(m.hpaywrap.balanceOf(address(this)), 100e6);
        assertEq(m.hpaywrap.balanceOf(user), 0);
    }

    /// (c) Spends half and leaves the rest with the taker.
    function test_settler_spendHalf() public {
        _execUsdc(address(m.hspend), 100e6, 0);
        assertEq(m.husdc.balanceOf(address(this)), 50e6);
        assertEq(m.husdc.allowance(address(this), address(m.holder)), 50e6);
        assertEq(m.hspend.balanceOf(user), 50e6);
    }

    /// (f) Reverts with data, through the holder unchanged.
    function test_settler_revertWithData() public {
        vm.expectRevert(abi.encodeWithSelector(MockSettler.MockSettlerFailed.selector, m.husdc, m.hrevert, 1e6));
        this.execUsdcStrict(address(m.hrevert), 1e6, 0);
    }

    function test_settler_revertHuge_size() public {
        (bool ok, bytes memory ret) = _execUsdc(address(m.hbigrev), 1e6, 0);
        assertFalse(ok);
        assertEq(ret.length, 1 << 20);
        assertEq(bytes4(ret), MockSettler.MockSettlerHugeRevert.selector);
        for (uint256 i = 4; i < ret.length; i += 4099) {
            assertEq(uint8(ret[i]), 0);
        }
    }

    /// (g) Calls swap on its taker. A taker that accepts the call is reported as ReentryAccepted.
    function test_settler_reenter_callsTakerSwap() public {
        vm.expectRevert(MockSettler.ReentryAccepted.selector);
        this.execUsdcStrict(address(m.hreenter), 1e6, 0);
    }

    function swap(FeeWrapper.SwapQuote calldata, bytes calldata, bytes calldata) external payable {}

    function test_settler_underOracle_paysNinetyPercent() public {
        _execUsdc(address(m.horacle), 100e6, 0);
        assertEq(m.horacle.balanceOf(user), 90e6);
    }

    function test_settler_constructorRefusesBadRows() public {
        MockSettler.PairConfig[] memory rows = new MockSettler.PairConfig[](1);
        rows[0] = MockSettler.PairConfig(address(1), address(2), MockSettler.Mode.Pay, 1, 0);
        vm.expectRevert(MockSettler.BadRate.selector);
        new MockSettler(m.holder, rows);
        rows[0] = MockSettler.PairConfig(address(1), address(2), MockSettler.Mode.Unset, 1, 1);
        vm.expectRevert(MockSettler.BadRate.selector);
        new MockSettler(m.holder, rows);
    }

    function test_pairTable_everyScenarioConfigured() public view {
        _assertPair(address(0), address(m.husdc), MockSettler.Mode.Pay, 3_000e6, 1e18);
        _assertPair(address(m.husdc), m.settler.NATIVE_OUT(), MockSettler.Mode.Pay, 1e18, 3_000e6);
        _assertPair(address(m.husdc), address(m.hweth), MockSettler.Mode.Pay, 1e18, 3_000e6);
        _assertPair(address(m.hweth), address(m.husdc), MockSettler.Mode.Pay, 3_000e6, 1e18);
        _assertPair(address(m.husdc), address(m.hunder), MockSettler.Mode.Underpay, 1, 1);
        _assertPair(address(m.husdc), address(m.hpaywrap), MockSettler.Mode.PayTaker, 1, 1);
        _assertPair(address(m.husdc), address(m.hspend), MockSettler.Mode.SpendHalf, 1, 1);
        _assertPair(address(0), address(m.hspend), MockSettler.Mode.SpendHalf, 3_000e6, 1e18);
        _assertPair(address(m.husdc), address(m.hrevert), MockSettler.Mode.RevertWithData, 1, 1);
        _assertPair(address(m.husdc), address(m.hbigrev), MockSettler.Mode.RevertHuge, 1, 1);
        _assertPair(address(m.husdc), address(m.hreenter), MockSettler.Mode.Reenter, 1, 1);
        _assertPair(address(m.husdc), address(m.horacle), MockSettler.Mode.Pay, 9, 10);
        assertEq(address(m.settler).balance, 100 ether);
    }

    function _assertPair(address sellKey, address buyKey, MockSettler.Mode mode, uint128 num, uint128 den)
        internal
        view
    {
        (MockSettler.Mode gotMode, uint128 gotNum, uint128 gotDen) = m.settler.pairs(sellKey, buyKey);
        assertEq(uint8(gotMode), uint8(mode));
        assertEq(gotNum, num);
        assertEq(gotDen, den);
    }

    // ------------------------------------------------------------ tokens

    function test_tokens_decimals() public view {
        assertEq(m.husdc.decimals(), 6);
        assertEq(m.hweth.decimals(), 18);
        assertEq(m.husdt.decimals(), 6);
        assertEq(m.husdc.symbol(), "hUSDC");
        assertEq(m.hweth.symbol(), "hWETH");
    }

    function test_hweth_depositWithdraw() public {
        m.hweth.deposit{value: 1 ether}();
        assertEq(m.hweth.balanceOf(address(this)), 1 ether);
        uint256 before = address(this).balance;
        m.hweth.withdraw(1 ether);
        assertEq(address(this).balance, before + 1 ether);
    }

    receive() external payable {}

    function test_usdt_noReturnValue_andApproveFromNonZeroReverts() public {
        m.husdt.mint(address(this), 10e6);
        (bool ok, bytes memory ret) =
            address(m.husdt).call(abi.encodeWithSignature("transfer(address,uint256)", user, 1e6));
        assertTrue(ok);
        assertEq(ret.length, 0);
        (ok, ret) = address(m.husdt).call(abi.encodeWithSignature("approve(address,uint256)", user, 1));
        assertTrue(ok);
        assertEq(ret.length, 0);
        vm.expectRevert("hUSDT: approve from non-zero");
        m.husdt.approve(user, 2);
        m.husdt.approve(user, 0);
        m.husdt.approve(user, 2);
        assertEq(m.husdt.allowance(address(this), user), 2);
    }

    function test_falseToken_returnsFalseAndMovesNothing() public {
        m.hfalse.mint(address(this), 10e6);
        assertFalse(m.hfalse.transfer(user, 1e6));
        assertEq(m.hfalse.balanceOf(user), 0);
        assertEq(m.hfalse.balanceOf(address(this)), 10e6);
    }

    function test_feeOnTransfer_burnsOnePercent() public {
        m.htax.mint(address(this), 100e6);
        m.htax.transfer(user, 100e6);
        assertEq(m.htax.balanceOf(user), 99e6);
    }

    function test_hookToken_callsSendAndReceiveHooks() public {
        RecordingHook hook = new RecordingHook();
        m.hhook.setHook(address(hook));
        m.hhook.mint(address(this), 10e6);
        assertEq(hook.received(), 10e6);
        m.hhook.transfer(user, 4e6);
        assertEq(hook.sent(), 4e6);
    }

    // ------------------------------------------------------------ deploy script

    function test_deployMocks_refusesOtherChains() public {
        DeployHarness h = new DeployHarness();
        vm.chainId(8453);
        vm.expectRevert(abi.encodeWithSelector(DeployHarness.NotLocalChain.selector, 8453));
        h.deployMocks();
    }
}

/// @dev An operator that tries to pull one unit more than its allowance.
contract PullTooMuch {
    MockAllowanceHolder internal immutable holder;

    constructor(MockAllowanceHolder holder_) {
        holder = holder_;
    }

    fallback() external {
        (, address token, address owner,) = holder.execContext();
        holder.transferFrom(token, owner, address(this), 10e6 + 1);
    }
}
