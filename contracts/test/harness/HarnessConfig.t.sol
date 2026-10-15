// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, console} from "forge-std/Test.sol";
import {FeeWrapper} from "../../src/FeeWrapper.sol";
import {DeployHarness} from "./DeployHarness.s.sol";
import {HarnessConfig} from "./HarnessConfig.sol";
import {
    FalseReturnToken,
    FeeOnTransferHarnessToken,
    HarnessToken,
    HarnessWETH,
    HookToken,
    UsdtStyleToken
} from "./HarnessTokens.sol";
import {MockAllowanceHolder, MockSettler} from "./ZeroXMocks.sol";

/// @notice The committed address table must be what CREATE2 gives for the current init code, and
///         the harness accounts must be what the published mnemonic derives (PUBLIC anvil keys, chain
///         31337 only; derived here, never written down).
contract HarnessConfigTest is Test {
    function _at(bytes32 salt, bytes memory initCode) internal pure returns (address) {
        return vm.computeCreate2Address(salt, keccak256(initCode), CREATE2_FACTORY);
    }

    function _token(bytes32 salt, string memory name, string memory symbol) internal pure returns (address) {
        return _at(salt, abi.encodePacked(type(HarnessToken).creationCode, abi.encode(name, symbol, uint8(6))));
    }

    function _computed() internal returns (DeployHarness.Mocks memory m) {
        m.husdc = HarnessToken(_token(HarnessConfig.SALT_HUSDC, "Harness USD Coin", "hUSDC"));
        m.hweth = HarnessWETH(payable(_at(HarnessConfig.SALT_HWETH, type(HarnessWETH).creationCode)));
        m.husdt = UsdtStyleToken(_at(HarnessConfig.SALT_HUSDT, type(UsdtStyleToken).creationCode));
        m.hfalse = FalseReturnToken(_at(HarnessConfig.SALT_HFALSE, type(FalseReturnToken).creationCode));
        m.htax = FeeOnTransferHarnessToken(_at(HarnessConfig.SALT_HTAX, type(FeeOnTransferHarnessToken).creationCode));
        m.hhook = HookToken(_at(HarnessConfig.SALT_HHOOK, type(HookToken).creationCode));
        m.hunder = HarnessToken(_token(HarnessConfig.SALT_HUNDER, "Harness scenario: underpays", "hUNDER"));
        m.hpaywrap = HarnessToken(_token(HarnessConfig.SALT_HPAYWRAP, "Harness scenario: pays the wrapper", "hPAYWRAP"));
        m.hspend = HarnessToken(_token(HarnessConfig.SALT_HSPEND, "Harness scenario: spends half", "hSPEND"));
        m.hrevert = HarnessToken(_token(HarnessConfig.SALT_HREVERT, "Harness scenario: reverts with data", "hREVERT"));
        m.hbigrev = HarnessToken(_token(HarnessConfig.SALT_HBIGREV, "Harness scenario: huge revert", "hBIGREV"));
        m.hreenter = HarnessToken(_token(HarnessConfig.SALT_HREENTER, "Harness scenario: re-enters", "hREENTER"));
        m.horacle = HarnessToken(_token(HarnessConfig.SALT_HORACLE, "Harness scenario: 10% under oracle", "hORACLE"));
        m.holder = MockAllowanceHolder(_at(HarnessConfig.SALT_ALLOWANCE_HOLDER, type(MockAllowanceHolder).creationCode));
        MockSettler.PairConfig[] memory table = new DeployHarness().pairTable(m);
        m.settler = MockSettler(
            payable(_at(
                    HarnessConfig.SALT_SETTLER,
                    abi.encodePacked(type(MockSettler).creationCode, abi.encode(m.holder, table))
                ))
        );
    }

    function test_addressTable_matchesCreate2() public {
        DeployHarness.Mocks memory m = _computed();
        console.log("MockAllowanceHolder", address(m.holder));
        console.log("MockSettler", address(m.settler));
        console.log("hUSDC", address(m.husdc));
        console.log("hWETH", address(m.hweth));
        console.log("hUSDT", address(m.husdt));
        console.log("hFALSE", address(m.hfalse));
        console.log("hTAX", address(m.htax));
        console.log("hHOOK", address(m.hhook));
        console.log("hUNDER", address(m.hunder));
        console.log("hPAYWRAP", address(m.hpaywrap));
        console.log("hSPEND", address(m.hspend));
        console.log("hREVERT", address(m.hrevert));
        console.log("hBIGREV", address(m.hbigrev));
        console.log("hREENTER", address(m.hreenter));
        console.log("hORACLE", address(m.horacle));
        assertEq(address(m.holder), HarnessConfig.ALLOWANCE_HOLDER, "MockAllowanceHolder");
        assertEq(address(m.settler), HarnessConfig.SETTLER, "MockSettler");
        assertEq(address(m.husdc), HarnessConfig.HUSDC, "hUSDC");
        assertEq(address(m.hweth), HarnessConfig.HWETH, "hWETH");
        assertEq(address(m.husdt), HarnessConfig.HUSDT, "hUSDT");
        assertEq(address(m.hfalse), HarnessConfig.HFALSE, "hFALSE");
        assertEq(address(m.htax), HarnessConfig.HTAX, "hTAX");
        assertEq(address(m.hhook), HarnessConfig.HHOOK, "hHOOK");
        assertEq(address(m.hunder), HarnessConfig.HUNDER, "hUNDER");
        assertEq(address(m.hpaywrap), HarnessConfig.HPAYWRAP, "hPAYWRAP");
        assertEq(address(m.hspend), HarnessConfig.HSPEND, "hSPEND");
        assertEq(address(m.hrevert), HarnessConfig.HREVERT, "hREVERT");
        assertEq(address(m.hbigrev), HarnessConfig.HBIGREV, "hBIGREV");
        assertEq(address(m.hreenter), HarnessConfig.HREENTER, "hREENTER");
        assertEq(address(m.horacle), HarnessConfig.HORACLE, "hORACLE");
    }

    function test_wrapperAddress_matchesRunbook() public pure {
        bytes memory init = abi.encodePacked(
            type(FeeWrapper).creationCode,
            abi.encode(
                HarnessConfig.DEPLOYER, HarnessConfig.FEE_COLLECTOR, HarnessConfig.FEE_SIGNER, HarnessConfig.DEPLOYER
            )
        );
        assertEq(_at(HarnessConfig.FEE_WRAPPER_SALT, init), HarnessConfig.FEE_WRAPPER);
    }

    function test_accounts_matchPublishedMnemonic() public pure {
        // PUBLIC anvil keys, chain 31337 only: derived in memory to check the addresses, never stored.
        assertEq(vm.addr(vm.deriveKey(HarnessConfig.ANVIL_MNEMONIC, 0)), HarnessConfig.DEPLOYER);
        assertEq(
            vm.addr(vm.deriveKey(HarnessConfig.ANVIL_MNEMONIC, HarnessConfig.FEE_SIGNER_INDEX)),
            HarnessConfig.FEE_SIGNER
        );
        assertEq(vm.addr(vm.deriveKey(HarnessConfig.ANVIL_MNEMONIC, 2)), HarnessConfig.USER);
        assertEq(vm.addr(vm.deriveKey(HarnessConfig.ANVIL_MNEMONIC, 3)), HarnessConfig.FEE_COLLECTOR);
    }
}
