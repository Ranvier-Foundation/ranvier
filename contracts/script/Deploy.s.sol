// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {FeeWrapper} from "../src/FeeWrapper.sol";

/// @notice Deterministic deployment through the standard CREATE2 factory, so the wrapper has
///         the same address on every chain when the constructor arguments match.
contract Deploy is Script {
    function run() external returns (FeeWrapper wrapper) {
        bytes32 salt = vm.envBytes32("FEE_WRAPPER_SALT");
        address owner = vm.envAddress("ADMIN_MULTISIG");
        address collector = vm.envAddress("FEE_COLLECTOR");
        address signer = vm.envAddress("FEE_SIGNER");
        address guardian = vm.envAddress("GUARDIAN_MULTISIG");

        vm.startBroadcast();
        wrapper = new FeeWrapper{salt: salt}(owner, collector, signer, guardian);
        vm.stopBroadcast();
        console.log("FeeWrapper", address(wrapper));
    }
}
