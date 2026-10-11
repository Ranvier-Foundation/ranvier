// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Ranvier fee wrapper
/// @notice Takes the platform fee from the input token, forwards the rest to an
///         allowlisted router, and checks the user received at least the quoted minimum.
/// @dev Invariants (spec section 9): the fee never exceeds MAX_FEE_BPS, the contract never
///      keeps funds after a swap, and only allowlisted routers are called. Same-chain swaps only;
///      cross-chain routes get their own entry point once bridge providers are integrated.
contract FeeWrapper is Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    /// @notice Hard cap on the fee rate (0.3%). The fee schedule never goes above 0.2%.
    uint16 public constant MAX_FEE_BPS = 30;
    uint256 private constant BPS = 10_000;
    /// @notice Sentinel for the chain's native token.
    address public constant NATIVE = address(0);

    bytes32 public constant SWAP_QUOTE_TYPEHASH = keccak256(
        "SwapQuote(address user,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint16 feeBps,address router,bytes32 routerCalldataHash,uint256 nonce,uint256 deadline)"
    );

    /// @notice A quote signed by the backend fee signer. Binding the router calldata hash
    ///         means a signed fee rate can only be used with the route it was quoted for.
    struct SwapQuote {
        address user;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        uint16 feeBps;
        address router;
        bytes32 routerCalldataHash;
        uint256 nonce;
        uint256 deadline;
    }

    /// @notice Receives fees. Immutable: a new collector means a versioned redeploy.
    address public immutable feeCollector;
    address public feeSigner;
    /// @notice Can pause, but not unpause or move funds.
    address public guardian;
    mapping(address router => bool allowed) public isRouterAllowed;
    mapping(address user => mapping(uint256 nonce => bool used)) public nonceUsed;

    event SwapExecuted(
        address indexed user,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee,
        uint16 feeBps,
        address router,
        uint256 nonce
    );
    event RouterSet(address indexed router, bool allowed);
    event FeeSignerSet(address indexed feeSigner);
    event GuardianSet(address indexed guardian);

    error ZeroAddress();
    error NotQuoteUser();
    error QuoteExpired();
    error FeeAboveCap();
    error RouterNotAllowed();
    error SameToken();
    error CalldataMismatch();
    error NonceAlreadyUsed();
    error InvalidSignature();
    error InvalidValue();
    error UnsupportedToken();
    error InsufficientOutput();
    error NotGuardianOrOwner();
    error UnexpectedNative();
    error NativeTransferFailed();
    error RenounceDisabled();

    constructor(address owner_, address feeCollector_, address feeSigner_, address guardian_)
        Ownable(owner_)
        EIP712("Ranvier FeeWrapper", "1")
    {
        if (feeCollector_ == address(0) || feeSigner_ == address(0) || guardian_ == address(0)) {
            revert ZeroAddress();
        }
        feeCollector = feeCollector_;
        feeSigner = feeSigner_;
        guardian = guardian_;
        emit FeeSignerSet(feeSigner_);
        emit GuardianSet(guardian_);
    }

    /// @dev Native output may be paid to this contract by a router mid-swap; it is forwarded
    ///      to the user before the swap returns. Outside a swap, native transfers are refused.
    receive() external payable {
        if (!_reentrancyGuardEntered()) revert UnexpectedNative();
    }

    // ---------------------------------------------------------------- swap

    // reentrancy-balance: re-entry is blocked by nonReentrant, and the before/after balance
    // difference is the intended output check. Only the user or the allowlisted router can
    // change the user's balance mid-swap, which can only affect the user's own minimum.
    // slither-disable-next-line reentrancy-balance
    function swap(SwapQuote calldata q, bytes calldata signature, bytes calldata routerCalldata)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (uint256 amountOut)
    {
        _validate(q, signature, routerCalldata);
        nonceUsed[q.user][q.nonce] = true;

        bool nativeIn = q.tokenIn == NATIVE;
        if (nativeIn ? msg.value != q.amountIn : msg.value != 0) revert InvalidValue();

        // Balances that predate this swap are not the user's and are left alone.
        uint256 inBefore = _balanceOf(q.tokenIn, address(this)) - msg.value;
        uint256 outBefore = _balanceOf(q.tokenOut, address(this));
        uint256 userOutBefore = _balanceOf(q.tokenOut, q.user);

        uint256 fee = (q.amountIn * q.feeBps) / BPS;
        uint256 toRoute = q.amountIn - fee;

        if (nativeIn) {
            if (fee > 0) _sendNative(feeCollector, fee);
            _callRouter(q.router, toRoute, routerCalldata);
        } else {
            IERC20 tokenIn = IERC20(q.tokenIn);
            tokenIn.safeTransferFrom(msg.sender, address(this), q.amountIn);
            // Fee-on-transfer and rebasing tokens break exact accounting; refuse them.
            if (tokenIn.balanceOf(address(this)) - inBefore != q.amountIn) revert UnsupportedToken();
            if (fee > 0) tokenIn.safeTransfer(feeCollector, fee);
            tokenIn.forceApprove(q.router, toRoute);
            _callRouter(q.router, 0, routerCalldata);
            tokenIn.forceApprove(q.router, 0);
        }

        // Never hold funds: return unspent input and any output paid to this contract.
        uint256 inLeft = _balanceOf(q.tokenIn, address(this)) - inBefore;
        if (inLeft > 0) _send(q.tokenIn, q.user, inLeft);
        uint256 outHeld = _balanceOf(q.tokenOut, address(this)) - outBefore;
        if (outHeld > 0) _send(q.tokenOut, q.user, outHeld);

        // Positive slippage stays with the user: only a floor is enforced.
        amountOut = _balanceOf(q.tokenOut, q.user) - userOutBefore;
        if (amountOut < q.minAmountOut) revert InsufficientOutput();

        emit SwapExecuted(q.user, q.tokenIn, q.tokenOut, q.amountIn, amountOut, fee, q.feeBps, q.router, q.nonce);
    }

    /// @notice EIP-712 digest the fee signer signs for a quote.
    function hashQuote(SwapQuote calldata q) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SWAP_QUOTE_TYPEHASH,
                    q.user,
                    q.tokenIn,
                    q.tokenOut,
                    q.amountIn,
                    q.minAmountOut,
                    q.feeBps,
                    q.router,
                    q.routerCalldataHash,
                    q.nonce,
                    q.deadline
                )
            )
        );
    }

    // ---------------------------------------------------------------- admin

    function setRouter(address router, bool allowed) external onlyOwner {
        if (router == address(0)) revert ZeroAddress();
        isRouterAllowed[router] = allowed;
        emit RouterSet(router, allowed);
    }

    function setFeeSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        feeSigner = newSigner;
        emit FeeSignerSet(newSigner);
    }

    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert ZeroAddress();
        guardian = newGuardian;
        emit GuardianSet(newGuardian);
    }

    /// @notice Circuit breaker: the guardian or the owner can pause instantly.
    function pause() external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardianOrOwner();
        _pause();
    }

    /// @notice Only the owner (admin multisig behind a timelock) can unpause.
    function unpause() external onlyOwner {
        _unpause();
    }

    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    // ---------------------------------------------------------------- internal

    function _validate(SwapQuote calldata q, bytes calldata signature, bytes calldata routerCalldata) private view {
        if (msg.sender != q.user) revert NotQuoteUser();
        if (block.timestamp > q.deadline) revert QuoteExpired();
        if (q.feeBps > MAX_FEE_BPS) revert FeeAboveCap();
        if (!isRouterAllowed[q.router]) revert RouterNotAllowed();
        if (q.tokenIn == q.tokenOut) revert SameToken();
        if (keccak256(routerCalldata) != q.routerCalldataHash) revert CalldataMismatch();
        if (nonceUsed[q.user][q.nonce]) revert NonceAlreadyUsed();
        // The third return value is the error argument; the error and signer are both checked.
        // slither-disable-next-line unused-return
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(hashQuote(q), signature);
        if (err != ECDSA.RecoverError.NoError || signer != feeSigner) revert InvalidSignature();
    }

    function _callRouter(address router, uint256 value, bytes calldata data) private {
        // Only admin-allowlisted routers reach here, with calldata bound to the signed quote.
        // slither-disable-next-line arbitrary-send-eth,low-level-calls
        (bool ok, bytes memory ret) = router.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    function _balanceOf(address token, address account) private view returns (uint256) {
        return token == NATIVE ? account.balance : IERC20(token).balanceOf(account);
    }

    function _send(address token, address to, uint256 amount) private {
        if (token == NATIVE) _sendNative(to, amount);
        else IERC20(token).safeTransfer(to, amount);
    }

    function _sendNative(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert NativeTransferFailed();
    }
}
