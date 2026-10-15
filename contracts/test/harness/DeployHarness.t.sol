// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {FeeWrapper} from "../../src/FeeWrapper.sol";
import {DeployHarness} from "./DeployHarness.s.sol";
import {HarnessConfig} from "./HarnessConfig.sol";

/// @dev Runs `deployAll` from forge's default sender, which is also the test broadcaster.
contract HarnessCaller {
    function deployAll(DeployHarness script, Deploy.Config memory roles)
        external
        returns (FeeWrapper wrapper, DeployHarness.Mocks memory m)
    {
        return script.deployAll(roles);
    }
}

contract DeployHarnessTest is Test {
    function test_deployAll_mocksAtTableAddresses_realWrapperWithHolderOnly() public {
        vm.chainId(31337);
        deployCodeTo("DeployHarness.t.sol:HarnessCaller", DEFAULT_SENDER);
        Deploy.Config memory roles;
        roles.salt = HarnessConfig.FEE_WRAPPER_SALT;
        roles.owner = DEFAULT_SENDER;
        roles.guardian = HarnessConfig.DEPLOYER;
        roles.collector = HarnessConfig.FEE_COLLECTOR;
        roles.signer = HarnessConfig.FEE_SIGNER;

        (FeeWrapper wrapper, DeployHarness.Mocks memory m) =
            HarnessCaller(DEFAULT_SENDER).deployAll(new DeployHarness(), roles);

        assertEq(address(m.holder), HarnessConfig.ALLOWANCE_HOLDER);
        assertEq(address(m.settler), HarnessConfig.SETTLER);
        assertEq(address(m.husdc), HarnessConfig.HUSDC);
        assertEq(address(m.settler).balance, HarnessConfig.SETTLER_NATIVE_FLOAT);
        assertTrue(wrapper.isRouterAllowed(address(m.holder)));
        assertFalse(wrapper.isRouterAllowed(address(m.settler)));
        assertEq(wrapper.feeSigner(), HarnessConfig.FEE_SIGNER);
        assertEq(wrapper.feeCollector(), HarnessConfig.FEE_COLLECTOR);
        assertEq(wrapper.owner(), DEFAULT_SENDER);
        (, string memory name, string memory version, uint256 chainId, address verifying,,) = wrapper.eip712Domain();
        assertEq(name, "Ranvier FeeWrapper");
        assertEq(version, "1");
        assertEq(chainId, 31337);
        assertEq(verifying, address(wrapper));
    }

    function test_deployAll_refusesOtherChains() public {
        DeployHarness h = new DeployHarness();
        Deploy.Config memory roles;
        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(DeployHarness.NotLocalChain.selector, 1));
        h.deployAll(roles);
    }
}
