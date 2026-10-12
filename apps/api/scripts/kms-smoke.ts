/**
 * Live smoke test of the production fee-signing key in AWS KMS (docs/runbooks/kms-setup.md).
 *
 *   KMS_KEY_ID=alias/ranvier-fee-signer AWS_REGION=eu-west-1 pnpm --filter @ranvier/api kms:smoke
 *
 * Credentials come from the default AWS provider chain (AWS_PROFILE, SSO, instance or task
 * role); this script never reads or prints them. It signs one fixed test message for chain
 * 31337 that can never be a valid quote. Exit code 0 on PASS, 1 on FAIL.
 */
import { KMSClient } from '@aws-sdk/client-kms';
import { awsKmsTransport } from '../src/adapters/signers/kms.js';
import { loadConfig } from '../src/config.js';
import { runKmsSmoke } from '../src/kms-smoke.js';

// Validate the two settings exactly as the API does; nothing else from the environment.
const config = loadConfig({
  KMS_KEY_ID: process.env.KMS_KEY_ID,
  AWS_REGION: process.env.AWS_REGION,
});
if (!config.KMS_KEY_ID || !config.AWS_REGION) {
  console.error('Set KMS_KEY_ID (key ARN or alias/...) and AWS_REGION.');
  process.exit(1);
}

const passed = await runKmsSmoke({
  keyId: config.KMS_KEY_ID,
  transport: awsKmsTransport(new KMSClient({ region: config.AWS_REGION, maxAttempts: 1 })),
  print: (line) => console.log(line),
});
process.exit(passed ? 0 : 1);
