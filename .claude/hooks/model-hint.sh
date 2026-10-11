#!/usr/bin/env bash
# Shows a model suggestion based on the prompt. Never blocks.
prompt=$(jq -r '.prompt // ""' | tr '[:upper:]' '[:lower:]')

opus='contract|solidity|fee wrapper|invariant|audit|security|exploit|threat model|multisig|treasury|signing|key management|architecture|adr|routing engine|quote engine|split route|rfq|refund|stuck|incident|refactor'
haiku='rename|typo|lint|format|changelog|commit message'

if echo "$prompt" | grep -Eq "$opus"; then
  msg="Ranvier: this looks like Opus work (money, security or architecture). Use plan mode, or run /model opus."
elif echo "$prompt" | grep -Eq "$haiku"; then
  msg="Ranvier: this is a quick chore. /model haiku is enough."
else
  exit 0
fi

jq -n --arg m "$msg" '{systemMessage: $m}'
