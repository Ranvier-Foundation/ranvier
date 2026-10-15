// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {FeeWrapper} from "../src/FeeWrapper.sol";

/// @notice Deterministic deployment through the standard CREATE2 factory, so the wrapper has
///         the same address on every chain when the constructor arguments match.
/// @dev On testnets the deployer can be the owner and allowlist routers in the same run
///      (INITIAL_ROUTERS). On mainnet the owner is the admin multisig, which allowlists
///      routers itself; the script refuses INITIAL_ROUTERS when it is not the owner.
///
///      Role guard (ADR 0013, section 8): before anything is broadcast, on every chain except the
///      local chain 31337, the script refuses a published development address in any role or as
///      an initial router, and on Ethereum, Base and Arbitrum One it refuses INITIAL_ROUTERS.
contract Deploy is Script {
    /// @notice Anvil and Hardhat's chain ID; the only chain where published development addresses are allowed.
    uint256 public constant LOCAL_CHAIN_ID = 31337;

    struct Config {
        bytes32 salt;
        address owner;
        address collector;
        address signer;
        address guardian;
        address[] routers;
    }

    error PublishedDevAddress(string role, address account);
    error InitialRoutersRefused(uint256 chainId);

    function run() external virtual returns (FeeWrapper wrapper) {
        Config memory c = _rolesFromEnv();
        c.routers = vm.envOr("INITIAL_ROUTERS", ",", new address[](0));
        return _deploy(c);
    }

    function _rolesFromEnv() internal view returns (Config memory c) {
        c.salt = vm.envBytes32("FEE_WRAPPER_SALT");
        c.owner = vm.envAddress("ADMIN_ADDRESS");
        c.collector = vm.envAddress("FEE_COLLECTOR");
        c.signer = vm.envAddress("FEE_SIGNER");
        c.guardian = vm.envAddress("GUARDIAN_ADDRESS");
    }

    function _deploy(Config memory c) internal returns (FeeWrapper wrapper) {
        checkRoles(block.chainid, c);

        vm.startBroadcast();
        wrapper = new FeeWrapper{salt: c.salt}(c.owner, c.collector, c.signer, c.guardian);
        if (c.routers.length > 0) {
            require(msg.sender == c.owner, "INITIAL_ROUTERS needs the deployer to be the owner");
            for (uint256 i = 0; i < c.routers.length; i++) {
                wrapper.setRouter(c.routers[i], true);
            }
        }
        vm.stopBroadcast();

        console.log("FeeWrapper", address(wrapper));
        console.log("chainId", block.chainid);
        for (uint256 i = 0; i < c.routers.length; i++) {
            console.log("router allowed", c.routers[i]);
        }
    }

    /// @notice Reverts when the configuration must not be deployed on `chainId`. Nothing is checked on 31337.
    function checkRoles(uint256 chainId, Config memory c) public pure {
        if (chainId == LOCAL_CHAIN_ID) return;
        if ((chainId == 1 || chainId == 8453 || chainId == 42161) && c.routers.length > 0) {
            revert InitialRoutersRefused(chainId);
        }
        _refusePublished("ADMIN_ADDRESS", c.owner);
        _refusePublished("GUARDIAN_ADDRESS", c.guardian);
        _refusePublished("FEE_COLLECTOR", c.collector);
        _refusePublished("FEE_SIGNER", c.signer);
        for (uint256 i = 0; i < c.routers.length; i++) {
            _refusePublished("INITIAL_ROUTERS", c.routers[i]);
        }
    }

    function _refusePublished(string memory role, address account) private pure {
        if (isPublishedDevAddress(account)) revert PublishedDevAddress(role, account);
    }

    /// @notice True for an address anyone can control or that no role may hold: the first 20 accounts
    ///         of the published `test test ... junk` mnemonic (addresses only; their keys are public),
    ///         the zero address, the precompiles 0x...01 and 0x...02, and anvil's CREATE2 factory
    ///         (`CREATE2_FACTORY` from forge-std, 0x4e59b44847b379578588920cA78FbF26c0B4956C).
    function isPublishedDevAddress(address a) public pure returns (bool) {
        if (uint160(a) <= 2 || a == CREATE2_FACTORY) return true;
        address[20] memory accounts = [
            0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266,
            0x70997970C51812dc3A010C7d01b50e0d17dc79C8,
            0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC,
            0x90F79bf6EB2c4f870365E785982E1f101E93b906,
            0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65,
            0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc,
            0x976EA74026E726554dB657fA54763abd0C3a0aa9,
            0x14dC79964da2C08b23698B3D3cc7Ca32193d9955,
            0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f,
            0xa0Ee7A142d267C1f36714E4a8F75612F20a79720,
            0xBcd4042DE499D14e55001CcbB24a551F3b954096,
            0x71bE63f3384f5fb98995898A86B02Fb2426c5788,
            0xFABB0ac9d68B0B445fB7357272Ff202C5651694a,
            0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec,
            0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097,
            0xcd3B766CCDd6AE721141F452C550Ca635964ce71,
            0x2546BcD3c84621e976D8185a91A922aE77ECEc30,
            0xbDA5747bFD65F08deb54cb465eB87D40e51B197E,
            0xdD2FD4581271e230360230F9337D5c0430Bf44C0,
            0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199
        ];
        for (uint256 i = 0; i < accounts.length; i++) {
            if (a == accounts[i]) return true;
        }
        return false;
    }
}
