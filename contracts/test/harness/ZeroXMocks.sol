// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// LOCAL TEST HARNESS ONLY (ADR 0013, section 3). Never deployed on a real network.
//
// The external ABIs are exactly those of 0x AllowanceHolder `exec` and Settler `execute` as the API
// decodes them (apps/api/src/domain/allowance-holder.ts), so `vetRoute` checks harness calldata with
// no change. Everything behind those entry points is a stand-in: the mocks do not reproduce 0x's
// actions, its confused-deputy checks or its real transient-allowance rules.

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {FeeWrapper} from "../../src/FeeWrapper.sol";

interface IHarnessMintable {
    function mint(address to, uint256 amount) external;
}

/// @notice Stand-in for 0x AllowanceHolder. `exec` grants `operator` a one-call allowance of `amount`
///         of `token` from the caller, then calls `target` with `data` (plus the caller's address
///         appended, as 0x does) and the call's value. The operator spends it with `transferFrom`,
///         which pulls from the caller **as this contract**: the caller must have approved this
///         contract, so an approval to any other spender fails.
contract MockAllowanceHolder {
    using SafeERC20 for IERC20;

    address private constant NATIVE = address(0);

    address private transient _operator;
    address private transient _token;
    address private transient _owner;
    uint256 private transient _allowance;

    error NativeValueMismatch(uint256 value, uint256 amount);
    error UnexpectedValue();
    error NestedExec();
    error NotOperator();
    error WrongOwnerOrToken();
    error AllowanceExceeded(uint256 allowance, uint256 amount);

    /// @dev Selector 0x2213bc0b, as 0x AllowanceHolder.
    function exec(address operator, address token, uint256 amount, address payable target, bytes calldata data)
        external
        payable
        returns (bytes memory result)
    {
        // Native input (behaviour e): the value must be exactly the amount, and it is forwarded.
        if (token == NATIVE) {
            if (msg.value != amount) revert NativeValueMismatch(msg.value, amount);
        } else if (msg.value != 0) {
            revert UnexpectedValue();
        }
        if (_operator != address(0)) revert NestedExec();
        _operator = operator;
        _token = token;
        _owner = msg.sender;
        _allowance = token == NATIVE ? 0 : amount;

        bool ok;
        (ok, result) = target.call{value: msg.value}(abi.encodePacked(data, msg.sender));

        _operator = address(0);
        _token = address(0);
        _owner = address(0);
        _allowance = 0;
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(result, 0x20), mload(result))
            }
        }
    }

    /// @notice Pulls `amount` of `token` from `owner` to `recipient`, as this contract (behaviour d).
    /// @dev Same signature as 0x AllowanceHolder.transferFrom.
    function transferFrom(address token, address owner, address recipient, uint256 amount) external returns (bool) {
        if (msg.sender != _operator) revert NotOperator();
        if (owner != _owner || token != _token) revert WrongOwnerOrToken();
        uint256 allowed = _allowance;
        if (amount > allowed) revert AllowanceExceeded(allowed, amount);
        _allowance = allowed - amount;
        IERC20(token).safeTransferFrom(owner, recipient, amount);
        return true;
    }

    /// @notice The open `exec` call: who may spend, which token, how much is left. Harness only.
    function execContext() external view returns (address operator, address token, address owner, uint256 allowance) {
        return (_operator, _token, _owner, _allowance);
    }
}

/// @notice Stand-in for a 0x Settler. `execute` takes the 0x arguments, and the sell side comes from
///         the AllowanceHolder call it runs under. What happens next is chosen per token pair
///         (ADR 0013, section 3). It never checks `minAmountOut`: the wrapper's own check must be the
///         guard that fires.
/// @dev Pair keys follow 0x's encoding: the sell key is the zero address for native input, the buy
///      key is 0xeeee...eeee for native output. ERC-20 output is minted to the payee; native output
///      is paid from this contract's balance (fund it first).
contract MockSettler {
    using SafeERC20 for IERC20;

    address public constant NATIVE_IN = address(0);
    address public constant NATIVE_OUT = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    /// @notice Size of the `RevertHuge` payload: 1 MiB.
    uint256 public constant HUGE_REVERT_BYTES = 1 << 20;

    enum Mode {
        Unset,
        /// Spends the whole amount and pays `amount * num / den` to the recipient.
        Pay,
        /// (a) Pays one unit less than `minAmountOut`, without reverting.
        Underpay,
        /// (b) Pays the full output to the taker (the wrapper) instead of the recipient.
        PayTaker,
        /// (c) Spends half the amount, pays for that half, leaves the rest with the taker.
        SpendHalf,
        /// (f) Reverts with `MockSettlerFailed(sellToken, buyToken, amount)`.
        RevertWithData,
        /// (f) Reverts with a 1 MiB payload that starts with `MockSettlerHugeRevert()`.
        RevertHuge,
        /// (g) Calls `swap` on the taker (the wrapper) and bubbles its revert.
        Reenter
    }

    /// @dev Field names and order as 0x `ISettlerBase.AllowedSlippage`.
    struct AllowedSlippage {
        address recipient;
        address buyToken;
        uint256 minAmountOut;
    }

    struct Pair {
        Mode mode;
        uint128 num;
        uint128 den;
    }

    /// @notice One row of the pair table, fixed at deployment.
    struct PairConfig {
        address sellKey;
        address buyKey;
        Mode mode;
        uint128 num;
        uint128 den;
    }

    MockAllowanceHolder public immutable allowanceHolder;
    mapping(address sellKey => mapping(address buyKey => Pair pair)) public pairs;

    error BadRate();
    error NotViaAllowanceHolder();
    error NotOperator();
    error PairNotConfigured(address sellKey, address buyKey);
    error MockSettlerFailed(address sellToken, address buyToken, uint256 amount);
    error MockSettlerHugeRevert();
    error ReentryAccepted();
    error PaymentFailed();

    /// @dev The table is part of the init code, so it is part of the CREATE2 address: nobody can
    ///      change a pair after deployment, and a changed table moves the address.
    constructor(MockAllowanceHolder allowanceHolder_, PairConfig[] memory table) {
        allowanceHolder = allowanceHolder_;
        for (uint256 i = 0; i < table.length; i++) {
            PairConfig memory row = table[i];
            if (row.mode == Mode.Unset || row.den == 0) revert BadRate();
            pairs[row.sellKey][row.buyKey] = Pair(row.mode, row.num, row.den);
        }
    }

    receive() external payable {}

    /// @dev Selector 0x1fff991f, as 0x Settler (taker-submitted).
    function execute(AllowedSlippage calldata slippage, bytes[] calldata, bytes32) external payable returns (bool) {
        if (msg.sender != address(allowanceHolder)) revert NotViaAllowanceHolder();
        // As 0x: under AllowanceHolder the taker is the last 20 bytes of calldata.
        address taker = address(bytes20(msg.data[msg.data.length - 20:]));
        (address operator, address sellToken,, uint256 allowance) = allowanceHolder.execContext();
        if (operator != address(this)) revert NotOperator();
        uint256 amount = sellToken == NATIVE_IN ? msg.value : allowance;

        Pair memory p = pairs[sellToken][slippage.buyToken];
        if (p.mode == Mode.Unset) revert PairNotConfigured(sellToken, slippage.buyToken);
        if (p.mode == Mode.RevertWithData) revert MockSettlerFailed(sellToken, slippage.buyToken, amount);
        if (p.mode == Mode.RevertHuge) _revertHuge();
        if (p.mode == Mode.Reenter) _reenter(taker);

        uint256 spend = p.mode == Mode.SpendHalf ? amount / 2 : amount;
        if (sellToken == NATIVE_IN) {
            // Unspent native input goes back to the taker, as a router refund would.
            if (msg.value > spend) _pay(NATIVE_OUT, taker, msg.value - spend);
        } else if (spend > 0) {
            allowanceHolder.transferFrom(sellToken, taker, address(this), spend);
        }

        uint256 out = (spend * p.num) / p.den;
        if (p.mode == Mode.Underpay) out = slippage.minAmountOut == 0 ? 0 : slippage.minAmountOut - 1;
        _pay(slippage.buyToken, p.mode == Mode.PayTaker ? taker : slippage.recipient, out);
        return true;
    }

    function _pay(address buyToken, address to, uint256 amount) private {
        if (amount == 0) return;
        if (buyToken == NATIVE_OUT) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert PaymentFailed();
        } else {
            IHarnessMintable(buyToken).mint(to, amount);
        }
    }

    function _revertHuge() private pure {
        bytes4 selector = MockSettlerHugeRevert.selector;
        uint256 size = HUGE_REVERT_BYTES;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            // The selector, then zeros: copying calldata from past its end writes zeros.
            mstore(ptr, selector)
            calldatacopy(add(ptr, 0x20), calldatasize(), sub(size, 0x20))
            revert(ptr, size)
        }
    }

    function _reenter(address taker) private {
        FeeWrapper.SwapQuote memory empty;
        (bool ok, bytes memory ret) = taker.call(abi.encodeCall(FeeWrapper.swap, (empty, "", "")));
        if (ok) revert ReentryAccepted();
        assembly ("memory-safe") {
            revert(add(ret, 0x20), mload(ret))
        }
    }
}
