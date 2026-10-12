# Runbook: set up the AWS KMS fee-signing key

The API signs fee-wrapper quotes with an asymmetric AWS KMS key. The private key is generated inside KMS and never leaves it. See [ADR 0005](../adr/0005-aws-kms-quote-signer.md) for the design and the threat model.

You need: an AWS account with an IAM admin principal, the AWS CLI v2, and this repo checked out with `pnpm install` done.

Placeholders used below: `<region>` (e.g. `eu-west-1`), `<account-id>`, `<admin-role-arn>` (the principal that manages the key), `<api-role-arn>` (the role the API runs as) and `<key-id>` (the UUID that `create-key` prints).

## 0. Before you start

- **Root and admin accounts use MFA with a hardware security key** (FIDO2), as spec section 9 requires. The root user has no access keys and is used only for account-level tasks.
- **Never create IAM access keys** (`AKIA...`) for any human or machine with these KMS permissions. Anyone holding such a key could sign quotes from anywhere until it is revoked. The API gets short-lived credentials from a role, as set out in step 4.
- **Create two keys**: one for testnets (`alias/ranvier-fee-signer-testnet`) and one for production (`alias/ranvier-fee-signer`). Never point a testnet deployment at the production key. Set up and smoke-test the testnet key first.
- Pick one region and keep the key, the API and the CloudTrail alarms there. KMS keys are regional. Do not create a multi-Region key.

## 1. Key policy

Save as `key-policy.json`, replacing the placeholders. The policy works as follows:

- The account root statement keeps the key manageable if a role is deleted (AWS's default). IAM policies decide who else gets access.
- `<admin-role-arn>` can manage the key but not sign with it.
- `<api-role-arn>` can only sign 32-byte digests with ECDSA_SHA_256, read the public key and read the key metadata.
- The `Deny` statement blocks `kms:Sign` for every other principal, including account admins with `kms:*` in IAM. An explicit deny wins over any allow.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EnableRootAccountForRecovery",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::<account-id>:root" },
      "Action": "kms:*",
      "Resource": "*"
    },
    {
      "Sid": "KeyAdministrationWithoutSigning",
      "Effect": "Allow",
      "Principal": { "AWS": "<admin-role-arn>" },
      "Action": [
        "kms:Describe*",
        "kms:Get*",
        "kms:List*",
        "kms:Create*",
        "kms:Put*",
        "kms:Update*",
        "kms:Enable*",
        "kms:Disable*",
        "kms:Revoke*",
        "kms:TagResource",
        "kms:UntagResource",
        "kms:ScheduleKeyDeletion",
        "kms:CancelKeyDeletion"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ApiRoleSignsDigestsOnly",
      "Effect": "Allow",
      "Principal": { "AWS": "<api-role-arn>" },
      "Action": "kms:Sign",
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "kms:SigningAlgorithm": "ECDSA_SHA_256",
          "kms:MessageType": "DIGEST"
        }
      }
    },
    {
      "Sid": "ApiRoleReadsPublicKeyAndMetadata",
      "Effect": "Allow",
      "Principal": { "AWS": "<api-role-arn>" },
      "Action": ["kms:GetPublicKey", "kms:DescribeKey"],
      "Resource": "*"
    },
    {
      "Sid": "NobodyElseSigns",
      "Effect": "Deny",
      "Principal": { "AWS": "*" },
      "Action": "kms:Sign",
      "Resource": "*",
      "Condition": {
        "ArnNotEquals": { "aws:PrincipalArn": "<api-role-arn>" }
      }
    }
  ]
}
```

`kms:DescribeKey` is needed because the API refuses to start unless the key is `Enabled`, `ECC_SECG_P256K1`, `SIGN_VERIFY` and generated in AWS. Only `DescribeKey` reports the key state and origin. It is read-only.

Because the root statement lets IAM grant access, any IAM admin could change this policy (`PutKeyPolicy`) and remove the deny. The alarm in step 5 fires on every such change.

## 2. Create the key and its alias

### AWS CLI

Run as the admin principal (with MFA):

```sh
aws kms create-key \
  --region <region> \
  --key-spec ECC_SECG_P256K1 \
  --key-usage SIGN_VERIFY \
  --origin AWS_KMS \
  --description "Ranvier fee-quote signer (production). Rotate via FeeWrapper.setFeeSigner." \
  --tags TagKey=project,TagValue=ranvier TagKey=purpose,TagValue=fee-quote-signer TagKey=environment,TagValue=production \
  --policy file://key-policy.json

# <key-id> is KeyMetadata.KeyId in the output.
aws kms create-alias --region <region> \
  --alias-name alias/ranvier-fee-signer \
  --target-key-id <key-id>

aws kms describe-key --region <region> --key-id alias/ranvier-fee-signer \
  --query 'KeyMetadata.[Arn,KeySpec,KeyUsage,KeyState,Origin,MultiRegion]'
```

For the testnet key, use `environment=testnet`, a description saying "testnet", and `alias/ranvier-fee-signer-testnet`.

Expect `ECC_SECG_P256K1`, `SIGN_VERIFY`, `Enabled`, `AWS_KMS` and `false`. Automatic key rotation does not exist for asymmetric keys; rotation is the manual procedure in ADR 0005.

### Console

1. KMS → Customer managed keys → **Create key**.
2. Key type **Asymmetric**, key usage **Sign and verify**, key spec **ECC_SECG_P256K1**. Under Advanced options: key material origin **KMS**, **Single-Region key**.
3. Alias `ranvier-fee-signer` (or `ranvier-fee-signer-testnet`), the description above, tags `project=ranvier`, `purpose=fee-quote-signer`, `environment=production`.
4. Key administrators: the admin role only. Leave **Allow key administrators to delete this key** ticked only if that role is MFA-protected.
5. Key users: none (key users would get `kms:Sign` without conditions).
6. On the review page, choose **Edit** on the key policy, paste `key-policy.json` and finish.

## 3. Check the address independently

The smoke test (step 6) prints the address that the API derives. Before you put an address on chain, read it a second way, without our code:

```sh
aws kms get-public-key --region <region> --key-id alias/ranvier-fee-signer \
  --query PublicKey --output text | base64 -d | tail -c 64 | xxd -p -c 64
# prints X||Y (128 hex characters); then:
cast keccak 0x<those 128 hex characters>
# the address is 0x followed by the LAST 40 hex characters of the hash
cast to-check-sum-address 0x<last 40 hex characters>
```

The key is a fixed 88-byte DER SubjectPublicKeyInfo ending in the 64-byte X||Y, so `tail -c 64` is exact for this key spec.

## 4. API role and credentials

The API reads credentials only from the AWS SDK default provider chain. Our config has no setting for access keys.

- **API on EC2 or ECS:** attach `<api-role-arn>` as the instance profile or the ECS task role. Nothing else is needed.
- **API on a server outside AWS** (self-hosted): use IAM Roles Anywhere. It issues short-lived role credentials against an X.509 certificate from your own CA. Configure an AWS CLI profile with `credential_process` using `aws_signing_helper`, and run the API with `AWS_PROFILE` set to that profile. Protect the certificate's private key as a credential (file permissions, or a TPM/PKCS#11 store). It can be revoked at the trust anchor. It is still not an access key, and it never grants more than the role.

IAM policy for the API role (inline or managed). Replace `<key-arn>` with the key ARN from `describe-key`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "RanvierFeeSignerSign",
      "Effect": "Allow",
      "Action": "kms:Sign",
      "Resource": "<key-arn>",
      "Condition": {
        "StringEquals": {
          "kms:SigningAlgorithm": "ECDSA_SHA_256",
          "kms:MessageType": "DIGEST"
        }
      }
    },
    {
      "Sid": "RanvierFeeSignerRead",
      "Effect": "Allow",
      "Action": ["kms:GetPublicKey", "kms:DescribeKey"],
      "Resource": "<key-arn>"
    }
  ]
}
```

Grant nothing else from KMS. In particular, give the API role no `kms:CreateGrant`, `kms:PutKeyPolicy` and no wildcard actions.

**Revoking the API's signing access fast:** `aws kms disable-key --key-id <key-arn>` stops all signing at once, and the API answers `503 signing_unavailable`. `enable-key` restores it. To revoke only the role, detach this IAM policy and remove the role from the key policy statements.

## 5. CloudTrail logging and alarms

KMS API calls, including every `Sign`, are CloudTrail management events.

1. Create a multi-Region trail with log file validation, delivered to an S3 bucket that the API role cannot write to, and to a CloudWatch Logs log group (e.g. `ranvier-cloudtrail`). Do **not** tick "Exclude AWS KMS events".
2. Create an SNS topic (e.g. `ranvier-security-alerts`) with an email or pager subscription.
3. Add these metric filters on the log group. Give each one an alarm to the SNS topic with a threshold of `>= 1` in 5 minutes, unless the filter says otherwise.

   - **Key policy or key changed** (`ranvier-kms-key-changed`):

     ```text
     { $.eventSource = "kms.amazonaws.com" && ($.eventName = "PutKeyPolicy" || $.eventName = "CreateGrant" || $.eventName = "DisableKey" || $.eventName = "EnableKey" || $.eventName = "ScheduleKeyDeletion" || $.eventName = "CancelKeyDeletion" || $.eventName = "UpdateAlias" || $.eventName = "DeleteAlias") }
     ```

   - **Sign attempted by anyone but the API role** (`ranvier-kms-foreign-sign`). The key policy denies these, but an attempt means a principal is probing the key:

     ```text
     { $.eventSource = "kms.amazonaws.com" && $.eventName = "Sign" && ($.userIdentity.type != "AssumedRole" || $.userIdentity.sessionContext.sessionIssuer.arn != "<api-role-arn>") }
     ```

   - **Sign errors** (`ranvier-kms-sign-errors`). Alarm when there are more than a handful in 5 minutes:

     ```text
     { $.eventSource = "kms.amazonaws.com" && $.eventName = "Sign" && $.errorCode = "*" }
     ```

   - **Sign volume** (`ranvier-kms-sign-volume`). Alarm at a few times your normal peak of signed quotes per 5 minutes:

     ```text
     { $.eventSource = "kms.amazonaws.com" && $.eventName = "Sign" }
     ```

   - **Root user used** (`ranvier-root-used`):

     ```text
     { $.userIdentity.type = "Root" && $.userIdentity.invokedBy NOT EXISTS && $.eventType != "AwsServiceEvent" }
     ```

Example for the first filter and its alarm (repeat for each one):

```sh
aws logs put-metric-filter --region <region> \
  --log-group-name ranvier-cloudtrail \
  --filter-name ranvier-kms-key-changed \
  --metric-transformations metricName=RanvierKmsKeyChanged,metricNamespace=Ranvier/Security,metricValue=1 \
  --filter-pattern '{ $.eventSource = "kms.amazonaws.com" && ($.eventName = "PutKeyPolicy" || $.eventName = "CreateGrant" || $.eventName = "DisableKey" || $.eventName = "EnableKey" || $.eventName = "ScheduleKeyDeletion" || $.eventName = "CancelKeyDeletion" || $.eventName = "UpdateAlias" || $.eventName = "DeleteAlias") }'

aws cloudwatch put-metric-alarm --region <region> \
  --alarm-name ranvier-kms-key-changed \
  --namespace Ranvier/Security --metric-name RanvierKmsKeyChanged \
  --statistic Sum --period 300 --evaluation-periods 1 \
  --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions arn:aws:sns:<region>:<account-id>:ranvier-security-alerts
```

Test the alarms on the **testnet** key. Run `aws kms disable-key` and then `aws kms enable-key`, and check that the key-change email arrives (CloudTrail delivery can take several minutes). Then run the smoke test (step 6) from a principal other than the API role, and check that the foreign-sign alarm fires.

Grants cannot bypass the deny: an explicit `Deny` in the key policy also applies to access through grants.

## 6. Smoke test

The smoke test runs the API's own signer against the real key. It prints the key ARN, spec, state, origin and address, signs one fixed test message (chain ID 31337, domain `Ranvier KMS smoke test (not a quote)`, which can never be a valid quote) and prints PASS or FAIL. It never prints credentials. It exits with code 0 on PASS and 1 on FAIL.

It must run as the API role, because the key policy refuses `Sign` to everyone else. Choose one of these:

- **On the API host**, where the role is already the default credential:

  ```sh
  KMS_KEY_ID=alias/ranvier-fee-signer AWS_REGION=<region> pnpm --filter @ranvier/api kms:smoke
  ```

- **From your machine**, by assuming the API role with MFA. Temporarily add this statement to the API role's trust policy:

  ```json
  {
    "Effect": "Allow",
    "Principal": { "AWS": "<admin-role-arn>" },
    "Action": "sts:AssumeRole",
    "Condition": { "Bool": { "aws:MultiFactorAuthPresent": "true" } }
  }
  ```

  Add a profile to `~/.aws/config`:

  ```ini
  [profile ranvier-signer-smoke]
  role_arn = <api-role-arn>
  source_profile = <your admin profile>
  mfa_serial = <your MFA device ARN>
  region = <region>
  ```

  Then run:

  ```sh
  AWS_PROFILE=ranvier-signer-smoke KMS_KEY_ID=alias/ranvier-fee-signer AWS_REGION=<region> \
    pnpm --filter @ranvier/api kms:smoke
  ```

  Remove the trust statement afterwards. While it exists, your admin principal can sign quotes.

The address printed must equal the one from step 3. Record it: it is the `FEE_SIGNER` for the wrapper deployment, or the argument of the multisig `setFeeSigner` call when you rotate.

Common failures: `AccessDeniedException` (wrong role, a missing key or IAM policy statement, or the deny statement naming another role); `NotFoundException` (wrong region or alias); `KeyState is Disabled`.

## 7. Configure the API

In the API environment (not in the repo):

```sh
KMS_KEY_ID=arn:aws:kms:<region>:<account-id>:key/<key-id>   # or alias/ranvier-fee-signer
AWS_REGION=<region>
# QUOTE_SIGNER_PRIVATE_KEY and LOCAL_SIGNER_CHAIN_IDS must be unset: the API refuses to start otherwise.
```

At startup the API checks the key, derives the address and logs `signer`, `signerKind: "kms"` and `kmsKeyArn`. If anything is wrong it refuses to start with a message naming the KMS call and the AWS error name. Check that the logged address equals `cast call <wrapper> 'feeSigner()(address)'` on every chain in `ZEROX_CHAIN_IDS` (an automatic check is a planned follow-up, ADR 0005).

## Deletion

There is no deletion-protection switch on KMS keys; deletion is always scheduled. If the production key is deleted, no quote can be signed until a new key is set on chain through the multisig.

- Schedule deletion only with the maximum waiting period: `aws kms schedule-key-deletion --key-id <key-arn> --pending-window-in-days 30`. Disable a key and leave it disabled for a long time before you delete it.
- The alarm in step 5 fires on `ScheduleKeyDeletion`. `aws kms cancel-key-deletion` undoes it during the waiting period, and the key is then disabled until you enable it again.
- To prevent deletion entirely, add a statement that denies `kms:ScheduleKeyDeletion` to everyone except a break-glass role, and protect that role with hardware MFA.
