// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

// LOCAL TEST HARNESS ONLY (ADR 0013). Fixed salts and the CREATE2 addresses they give through
// anvil's factory (0x4e59b44847b379578588920cA78FbF26c0B4956C). The addresses depend only on the
// salt and the init code, never on who deploys, so the TypeScript side can hard-code them.
// `HarnessConfig.t.sol` recomputes every address and `DeployHarness` refuses a mismatch:
// changing a mock moves its address, and this table must be updated in the same PR.

library HarnessConfig {
    uint256 internal constant CHAIN_ID = 31337;

    /// @dev PUBLIC anvil mnemonic, chain 31337 only. Its keys are published; never use them elsewhere.
    string internal constant ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
    /// @dev Anvil accounts used by the harness (addresses only).
    address internal constant DEPLOYER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266; // account 0
    address internal constant FEE_SIGNER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8; // account 1
    address internal constant USER = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; // account 2
    address internal constant FEE_COLLECTOR = 0x90F79bf6EB2c4f870365E785982E1f101E93b906; // account 3
    uint32 internal constant FEE_SIGNER_INDEX = 1;

    /// @dev The wrapper salt from docs/runbooks/local-harness.md ("RANV").
    bytes32 internal constant FEE_WRAPPER_SALT = 0x0000000000000000000000000000000000000000000000000000000052414e56;

    bytes32 internal constant SALT_ALLOWANCE_HOLDER = "ranvier.harness.allowanceHolder";
    bytes32 internal constant SALT_SETTLER = "ranvier.harness.settler";
    bytes32 internal constant SALT_HUSDC = "ranvier.harness.hUSDC";
    bytes32 internal constant SALT_HWETH = "ranvier.harness.hWETH";
    bytes32 internal constant SALT_HUSDT = "ranvier.harness.hUSDT";
    bytes32 internal constant SALT_HFALSE = "ranvier.harness.hFALSE";
    bytes32 internal constant SALT_HTAX = "ranvier.harness.hTAX";
    bytes32 internal constant SALT_HHOOK = "ranvier.harness.hHOOK";
    bytes32 internal constant SALT_HUNDER = "ranvier.harness.hUNDER";
    bytes32 internal constant SALT_HPAYWRAP = "ranvier.harness.hPAYWRAP";
    bytes32 internal constant SALT_HSPEND = "ranvier.harness.hSPEND";
    bytes32 internal constant SALT_HREVERT = "ranvier.harness.hREVERT";
    bytes32 internal constant SALT_HBIGREV = "ranvier.harness.hBIGREV";
    bytes32 internal constant SALT_HREENTER = "ranvier.harness.hREENTER";
    bytes32 internal constant SALT_HORACLE = "ranvier.harness.hORACLE";

    /// @dev Prices the settler rates are derived from (ADR 0013: ETH and hWETH $3,000, the rest $1).
    uint128 internal constant ETH_USD = 3_000;
    /// @dev Native ETH the deployer gives the settler, so it can pay native output.
    uint256 internal constant SETTLER_NATIVE_FLOAT = 100 ether;

    // CREATE2 results (filled from HarnessConfig.t.sol; see docs/runbooks/local-harness.md).
    address internal constant ALLOWANCE_HOLDER = 0xC0b06d1E9E0bb6e4b5d903A2b5afc57e1bF41Ce2;
    address internal constant SETTLER = 0x2c7959766740C57e7615b9452FDe5E7273Bb6E3c;
    address internal constant HUSDC = 0x5784F90419222088aC18AE5B62ef381f4Cb2deB1;
    address internal constant HWETH = 0x47FA559bE608137ea4D28588b6c57D0D1aC6552D;
    address internal constant HUSDT = 0x591C8458edF8fD663317FD0D9F712B304829f996;
    address internal constant HFALSE = 0x76faf45C3E69F33E64FD1448A18cDe535a80b3c7;
    address internal constant HTAX = 0x60bD9A310DF2ad9dfBC230ebf0aE49c35f547229;
    address internal constant HHOOK = 0x3f7E44dc6b1F3465c2e453BF5B37DDF2403c3DEC;
    address internal constant HUNDER = 0x3d186379d8AfB89332aA0b11CFD399d4966Eb917;
    address internal constant HPAYWRAP = 0x2412e0EcE709981e91b3a54cf44a5558162e36de;
    address internal constant HSPEND = 0x00f68444Cd6325033d2B51CB61A0De7e781413D1;
    address internal constant HREVERT = 0x6a30B9fFa7B7353699D1B8F309554A979018a3e4;
    address internal constant HBIGREV = 0x8114705c3eb8885ce22D5F14590788992F136668;
    address internal constant HREENTER = 0xa6673ad0094B3C28E672a9E1e28F03dbcBe7Cfb5;
    address internal constant HORACLE = 0xa03B74d8a5289B2A6278554183cE5d51dEb12c09;
    /// @dev The wrapper with FEE_WRAPPER_SALT and the roles above (owner and guardian DEPLOYER).
    address internal constant FEE_WRAPPER = 0x60A10abb52c31ec38f1f93c70B64D2Fb00913859;
}
