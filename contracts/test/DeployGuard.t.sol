// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {FeeWrapper} from "../src/FeeWrapper.sol";
import {DeployHarness} from "./harness/DeployHarness.s.sol";

/// @dev Calls a script from forge's default sender, which is also the test broadcaster, so the
///      script's `msg.sender == owner` check sees the same address that sends the transactions.
contract ScriptCaller {
    function run(Deploy script) external returns (FeeWrapper) {
        return script.run();
    }
}

/// @notice Deploy.s.sol role guard (ADR 0013, section 8): off chain 31337, no published development
///         address in any role or as an initial router; on 1, 8453 and 42161, no INITIAL_ROUTERS.
contract DeployGuardTest is Test {
    /// PUBLIC anvil mnemonic, chain 31337 only. Used here to derive the published addresses
    /// independently of the list in Deploy.s.sol; no key is stored or printed.
    string internal constant MNEMONIC = "test test test test test test test test test test test junk";
    address internal constant ZEROX_ALLOWANCE_HOLDER = 0x0000000000001fF3684f28c67538d4D072C22734;
    uint256 internal constant BASE_SEPOLIA = 84532;

    Deploy internal script;

    function setUp() public {
        script = new Deploy();
    }

    function _prodShaped() internal returns (Deploy.Config memory c) {
        c.salt = keccak256("salt");
        c.owner = makeAddr("adminMultisig");
        c.collector = makeAddr("feeCollectorSafe");
        c.signer = makeAddr("kmsSigner");
        c.guardian = makeAddr("guardianMultisig");
        c.routers = new address[](0);
    }

    function _withRouter(Deploy.Config memory c, address router) internal pure returns (Deploy.Config memory) {
        c.routers = new address[](1);
        c.routers[0] = router;
        return c;
    }

    function _expectPublished(uint256 chainId, Deploy.Config memory c, string memory role, address account) internal {
        vm.expectRevert(abi.encodeWithSelector(Deploy.PublishedDevAddress.selector, role, account));
        script.checkRoles(chainId, c);
    }

    function _anvil(uint32 index) internal pure returns (address) {
        return vm.addr(vm.deriveKey(MNEMONIC, index));
    }

    // ------------------------------------------------------------ one test per refused role

    function test_refuses_publishedAdmin() public {
        Deploy.Config memory c = _prodShaped();
        c.owner = _anvil(0);
        _expectPublished(BASE_SEPOLIA, c, "ADMIN_ADDRESS", c.owner);
    }

    function test_refuses_publishedGuardian() public {
        Deploy.Config memory c = _prodShaped();
        c.guardian = _anvil(0);
        _expectPublished(BASE_SEPOLIA, c, "GUARDIAN_ADDRESS", c.guardian);
    }

    function test_refuses_publishedCollector() public {
        Deploy.Config memory c = _prodShaped();
        c.collector = _anvil(3);
        _expectPublished(BASE_SEPOLIA, c, "FEE_COLLECTOR", c.collector);
    }

    function test_refuses_publishedSigner() public {
        Deploy.Config memory c = _prodShaped();
        c.signer = _anvil(1);
        _expectPublished(BASE_SEPOLIA, c, "FEE_SIGNER", c.signer);
    }

    function test_refuses_publishedInitialRouter() public {
        Deploy.Config memory c = _prodShaped();
        c.routers = new address[](2);
        c.routers[0] = ZEROX_ALLOWANCE_HOLDER;
        c.routers[1] = _anvil(5);
        _expectPublished(BASE_SEPOLIA, c, "INITIAL_ROUTERS", c.routers[1]);
    }

    // ------------------------------------------------------------ one test per refused address class

    function test_refuses_first20MnemonicAccounts_onEveryRealChain() public {
        uint256[5] memory chains = [uint256(1), 8453, 42161, BASE_SEPOLIA, 11155111];
        for (uint32 i = 0; i < 20; i++) {
            address a = _anvil(i);
            assertTrue(script.isPublishedDevAddress(a));
            for (uint256 j = 0; j < chains.length; j++) {
                Deploy.Config memory c = _prodShaped();
                c.signer = a;
                _expectPublished(chains[j], c, "FEE_SIGNER", a);
            }
        }
    }

    function test_refuses_zeroAddress() public {
        Deploy.Config memory c = _prodShaped();
        c.collector = address(0);
        _expectPublished(8453, c, "FEE_COLLECTOR", address(0));
    }

    function test_refuses_precompile1() public {
        Deploy.Config memory c = _prodShaped();
        c.guardian = address(1);
        _expectPublished(8453, c, "GUARDIAN_ADDRESS", address(1));
    }

    function test_refuses_precompile2() public {
        Deploy.Config memory c = _prodShaped();
        c.owner = address(2);
        _expectPublished(8453, c, "ADMIN_ADDRESS", address(2));
    }

    function test_refuses_create2Factory() public {
        Deploy.Config memory c = _prodShaped();
        c.signer = CREATE2_FACTORY;
        _expectPublished(42161, c, "FEE_SIGNER", CREATE2_FACTORY);
    }

    function test_refuses_anyInitialRouterOnMainnets() public {
        uint256[3] memory chains = [uint256(1), 8453, 42161];
        for (uint256 j = 0; j < chains.length; j++) {
            Deploy.Config memory c = _withRouter(_prodShaped(), ZEROX_ALLOWANCE_HOLDER);
            vm.expectRevert(abi.encodeWithSelector(Deploy.InitialRoutersRefused.selector, chains[j]));
            script.checkRoles(chains[j], c);
        }
    }

    // ------------------------------------------------------------ what still passes

    function test_allows_productionShaped_onMainnets() public {
        script.checkRoles(1, _prodShaped());
        script.checkRoles(8453, _prodShaped());
        script.checkRoles(42161, _prodShaped());
    }

    /// docs/runbooks/testnet-deploy.md: fresh keys, the 0x AllowanceHolder as initial router.
    function test_allows_testnetShaped_withRouter() public {
        script.checkRoles(BASE_SEPOLIA, _withRouter(_prodShaped(), ZEROX_ALLOWANCE_HOLDER));
    }

    /// Only the first 20 accounts are listed; neighbours of the refused classes are fine.
    function test_allows_neighbours() public {
        Deploy.Config memory c = _prodShaped();
        c.signer = address(3);
        c.collector = _anvil(20);
        script.checkRoles(8453, c);
        assertFalse(script.isPublishedDevAddress(address(3)));
        assertFalse(script.isPublishedDevAddress(_anvil(20)));
    }

    /// The local chain is the harness: published accounts and routers are expected there.
    function test_allows_everything_onLocalChain() public view {
        Deploy.Config memory c;
        c.owner = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
        c.guardian = address(0);
        c.collector = CREATE2_FACTORY;
        c.signer = address(1);
        c.routers = new address[](1);
        c.routers[0] = address(2);
        script.checkRoles(31337, c);
    }

    function testFuzz_unpublishedAddresses_pass(address owner, address signer, uint256 chainId) public view {
        vm.assume(!script.isPublishedDevAddress(owner) && !script.isPublishedDevAddress(signer));
        chainId = bound(chainId, 1, type(uint64).max);
        Deploy.Config memory c;
        c.owner = owner;
        c.guardian = owner;
        c.collector = signer;
        c.signer = signer;
        c.routers = new address[](0);
        script.checkRoles(chainId, c);
    }

    // ------------------------------------------------------------ the env path, end to end

    /// The only test that touches environment variables (forge runs tests in parallel, and the
    /// environment is shared), so every env scenario runs here in sequence.
    function test_run_readsEnv_guardsBeforeBroadcast() public {
        deployCodeTo("DeployGuard.t.sol:ScriptCaller", DEFAULT_SENDER);
        bytes32 salt = keccak256("env salt");
        vm.setEnv("FEE_WRAPPER_SALT", vm.toString(salt));
        vm.setEnv("ADMIN_ADDRESS", vm.toString(DEFAULT_SENDER));
        vm.setEnv("GUARDIAN_ADDRESS", vm.toString(makeAddr("guardianMultisig")));
        vm.setEnv("FEE_COLLECTOR", vm.toString(makeAddr("feeCollectorSafe")));
        vm.setEnv("FEE_SIGNER", vm.toString(_anvil(1)));
        vm.setEnv("INITIAL_ROUTERS", vm.toString(ZEROX_ALLOWANCE_HOLDER));

        // 1. A published fee signer on Base Sepolia: refused before anything is broadcast.
        vm.chainId(BASE_SEPOLIA);
        address expected = vm.computeCreate2Address(
            salt,
            keccak256(
                abi.encodePacked(
                    type(FeeWrapper).creationCode,
                    abi.encode(DEFAULT_SENDER, makeAddr("feeCollectorSafe"), _anvil(1), makeAddr("guardianMultisig"))
                )
            )
        );
        vm.expectRevert(abi.encodeWithSelector(Deploy.PublishedDevAddress.selector, "FEE_SIGNER", _anvil(1)));
        ScriptCaller(DEFAULT_SENDER).run(script);
        assertEq(expected.code.length, 0, "nothing deployed");

        // 2. Testnet-shaped (fresh signer, 0x AllowanceHolder router): deploys as before.
        address signer = makeAddr("testnetSigner");
        vm.setEnv("FEE_SIGNER", vm.toString(signer));
        FeeWrapper w = ScriptCaller(DEFAULT_SENDER).run(script);
        assertEq(w.feeSigner(), signer);
        assertEq(w.owner(), DEFAULT_SENDER);
        assertTrue(w.isRouterAllowed(ZEROX_ALLOWANCE_HOLDER));

        // 3. The same env on Base mainnet: INITIAL_ROUTERS refused.
        vm.chainId(8453);
        vm.expectRevert(abi.encodeWithSelector(Deploy.InitialRoutersRefused.selector, 8453));
        ScriptCaller(DEFAULT_SENDER).run(script);

        // 4. Production-shaped on Base: no routers, multisig owner. Passes.
        vm.setEnv("INITIAL_ROUTERS", "");
        vm.setEnv("ADMIN_ADDRESS", vm.toString(makeAddr("adminMultisig")));
        vm.setEnv("FEE_WRAPPER_SALT", vm.toString(keccak256("mainnet salt")));
        w = ScriptCaller(DEFAULT_SENDER).run(script);
        assertEq(w.owner(), makeAddr("adminMultisig"));
        assertEq(w.feeSigner(), signer);

        // 5. The local runbook on 31337: published accounts as every role. Passes.
        vm.chainId(31337);
        vm.setEnv("FEE_WRAPPER_SALT", "0x0000000000000000000000000000000000000000000000000000000052414e56");
        vm.setEnv("ADMIN_ADDRESS", vm.toString(_anvil(0)));
        vm.setEnv("GUARDIAN_ADDRESS", vm.toString(_anvil(0)));
        vm.setEnv("FEE_COLLECTOR", vm.toString(_anvil(3)));
        vm.setEnv("FEE_SIGNER", vm.toString(_anvil(1)));
        w = ScriptCaller(DEFAULT_SENDER).run(script);
        assertEq(address(w), 0x60A10abb52c31ec38f1f93c70B64D2Fb00913859, "runbook address");

        // 6. DeployHarness: refuses another chain before reading anything, and refuses INITIAL_ROUTERS.
        DeployHarness harness = new DeployHarness();
        vm.chainId(BASE_SEPOLIA);
        vm.expectRevert(abi.encodeWithSelector(DeployHarness.NotLocalChain.selector, BASE_SEPOLIA));
        ScriptCaller(DEFAULT_SENDER).run(harness);
        vm.chainId(31337);
        vm.setEnv("INITIAL_ROUTERS", vm.toString(ZEROX_ALLOWANCE_HOLDER));
        vm.expectRevert(DeployHarness.InitialRoutersSetByHarness.selector);
        ScriptCaller(DEFAULT_SENDER).run(harness);
    }
}
