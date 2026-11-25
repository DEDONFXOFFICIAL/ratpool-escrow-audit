# Signed entry amounts — devnet v5

The `join` instruction is now `join(id: u64, expected_entry: u64)`. It rejects
an entry different from the match's price before approving any tokens. This
also protects a pending join after an empty match is cancelled and recreated.
The price remains configurable for new matches. Existing account layouts,
seeds and previous error numbers are unchanged. Legacy joins without an entry
are rejected. Both the API and client must use the regenerated IDL.

The client validates the signed amount against the selected tier. The API
validates the requested amount against the match before co-signing. Old app
versions must update to Android code 51 / 0.4.8.7 for this instruction.

Build SHA-256: `07b99773487ff24e3b31895b501199b6bf871cc7a8441fb4e5417f3e349bfc02`.
All 78 LiteSVM contract tests pass against this binary, including wrong-price,
cancel/recreate, exact new-tier and legacy-instruction tests. The rent quote's
4,096-byte ceiling is checked against the compiled match account size.

`upgrade-v5.sh` pins the binary and verifies the authority before devnet-only
deployment. Do not use the old v4 rollback while joins are enabled: it removes
the on-chain price check even though a v5 client includes the extra argument.
This change is not a mainnet launch or an independent security audit.
