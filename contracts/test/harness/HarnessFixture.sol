// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {FeeWrapper} from "../../src/FeeWrapper.sol";
import {DeployHarness} from "./DeployHarness.s.sol";
import {MockAllowanceHolder, MockSettler} from "./ZeroXMocks.sol";

/// @notice The harness mocks exactly as DeployHarness deploys them (same CREATE2 path and address
///         check), plus a real FeeWrapper that allowlists the mock AllowanceHolder.
abstract contract HarnessFixture is Test {
    address internal constant NATIVE = address(0);
    address internal constant NATIVE_OUT = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    DeployHarness.Mocks internal m;
    FeeWrapper internal wrapper;

    address internal owner = makeAddr("owner");
    address internal collector = makeAddr("collector");
    address internal guardian = makeAddr("guardian");
    address internal user = makeAddr("user");
    uint256 internal signerKey = 0xA11CE;
    address internal signer = vm.addr(signerKey);
    uint256 internal nextNonce = 1;

    function setUp() public virtual {
        vm.chainId(31337);
        m = new DeployHarness().deployMocks();
        wrapper = new FeeWrapper(owner, collector, signer, guardian);
        vm.prank(owner);
        wrapper.setRouter(address(m.holder), true);
        vm.deal(user, 1_000 ether);
    }

    /// @dev 0x-shaped calldata, encoded as the API does: AllowanceHolder.exec(settler, sellKey,
    ///      amount, settler, Settler.execute((recipient, buyKey, minOut), [], 0)).
    function _zeroX(address sellKey, uint256 amount, address buyKey, address recipient, uint256 minOut)
        internal
        view
        returns (bytes memory)
    {
        bytes memory inner = abi.encodeCall(
            MockSettler.execute, (MockSettler.AllowedSlippage(recipient, buyKey, minOut), new bytes[](0), bytes32(0))
        );
        return abi.encodeCall(
            MockAllowanceHolder.exec, (address(m.settler), sellKey, amount, payable(address(m.settler)), inner)
        );
    }

    /// @notice A signed quote for `user` selling `amountIn` (fee `feeBps`) of `tokenIn` for `tokenOut`.
    ///         The router amount is `amountIn - fee`, as the API sends it.
    function _quote(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, uint256 feeBps)
        internal
        returns (FeeWrapper.SwapQuote memory q, bytes memory data, bytes memory sig)
    {
        return _quoteFor(user, tokenIn, tokenOut, amountIn, minOut, feeBps);
    }

    function _quoteFor(
        address taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 feeBps
    ) internal returns (FeeWrapper.SwapQuote memory q, bytes memory data, bytes memory sig) {
        uint256 fee = (amountIn * feeBps) / 10_000;
        data = _zeroX(tokenIn, amountIn - fee, tokenOut == NATIVE ? NATIVE_OUT : tokenOut, taker, minOut);
        q = FeeWrapper.SwapQuote({
            user: taker,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: minOut,
            feeAmount: fee,
            router: address(m.holder),
            routerCalldataHash: keccak256(data),
            nonce: nextNonce++,
            deadline: block.timestamp + 60
        });
        sig = _sign(q);
    }

    function _sign(FeeWrapper.SwapQuote memory q) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, wrapper.hashQuote(q));
        return abi.encodePacked(r, s, v);
    }

    function _swap(FeeWrapper.SwapQuote memory q, bytes memory data, bytes memory sig) internal returns (uint256) {
        vm.prank(user);
        return wrapper.swap{value: q.tokenIn == NATIVE ? q.amountIn : 0}(q, sig, data);
    }

    function _expectSwapRevert(FeeWrapper.SwapQuote memory q, bytes memory data, bytes memory sig, bytes memory err)
        internal
    {
        vm.prank(user);
        vm.expectRevert(err);
        wrapper.swap{value: q.tokenIn == NATIVE ? q.amountIn : 0}(q, sig, data);
    }

    /// @dev The wrapper never keeps anything: no token, no ETH, no allowance to the holder.
    function _assertWrapperEmpty(address token) internal view {
        assertEq(address(wrapper).balance, 0, "wrapper ETH");
        if (token != NATIVE) {
            (bool ok, bytes memory ret) =
                token.staticcall(abi.encodeWithSignature("balanceOf(address)", address(wrapper)));
            assertTrue(ok);
            assertEq(abi.decode(ret, (uint256)), 0, "wrapper token balance");
            (ok, ret) = token.staticcall(
                abi.encodeWithSignature("allowance(address,address)", address(wrapper), address(m.holder))
            );
            assertTrue(ok);
            assertEq(abi.decode(ret, (uint256)), 0, "wrapper allowance to holder");
        }
    }
}
