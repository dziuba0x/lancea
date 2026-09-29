# Contributing

Thank you for looking. Lancea is small on purpose: a guard is easier to trust when it is short enough to read.

- **Run the tests first.** `npm ci && npm test` runs 42 tests offline, and `npx tsc --noEmit` must stay clean. CI runs both on every push.
- **A change to what the guard signs needs a test that shows the refusal**, next to the one that shows the signature.
- **Fail closed.** Every read and write can fail; a failure is a refusal, never a signature and never a crash.
- **No keys in the repo, in logs or in journals.** Config is public; keys live with the process that uses them (`src/service/config.ts`).
- **Plain words** in docs and in the reasons the guard and the agent write: the dashboard shows them to people.
- The dashboard (`dashboard/`) builds into `docs/index.html` with `npx tsx scripts/dashboard-build.ts`; commit both.

Issues and pull requests are welcome. For anything that could let a payment past the guard, please read [SECURITY.md](SECURITY.md) first.
