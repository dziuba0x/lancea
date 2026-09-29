# Security

Lancea is a guard: a bug in it is a way past a spending limit. Reports are welcome and taken seriously.

## Scope

- The guard (`src/guard.ts`, `src/smart-accounts.ts`, `src/policy.ts`): any payment it co-signs that the umbrella's budget, the principal's rules or the Smart Accounts policy should have refused, or a strike it should have written and did not.
- The services (`src/service/`): anything that lets a process other than the autopilot obtain a co-signature, or lets a key leave its machine.
- The autopilot's planning (`src/autopilot.ts`, `src/brain.ts`): a step it proposes that the guard should refuse (it would strike its own umbrella).
- The contracts Lancea calls are DELICTI's. Report those at [dziuba0x/delicti](https://github.com/dziuba0x/delicti/blob/main/SECURITY.md).

## How to report

Please use GitHub's private vulnerability reporting (**Security → Report a vulnerability**) rather than a public issue. Include the payment or the steps, and what you expected the guard to do. Proofs of concept belong on testnets or a local fork, never on mainnet.

## Status

Testnets only, unaudited. There is no bounty yet; credit in the release notes and the README if you would like it.
