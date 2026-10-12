# Runbook: set up the AWS KMS fee-signing key

The API signs fee-wrapper quotes with an asymmetric AWS KMS key. The private key is generated inside KMS and never leaves it. See [ADR 0005](../adr/0005-aws-kms-quote-signer.md) for the design and the threat model.

You need: an AWS account (ideally a dedicated one, see step 0), the AWS CLI v2, and this repo checked out with `pnpm install` done. Foundry's `cast` is needed for step 3.

Placeholders used below:

| Placeholder              | Meaning                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `<region>`               | the one Region for the key, the API and the alarms, e.g. `eu-west-1`                                |
| `<account-id>`           | the 12-digit account that holds the key                                                             |
| `<admin-role-arn>`       | day-to-day key administration: can manage the key, cannot sign, cannot change the key policy        |
| `<break-glass-role-arn>` | the only principal that may change the key policy (step 1)                                          |
| `<api-role-arn>`         | the role the API runs as, `arn:aws:iam::<account-id>:role/<name>` (never an `assumed-role/...` ARN) |
| `<deployer-role-arn>`    | the principal that launches the API (instances, tasks); the only one allowed to pass the API role   |
| `<key-arn>`              | `arn:aws:kms:<region>:<account-id>:key/<uuid>`, printed by `create-key`                             |
| `<vpce-id>`              | the KMS interface VPC endpoint the API uses (AWS-hosted API)                                        |
| `<egress-ip>`            | the fixed public IP the API host uses to reach AWS (self-hosted API)                                |

## 0. Before you start

- **The signer address must never hold funds or do anything else.** The API role can have KMS sign _any_ 32-byte digest for this key: a quote, but also an Ethereum transaction, a `permit`, or a message for any other contract. So the signer address must never receive ETH or tokens, never approve anything, and never hold any role except `feeSigner` on the fee wrappers. Anyone who can sign as the API role can act as that address.
- **Use a dedicated AWS account for the signer** (an AWS Organizations member account that runs only the API, or at least only the signer key and its role). Every ECC `Sign` in an account and Region shares one request quota, so other workloads cannot then exhaust it, and nobody can exhaust it to stop our signing. Fewer people and services also have IAM rights there. Check the quota in Service Quotas (AWS KMS → "Cryptographic operations (ECC) request rate") in your Region; do not rely on a number from this document.
- **Root and admin users use MFA with a hardware security key** (FIDO2), as spec section 9 requires. The root user has no access keys and is used only for account-level tasks.
- **Never create IAM access keys** (`AKIA...`) for any human or machine with these KMS permissions. Anyone holding one could sign from anywhere until it is revoked. The API gets short-lived credentials from a role (step 4).
- **Create two keys**: a testnet key (`alias/ranvier-fee-signer-testnet`) and a production key (`alias/ranvier-fee-signer`), ideally in separate accounts. Never point a testnet deployment at the production key. Set up and smoke-test the testnet key first.
- Keep the key, the API and the alarms in one Region. Do not create a multi-Region key; the API refuses one.

### Break-glass role

The key policy (step 1) lets only `<break-glass-role-arn>` change the key policy. Create that role first:

- **Trust policy:** only named IAM users who sign in with a hardware security key, and only with MFA. Replace `<break-glass-user-arn>`:

  ```json
  {
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Principal": { "AWS": "<break-glass-user-arn>" },
        "Action": "sts:AssumeRole",
        "Condition": { "Bool": { "aws:MultiFactorAuthPresent": "true" } }
      }
    ]
  }
  ```

  `Bool` (not `BoolIfExists`) in an `Allow` fails closed: without MFA context the key is absent, the condition is false, and nothing is allowed. Give those users no access keys. They sign in to the console with their security key, use **Switch role**, and run the commands below in **CloudShell**.

- **Permissions:** `kms:*` on the signer key (`<key-arn>`, or `arn:aws:kms:<region>:<account-id>:key/*` before the key exists), plus `kms:CreateKey` and `kms:TagResource` on `*`. Attach it as an inline policy.
- Use it only to create the key, to change the key policy, and in emergencies. Every use raises the IAM/STS alarms in step 5.
- If the role is deleted, nobody can change the key policy. The key keeps working, and a role recreated with the **same name** regains the right, because the policy compares the role ARN as a string (`aws:PrincipalArn`). Do not delete it.

## 1. Key policy

Save as `key-policy.json`, replacing the placeholders. Then add **one** network statement from step 1a. What the statements do:

| Sid                                | Effect                                                                                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EnableRootAccountForRecovery`     | Lets IAM policies in this account grant access (AWS's default). This keeps the key recoverable, but it means IAM admins are part of the trust base; the deny statements below limit them. |
| `KeyAdministrationWithoutSigning`  | `<admin-role-arn>` can describe, enable, disable, tag, alias and schedule deletion. It cannot sign, change the key policy, create grants or replicate the key.                            |
| `ApiRoleSignsDigestsOnly`          | `<api-role-arn>` can sign 32-byte digests with `ECDSA_SHA_256` only.                                                                                                                      |
| `ApiRoleReadsPublicKeyAndMetadata` | The API's startup checks (`GetPublicKey`, `DescribeKey`).                                                                                                                                 |
| `NobodyElseSigns`                  | Denies `kms:Sign` to every principal except the API role, including admins with `kms:*` in IAM and anyone using a grant.                                                                  |
| `OnlyBreakGlassChangesPolicy`      | Denies `PutKeyPolicy`, `CreateGrant` and `ReplicateKey` to everyone except the break-glass role.                                                                                          |
| `DeletionWaitsThirtyDays`          | Denies `ScheduleKeyDeletion` with a waiting period under 30 days.                                                                                                                         |

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
        "kms:DescribeKey",
        "kms:GetPublicKey",
        "kms:GetKeyPolicy",
        "kms:GetKeyRotationStatus",
        "kms:ListGrants",
        "kms:ListKeyPolicies",
        "kms:ListResourceTags",
        "kms:CreateAlias",
        "kms:UpdateAlias",
        "kms:DeleteAlias",
        "kms:EnableKey",
        "kms:DisableKey",
        "kms:RevokeGrant",
        "kms:TagResource",
        "kms:UntagResource",
        "kms:UpdateKeyDescription",
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
    },
    {
      "Sid": "OnlyBreakGlassChangesPolicy",
      "Effect": "Deny",
      "Principal": { "AWS": "*" },
      "Action": ["kms:PutKeyPolicy", "kms:CreateGrant", "kms:ReplicateKey"],
      "Resource": "*",
      "Condition": {
        "ArnNotEquals": { "aws:PrincipalArn": "<break-glass-role-arn>" }
      }
    },
    {
      "Sid": "DeletionWaitsThirtyDays",
      "Effect": "Deny",
      "Principal": { "AWS": "*" },
      "Action": "kms:ScheduleKeyDeletion",
      "Resource": "*",
      "Condition": {
        "NumericLessThan": { "kms:ScheduleKeyDeletionPendingWindowInDays": "30" }
      }
    }
  ]
}
```

Notes on these statements:

- In a key policy, `aws:PrincipalArn` is the **role** ARN, not the session ARN, so `<api-role-arn>` and `<break-glass-role-arn>` must be `arn:aws:iam::...:role/...`.
- With `ArnNotEquals`, `StringNotEquals` or `NotIpAddress`, a condition key missing from the request makes the condition true, so the deny applies (fail closed). The positive conditions in the `Allow` statements fail closed the other way: a missing key means no match, so no access.
- `kms:SigningAlgorithm` and `kms:MessageType` are string condition keys for `Sign`. `kms:ScheduleKeyDeletionPendingWindowInDays` is numeric; 30 days is the KMS maximum.
- **Trade-off of the root statement.** It keeps the key recoverable through IAM, which AWS recommends. The price is that an IAM administrator can still, in several logged steps, take control: change the break-glass role's trust policy, assume it, then rewrite the key policy. Each of these steps raises an alarm in step 5. An SCP (step 5c) is what stops it in production. Removing the root statement instead would make IAM unable to fix the key if the break-glass role were broken, and recovery would need AWS Support.

### 1a. Network origin: add exactly one

The statements above check **who** signs, not **where from**. Stolen API-role credentials (for example taken from the instance metadata service, or a copied Roles Anywhere certificate) would sign as the API role and would not trip the "foreign sign" alarm. Pin `Sign` to the API's network:

**AWS-hosted API (EC2/ECS) with a KMS interface VPC endpoint.** Create an interface VPC endpoint for `com.amazonaws.<region>.kms` in the API's VPC, with **private DNS enabled**, so that the SDK's normal `kms.<region>.amazonaws.com` resolves to it. Then add:

```json
{
  "Sid": "SignOnlyThroughApiVpcEndpoint",
  "Effect": "Deny",
  "Principal": { "AWS": "*" },
  "Action": "kms:Sign",
  "Resource": "*",
  "Condition": {
    "StringNotEquals": { "aws:SourceVpce": "<vpce-id>" }
  }
}
```

`aws:SourceVpce` is only present when a request comes through a VPC endpoint. A request from anywhere else lacks it, the negated condition is true, and the deny applies. `aws:SourceIp` is never present for VPC endpoint traffic, so do not use the IP variant with an endpoint.

Also restrict the endpoint itself with an endpoint policy that allows only the API role and only this key:

```json
{
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": "*",
      "Action": ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"],
      "Resource": "<key-arn>",
      "Condition": { "ArnEquals": { "aws:PrincipalArn": "<api-role-arn>" } }
    }
  ]
}
```

That endpoint policy blocks every other KMS use through this endpoint. Use it only in a VPC that runs nothing else needing KMS (another reason for a dedicated account). Requests refused by the endpoint policy are not recorded in CloudTrail. On EC2, also require IMDSv2 with a hop limit of 1, so that a container or SSRF bug cannot read the role's credentials.

**Self-hosted API (IAM Roles Anywhere) with a fixed egress IP.** Add:

```json
{
  "Sid": "SignOnlyFromApiEgressIp",
  "Effect": "Deny",
  "Principal": { "AWS": "*" },
  "Action": "kms:Sign",
  "Resource": "*",
  "Condition": {
    "NotIpAddress": { "aws:SourceIp": "<egress-ip>/32" }
  }
}
```

If the host also reaches AWS over IPv6, add its IPv6 range to the list, or IPv6 requests will be denied.

With either variant, nothing can sign from outside the API's network, including the smoke test from a laptop (step 6).

`kms:DescribeKey` is needed because the API refuses to start unless the key is `Enabled`, `ECC_SECG_P256K1`, `SIGN_VERIFY`, single-Region and generated in AWS. Only `DescribeKey` reports those properties. It is read-only.

## 2. Create the key and its alias

Because of `OnlyBreakGlassChangesPolicy`, KMS's policy lockout safety check only accepts this policy from a principal that may still call `PutKeyPolicy` afterwards. **Run `create-key` as the break-glass role** (console Switch role → CloudShell). Never pass `--bypass-policy-lockout-safety-check`.

### AWS CLI

```sh
aws kms create-key \
  --region <region> \
  --key-spec ECC_SECG_P256K1 \
  --key-usage SIGN_VERIFY \
  --origin AWS_KMS \
  --no-multi-region \
  --description "Ranvier fee-quote signer (production). Rotate via FeeWrapper.setFeeSigner." \
  --tags TagKey=project,TagValue=ranvier TagKey=purpose,TagValue=fee-quote-signer TagKey=environment,TagValue=production \
  --policy file://key-policy.json \
  --query 'KeyMetadata.[Arn,KeySpec,KeyUsage,KeyState,Origin,MultiRegion]'
```

Record the printed `Arn`: this is `<key-arn>`. Expect `ECC_SECG_P256K1`, `SIGN_VERIFY`, `Enabled`, `AWS_KMS` and `false`.

Next, as the admin role, create the alias. Alias operations need permission twice: on the key (the key policy gives it) and on the alias itself (`kms:CreateAlias` on `arn:aws:kms:<region>:<account-id>:alias/ranvier-fee-signer*` in the admin role's IAM policy).

```sh
aws kms create-alias --region <region> \
  --alias-name alias/ranvier-fee-signer \
  --target-key-id <key-arn>
```

For the testnet key, use `environment=testnet`, a description saying "testnet", and `alias/ranvier-fee-signer-testnet`. Automatic key rotation does not exist for asymmetric keys; rotation is the manual procedure in ADR 0005.

### Console

1. As the break-glass role: KMS → Customer managed keys → **Create key**.
2. Key type **Asymmetric**, key usage **Sign and verify**, key spec **ECC_SECG_P256K1**. Under Advanced options: key material origin **KMS**, **Single-Region key**.
3. Alias, description and tags as above.
4. Key administrators: none. Key users: none. Both checkboxes would add statements the policy does not want.
5. On the review page, choose **Edit** on the key policy, paste `key-policy.json` with your network statement, and finish.

## 3. Record the signer address (from the key ARN, not the alias)

Read the address from the key **ARN**, without our code. Do not use the alias: an alias can be moved to another key.

```sh
aws kms get-public-key --region <region> --key-id <key-arn> \
  --query PublicKey --output text | base64 -d | tail -c 64 | xxd -p -c 64
# prints X||Y (128 hex characters); then:
cast keccak 0x<those 128 hex characters>
# the address is 0x followed by the LAST 40 hex characters of the hash
cast to-check-sum-address 0x<last 40 hex characters>
```

The public key is a fixed 88-byte DER SubjectPublicKeyInfo ending in the 64-byte X||Y, so `tail -c 64` is exact for this key spec.

This address is used in three places, and all three must match:

- `FEE_SIGNER` when deploying the wrapper, or the argument of the multisig `setFeeSigner` call when rotating;
- `KMS_EXPECTED_SIGNER_ADDRESS` in the API environment (step 7). The API refuses to start if the key derives to anything else;
- the address that the smoke test prints (step 6).

## 4. API role and credentials

The API reads credentials only from the AWS SDK default provider chain. Our config has no setting for access keys.

- **API on EC2 or ECS:** attach `<api-role-arn>` as the instance profile or the ECS task role, and use the VPC endpoint variant in step 1a.
- **API on a server outside AWS** (self-hosted): use IAM Roles Anywhere. It issues short-lived role credentials against an X.509 certificate from your own CA. Configure an AWS CLI profile with `credential_process` using `aws_signing_helper`, and run the API with `AWS_PROFILE` set to that profile. Protect the certificate's private key as a credential (file permissions, or a TPM/PKCS#11 store). It can be revoked at the trust anchor. Use the egress IP variant in step 1a.

Give the API role exactly one **inline** policy (not a managed policy, so that `CreatePolicyVersion` on some shared policy cannot widen it). Replace `<key-arn>`:

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

Grant nothing else from KMS. In particular, give the API role no `kms:CreateGrant`, no `kms:PutKeyPolicy` and no wildcard actions.

**Restrict who can become the API role.** Anyone who can pass the role to a new instance or task (`iam:PassRole` with `ec2:RunInstances` or `ecs:RunTask`), or edit its trust policy, can sign. Allow `iam:PassRole` on `<api-role-arn>` only to `<deployer-role-arn>` (step 5c has an SCP for this). Its trust policy should name only the EC2/ECS service or the Roles Anywhere trust anchor.

**Revoking signing fast:** `aws kms disable-key --key-id <key-arn>` (admin role) stops all signing at once, and the API answers `503 signing_unavailable`. `enable-key` restores it.

## 5. Logging and alarms

### 5a. Trail

KMS `Sign`, `GetPublicKey` and `DescribeKey` are **read-only management events** (`"readOnly": true`), and IAM changes are write events.

- **Preferred for production:** an AWS Organizations **organization trail**, created in the management account and delivered to an S3 bucket in a separate **log-archive** account. Users in the signer account cannot stop or edit it.
- **Otherwise:** a multi-Region trail in the signer account, with log file validation, delivered to an S3 bucket the API role cannot write to.

Either way:

- Management events must be **Read and Write**. A Write-only trail misses every `Sign`.
- Do **not** tick "Exclude AWS KMS events".
- The trail must be multi-Region: IAM and STS events are global and are recorded in us-east-1.
- Also deliver to a CloudWatch Logs log group (e.g. `ranvier-cloudtrail`) in `<region>`.

Create an SNS topic (e.g. `ranvier-security-alerts`) with an email or pager subscription.

### 5b. Metric filters and alarms

Create each filter on the log group with an alarm to the SNS topic. Use a threshold of `>= 1` in 5 minutes unless the item says otherwise. Use the `put-metric-filter` / `put-metric-alarm` commands at the end of this section.

1. **Key policy or key changed** (`ranvier-kms-key-changed`):

   ```text
   { $.eventSource = "kms.amazonaws.com" && ($.eventName = "PutKeyPolicy" || $.eventName = "CreateGrant" || $.eventName = "ReplicateKey" || $.eventName = "DisableKey" || $.eventName = "EnableKey" || $.eventName = "ScheduleKeyDeletion" || $.eventName = "CancelKeyDeletion" || $.eventName = "CreateAlias" || $.eventName = "UpdateAlias" || $.eventName = "DeleteAlias") }
   ```

2. **Sign from the wrong principal or the wrong network** (`ranvier-kms-foreign-sign`). Allowed or denied, this means someone is using the key outside the API path. AWS-hosted variant:

   ```text
   { $.eventSource = "kms.amazonaws.com" && $.eventName = "Sign" && ($.userIdentity.type != "AssumedRole" || $.userIdentity.sessionContext.sessionIssuer.arn != "<api-role-arn>" || $.vpcEndpointId NOT EXISTS || $.vpcEndpointId != "<vpce-id>") }
   ```

   Self-hosted variant: replace the last two terms with `$.sourceIPAddress != "<egress-ip>"`.

3. **Sign errors** (`ranvier-kms-sign-errors`). Alarm when there are more than a handful in 5 minutes:

   ```text
   { $.eventSource = "kms.amazonaws.com" && $.eventName = "Sign" && $.errorCode = "*" }
   ```

4. **Sign volume** (`ranvier-kms-sign-volume`). Alarm at a few times your normal peak of signed quotes per 5 minutes:

   ```text
   { $.eventSource = "kms.amazonaws.com" && $.eventName = "Sign" }
   ```

5. **Signer or break-glass role changed** (`ranvier-iam-signer-roles`). Replace the two role names (names, not ARNs):

   ```text
   { $.eventSource = "iam.amazonaws.com" && ($.eventName = "UpdateAssumeRolePolicy" || $.eventName = "AttachRolePolicy" || $.eventName = "DetachRolePolicy" || $.eventName = "PutRolePolicy" || $.eventName = "DeleteRolePolicy" || $.eventName = "PutRolePermissionsBoundary" || $.eventName = "DeleteRolePermissionsBoundary") && ($.requestParameters.roleName = "<api-role-name>" || $.requestParameters.roleName = "<break-glass-role-name>") }
   ```

6. **Managed policy versions changed** (`ranvier-iam-policy-versions`). In a dedicated account this should be rare:

   ```text
   { $.eventSource = "iam.amazonaws.com" && ($.eventName = "CreatePolicyVersion" || $.eventName = "SetDefaultPolicyVersion") }
   ```

7. **Someone other than the platform assumed the API or break-glass role** (`ranvier-sts-role-assumed`). This catches the temporary smoke-test trust statement (step 6) and every break-glass use:

   ```text
   { $.eventSource = "sts.amazonaws.com" && $.eventName = "AssumeRole" && $.userIdentity.type != "AWSService" && ($.requestParameters.roleArn = "<api-role-arn>" || $.requestParameters.roleArn = "<break-glass-role-arn>") }
   ```

8. **Logging or alerting tampered with** (`ranvier-audit-tamper`):

   ```text
   { ($.eventSource = "cloudtrail.amazonaws.com" && ($.eventName = "StopLogging" || $.eventName = "DeleteTrail" || $.eventName = "UpdateTrail" || $.eventName = "PutEventSelectors")) || ($.eventSource = "logs.amazonaws.com" && ($.eventName = "DeleteMetricFilter" || $.eventName = "PutMetricFilter" || $.eventName = "DeleteLogGroup")) || ($.eventSource = "monitoring.amazonaws.com" && ($.eventName = "DeleteAlarms" || $.eventName = "DisableAlarmActions" || $.eventName = "PutMetricAlarm")) || ($.eventSource = "sns.amazonaws.com" && ($.eventName = "DeleteTopic" || $.eventName = "Unsubscribe" || $.eventName = "SetTopicAttributes" || $.eventName = "RemovePermission")) }
   ```

   This alarm fires on your own setup changes too; expect that while you build the alarms. An attacker who deletes alarms can delete this one in the same call, which is why the organization trail and the SCP below matter.

9. **Root user used** (`ranvier-root-used`):

   ```text
   { $.userIdentity.type = "Root" && $.userIdentity.invokedBy NOT EXISTS && $.eventType != "AwsServiceEvent" }
   ```

Commands for one filter and its alarm (repeat with each name and pattern):

```sh
aws logs put-metric-filter --region <region> \
  --log-group-name ranvier-cloudtrail \
  --filter-name ranvier-kms-key-changed \
  --metric-transformations metricName=RanvierKmsKeyChanged,metricNamespace=Ranvier/Security,metricValue=1 \
  --filter-pattern '<pattern from the list above>'

aws cloudwatch put-metric-alarm --region <region> \
  --alarm-name ranvier-kms-key-changed \
  --namespace Ranvier/Security --metric-name RanvierKmsKeyChanged \
  --statistic Sum --period 300 --evaluation-periods 1 \
  --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching \
  --alarm-actions arn:aws:sns:<region>:<account-id>:ranvier-security-alerts
```

Before you rely on the alarms, test them on the **testnet** account:

- Paste each pattern into the CloudWatch console's "Test pattern" box with a real event from the trail.
- Run `aws kms disable-key` and then `enable-key`, and check that the key-change email arrives. CloudTrail delivery can take several minutes.
- Run the smoke test from a laptop against the testnet key, and check that the foreign-sign alarm fires.

### 5c. Production guardrails (AWS Organizations)

Alarms only report. In production, put the signer account in an Organizations OU with an SCP like the following. Replace the placeholders, and test it on the testnet account first. SCPs apply to every user and role in member accounts, including the root user, but never to the management account. That is another reason to keep the signer in a member account.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ProtectSignerRoles",
      "Effect": "Deny",
      "Action": [
        "iam:UpdateAssumeRolePolicy",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:PutRolePermissionsBoundary",
        "iam:DeleteRolePermissionsBoundary",
        "iam:DeleteRole"
      ],
      "Resource": ["<api-role-arn>", "<break-glass-role-arn>"],
      "Condition": { "ArnNotEquals": { "aws:PrincipalArn": "<break-glass-role-arn>" } }
    },
    {
      "Sid": "OnlyDeployerPassesApiRole",
      "Effect": "Deny",
      "Action": "iam:PassRole",
      "Resource": "<api-role-arn>",
      "Condition": { "ArnNotEquals": { "aws:PrincipalArn": "<deployer-role-arn>" } }
    },
    {
      "Sid": "ProtectKeyPolicy",
      "Effect": "Deny",
      "Action": ["kms:PutKeyPolicy", "kms:CreateGrant", "kms:ReplicateKey"],
      "Resource": "*",
      "Condition": { "ArnNotEquals": { "aws:PrincipalArn": "<break-glass-role-arn>" } }
    },
    {
      "Sid": "ProtectLocalAudit",
      "Effect": "Deny",
      "Action": [
        "cloudtrail:StopLogging",
        "cloudtrail:DeleteTrail",
        "cloudtrail:UpdateTrail",
        "cloudtrail:PutEventSelectors",
        "logs:DeleteLogGroup",
        "logs:DeleteMetricFilter",
        "cloudwatch:DeleteAlarms",
        "cloudwatch:DisableAlarmActions",
        "sns:DeleteTopic"
      ],
      "Resource": "*",
      "Condition": { "ArnNotEquals": { "aws:PrincipalArn": "<break-glass-role-arn>" } }
    }
  ]
}
```

The CloudWatch alarm actions are `cloudwatch:` in IAM, even though their CloudTrail event source is `monitoring.amazonaws.com`.

## 6. Smoke test

The smoke test runs the API's own signer against the real key. It prints the key ARN, spec, state, origin and address, and signs one fixed test message (chain ID 31337, domain `Ranvier KMS smoke test (not a quote)`, which can never be a valid quote). It prints PASS or FAIL, never credentials, and exits with code 0 on PASS and 1 on FAIL.

It signs as the API role, because the key policy refuses `Sign` to everyone else.

- **Production key: run it on the API host only.** There the role and the network origin are the real ones:

  ```sh
  KMS_KEY_ID=<key-arn> AWS_REGION=<region> pnpm --filter @ranvier/api kms:smoke
  ```

- **Testnet key, from your machine:** only if the testnet key policy has no network statement. Add this statement to the API role's trust policy for **one hour**. Set `DateLessThan` to the current UTC time plus one hour, and remove the statement afterwards:

  ```json
  {
    "Sid": "TemporarySmokeTest",
    "Effect": "Allow",
    "Principal": { "AWS": "<your-iam-user-arn>" },
    "Action": "sts:AssumeRole",
    "Condition": {
      "Bool": { "aws:MultiFactorAuthPresent": "true" },
      "DateLessThan": { "aws:CurrentTime": "2026-10-12T15:00:00Z" }
    }
  }
  ```

  Keep `Bool`, never `BoolIfExists`. In an `Allow`, `BoolIfExists` would also allow callers that carry no MFA context at all.

  The MFA caveat (role chaining): credentials obtained through `AssumeRole` carry no MFA context. So this condition is only met when the `AssumeRole` call itself presents your MFA device, as an IAM user's profile with `mfa_serial` does. If you are signed in through a role (IAM Identity Center/SSO, or a role you switched to), the second `AssumeRole` has no MFA context and is refused. Do not "fix" that by loosening the condition: use the API host instead.

  Profile in `~/.aws/config`:

  ```ini
  [profile ranvier-signer-smoke]
  role_arn = <api-role-arn>
  source_profile = <your IAM user profile>
  mfa_serial = <your MFA device ARN>
  region = <region>
  ```

  Then run:

  ```sh
  AWS_PROFILE=ranvier-signer-smoke KMS_KEY_ID=alias/ranvier-fee-signer-testnet AWS_REGION=<region> \
    pnpm --filter @ranvier/api kms:smoke
  ```

  The STS alarm (5b, item 7) fires when the role is assumed this way; that is expected.

The address printed must equal the one from step 3.

Common failures:

- `AccessDeniedException`: wrong role, a missing statement, the network statement (you are not on the API's network), or `NobodyElseSigns` naming another role.
- `NotFoundException`: wrong Region or ARN.
- `KeyState is Disabled`.
- `MultiRegion is true`: create a single-Region key.

## 7. Configure the API

In the API environment (not in the repo):

```sh
KMS_KEY_ID=<key-arn>                        # the full key ARN; aliases are refused for mainnets and in production
KMS_EXPECTED_SIGNER_ADDRESS=<address from step 3>
AWS_REGION=<region>
# QUOTE_SIGNER_PRIVATE_KEY and LOCAL_SIGNER_CHAIN_IDS must be unset: the API refuses to start otherwise.
```

When `NODE_ENV=production`, or when any chain in `ZEROX_CHAIN_IDS` is not a known testnet, the API requires both a full key ARN and `KMS_EXPECTED_SIGNER_ADDRESS`. It refuses to start if the key derives to a different address. At startup it logs `signer`, `signerKind: "kms"` and `kmsKeyArn`.

Before going live, check that the logged address equals `cast call <wrapper> 'feeSigner()(address)'` on every chain in `ZEROX_CHAIN_IDS`. An automatic check is a planned follow-up (ADR 0005).

## Deletion

There is no deletion-protection switch on KMS keys; deletion is always scheduled. If the production key is deleted, no quote can be signed until a new key is set on chain through the multisig.

- `DeletionWaitsThirtyDays` makes 30 days the only accepted waiting period: `aws kms schedule-key-deletion --key-id <key-arn> --pending-window-in-days 30`. Disable a key and leave it disabled for a long time before you delete it.
- The key-change alarm fires on `ScheduleKeyDeletion`. `aws kms cancel-key-deletion` undoes it during the waiting period, and the key is then disabled until you enable it again.
- To forbid deletion entirely, extend `OnlyBreakGlassChangesPolicy` with `kms:ScheduleKeyDeletion`.
