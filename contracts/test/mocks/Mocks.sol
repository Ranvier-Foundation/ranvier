// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeWrapper} from "../../src/FeeWrapper.sol";

contract MockERC20 is ERC20 {
    constructor(string memory symbol) ERC20(symbol, symbol) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Burns 1% on every transfer.
contract FeeOnTransferToken is MockERC20 {
    constructor() MockERC20("TAX") {}

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 tax = value / 100;
            super._update(from, address(0), tax);
            value -= tax;
        }
        super._update(from, to, value);
    }
}

/// @dev Stand-in for a DEX aggregator router. Pulls `spend` of the input from the caller,
///      pays `amountOut` to `recipient`, and refunds any unspent native input to the caller.
contract MockRouter {
    address constant NATIVE = address(0);

    function swap(address tokenIn, address tokenOut, uint256 spend, uint256 amountOut, address recipient)
        external
        payable
    {
        if (tokenIn == NATIVE) {
            require(msg.value >= spend, "value");
            if (msg.value > spend) {
                (bool ok,) = msg.sender.call{value: msg.value - spend}("");
                require(ok, "refund");
            }
        } else {
            IERC20(tokenIn).transferFrom(msg.sender, address(this), spend);
        }
        if (tokenOut == NATIVE) {
            (bool ok,) = recipient.call{value: amountOut}("");
            require(ok, "pay");
        } else {
            MockERC20(tokenOut).mint(recipient, amountOut);
        }
    }

    function fail() external pure {
        revert("router failed");
    }

    receive() external payable {}
}

/// @dev Tries to re-enter the wrapper during a swap.
contract ReentrantRouter {
    function attack(FeeWrapper wrapper, FeeWrapper.SwapQuote calldata q, bytes calldata sig, bytes calldata data)
        external
    {
        wrapper.swap(q, sig, data);
    }
}

contract RejectsNative {
    receive() external payable {
        revert("no");
    }
}
