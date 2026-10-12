# Runbook: set up the AWS KMS fee-signing key

The API signs fee-wrapper quotes with an asymmetric AWS KMS key. The private key is generated inside KMS and never leaves it. See [ADR 0005](../adr/0005-aws-kms-quote-signer.md) for the design and the threat model.

You need: an AWS account (ideally a dedicated one, see step 0), the AWS CLI v2, and this repo checked out with `pnpm install` done. Foundry's `cast` is needed for step 3. Every JSON block in this runbook is checked for valid JSON in CI (`apps/api/scripts/runbook-json.test.ts`).

Placeholders used below:

| Placeholder                      | Meaning                                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `<region>`                       | the one Region for the key, the API and the alarms, e.g. `eu-west-1`                                |
| `<account-id>`                   | the 12-digit account that holds the key                                                             |
| `<break-glass-user-arn>`         | each IAM user allowed to assume the break-glass role, `arn:aws:iam::<account-id>:user/<name>`       |
| `<break-glass-role-arn>`         | the only principal that may change the key policy, the SCPs' exemption                              |
| `<admin-role-arn>`               | day-to-day key administration: can manage the key, cannot sign, cannot change the key policy        |
| `<api-role-arn>` / `-name>`      | the role the API runs as, `arn:aws:iam::<account-id>:role/<name>` (never an `assumed-role/...` ARN) |
| `<deployer-role-arn>` / `-name>` | the principal that launches the API (instances, tasks)                                              |
| `<ci-role-arn>` / `-name>`       | your CI or CloudFormation execution role, if it also passes the API role (otherwise drop it)        |
| `<key-arn>`                      | `arn:aws:kms:<region>:<account-id>:key/<uuid>`, printed by `create-key` in step 2                   |
| `<vpce-id>`                      | the KMS interface VPC endpoint the API uses (AWS-hosted API)                                        |
| `<egress-ip>`                    | the fixed public IP the API host uses to reach AWS (self-hosted API)                                |
| `<trust-anchor-arn>`             | the IAM Roles Anywhere trust anchor (self-hosted API)                                               |

## Order of work

Do the steps in order. Each step only uses things created before it:

0. Principles; break-glass users and role; admin role; API role (trust only); network (VPC endpoint or egress IP).
1. Write the key policy (it names the roles and the network from step 0, which must exist).
2. Create the key as the break-glass role; create the alias as the admin role.
3. Record the signer address from the key ARN.
4. Give the API role its permissions; restrict the VPC endpoint policy to the key.
5. Trails and alarms; then, last, the production SCPs.
6. Smoke test. 7. Configure the API.

## 0. Before you start

### 0.1 Principles

- **The signer address must never hold funds or do anything else.** The API role can have KMS sign _any_ 32-byte digest for this key: a quote, but also an Ethereum transaction, a `permit`, or a message for any other contract. So the signer address must never receive ETH or tokens, never approve anything, and never hold any role except `feeSigner` on the fee wrappers. Anyone who can sign as the API role can act as that address.
- **Use a dedicated AWS account for the signer** (an AWS Organizations member account that runs only the API, or at least only the signer key and its role). Every ECC `Sign` in an account and Region shares one request quota, so other workloads cannot exhaust it and nobody can exhaust it against us; fewer people and services hold IAM rights there; and the production SCPs in step 5c take shell access away from everyone, which is only acceptable in an account that runs nothing else. Check the quota in Service Quotas (AWS KMS → "Cryptographic operations (ECC) request rate") in your Region; do not rely on a number from this document.
- **Root and admin users use MFA with a hardware security key** (FIDO2), as spec section 9 requires. The root user has no access keys and is used only for account-level tasks.
- **Never create IAM access keys** (`AKIA...`) for any human or machine with these KMS permissions. Anyone holding one could sign from anywhere until it is revoked. The API gets short-lived credentials from a role.
- **Create two keys**: a testnet key (`alias/ranvier-fee-signer-testnet`) and a production key (`alias/ranvier-fee-signer`), ideally in separate accounts. Never point a testnet deployment at the production key. Set up and smoke-test the testnet key first.
- Keep the key, the API and the alarms in one Region. Do not create a multi-Region key; the API refuses one.

### 0.2 Break-glass users and role

The key policy lets only `<break-glass-role-arn>` change the key policy, and the production SCPs exempt only it.

1. Create one IAM user per person who may use break-glass (two people is a sensible minimum, so losing one key is not fatal). Give each a console password and **enroll a hardware security key as MFA now**: after the SCPs in step 5c are attached, MFA devices on these users can no longer be changed except by the break-glass role itself. Create **no access keys** for them.
2. Create the role `ranvier-break-glass` with this trust policy (one `Principal` entry per user):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": { "AWS": ["<break-glass-user-arn>"] },
         "Action": "sts:AssumeRole",
         "Condition": { "Bool": { "aws:MultiFactorAuthPresent": "true" } }
       }
     ]
   }
   ```

   `Bool` (not `BoolIfExists`) in an `Allow` fails closed: without MFA context the key is absent, the condition is false, nothing is allowed.

3. Attach the AWS managed policy `AdministratorAccess` to the role. It is the emergency role: it must be able to fix IAM, KMS, CloudTrail and the alarms, all of which the SCPs deny to everyone else. It still cannot sign: the key policy denies `kms:Sign` to every principal except the API role.

CLI (as an IAM administrator; `bg-trust.json` is the trust policy above):

```sh
aws iam create-role --role-name ranvier-break-glass --assume-role-policy-document file://bg-trust.json
aws iam attach-role-policy --role-name ranvier-break-glass \
  --policy-arn arn:aws:iam::aws:policy/AdministratorAccess
```

The break-glass users work through the console: sign in with the security key, **Switch role** to `ranvier-break-glass`, and run the CLI commands in **CloudShell** (no access keys needed). If the role is ever deleted, nobody can change the key policy; a role recreated with the **same name** regains the right, because the policies compare the role ARN as a string (`aws:PrincipalArn`).

### 0.3 Admin role

Create the role `ranvier-kms-admin` for day-to-day key administration (enable/disable, tags, aliases, deletion scheduling). Trust: the people who administer it, with MFA, in the same form as the break-glass trust policy. Its inline policy only needs the alias half of alias operations (the key half comes from the key policy):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SignerAliases",
      "Effect": "Allow",
      "Action": ["kms:CreateAlias", "kms:UpdateAlias", "kms:DeleteAlias"],
      "Resource": "arn:aws:kms:<region>:<account-id>:alias/ranvier-fee-signer*"
    },
    {
      "Sid": "ListKeysAndAliases",
      "Effect": "Allow",
      "Action": ["kms:ListKeys", "kms:ListAliases"],
      "Resource": "*"
    }
  ]
}
```

```sh
aws iam create-role --role-name ranvier-kms-admin --assume-role-policy-document file://admin-trust.json
aws iam put-role-policy --role-name ranvier-kms-admin --policy-name ranvier-kms-admin \
  --policy-document file://admin-policy.json
```

### 0.4 API role (trust policy only, no permissions yet)

Create `<api-role-name>` now, because the key policy names it and KMS refuses a key policy whose principals do not exist yet (`MalformedPolicyDocumentException`). Its permissions are attached in step 4, once the key ARN exists. Use **one** trust policy:

- **EC2 instance profile:**

  ```json
  {
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Principal": { "Service": "ec2.amazonaws.com" },
        "Action": "sts:AssumeRole"
      }
    ]
  }
  ```

- **ECS task role:**

  ```json
  {
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Principal": { "Service": "ecs-tasks.amazonaws.com" },
        "Action": "sts:AssumeRole",
        "Condition": { "StringEquals": { "aws:SourceAccount": "<account-id>" } }
      }
    ]
  }
  ```

- **IAM Roles Anywhere (self-hosted)**, pinned to one trust anchor and one certificate subject:

  ```json
  {
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Principal": { "Service": "rolesanywhere.amazonaws.com" },
        "Action": ["sts:AssumeRole", "sts:TagSession", "sts:SetSourceIdentity"],
        "Condition": {
          "ArnEquals": { "aws:SourceArn": "<trust-anchor-arn>" },
          "StringEquals": { "aws:PrincipalTag/x509Subject/CN": "ranvier-api" }
        }
      }
    ]
  }
  ```

```sh
aws iam create-role --role-name <api-role-name> --assume-role-policy-document file://api-trust.json
# EC2 only: wrap the role in an instance profile
aws iam create-instance-profile --instance-profile-name <api-role-name>
aws iam add-role-to-instance-profile --instance-profile-name <api-role-name> --role-name <api-role-name>
```

Console: IAM → Roles → **Create role** → **Custom trust policy**, paste the JSON, attach **no** permissions, create.

### 0.5 Network

The key policy pins `Sign` to the API's network (step 1a), so set the network up first:

- **AWS-hosted API:** create an interface VPC endpoint for KMS in the API's VPC, with **private DNS enabled** so the SDK's normal `kms.<region>.amazonaws.com` resolves to it. Leave the default endpoint policy for now; step 4 restricts it once the key exists.

  ```sh
  aws ec2 create-vpc-endpoint --region <region> --vpc-endpoint-type Interface \
    --service-name com.amazonaws.<region>.kms --vpc-id <vpc-id> \
    --subnet-ids <subnet-id> --security-group-ids <sg-id> --private-dns-enabled
  ```

  Record the `VpcEndpointId` as `<vpce-id>`. On EC2, require IMDSv2 with a hop limit of 1 so that a container or SSRF bug cannot read the instance role's credentials. A hop limit of 1 **breaks Docker containers on EC2 that rely on the instance profile** (they are one hop further away); ECS task roles are not affected because they use the ECS credential endpoint, not IMDS. If you run the API in Docker on plain EC2, use ECS task roles instead of raising the hop limit.

- **Self-hosted API:** give the API host a **fixed egress IP used by nothing else** (`<egress-ip>`). The IP pin in step 1a is only as strong as that exclusivity: a shared NAT, a home connection or a cloud provider's shared egress lets every other user of that IP pass it.

## 1. Key policy

Save as `key-policy.json`, replacing the placeholders. Then add **one** network statement from step 1a. Every principal named here must already exist (step 0). What the statements do:

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
- **Trade-off of the root statement.** It keeps the key recoverable through IAM, which AWS recommends. The price is that IAM administrators are in the trust base: without the SCPs in step 5c, an IAM administrator in this account can take over in a few logged steps (for example edit the break-glass role's trust policy or reset a break-glass user's MFA, assume the role, rewrite the key policy; or pass the API role to a new instance and sign from it). The alarms in step 5b report each step. The SCPs in step 5c are what block them. Removing the root statement instead would leave IAM unable to fix the key if the break-glass role broke, and recovery would need AWS Support.

### 1a. Network origin: add exactly one

The statements above check **who** signs, not **where from**. Stolen API-role credentials (for example taken from the instance metadata service, or a copied Roles Anywhere certificate) would sign as the API role and would not trip the "foreign principal" check. Pin `Sign` to the API's network.

**AWS-hosted API (EC2/ECS) through the KMS VPC endpoint from step 0.5:**

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

**Self-hosted API (IAM Roles Anywhere) with the fixed egress IP from step 0.5:**

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

With either variant, nothing can sign from outside the API's network, including the smoke test from a laptop (step 6). The network pin does not help against code running **on** the API host; step 5c restricts the ways into that host.

`kms:DescribeKey` is needed because the API refuses to start unless the key is `Enabled`, `ECC_SECG_P256K1`, `SIGN_VERIFY`, single-Region and generated in AWS. Only `DescribeKey` reports those properties. It is read-only.

## 2. Create the key and its alias

Because of `OnlyBreakGlassChangesPolicy`, KMS's policy lockout safety check only accepts this policy from a principal that may still call `PutKeyPolicy` afterwards. **Run `create-key` as the break-glass role** in CloudShell (console → Switch role → CloudShell). Never pass `--bypass-policy-lockout-safety-check`. Use the CLI rather than the console wizard: the wizard adds its own key-policy statements and alias as the break-glass role, which this runbook does not want.

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

Then switch to the **admin role** (not break-glass) and create the alias; its IAM policy (step 0.3) covers the alias, the key policy covers the key:

```sh
aws kms create-alias --region <region> \
  --alias-name alias/ranvier-fee-signer \
  --target-key-id <key-arn>
```

For the testnet key, use `environment=testnet`, a description saying "testnet", and `alias/ranvier-fee-signer-testnet`. Automatic key rotation does not exist for asymmetric keys; rotation is the manual procedure in ADR 0005.

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

## 4. API role permissions and credentials

The API reads credentials only from the AWS SDK default provider chain. Our config has no setting for access keys.

- **API on EC2 or ECS:** attach `<api-role-arn>` as the instance profile or the ECS task role.
- **API on a server outside AWS** (self-hosted): create the IAM Roles Anywhere trust anchor (your CA) and a profile for `<api-role-arn>`. Configure an AWS CLI profile with `credential_process` using `aws_signing_helper`, and run the API with `AWS_PROFILE` set to that profile. Issue the API's certificate with subject `CN=ranvier-api` (the trust policy in step 0.4 requires it). Protect the certificate's private key as a credential (file permissions, or a TPM/PKCS#11 store).

Now that the key exists, give the API role exactly one **inline** policy (not a managed policy, so that `CreatePolicyVersion` on some shared policy cannot widen it). Replace `<key-arn>`:

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

```sh
aws iam put-role-policy --role-name <api-role-name> --policy-name ranvier-fee-signer \
  --policy-document file://api-policy.json
```

Grant nothing else from KMS. In particular, give the API role no `kms:CreateGrant`, no `kms:PutKeyPolicy` and no wildcard actions.

**AWS-hosted API: restrict the VPC endpoint** to the API role and this key (it allowed everything until now):

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

```sh
aws ec2 modify-vpc-endpoint --region <region> --vpc-endpoint-id <vpce-id> \
  --policy-document file://vpce-policy.json
```

That endpoint policy blocks every other KMS use through this endpoint. Use it only in a VPC that runs nothing else needing KMS. Requests refused by the endpoint policy are not recorded in CloudTrail.

**Who can become the API role.** Anyone who can pass the role to a new instance or task, edit its trust policy, change the Roles Anywhere trust anchor or profile, or run commands on the API host can sign. Step 5c's SCPs restrict all of these in production. Until they are attached, give `iam:PassRole` on `<api-role-arn>` only to the deployer and CI roles, and deploy only immutable image digests (a mutable image tag lets whoever can push to the repository replace the code that runs with the role).

**Revoking signing fast:** `aws kms disable-key --key-id <key-arn>` (admin role) stops all signing at once, and the API answers `503 signing_unavailable`. `enable-key` restores it.

## 5. Logging, alarms and guardrails

### 5a. Trails

KMS `Sign`, `GetPublicKey` and `DescribeKey` are **read-only management events** (`"readOnly": true`), and IAM changes are write events.

**The signer account always has its own trail for the alarms.** Create a multi-Region trail in the signer account:

- management events **Read and Write** (a Write-only trail misses every `Sign`);
- "Exclude AWS KMS events" **not** ticked;
- log file validation on; delivered to an S3 bucket the API role cannot write to;
- delivered to a CloudWatch Logs log group **in this account**, `ranvier-cloudtrail` in `<region>`. The alarms in 5b read this log group.

Multi-Region matters: IAM and STS events are global and are recorded in us-east-1.

**In production, also** have the organization's management account (or the CloudTrail delegated administrator) run an **organization trail** into an S3 bucket in a separate **log-archive** account. Member accounts cannot stop, delete or change an organization trail, so it is the tamper-resistant archive. It does **not** feed the alarms: an organization trail can only deliver to a CloudWatch Logs group in the account that manages it, so the signer account sees none of its events. Keep both trails.

Create an SNS topic `ranvier-security-alerts` in `<region>` with an email or pager subscription, and confirm the subscription.

### 5b. Metric filters and alarms

Create each filter on `ranvier-cloudtrail` with an alarm named the same, sending to the SNS topic. Use a threshold of `>= 1` in 5 minutes with `--treat-missing-data notBreaching` unless the item says otherwise (no matching events is the normal, quiet case). All alarm and filter names start with `ranvier-`, which the SCP in step 5c relies on.

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

5. **Protected roles changed** (`ranvier-iam-protected-roles`): the API, break-glass, deployer and CI roles (names, not ARNs):

   ```text
   { $.eventSource = "iam.amazonaws.com" && ($.eventName = "UpdateAssumeRolePolicy" || $.eventName = "AttachRolePolicy" || $.eventName = "DetachRolePolicy" || $.eventName = "PutRolePolicy" || $.eventName = "DeleteRolePolicy" || $.eventName = "PutRolePermissionsBoundary" || $.eventName = "DeleteRolePermissionsBoundary" || $.eventName = "DeleteRole") && ($.requestParameters.roleName = "<api-role-name>" || $.requestParameters.roleName = "ranvier-break-glass" || $.requestParameters.roleName = "<deployer-role-name>" || $.requestParameters.roleName = "<ci-role-name>") }
   ```

6. **Break-glass users changed** (`ranvier-iam-break-glass-users`): any credential, MFA or policy change on those users. List each user name:

   ```text
   { $.eventSource = "iam.amazonaws.com" && ($.eventName = "CreateAccessKey" || $.eventName = "UpdateAccessKey" || $.eventName = "CreateLoginProfile" || $.eventName = "UpdateLoginProfile" || $.eventName = "DeactivateMFADevice" || $.eventName = "EnableMFADevice" || $.eventName = "ResyncMFADevice" || $.eventName = "AttachUserPolicy" || $.eventName = "PutUserPolicy" || $.eventName = "AddUserToGroup" || $.eventName = "UpdateUser" || $.eventName = "DeleteUser") && ($.requestParameters.userName = "<break-glass-user-1>" || $.requestParameters.userName = "<break-glass-user-2>") }
   ```

7. **Managed policy versions changed** (`ranvier-iam-policy-versions`). In a dedicated account this should be rare:

   ```text
   { $.eventSource = "iam.amazonaws.com" && ($.eventName = "CreatePolicyVersion" || $.eventName = "SetDefaultPolicyVersion") }
   ```

8. **Someone other than the platform assumed the API or break-glass role** (`ranvier-sts-role-assumed`). This catches the temporary smoke-test trust statement (step 6) and every break-glass use:

   ```text
   { $.eventSource = "sts.amazonaws.com" && $.eventName = "AssumeRole" && $.userIdentity.type != "AWSService" && ($.requestParameters.roleArn = "<api-role-arn>" || $.requestParameters.roleArn = "<break-glass-role-arn>") }
   ```

9. **Roles Anywhere configuration changed** (`ranvier-rolesanywhere-changed`), self-hosted only:

   ```text
   { $.eventSource = "rolesanywhere.amazonaws.com" && ($.eventName = "Create*" || $.eventName = "Update*" || $.eventName = "Enable*" || $.eventName = "Put*" || $.eventName = "Delete*" || $.eventName = "Disable*" || $.eventName = "ImportCrl") }
   ```

10. **Logging or alerting tampered with** (`ranvier-audit-tamper`):

    ```text
    { ($.eventSource = "cloudtrail.amazonaws.com" && ($.eventName = "StopLogging" || $.eventName = "DeleteTrail" || $.eventName = "UpdateTrail" || $.eventName = "PutEventSelectors")) || ($.eventSource = "logs.amazonaws.com" && ($.eventName = "DeleteMetricFilter" || $.eventName = "PutMetricFilter" || $.eventName = "DeleteLogGroup" || $.eventName = "PutRetentionPolicy")) || ($.eventSource = "monitoring.amazonaws.com" && ($.eventName = "DeleteAlarms" || $.eventName = "DisableAlarmActions" || $.eventName = "PutMetricAlarm")) || ($.eventSource = "sns.amazonaws.com" && ($.eventName = "DeleteTopic" || $.eventName = "Unsubscribe" || $.eventName = "SetTopicAttributes" || $.eventName = "SetSubscriptionAttributes" || $.eventName = "RemovePermission")) }
    ```

    This alarm cannot see its own silencing: a `PutMetricFilter` that replaces this very pattern, or a `PutMetricAlarm` that removes this alarm's action, is the last thing it reports at best. That is why step 5c denies these calls on the `ranvier-*` resources outright.

11. **Root user used** (`ranvier-root-used`):

    ```text
    { $.userIdentity.type = "Root" && $.userIdentity.invokedBy NOT EXISTS && $.eventType != "AwsServiceEvent" }
    ```

12. **Trail delivery stopped** (`ranvier-trail-heartbeat`). Not a metric filter: an alarm on the log group's own `IncomingLogEvents` metric, which **breaches on missing data**, so silence pages you. Pick the period from your account's quietest normal hour (one hour shown):

    ```sh
    aws cloudwatch put-metric-alarm --region <region> \
      --alarm-name ranvier-trail-heartbeat \
      --namespace AWS/Logs --metric-name IncomingLogEvents \
      --dimensions Name=LogGroupName,Value=ranvier-cloudtrail \
      --statistic Sum --period 3600 --evaluation-periods 1 \
      --threshold 1 --comparison-operator LessThanThreshold \
      --treat-missing-data breaching \
      --alarm-actions arn:aws:sns:<region>:<account-id>:ranvier-security-alerts
    ```

Commands for one metric filter and its alarm (repeat with each name and pattern):

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

### 5c. Production guardrails: service control policies

Alarms only report. In production, put the signer account in its own Organizations OU and attach the two SCPs below. **Attach them last**: after the break-glass users have enrolled their MFA (step 0.2) and after every trail, filter and alarm in 5a and 5b exists, because from then on only the break-glass role can change those. Test both on the testnet account first.

What they cost: in the signer account nobody but break-glass can open a shell or run commands on instances or containers (SSM Session Manager, Run Command, ECS Exec, EC2 Instance Connect, user-data changes), change the protected roles or users, or change the alarms. That is why the signer belongs in a dedicated account. If you need SSM for an incident, switch to the break-glass role (which raises the STS alarm). SCPs apply to every user and role in member accounts, including the root user, and never to the management account.

**SCP 1, `ranvier-signer-identity`** (who can become the API role or break-glass):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ProtectRoles",
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
      "Resource": [
        "<api-role-arn>",
        "<break-glass-role-arn>",
        "<deployer-role-arn>",
        "<ci-role-arn>"
      ],
      "Condition": { "ArnNotEquals": { "aws:PrincipalArn": "<break-glass-role-arn>" } }
    },
    {
      "Sid": "ProtectBreakGlassUsers",
      "Effect": "Deny",
      "Action": [
        "iam:CreateAccessKey",
        "iam:UpdateAccessKey",
        "iam:CreateLoginProfile",
        "iam:UpdateLoginProfile",
        "iam:DeactivateMFADevice",
        "iam:EnableMFADevice",
        "iam:ResyncMFADevice",
        "iam:AttachUserPolicy",
        "iam:PutUserPolicy",
        "iam:AddUserToGroup",
        "iam:UpdateUser",
        "iam:DeleteUser"
      ],
      "Resource": ["<break-glass-user-arn>"],
      "Condition": { "ArnNotEquals": { "aws:PrincipalArn": "<break-glass-role-arn>" } }
    },
    {
      "Sid": "OnlyDeployersPassApiRole",
      "Effect": "Deny",
      "Action": "iam:PassRole",
      "Resource": "<api-role-arn>",
      "Condition": {
        "ArnNotLike": {
          "aws:PrincipalArn": ["<deployer-role-arn>", "<ci-role-arn>", "<break-glass-role-arn>"]
        }
      }
    },
    {
      "Sid": "ProtectSignerKeyPolicy",
      "Effect": "Deny",
      "Action": ["kms:PutKeyPolicy", "kms:CreateGrant", "kms:ReplicateKey"],
      "Resource": "<key-arn>",
      "Condition": { "ArnNotEquals": { "aws:PrincipalArn": "<break-glass-role-arn>" } }
    },
    {
      "Sid": "NoShellOnApiHosts",
      "Effect": "Deny",
      "Action": [
        "ssm:StartSession",
        "ssm:SendCommand",
        "ssm:CreateAssociation",
        "ssm:UpdateAssociation",
        "ssm:StartAutomationExecution",
        "ecs:ExecuteCommand",
        "ec2:ModifyInstanceAttribute",
        "ec2-instance-connect:SendSSHPublicKey",
        "ec2-instance-connect:SendSerialConsoleSSHPublicKey",
        "ec2-instance-connect:OpenTunnel"
      ],
      "Resource": "*",
      "Condition": { "ArnNotEquals": { "aws:PrincipalArn": "<break-glass-role-arn>" } }
    },
    {
      "Sid": "ProtectRolesAnywhere",
      "Effect": "Deny",
      "Action": [
        "rolesanywhere:CreateTrustAnchor",
        "rolesanywhere:UpdateTrustAnchor",
        "rolesanywhere:EnableTrustAnchor",
        "rolesanywhere:CreateProfile",
        "rolesanywhere:UpdateProfile",
        "rolesanywhere:EnableProfile",
        "rolesanywhere:PutAttributeMapping",
        "rolesanywhere:DeleteAttributeMapping",
        "rolesanywhere:ImportCrl",
        "rolesanywhere:UpdateCrl",
        "rolesanywhere:DisableCrl",
        "rolesanywhere:DeleteCrl"
      ],
      "Resource": "*",
      "Condition": { "ArnNotEquals": { "aws:PrincipalArn": "<break-glass-role-arn>" } }
    }
  ]
}
```

Scoping: the IAM, PassRole and KMS statements name the exact roles, users and key. The shell statement uses `"*"` on purpose: instances and tasks are replaced on every deploy, and in a dedicated signer account every instance is an API host. The Roles Anywhere statement uses `"*"` because a dedicated account has only the API's trust anchor and profile, and `CreateTrustAnchor` has no existing resource to name. Remove `ProtectRolesAnywhere` if you are AWS-hosted and the `<ci-role-arn>` entries if you have no CI role.

**SCP 2, `ranvier-signer-audit`** (nobody but break-glass can silence the trail or the alarms):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ProtectSignerTrail",
      "Effect": "Deny",
      "Action": [
        "cloudtrail:StopLogging",
        "cloudtrail:DeleteTrail",
        "cloudtrail:UpdateTrail",
        "cloudtrail:PutEventSelectors"
      ],
      "Resource": "arn:aws:cloudtrail:<region>:<account-id>:trail/<trail-name>",
      "Condition": { "ArnNotEquals": { "aws:PrincipalArn": "<break-glass-role-arn>" } }
    },
    {
      "Sid": "ProtectAlarmLogGroup",
      "Effect": "Deny",
      "Action": [
        "logs:PutMetricFilter",
        "logs:DeleteMetricFilter",
        "logs:PutRetentionPolicy",
        "logs:DeleteLogGroup"
      ],
      "Resource": [
        "arn:aws:logs:<region>:<account-id>:log-group:ranvier-cloudtrail",
        "arn:aws:logs:<region>:<account-id>:log-group:ranvier-cloudtrail:*"
      ],
      "Condition": { "ArnNotEquals": { "aws:PrincipalArn": "<break-glass-role-arn>" } }
    },
    {
      "Sid": "ProtectAlarms",
      "Effect": "Deny",
      "Action": [
        "cloudwatch:PutMetricAlarm",
        "cloudwatch:DeleteAlarms",
        "cloudwatch:DisableAlarmActions"
      ],
      "Resource": "arn:aws:cloudwatch:<region>:<account-id>:alarm:ranvier-*",
      "Condition": { "ArnNotEquals": { "aws:PrincipalArn": "<break-glass-role-arn>" } }
    },
    {
      "Sid": "ProtectAlertTopic",
      "Effect": "Deny",
      "Action": [
        "sns:DeleteTopic",
        "sns:SetTopicAttributes",
        "sns:RemovePermission",
        "sns:Unsubscribe",
        "sns:SetSubscriptionAttributes"
      ],
      "Resource": [
        "arn:aws:sns:<region>:<account-id>:ranvier-security-alerts",
        "arn:aws:sns:<region>:<account-id>:ranvier-security-alerts:*"
      ],
      "Condition": { "ArnNotEquals": { "aws:PrincipalArn": "<break-glass-role-arn>" } }
    }
  ]
}
```

The second ARN in each of the last two lists covers resources nested under the log group (its streams) and under the topic (its subscriptions, `...:ranvier-security-alerts:<uuid>`). CloudWatch alarm actions are `cloudwatch:` in IAM, although their CloudTrail event source is `monitoring.amazonaws.com`. From now on, every change to the trail, the `ranvier-*` alarms, the log group's filters and the alert topic is made as the break-glass role.

Size: an SCP holds at most 10,240 characters. The console strips white space before counting; with the CLI, minify first (`jq -c . scp.json`).

**What these SCPs do not cover.** They are not an exhaustive list of ways to run code as the API role. In particular:

- anyone who can push to the API's image repository or edit its launch template can change the code that runs with the role (deploy immutable digests; restrict `ecr:PutImage` and `ec2:CreateLaunchTemplateVersion` to the CI role);
- anyone holding a break-glass user's password **and** hardware key is break-glass;
- the management account and AWS Support are outside SCPs.

## 6. Smoke test

The smoke test runs the API's own signer against the real key. It prints the key ARN, spec, state, origin and address, and signs one fixed test message (chain ID 31337, domain `Ranvier KMS smoke test (not a quote)`, which can never be a valid quote). It prints PASS or FAIL, never credentials, and exits with code 0 on PASS and 1 on FAIL.

It signs as the API role, because the key policy refuses `Sign` to everyone else.

- **Production key: run it on the API host only.** There the role and the network origin are the real ones. With the step 5c SCPs in place that means a deploy of the smoke command (or a shell as break-glass):

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

  The MFA caveat (role chaining): credentials obtained through `AssumeRole` carry no MFA context. So this condition is only met when the `AssumeRole` call itself presents your MFA device, as an IAM user's profile with `mfa_serial` does (that user then needs access keys, which is why this path is for the testnet account only). If you are signed in through a role (IAM Identity Center/SSO, or a role you switched to), the second `AssumeRole` has no MFA context and is refused. Do not "fix" that by loosening the condition: use the API host instead.

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

  The STS alarm (5b, item 8) fires when the role is assumed this way; that is expected.

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
