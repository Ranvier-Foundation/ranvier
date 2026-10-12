// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {FeeWrapper} from "../src/FeeWrapper.sol";

/// @notice Deterministic deployment through the standard CREATE2 factory, so the wrapper has
///         the same address on every chain when the constructor arguments match.
/// @dev On testnets the deployer can be the owner and allowlist routers in the same run
///      (INITIAL_ROUTERS). On mainnet the owner is the admin multisig, which allowlists
///      routers itself; the script refuses INITIAL_ROUTERS when it is not the owner.
contract Deploy is Script {
    function run() external returns (FeeWrapper wrapper) {
        bytes32 salt = vm.envBytes32("FEE_WRAPPER_SALT");
        address owner = vm.envAddress("ADMIN_ADDRESS");
        address collector = vm.envAddress("FEE_COLLECTOR");
        address signer = vm.envAddress("FEE_SIGNER");
        address guardian = vm.envAddress("GUARDIAN_ADDRESS");
        address[] memory routers = vm.envOr("INITIAL_ROUTERS", ",", new address[](0));

        vm.startBroadcast();
        wrapper = new FeeWrapper{salt: salt}(owner, collector, signer, guardian);
        if (routers.length > 0) {
            require(msg.sender == owner, "INITIAL_ROUTERS needs the deployer to be the owner");
            for (uint256 i = 0; i < routers.length; i++) {
                wrapper.setRouter(routers[i], true);
            }
        }
        vm.stopBroadcast();

        console.log("FeeWrapper", address(wrapper));
        console.log("chainId", block.chainid);
        for (uint256 i = 0; i < routers.length; i++) {
            console.log("router allowed", routers[i]);
        }
    }
}
