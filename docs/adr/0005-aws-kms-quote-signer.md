# ADR 0005: AWS KMS quote signer

- Status: accepted
- Date: 2026-10-12

## Context

The fee wrapper accepts a fee only with a backend signature over the exact quote (ADR 0003). Until now the only signer was `LocalKeySigner`, a key from the environment that refuses every mainnet (ADR 0004). Production needs a signer whose key is held in a cloud KMS or HSM and never exists on a server disk (spec section 4). The owner chose AWS KMS.

## Decision

### Key

- One asymmetric customer managed KMS key per environment: KeySpec `ECC_SECG_P256K1` (secp256k1), KeyUsage `SIGN_VERIFY`, origin `AWS_KMS`. Production and testnet use separate keys.
- The signer refuses to start unless `DescribeKey` reports:
  - exactly that spec and usage;
  - `KeyState` `Enabled` and `KeyManager` `CUSTOMER`;
  - `ECDSA_SHA_256` among the signing algorithms;
  - an origin of `AWS_KMS` or `AWS_CLOUDHSM`. Imported (`EXTERNAL`) and external key store keys are refused, because their private key exists or existed outside an AWS HSM;
  - `MultiRegion` exactly `false`. A multi-Region key shares its key material with replicas in other Regions, each with its own key policy. A response without the field is refused too. `mrk-` key IDs are refused in config.
- The API addresses the key by the ARN that `DescribeKey` resolves at startup. A later change to the alias therefore cannot swap the key under a running process.
- **Pinning.** Under `NODE_ENV=production`, or when any chain in `ZEROX_CHAIN_IDS` is not a known testnet or local chain (unknown chains count as mainnets), `KMS_KEY_ID` must be a full key ARN, not an alias, and `KMS_EXPECTED_SIGNER_ADDRESS` is required. The API refuses to start unless the key derives to exactly that address, compared case-insensitively. When the variable is set it is also checked in development. The owner records the address from the key ARN, not the alias, and uses the same value for the wrapper's `feeSigner` (runbook, step 3).

### Address

At startup the signer calls `GetPublicKey`. It parses the DER SubjectPublicKeyInfo strictly: it must be the 88-byte id-ecPublicKey/secp256k1 encoding with an uncompressed point on the curve. The signer then takes the Ethereum address as the last 20 bytes of keccak256(X || Y). It also checks that the response names the same key ARN, spec and usage.

### Signing

- `SignCommand` with `KeyId` = the key ARN, `Message` = the 32-byte EIP-712 digest, `MessageType: 'DIGEST'` and `SigningAlgorithm: 'ECDSA_SHA_256'`. With `DIGEST`, KMS skips its own hashing step, and the message must be exactly as long as the algorithm's hash (32 bytes for SHA-256). KMS therefore signs the keccak256 digest as given, which is what `ecrecover` expects.
- KMS returns an ASN.1 DER `SEQUENCE { r, s }`. The adapter:
  1. parses it strictly: minimal integers, `0x00` padding only when the top bit is set, no trailing bytes, `1 <= r, s < n`;
  2. moves `s` to the low half (`s = n - s` when `s > n/2`), because OpenZeppelin `ECDSA.tryRecover` rejects high-s signatures;
  3. finds the recovery bit by trying v = 27 and 28 against the known signer address, and refuses if neither matches.
- Before returning, the adapter checks the 65-byte `r || s || v` again, on its own: `s <= n/2`, `v` is 27 or 28, and recovery from the digest gives the signer address. Any mismatch fails closed.
- `KmsSigner` refuses typed data for chains outside its configured list, as `LocalKeySigner` does.

### Which chains can be signed

`canSignChain(signer, policy, chainId)` in `apps/api/src/signing-policy.ts` gates every signature in the HTTP layer. A chain is signable only when all of these hold:

1. the signer's own `canSign` agrees. A local key accepts only its testnet allowlist. A KMS key accepts only `ZEROX_CHAIN_IDS`.
2. the chain has a non-empty trusted router policy (`TRUSTED_ROUTERS`), so every route on it went through `vetRoute` (ADR 0004).
3. if a local key may never sign for the chain (every mainnet and live chain, `NEVER_LOCAL_CHAINS`), the signer kind is `kms`. This holds whatever any signer's `canSign` claims.

At startup with `KMS_KEY_ID`, every chain in `ZEROX_CHAIN_IDS` must pass this gate, or the API refuses to start. `LocalKeySigner`, its denylist and its startup checks are unchanged.

### Configuration

- `KMS_KEY_ID` takes a key ARN, alias name, alias ARN or key ID; production and mainnets need the key ARN (see Pinning). `AWS_REGION` is required with it, and must match the region in a key ARN.
- Exactly one of `KMS_KEY_ID` and `QUOTE_SIGNER_PRIVATE_KEY` may be set. If both are set, the API refuses to start. `LOCAL_SIGNER_CHAIN_IDS` is refused with a KMS key.
- Credentials come only from the AWS SDK's default provider chain, normally an instance or task role. The config schema has no access-key settings. Startup logs the signer address, kind and key ARN, never credentials.

### Availability and limits

- Each KMS call has a deadline (`KMS_SIGN_TIMEOUT_MS`, default 2 s). On timeout the call is aborted, and the signer returns even if the SDK ignores the abort. The SDK's own retries are off (`maxAttempts: 1`).
- The signer retries at most once, and only after throttling or a transient error: `ThrottlingException`, `DependencyTimeoutException`, `KMSInternalException`, `KeyUnavailableException`, our own timeout, connection resets, or another server-side fault. It never retries access denied, a disabled, missing or invalid key, or a credentials error.
- An in-memory limit caps Sign calls: `KMS_MAX_IN_FLIGHT` (default 16) running, `KMS_MAX_QUEUE` (default 64) waiting, each waiting at most the timeout. Beyond that, signing fails at once without calling KMS.
- Every signing failure (busy, timeout, upstream, integrity) is a `SigningUnavailableError`. `POST /v1/quotes` answers `503 { "error": "signing_unavailable" }`, the code a refused chain already used. AWS error text goes only to the server log, as the error name and at most 200 characters of message. An integrity failure is logged at error level and must page.
- Worst case per quote: up to one timeout of queue wait, then two attempts plus a 100 ms pause (about 6 s with the defaults).

### Smoke test

`pnpm --filter @ranvier/api kms:smoke` runs the API's own `KmsSigner` against the real key. It prints the key ARN, spec, state, origin and address. It then signs one fixed, clearly labelled typed-data message (domain `Ranvier KMS smoke test (not a quote)`, chain ID 31337, type `SmokeTest`), verifies the signature independently, and prints PASS or FAIL. The message can never be a valid `SwapQuote`. See [docs/runbooks/kms-setup.md](../runbooks/kms-setup.md).

## Threat model

> **The production service control policies in the runbook (step 5c) have NOT been tested against real AWS.** The claims below about what they enforce describe their intent. Before they are used on the production account, apply them in a throwaway test account, run the runbook's checklist, and get a final security review. The testnet steps (runbook steps 0 to 4, 5a, 5b, 6 and 7) are safe to follow now.

- **The key cannot be copied.** The private key never leaves KMS. A compromised API host, or a leaked role session, cannot take the key away and use it later.
- **The signer address is single-purpose.** The API role can have any 32-byte digest signed: a quote, but equally an Ethereum transaction or a `permit`. The signer address must therefore never hold funds or approvals, and must never have any role except `feeSigner`.
- **What a compromised API host can do.** It can call `kms:Sign` with the API role for as long as the role or key policy allows it. It can sign any `SwapQuote`: any fee from zero up to the cap, any allowlisted router and calldata, for any user. The damage is bounded:
  - The wrapper refuses a fee above its hard cap (0.3% of the input), so it cannot sign a larger fee.
  - The wrapper only executes a quote for its own user (`msg.sender == q.user`) and pulls the input from the caller. A quote signed by an attacker therefore cannot move funds of users who do not submit it themselves.
  - For a user who does submit a quote, the wrapper calls only allowlisted routers, approves exact amounts and checks the user's balance increase against the signed minimum, which the user sees before signing the transaction.
  - The realistic loss is fee revenue: zero-fee quotes, until the role is revoked. A host-level attacker could also corrupt quotes for real users. `vetRoute` would no longer protect them, but the wrapper's on-chain checks still would.
- **Stolen role credentials, or a new principal acting as the role.** The key policy's principal check cannot tell the API from someone else using the API role. That someone could be using credentials taken from instance metadata, a copied Roles Anywhere certificate, a new instance launched with the role through `iam:PassRole`, or an edited trust policy. The runbook therefore:
  - adds a network-origin deny on `kms:Sign`: the KMS VPC endpoint (`aws:SourceVpce`) for an AWS-hosted API, or the API's egress IP (`aws:SourceIp`) for a self-hosted one. A request without the key is denied. The IP pin is only as strong as the IP's exclusivity: a shared NAT or home IP weakens it;
  - adds alarms on Sign from another principal, endpoint or IP; on changes to the protected roles, the break-glass users, policy versions and Roles Anywhere; and on unexpected `AssumeRole`;
  - in production, adds the SCPs below.

  An attacker who runs code on the API host is inside the network pin and holds the role's session. The SCPs deny the specific remote ways in that they list (see below). A host compromised in any other way is the case described above.

- **IAM administrators in the signer account.** The key policy keeps AWS's root "enable IAM" statement so that the key stays recoverable. As a result, IAM administrators are part of the trust base.
  - **Without the SCPs**, an IAM administrator in the signer account can take control in a few steps. The alarms report each step after the fact; nothing blocks it. The administrator can:
    - reset a break-glass user's password and MFA device, or edit the break-glass role's trust policy, then assume break-glass and rewrite the key policy;
    - pass the API role to a new instance or task, or edit the deployer role so it does, and sign from inside the VPC;
    - open a shell on an API host (SSM Session Manager, Run Command, ECS Exec, EC2 Instance Connect, user data);
    - for a self-hosted API, add a trust anchor or change the profile, CRL or attribute mapping in Roles Anywhere;
    - silence the alarms (overwrite a metric filter, re-put an alarm without actions, unsubscribe or filter the alert topic, stop the trail).
  - **With the three SCPs in the runbook (step 5c)**, every principal in the account except the break-glass role (and, where stated, the deployer and CI roles) is denied:
    - changes to the API, break-glass, deployer and CI roles;
    - credential, MFA and policy changes on the break-glass users;
    - `iam:PassRole` on the API role, except for the deployer, CI and break-glass roles. `sts:AssumeRole` into the deployer and CI roles is denied except for the named deployer operators (IAM users with MFA) and break-glass. The CI role is reached only through GitHub OIDC (`AssumeRoleWithWebIdentity`), and its trust policy limits that to the repository's `production` environment;
    - credential, MFA and policy changes on the deployer operators' IAM users;
    - `PutKeyPolicy`, `CreateGrant` and `ReplicateKey` on the signer key;
    - the listed SSM (sessions, commands, associations, automation, maintenance windows, document changes), ECS Exec, EC2 Instance Connect, root-volume and volume-attachment, and `ModifyInstanceAttribute` actions, on all resources in the account;
    - changes to launch templates, Auto Scaling groups, ECS task definitions and services, ECS `RunTask`/`StartTask` and ECR `PutImage`, except by the deployer, CI and break-glass roles;
    - Roles Anywhere trust anchor, profile, attribute-mapping and CRL changes;
    - stopping, changing or deleting the signer trail and its bucket policy, changing the `ranvier-cloudtrail` metric filters and retention, the `ranvier-*` alarms and the alert topic's attributes and data-protection policy, and `sns:Unsubscribe` / `sns:SetSubscriptionAttributes` on any resource. The email "unsubscribe" link is unauthenticated and outside IAM. It is covered only by confirming subscriptions with `AuthenticateOnUnsubscribe` and by keeping two independent subscriptions.
  - **What the SCPs do not stop:**
    - **break-glass itself, which can effectively sign by design**: it can rewrite the key policy and then sign, pass the API role, or open a shell on an API host. The control is that this path needs a hardware security key, is for emergencies only, and raises the STS and sign-in alarms on every use. The same applies to anyone holding a break-glass user's password and hardware key;
    - the deployer and CI roles, which can deploy any code by design; and whoever controls a deployer operator's credentials or the GitHub `production` environment;
    - the organization's management account and AWS Support, which SCPs never restrict;
    - ways to run code as the API role, or to change the alarms, that the SCPs do not list (AWS adds new APIs). Image pushes and launch-template edits are limited to the deployer, CI and break-glass roles, not removed; deploy immutable image digests.
  - **The organization trail** in a separate log-archive account cannot be stopped or changed from a member account. It is the tamper-resistant record. The alarms run on the signer account's own trail, because an organization trail delivers to CloudWatch Logs only in the account that manages it.
- **Key administrators.** Only the break-glass role may change the key policy, create grants or replicate the key (and so break-glass can, by design, give itself `Sign`). The admin role can manage the key, but it cannot sign or change the policy. Deletion needs the full 30-day wait.
- **Response.** Detach or deny `kms:Sign` for the API role, or disable the key. Signing stops at once, and quotes fail with `503 signing_unavailable`. If the key policy itself may have been changed, rotate the key (below) and pause the wrapper through the guardian if needed.
- **Detection.** CloudTrail records every `Sign`, `GetPublicKey`, `DescribeKey` and key-policy change. Alert on `Sign` calls from any principal other than the API role, on `Sign` volume far above the quote rate, and on any `PutKeyPolicy`, `CreateGrant`, `DisableKey`, `ScheduleKeyDeletion` or alias change (runbook).
- **Wrong or swapped key.** In production and on mainnets the API takes a key ARN, not an alias, and refuses to start unless the key derives to `KMS_EXPECTED_SIGNER_ADDRESS`. The on-chain check against `FeeWrapper.feeSigner()` (below) also compares the signer with every signing chain before the API listens.
- **A KMS or SDK bug** that returns a wrong signature fails closed through self-verification. It is never offered to a user.

## Key rotation

The fee signer is changed only through `FeeWrapper.setFeeSigner`, which only the admin multisig (behind its timelock) can call:

1. Create a new KMS key with the same settings (runbook) and a new alias, e.g. `alias/ranvier-fee-signer-v2`.
2. Record the new address from the new key's ARN (runbook, step 3), and confirm it with the smoke test on the API host before using it on chain.
3. Propose `setFeeSigner(<new address>)` on every chain's wrapper through the admin multisig. During the timelock, the old key keeps signing.
4. When the change executes on every chain, set `KMS_KEY_ID` to the new key ARN and `KMS_EXPECTED_SIGNER_ADDRESS` to the new address, and restart the API. Quotes signed by the old key in flight fail on chain at worst, and the user re-quotes. This needs no API change, because quotes live for 60 seconds.
5. Confirm with the startup log line and the on-chain check (the API refuses to start unless its address equals `feeSigner()` on every signing chain) that the API address equals `feeSigner()`. Then disable the old key: remove `kms:Sign` from its policy and run `aws kms disable-key`. Keep it disabled for at least the audit period before scheduling deletion (the waiting period is 30 days).

In an emergency (key policy compromised), skip the wait at step 3 only as far as the timelock allows, and pause the wrapper through the guardian in the meantime.

## Cost and quotas

- One customer managed key costs about $1 per month. Asymmetric `Sign` requests are not in the KMS free tier and cost about $0.15 per 10,000 at the time of writing (check current AWS pricing). One signed quote is one `Sign` call. Unsigned quotes and wrap/unwrap quotes cost nothing.
- `Sign` with ECC keys counts against one shared per-account, per-Region quota for ECC cryptographic operations, together with every other ECC operation in that account and Region. We could not pin the default value: the AWS quotas page gives 1,000 requests per second in its table and 300 in its prose. Read the real value in Service Quotas (AWS KMS, "Cryptographic operations (ECC) request rate") for your account and Region. A dedicated AWS account for the signer stops other workloads from using up the quota, and stops anyone from exhausting it against us. `GetPublicKey` and `DescribeKey` have their own quotas and run only at startup. The in-memory limit keeps one API instance well below any plausible quota. Request an increase before running many instances.

## On-chain signer check (built 2026-10-16, ADR 0013 work breakdown row 5)

`FeeSignerMonitor` (`apps/api/src/fee-signer-check.ts`), started from `main.ts`:

- **Which chains.** Every chain the API really signs for: `ZEROX_CHAIN_IDS` filtered by `canSignChain` with `TRUSTED_ROUTERS` (`signingChainIds`). In production with a KMS key that is every quoted chain; a local key signs no production chain (no testnet has a trusted router), so nothing is read.
- **What must hold**, read at one block through the balance reader's endpoints (`RPC_URLS_EVM_<chainId>`, else the public development defaults, with the same chain ID proof, timeouts and redirect refusal as ADR 0009; a signing chain without a token list gets an endpoint too): code at `FEE_WRAPPER_ADDRESS`; `feeSigner()` equal to the signer address (any case); `eip712Domain()` reporting `Ranvier FeeWrapper`, version `1`, that chain ID (`block.chainid` inside the call, so it also proves the chain of the endpoint that answered) and the wrapper itself as `verifyingContract`. A view that reverts or returns malformed data counts as a mismatch.
- **Startup: fail closed.** The API does not listen until every signing chain matches. A mismatch refuses at once with the chain, the reason and the on-chain `feeSigner` (all public). A chain that cannot be read is retried up to three times, two seconds apart, with its endpoints asked to prove their chain again in between; then startup is refused. No new configuration: the wrapper address is `FEE_WRAPPER_ADDRESS`, the endpoints are the existing RPC variables.
- **Runtime: cached, re-checked every 10 minutes.** A confirmed mismatch stops signing on that chain (`503 signing_unavailable`) until a later check matches, logged at error level (`FeeWrapper no longer matches the signer; signing stopped on this chain`; alert on it). A failed re-check keeps the last confirmed result and logs a warning. Why: `feeSigner` changes only through the admin multisig behind its timelock (hours), so ten minutes is enough to notice a rotation; the wrapper verifies every signature on chain, so a stale "matches" costs a reverted transaction at worst, never funds; and making signing depend on transient RPC health would couple quoting to RPC availability, which ADR 0009 keeps apart.
- **What a lying RPC can do.** It can refuse startup or stop signing on a chain (availability), or answer "matches" for a wrapper that does not match (the situation before this check existed). It cannot make the API sign for another wrapper or chain: the signed domain still uses the configured address and the request's chain.

Also at startup (ADR 0013, section 4): the signer address (local key or KMS) and `KMS_EXPECTED_SIGNER_ADDRESS` are refused when they are a published development address and any quoted chain is not 31337 (`apps/api/src/published-addresses.ts`, the same list as `Deploy.s.sol`'s `isPublishedDevAddress`). `KMS_EXPECTED_SIGNER_ADDRESS` is checked before any KMS call.

## Follow-up (not built)

- An alert on `integrity` signing failures and on sustained `busy` or `timeout` failures, once metrics exist.

## Consequences

- Mainnet quotes can now be signed. The local-key path is unchanged and still cannot sign a mainnet.
- Startup depends on KMS and IAM. A missing permission, a disabled key or a wrong region stops the API with a clear message instead of running without signatures.
- Each signed quote adds one KMS round trip (typically tens of milliseconds in-region) to its latency, and costs a small per-request fee.
- New dependency: `@aws-sdk/client-kms` (exact pin), used only by the KMS adapter and the smoke script. Its own `@aws-sdk/*` and `@smithy/*` dependencies, which include the credential chain, request signing and HTTP, are pinned in `pnpm-workspace.yaml` `overrides` to releases at least 7 days old that satisfy every dependency range. CI runs `pnpm --filter @ranvier/api check:aws-overrides`. It fails if the lockfile drifts from the overrides, if a new `@aws-sdk/*` or `@smithy/*` package is not pinned, or if a pinned version breaks any declared dependency range. Re-check the set whenever the client is bumped.
- The API role needs `kms:DescribeKey` as well as `kms:Sign` and `kms:GetPublicKey`. `DescribeKey` is read-only metadata, and it is the only call that reports `KeyState` and `Origin`.
