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
///      an initial router. INITIAL_ROUTERS is fail-closed: it may be non-empty only on the listed
///      testnets and 31337, a malformed value reverts instead of reading as "no routers", and a
///      duplicate entry is refused on every chain.
contract Deploy is Script {
    /// @notice Anvil and Hardhat's chain ID; the only chain where published development addresses are allowed.
    uint256 public constant LOCAL_CHAIN_ID = 31337;
    /// @notice Where forge deploys a test contract: `computeCreateAddress(DEFAULT_SENDER, 1)`.
    address public constant FORGE_TEST_CONTRACT = 0x7FA9385bE102ac3EAc297483Dd6233D62b3e1496;

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
    error DuplicateInitialRouter(address router);

    function run() external virtual returns (FeeWrapper wrapper) {
        Config memory c = _rolesFromEnv();
        c.routers = _routersFromEnv();
        return _deploy(c);
    }

    /// @notice INITIAL_ROUTERS as a comma-separated address list. Unset, empty or whitespace-only
    ///         means no routers. Otherwise every entry must parse as an address (entries are trimmed;
    ///         an empty item, a wrong length or a non-hex entry reverts), so a malformed value never
    ///         silently becomes an empty list. On a chain where initial routers are not allowed, any
    ///         non-empty value is refused before it is parsed.
    function _routersFromEnv() internal view returns (address[] memory) {
        return _routersFromEnv("INITIAL_ROUTERS");
    }

    /// @dev Takes the variable name only so tests can run each case under its own name in parallel.
    function _routersFromEnv(string memory name) internal view returns (address[] memory) {
        if (!vm.envExists(name)) return new address[](0);
        if (bytes(vm.trim(vm.envString(name))).length == 0) return new address[](0);
        if (!initialRoutersAllowed(block.chainid)) revert InitialRoutersRefused(block.chainid);
        return vm.envAddress(name, ",");
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

    /// @notice Reverts when the configuration must not be deployed on `chainId`. On 31337 only
    ///         duplicate routers are refused; everything else is allowed there (the harness).
    function checkRoles(uint256 chainId, Config memory c) public pure {
        for (uint256 i = 0; i < c.routers.length; i++) {
            for (uint256 j = 0; j < i; j++) {
                if (c.routers[i] == c.routers[j]) revert DuplicateInitialRouter(c.routers[i]);
            }
        }
        if (chainId == LOCAL_CHAIN_ID) return;
        if (c.routers.length > 0 && !initialRoutersAllowed(chainId)) revert InitialRoutersRefused(chainId);
        _refusePublished("ADMIN_ADDRESS", c.owner);
        _refusePublished("GUARDIAN_ADDRESS", c.guardian);
        _refusePublished("FEE_COLLECTOR", c.collector);
        _refusePublished("FEE_SIGNER", c.signer);
        for (uint256 i = 0; i < c.routers.length; i++) {
            _refusePublished("INITIAL_ROUTERS", c.routers[i]);
        }
    }

    /// @notice Fail-closed allowlist of the chains where INITIAL_ROUTERS may be non-empty: known
    ///         testnets and the local chain. Every other chain ID, known mainnet or unknown, is refused.
    ///         Mirrors LOCAL_SIGNER_DEFAULT_CHAINS in apps/api/src/mainnet-rules.ts (the only chains a
    ///         local key may sign for); keep the two lists in sync.
    function initialRoutersAllowed(uint256 chainId) public pure returns (bool) {
        return chainId == 84532 // Base Sepolia
            || chainId == 11155111 // Sepolia
            || chainId == 421614 // Arbitrum Sepolia
            || chainId == LOCAL_CHAIN_ID; // Anvil / Hardhat
    }

    function _refusePublished(string memory role, address account) private pure {
        if (isPublishedDevAddress(account)) revert PublishedDevAddress(role, account);
    }

    /// @notice True for an address anyone can control or that no role may hold:
    ///         - the zero address and everything up to 0x...01ff (precompiles, including 0x01, 0x02
    ///           and P256VERIFY at 0x0100, and room for future ones);
    ///         - anvil's CREATE2 factory (`CREATE2_FACTORY` from forge-std, 0x4e59...956C);
    ///         - forge's default sender (`DEFAULT_SENDER`, 0x1804...1f38) and the address forge
    ///           deploys a test contract at (its first CREATE, 0x7FA9...1496);
    ///         - the burn addresses 0x...dEaD and 0xdEAD...2069;
    ///         - the first 30 accounts of the published `test test ... junk` mnemonic (addresses
    ///           only; their keys are public).
    function isPublishedDevAddress(address a) public pure returns (bool) {
        if (uint160(a) <= 0x1ff || a == CREATE2_FACTORY) return true;
        if (a == DEFAULT_SENDER || a == FORGE_TEST_CONTRACT) return true;
        if (a == 0x000000000000000000000000000000000000dEaD || a == 0xdEAD000000000000000042069420694206942069) {
            return true;
        }
        address[30] memory accounts = [
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
            0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199,
            0x09DB0a93B389bEF724429898f539AEB7ac2Dd55f,
            0x02484cb50AAC86Eae85610D6f4Bf026f30f6627D,
            0x08135Da0A343E492FA2d4282F2AE34c6c5CC1BbE,
            0x5E661B79FE2D3F6cE70F5AAC07d8Cd9abb2743F1,
            0x61097BA76cD906d2ba4FD106E757f7Eb455fc295,
            0xDf37F81dAAD2b0327A0A50003740e1C935C70913,
            0x553BC17A05702530097c3677091C5BB47a3a7931,
            0x87BdCE72c06C21cd96219BD8521bDF1F42C78b5e,
            0x40Fc963A729c542424cD800349a7E4Ecc4896624,
            0x9DCCe783B6464611f38631e6C851bf441907c710
        ];
        for (uint256 i = 0; i < accounts.length; i++) {
            if (a == accounts[i]) return true;
        }
        return false;
    }
}
