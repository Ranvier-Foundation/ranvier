// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// LOCAL TEST HARNESS ONLY (ADR 0013, section 8). Chain 31337 only: refuses every other chain ID.
// Deploys the harness mocks at fixed CREATE2 addresses, then the REAL FeeWrapper through
// Deploy.s.sol's own path (same role guard, same broadcast code), with the roles from the
// environment and the mock AllowanceHolder as the only initial router.

import {Deploy} from "../../script/Deploy.s.sol";
import {FeeWrapper} from "../../src/FeeWrapper.sol";
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

contract DeployHarness is Deploy {
    struct Mocks {
        MockAllowanceHolder holder;
        MockSettler settler;
        HarnessToken husdc;
        HarnessWETH hweth;
        UsdtStyleToken husdt;
        FalseReturnToken hfalse;
        FeeOnTransferHarnessToken htax;
        HookToken hhook;
        HarnessToken hunder;
        HarnessToken hpaywrap;
        HarnessToken hspend;
        HarnessToken hrevert;
        HarnessToken hbigrev;
        HarnessToken hreenter;
        HarnessToken horacle;
    }

    error NotLocalChain(uint256 chainId);
    error InitialRoutersSetByHarness();
    error MockAddressChanged(string name, address expected, address actual);

    /// @notice Env: FEE_WRAPPER_SALT, ADMIN_ADDRESS (must be the sender), FEE_COLLECTOR, FEE_SIGNER,
    ///         GUARDIAN_ADDRESS. INITIAL_ROUTERS must be unset: the harness allowlists its own holder.
    function run() external override returns (FeeWrapper wrapper) {
        if (block.chainid != HarnessConfig.CHAIN_ID) revert NotLocalChain(block.chainid);
        if (vm.envOr("INITIAL_ROUTERS", ",", new address[](0)).length != 0) revert InitialRoutersSetByHarness();
        (wrapper,) = deployAll(_rolesFromEnv());
    }

    /// @notice Mocks, then the wrapper through `Deploy._deploy` with the mock holder as its router.
    function deployAll(Config memory roles) public returns (FeeWrapper wrapper, Mocks memory m) {
        m = deployMocks();
        roles.routers = new address[](1);
        roles.routers[0] = address(m.holder);
        wrapper = _deploy(roles);
    }

    function deployMocks() public returns (Mocks memory m) {
        if (block.chainid != HarnessConfig.CHAIN_ID) revert NotLocalChain(block.chainid);

        vm.startBroadcast();
        m.husdc = new HarnessToken{salt: HarnessConfig.SALT_HUSDC}("Harness USD Coin", "hUSDC", 6);
        m.hweth = new HarnessWETH{salt: HarnessConfig.SALT_HWETH}();
        m.husdt = new UsdtStyleToken{salt: HarnessConfig.SALT_HUSDT}();
        m.hfalse = new FalseReturnToken{salt: HarnessConfig.SALT_HFALSE}();
        m.htax = new FeeOnTransferHarnessToken{salt: HarnessConfig.SALT_HTAX}();
        m.hhook = new HookToken{salt: HarnessConfig.SALT_HHOOK}();
        m.hunder = new HarnessToken{salt: HarnessConfig.SALT_HUNDER}("Harness scenario: underpays", "hUNDER", 6);
        m.hpaywrap =
            new HarnessToken{salt: HarnessConfig.SALT_HPAYWRAP}("Harness scenario: pays the wrapper", "hPAYWRAP", 6);
        m.hspend = new HarnessToken{salt: HarnessConfig.SALT_HSPEND}("Harness scenario: spends half", "hSPEND", 6);
        m.hrevert =
            new HarnessToken{salt: HarnessConfig.SALT_HREVERT}("Harness scenario: reverts with data", "hREVERT", 6);
        m.hbigrev = new HarnessToken{salt: HarnessConfig.SALT_HBIGREV}("Harness scenario: huge revert", "hBIGREV", 6);
        m.hreenter = new HarnessToken{salt: HarnessConfig.SALT_HREENTER}("Harness scenario: re-enters", "hREENTER", 6);
        m.horacle =
            new HarnessToken{salt: HarnessConfig.SALT_HORACLE}("Harness scenario: 10% under oracle", "hORACLE", 6);
        m.holder = new MockAllowanceHolder{salt: HarnessConfig.SALT_ALLOWANCE_HOLDER}();
        m.settler = new MockSettler{salt: HarnessConfig.SALT_SETTLER}(m.holder, pairTable(m));
        (bool ok,) = address(m.settler).call{value: HarnessConfig.SETTLER_NATIVE_FLOAT}("");
        require(ok, "fund settler");
        vm.stopBroadcast();

        _expect("MockAllowanceHolder", HarnessConfig.ALLOWANCE_HOLDER, address(m.holder));
        _expect("MockSettler", HarnessConfig.SETTLER, address(m.settler));
        _expect("hUSDC", HarnessConfig.HUSDC, address(m.husdc));
        _expect("hWETH", HarnessConfig.HWETH, address(m.hweth));
        _expect("hUSDT", HarnessConfig.HUSDT, address(m.husdt));
        _expect("hFALSE", HarnessConfig.HFALSE, address(m.hfalse));
        _expect("hTAX", HarnessConfig.HTAX, address(m.htax));
        _expect("hHOOK", HarnessConfig.HHOOK, address(m.hhook));
        _expect("hUNDER", HarnessConfig.HUNDER, address(m.hunder));
        _expect("hPAYWRAP", HarnessConfig.HPAYWRAP, address(m.hpaywrap));
        _expect("hSPEND", HarnessConfig.HSPEND, address(m.hspend));
        _expect("hREVERT", HarnessConfig.HREVERT, address(m.hrevert));
        _expect("hBIGREV", HarnessConfig.HBIGREV, address(m.hbigrev));
        _expect("hREENTER", HarnessConfig.HREENTER, address(m.hreenter));
        _expect("hORACLE", HarnessConfig.HORACLE, address(m.horacle));
    }

    /// @notice The behaviour of every pair (ADR 0013, section 3). Rates are base units out per base
    ///         unit in, from ETH/hWETH = $3,000 and every other harness token = $1.
    function pairTable(Mocks memory m) public pure returns (MockSettler.PairConfig[] memory t) {
        address ethIn = address(0);
        address ethOut = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
        uint128 usdcPerEth = HarnessConfig.ETH_USD * 1e6; // per 1e18 wei
        t = new MockSettler.PairConfig[](17);
        // Happy paths: pay at the fixed rate.
        t[0] = _row(ethIn, address(m.husdc), MockSettler.Mode.Pay, usdcPerEth, 1e18);
        t[1] = _row(address(m.husdc), ethOut, MockSettler.Mode.Pay, 1e18, usdcPerEth);
        t[2] = _row(address(m.husdc), address(m.hweth), MockSettler.Mode.Pay, 1e18, usdcPerEth);
        t[3] = _row(address(m.hweth), address(m.husdc), MockSettler.Mode.Pay, usdcPerEth, 1e18);
        // Token quirks as input (and hUSDT as output), 1:1.
        t[4] = _row(address(m.husdt), address(m.husdc), MockSettler.Mode.Pay, 1, 1);
        t[5] = _row(address(m.husdc), address(m.husdt), MockSettler.Mode.Pay, 1, 1);
        t[6] = _row(address(m.hfalse), address(m.husdc), MockSettler.Mode.Pay, 1, 1);
        t[7] = _row(address(m.htax), address(m.husdc), MockSettler.Mode.Pay, 1, 1);
        t[8] = _row(address(m.hhook), address(m.husdc), MockSettler.Mode.Pay, 1, 1);
        // Router failures (a)-(g), selected by the output token.
        t[9] = _row(address(m.husdc), address(m.hunder), MockSettler.Mode.Underpay, 1, 1);
        t[10] = _row(address(m.husdc), address(m.hpaywrap), MockSettler.Mode.PayTaker, 1, 1);
        t[11] = _row(address(m.husdc), address(m.hspend), MockSettler.Mode.SpendHalf, 1, 1);
        t[12] = _row(ethIn, address(m.hspend), MockSettler.Mode.SpendHalf, usdcPerEth, 1e18);
        t[13] = _row(address(m.husdc), address(m.hrevert), MockSettler.Mode.RevertWithData, 1, 1);
        t[14] = _row(address(m.husdc), address(m.hbigrev), MockSettler.Mode.RevertHuge, 1, 1);
        t[15] = _row(address(m.husdc), address(m.hreenter), MockSettler.Mode.Reenter, 1, 1);
        // Pays 90% of the fair rate: vetRoute must refuse it with below_oracle_value (never signed).
        t[16] = _row(address(m.husdc), address(m.horacle), MockSettler.Mode.Pay, 9, 10);
    }

    function _row(address sellKey, address buyKey, MockSettler.Mode mode, uint128 num, uint128 den)
        private
        pure
        returns (MockSettler.PairConfig memory)
    {
        return MockSettler.PairConfig({sellKey: sellKey, buyKey: buyKey, mode: mode, num: num, den: den});
    }

    function _expect(string memory name, address expected, address actual) private pure {
        if (expected != actual) revert MockAddressChanged(name, expected, actual);
    }
}
