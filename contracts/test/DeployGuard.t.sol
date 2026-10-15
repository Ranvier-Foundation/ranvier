// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {FeeWrapper} from "../src/FeeWrapper.sol";
import {DeployHarness} from "./harness/DeployHarness.s.sol";

/// @dev Calls a script from the broadcaster's own address, so the script's `msg.sender == owner`
///      check sees the same address that sends the transactions.
contract ScriptCaller {
    function run(Deploy script) external returns (FeeWrapper) {
        return script.run();
    }
}

/// @dev Exposes the INITIAL_ROUTERS parser under any variable name, so each parsing case runs
///      under its own name and the tests can run in parallel without sharing an env variable.
contract DeployExposed is Deploy {
    function routersFromEnv(string memory name) external view returns (address[] memory) {
        return _routersFromEnv(name);
    }
}

/// @notice Deploy.s.sol role guard (ADR 0013, section 8): off chain 31337, no published development
///         address in any role or as an initial router; INITIAL_ROUTERS only on the listed testnets
///         and 31337, never malformed, never duplicated.
contract DeployGuardTest is Test {
    /// PUBLIC anvil mnemonic, chain 31337 only. Used here to derive the published addresses
    /// independently of the list in Deploy.s.sol; no key is stored or printed.
    string internal constant MNEMONIC = "test test test test test test test test test test test junk";
    address internal constant ZEROX_ALLOWANCE_HOLDER = 0x0000000000001fF3684f28c67538d4D072C22734;
    uint256 internal constant BASE_SEPOLIA = 84532;
    /// forge's revert selector for a failed cheatcode, e.g. vm.envAddress on a malformed value.
    bytes4 internal constant CHEATCODE_ERROR = bytes4(keccak256("CheatcodeError(string)"));

    Deploy internal script;
    DeployExposed internal exposed;

    function setUp() public {
        script = new Deploy();
        exposed = new DeployExposed();
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

    /// A newly listed address: refused as a signer and as an initial router on a testnet and on Base.
    function _expectRefusedEverywhere(address a) internal {
        assertTrue(script.isPublishedDevAddress(a));
        Deploy.Config memory c = _prodShaped();
        c.signer = a;
        _expectPublished(BASE_SEPOLIA, c, "FEE_SIGNER", a);
        _expectPublished(8453, c, "FEE_SIGNER", a);
        _expectPublished(BASE_SEPOLIA, _withRouter(_prodShaped(), a), "INITIAL_ROUTERS", a);
    }

    function _anvil(uint32 index) internal pure returns (address) {
        return vm.addr(vm.deriveKey(MNEMONIC, index));
    }

    function _neverLocalChains() internal pure returns (uint256[7] memory) {
        // NEVER_LOCAL_CHAINS in apps/api/src/adapters/signers/local-key.ts (the registry and
        // trusted-router chains 1, 8453 and 42161 are among these).
        return [uint256(1), 10, 56, 137, 8453, 42161, 43114];
    }

    function _expectParseFailure(string memory name, string memory value) internal {
        vm.setEnv(name, value);
        try exposed.routersFromEnv(name) returns (address[] memory parsed) {
            emit log_named_uint("parsed entries", parsed.length);
            fail();
        } catch (bytes memory err) {
            assertEq(bytes4(err), CHEATCODE_ERROR, "a parse failure, not a guard error");
        }
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

    // Mnemonic accounts 20-29: each literal in Deploy.s.sol, checked against vm.deriveKey.
    function test_refuses_mnemonicAccount20() public {
        _expectRefusedEverywhere(_anvil(20));
    }

    function test_refuses_mnemonicAccount21() public {
        _expectRefusedEverywhere(_anvil(21));
    }

    function test_refuses_mnemonicAccount22() public {
        _expectRefusedEverywhere(_anvil(22));
    }

    function test_refuses_mnemonicAccount23() public {
        _expectRefusedEverywhere(_anvil(23));
    }

    function test_refuses_mnemonicAccount24() public {
        _expectRefusedEverywhere(_anvil(24));
    }

    function test_refuses_mnemonicAccount25() public {
        _expectRefusedEverywhere(_anvil(25));
    }

    function test_refuses_mnemonicAccount26() public {
        _expectRefusedEverywhere(_anvil(26));
    }

    function test_refuses_mnemonicAccount27() public {
        _expectRefusedEverywhere(_anvil(27));
    }

    function test_refuses_mnemonicAccount28() public {
        _expectRefusedEverywhere(_anvil(28));
    }

    function test_refuses_mnemonicAccount29() public {
        _expectRefusedEverywhere(_anvil(29));
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

    /// The other Ethereum precompiles (0x03-0x11 as of Prague).
    function test_refuses_precompiles3to0x11() public {
        for (uint160 i = 3; i <= 0x11; i++) {
            _expectRefusedEverywhere(address(i));
        }
    }

    /// RIP-7212 / EIP-7951 P256VERIFY, live on Base, Optimism, Arbitrum and Polygon.
    function test_refuses_p256Precompile() public {
        _expectRefusedEverywhere(address(0x100));
    }

    /// The top of the reserved range: every address up to 0x01ff is refused.
    function test_refuses_wholePrecompileRange() public {
        for (uint160 i = 0; i <= 0x1ff; i++) {
            assertTrue(script.isPublishedDevAddress(address(i)));
        }
        _expectRefusedEverywhere(address(0x1ff));
    }

    function test_refuses_create2Factory() public {
        Deploy.Config memory c = _prodShaped();
        c.signer = CREATE2_FACTORY;
        _expectPublished(42161, c, "FEE_SIGNER", CREATE2_FACTORY);
    }

    function test_refuses_forgeDefaultSender() public {
        assertEq(DEFAULT_SENDER, 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38);
        _expectRefusedEverywhere(DEFAULT_SENDER);
    }

    function test_refuses_forgeTestContract() public {
        assertEq(script.FORGE_TEST_CONTRACT(), vm.computeCreateAddress(DEFAULT_SENDER, 1));
        assertEq(script.FORGE_TEST_CONTRACT(), address(this));
        _expectRefusedEverywhere(0x7FA9385bE102ac3EAc297483Dd6233D62b3e1496);
    }

    function test_refuses_burnAddressDead() public {
        _expectRefusedEverywhere(0x000000000000000000000000000000000000dEaD);
    }

    function test_refuses_burnAddressDead2069() public {
        _expectRefusedEverywhere(0xdEAD000000000000000042069420694206942069);
    }

    // ------------------------------------------------------------ INITIAL_ROUTERS: where it may be set

    function test_refuses_initialRouters_onEveryNeverLocalChain() public {
        uint256[7] memory chains = _neverLocalChains();
        for (uint256 j = 0; j < chains.length; j++) {
            assertFalse(script.initialRoutersAllowed(chains[j]));
            Deploy.Config memory c = _withRouter(_prodShaped(), ZEROX_ALLOWANCE_HOLDER);
            vm.expectRevert(abi.encodeWithSelector(Deploy.InitialRoutersRefused.selector, chains[j]));
            script.checkRoles(chains[j], c);
        }
    }

    /// Fail-closed: a chain the script does not know is treated as a mainnet.
    function test_refuses_initialRouters_onUnknownChains() public {
        uint256[5] memory chains = [uint256(5), 17000, 31338, 999_999_999, type(uint256).max];
        for (uint256 j = 0; j < chains.length; j++) {
            assertFalse(script.initialRoutersAllowed(chains[j]));
            Deploy.Config memory c = _withRouter(_prodShaped(), ZEROX_ALLOWANCE_HOLDER);
            vm.expectRevert(abi.encodeWithSelector(Deploy.InitialRoutersRefused.selector, chains[j]));
            script.checkRoles(chains[j], c);
        }
    }

    /// The allowlist is exactly LOCAL_SIGNER_DEFAULT_CHAINS in apps/api/src/mainnet-rules.ts.
    function test_allows_initialRouters_onEachTestnet() public {
        uint256[4] memory chains = [uint256(84532), 11155111, 421614, 31337];
        for (uint256 j = 0; j < chains.length; j++) {
            assertTrue(script.initialRoutersAllowed(chains[j]));
            script.checkRoles(chains[j], _withRouter(_prodShaped(), ZEROX_ALLOWANCE_HOLDER));
        }
    }

    function test_refuses_duplicateInitialRouter() public {
        Deploy.Config memory c = _prodShaped();
        c.routers = new address[](3);
        c.routers[0] = ZEROX_ALLOWANCE_HOLDER;
        c.routers[1] = makeAddr("otherRouter");
        c.routers[2] = ZEROX_ALLOWANCE_HOLDER;
        vm.expectRevert(abi.encodeWithSelector(Deploy.DuplicateInitialRouter.selector, ZEROX_ALLOWANCE_HOLDER));
        script.checkRoles(BASE_SEPOLIA, c);
        // A duplicate is a typo on every chain, the local one included.
        vm.expectRevert(abi.encodeWithSelector(Deploy.DuplicateInitialRouter.selector, ZEROX_ALLOWANCE_HOLDER));
        script.checkRoles(31337, c);
    }

    // ------------------------------------------------------------ INITIAL_ROUTERS: parsing

    function test_parse_unsetMeansNoRouters() public view {
        assertFalse(vm.envExists("DG_UNSET_NEVER_SET"));
        assertEq(exposed.routersFromEnv("DG_UNSET_NEVER_SET").length, 0);
    }

    function test_parse_emptyOrWhitespaceMeansNoRouters() public {
        vm.setEnv("DG_EMPTY", "");
        assertEq(exposed.routersFromEnv("DG_EMPTY").length, 0);
        vm.setEnv("DG_BLANK", "  \t ");
        assertEq(exposed.routersFromEnv("DG_BLANK").length, 0);
        // Not refused on a mainnet either: an empty value means "no routers" everywhere.
        vm.chainId(8453);
        assertEq(exposed.routersFromEnv("DG_EMPTY").length, 0);
    }

    function test_parse_trimsWhitespace() public {
        vm.setEnv(
            "DG_TRIM", " 0x0000000000001fF3684f28c67538d4D072C22734 , 0x6666666666666666666666666666666666666666 "
        );
        address[] memory r = exposed.routersFromEnv("DG_TRIM");
        assertEq(r.length, 2);
        assertEq(r[0], ZEROX_ALLOWANCE_HOLDER);
        assertEq(r[1], 0x6666666666666666666666666666666666666666);
    }

    function test_refuses_parse_emptyItem() public {
        _expectParseFailure(
            "DG_EMPTY_ITEM", "0x5555555555555555555555555555555555555555,,0x6666666666666666666666666666666666666666"
        );
    }

    function test_refuses_parse_trailingComma() public {
        _expectParseFailure("DG_TRAILING", "0x5555555555555555555555555555555555555555,");
    }

    function test_refuses_parse_39HexDigits() public {
        _expectParseFailure("DG_SHORT39", "0x555555555555555555555555555555555555555");
    }

    function test_refuses_parse_shortFirstEntry() public {
        _expectParseFailure("DG_SHORT_FIRST", "0x555,0x6666666666666666666666666666666666666666");
    }

    function test_refuses_parse_notHex() public {
        _expectParseFailure("DG_NOT_HEX", "0x0000000000001fF3684f28c67538d4D072C2273g");
    }

    /// Off the allowlist, any non-empty value (well-formed or not) is refused before parsing.
    function test_refuses_parse_malformedOnMainnet_asInitialRoutersRefused() public {
        vm.setEnv("DG_MAINNET_MALFORMED", "0x555,0x6666666666666666666666666666666666666666");
        vm.chainId(8453);
        vm.expectRevert(abi.encodeWithSelector(Deploy.InitialRoutersRefused.selector, 8453));
        exposed.routersFromEnv("DG_MAINNET_MALFORMED");
    }

    /// Duplicates are compared as addresses, not as text: different letter case is the same router.
    function test_refuses_duplicateInitialRouter_differentCase() public {
        vm.setEnv(
            "DG_DUP_CASE", "0x0000000000001fF3684f28c67538d4D072C22734,0x0000000000001ff3684f28c67538d4d072c22734"
        );
        Deploy.Config memory c = _prodShaped();
        c.routers = exposed.routersFromEnv("DG_DUP_CASE");
        assertEq(c.routers.length, 2);
        vm.expectRevert(abi.encodeWithSelector(Deploy.DuplicateInitialRouter.selector, ZEROX_ALLOWANCE_HOLDER));
        script.checkRoles(BASE_SEPOLIA, c);
    }

    // ------------------------------------------------------------ what still passes

    function test_allows_productionShaped_onMainnets() public {
        uint256[7] memory chains = _neverLocalChains();
        for (uint256 j = 0; j < chains.length; j++) {
            script.checkRoles(chains[j], _prodShaped());
        }
    }

    /// docs/runbooks/testnet-deploy.md: fresh keys, the 0x AllowanceHolder as initial router.
    function test_allows_testnetShaped_withRouter() public {
        script.checkRoles(BASE_SEPOLIA, _withRouter(_prodShaped(), ZEROX_ALLOWANCE_HOLDER));
    }

    /// Only the listed addresses are refused; neighbours of the refused classes are fine.
    function test_allows_neighbours() public {
        Deploy.Config memory c = _prodShaped();
        c.signer = address(0x200);
        c.collector = _anvil(30);
        c.guardian = 0x000000000000000000000000000000000000dEAe;
        script.checkRoles(8453, c);
        assertFalse(script.isPublishedDevAddress(address(0x200)));
        assertFalse(script.isPublishedDevAddress(_anvil(30)));
        assertFalse(script.isPublishedDevAddress(0x000000000000000000000000000000000000dEAe));
    }

    /// The local chain is the harness: published accounts and routers are expected there.
    function test_allows_everything_onLocalChain() public view {
        Deploy.Config memory c;
        c.owner = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
        c.guardian = address(0);
        c.collector = CREATE2_FACTORY;
        c.signer = DEFAULT_SENDER;
        c.routers = new address[](2);
        c.routers[0] = address(0x100);
        c.routers[1] = 0x000000000000000000000000000000000000dEaD;
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

    /// The only test that touches the real INITIAL_ROUTERS and role variables (forge runs tests in
    /// parallel, and the environment is shared), so every env scenario runs here in sequence.
    function test_run_readsEnv_guardsBeforeBroadcast() public {
        // A fresh testnet deployer (forge's default sender is refused off 31337). With exactly one
        // remembered key, the script's bare vm.startBroadcast() sends from it; the key is derived
        // from the label at run time and never printed.
        (address deployer, uint256 deployerKey) = makeAddrAndKey("testnetDeployer");
        vm.rememberKey(deployerKey);
        deployCodeTo("DeployGuard.t.sol:ScriptCaller", deployer);
        bytes32 salt = keccak256("env salt");
        vm.setEnv("FEE_WRAPPER_SALT", vm.toString(salt));
        vm.setEnv("ADMIN_ADDRESS", vm.toString(deployer));
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
                    abi.encode(deployer, makeAddr("feeCollectorSafe"), _anvil(1), makeAddr("guardianMultisig"))
                )
            )
        );
        vm.expectRevert(abi.encodeWithSelector(Deploy.PublishedDevAddress.selector, "FEE_SIGNER", _anvil(1)));
        ScriptCaller(deployer).run(script);
        assertEq(expected.code.length, 0, "nothing deployed");

        // 2. A malformed INITIAL_ROUTERS on Base Sepolia: fails loudly instead of deploying without routers.
        address signer = makeAddr("testnetSigner");
        vm.setEnv("FEE_SIGNER", vm.toString(signer));
        vm.setEnv("INITIAL_ROUTERS", "0x0000000000001fF3684f28c67538d4D072C22734,,");
        try ScriptCaller(deployer).run(script) {
            fail();
        } catch (bytes memory err) {
            assertEq(bytes4(err), CHEATCODE_ERROR);
        }

        // 3. A duplicated INITIAL_ROUTERS entry on Base Sepolia: refused.
        vm.setEnv(
            "INITIAL_ROUTERS", "0x0000000000001fF3684f28c67538d4D072C22734, 0x0000000000001ff3684f28c67538d4d072c22734"
        );
        vm.expectRevert(abi.encodeWithSelector(Deploy.DuplicateInitialRouter.selector, ZEROX_ALLOWANCE_HOLDER));
        ScriptCaller(deployer).run(script);

        // 4. Testnet-shaped (fresh signer, 0x AllowanceHolder router): deploys as before.
        vm.setEnv("INITIAL_ROUTERS", vm.toString(ZEROX_ALLOWANCE_HOLDER));
        FeeWrapper w = ScriptCaller(deployer).run(script);
        assertEq(w.feeSigner(), signer);
        assertEq(w.owner(), deployer);
        assertTrue(w.isRouterAllowed(ZEROX_ALLOWANCE_HOLDER));

        // 5. The same env on Base mainnet, and on an unknown chain: INITIAL_ROUTERS refused.
        vm.chainId(8453);
        vm.expectRevert(abi.encodeWithSelector(Deploy.InitialRoutersRefused.selector, 8453));
        ScriptCaller(deployer).run(script);
        vm.chainId(999_999);
        vm.expectRevert(abi.encodeWithSelector(Deploy.InitialRoutersRefused.selector, 999_999));
        ScriptCaller(deployer).run(script);

        // 6. Production-shaped on Base: no routers, multisig owner. Passes.
        vm.chainId(8453);
        vm.setEnv("INITIAL_ROUTERS", "");
        vm.setEnv("ADMIN_ADDRESS", vm.toString(makeAddr("adminMultisig")));
        vm.setEnv("FEE_WRAPPER_SALT", vm.toString(keccak256("mainnet salt")));
        w = ScriptCaller(deployer).run(script);
        assertEq(w.owner(), makeAddr("adminMultisig"));
        assertEq(w.feeSigner(), signer);

        // 7. The local runbook on 31337: published accounts as every role. Passes.
        vm.chainId(31337);
        vm.setEnv("FEE_WRAPPER_SALT", "0x0000000000000000000000000000000000000000000000000000000052414e56");
        vm.setEnv("ADMIN_ADDRESS", vm.toString(_anvil(0)));
        vm.setEnv("GUARDIAN_ADDRESS", vm.toString(_anvil(0)));
        vm.setEnv("FEE_COLLECTOR", vm.toString(_anvil(3)));
        vm.setEnv("FEE_SIGNER", vm.toString(_anvil(1)));
        w = ScriptCaller(deployer).run(script);
        assertEq(address(w), 0x60A10abb52c31ec38f1f93c70B64D2Fb00913859, "runbook address");

        // 8. DeployHarness: refuses another chain before reading anything, refuses INITIAL_ROUTERS,
        //    and fails loudly on a malformed one.
        DeployHarness harness = new DeployHarness();
        vm.chainId(BASE_SEPOLIA);
        vm.expectRevert(abi.encodeWithSelector(DeployHarness.NotLocalChain.selector, BASE_SEPOLIA));
        ScriptCaller(deployer).run(harness);
        vm.chainId(31337);
        vm.setEnv("INITIAL_ROUTERS", vm.toString(ZEROX_ALLOWANCE_HOLDER));
        vm.expectRevert(DeployHarness.InitialRoutersSetByHarness.selector);
        ScriptCaller(deployer).run(harness);
        vm.setEnv("INITIAL_ROUTERS", "0x555");
        try ScriptCaller(deployer).run(harness) {
            fail();
        } catch (bytes memory err) {
            assertEq(bytes4(err), CHEATCODE_ERROR);
        }
    }
}
