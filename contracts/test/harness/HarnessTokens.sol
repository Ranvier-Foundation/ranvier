// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// LOCAL TEST HARNESS ONLY (ADR 0013). Deployed on anvil chain 31337 and in forge tests, never on a
// real network. Lives under test/ so the production build, Slither, coverage and Deploy.s.sol never
// see it. Every token has an open `mint`: anyone can create any amount, which is the point here.

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Plain mintable ERC-20 with chosen decimals (hUSDC, the scenario tokens).
contract HarnessToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice WETH9-style wrapped native (hWETH, 18 decimals). `mint` is unbacked: `withdraw` of minted
///         tokens only works while the contract holds enough ETH from deposits.
contract HarnessWETH is HarnessToken {
    event Deposit(address indexed account, uint256 amount);
    event Withdrawal(address indexed account, uint256 amount);

    constructor() HarnessToken("Harness Wrapped Ether", "hWETH", 18) {}

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        _mint(msg.sender, msg.value);
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        emit Withdrawal(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "hWETH: ETH transfer failed");
    }
}

/// @notice USDT-style token: `transfer`, `transferFrom` and `approve` return nothing, and approving
///         a non-zero amount while the current allowance is non-zero reverts. A plain
///         `IERC20.approve` call cannot decode the missing return value, so only SafeERC20's
///         `forceApprove` works with it.
contract UsdtStyleToken {
    string public constant name = "Harness Tether-style USD";
    string public constant symbol = "hUSDT";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address account => uint256 amount) public balanceOf;
    mapping(address owner => mapping(address spender => uint256 amount)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 value) external {
        _move(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "hUSDT: allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _move(from, to, value);
    }

    function approve(address spender, uint256 value) external {
        require(value == 0 || allowance[msg.sender][spender] == 0, "hUSDT: approve from non-zero");
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
    }

    function _move(address from, address to, uint256 value) private {
        require(balanceOf[from] >= value, "hUSDT: balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}

/// @notice `transfer` and `transferFrom` return false and move nothing. SafeERC20 must refuse it.
contract FalseReturnToken is HarnessToken {
    constructor() HarnessToken("Harness False-returning Token", "hFALSE", 6) {}

    function transfer(address, uint256) public pure override returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return false;
    }
}

/// @notice Burns 1% of every transfer. The wrapper must refuse it with `UnsupportedToken`.
contract FeeOnTransferHarnessToken is HarnessToken {
    constructor() HarnessToken("Harness Fee-on-transfer Token", "hTAX", 6) {}

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 tax = value / 100;
            super._update(from, address(0), tax);
            value -= tax;
        }
        super._update(from, to, value);
    }
}

/// @notice ERC-777-style hooks, registered by the account itself (as with ERC-1820).
interface IHarnessTokenHook {
    function tokensToSend(address operator, address from, address to, uint256 amount) external;
    function tokensReceived(address operator, address from, address to, uint256 amount) external;
}

/// @notice ERC-777-style token: calls the sender's hook before a balance moves and the recipient's
///         hook after it. A hook can call back into anything, including the wrapper.
contract HookToken is HarnessToken {
    mapping(address account => address hook) public hookOf;

    constructor() HarnessToken("Harness Hook Token", "hHOOK", 6) {}

    function setHook(address hook) external {
        hookOf[msg.sender] = hook;
    }

    function _update(address from, address to, uint256 value) internal override {
        address sendHook = from == address(0) ? address(0) : hookOf[from];
        if (sendHook != address(0)) IHarnessTokenHook(sendHook).tokensToSend(msg.sender, from, to, value);
        super._update(from, to, value);
        address receiveHook = to == address(0) ? address(0) : hookOf[to];
        if (receiveHook != address(0)) IHarnessTokenHook(receiveHook).tokensReceived(msg.sender, from, to, value);
    }
}
