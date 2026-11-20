---
inclusion: always
---

# Product

Exhume resurrects dead pre-0.8 Solidity contracts.

## Users

Smart contract developers and auditors.

## Flow

1. **Graveyard**: curated dead contracts with verified source.
2. **Autopsy**: flag legacy syntax and dangerous patterns:
   - unchecked arithmetic
   - unchecked `send` / `call`
   - `tx.origin` auth
   - misnamed constructors
3. **Resurrection**: deterministic port to Solidity 0.8.
4. **Séance**: differential fuzzing of the original bytecode against the port.

## Séance divergence classes

Every séance divergence is classified as one of:

- **match**: same behaviour.
- **reason-modernised**: both revert, with different revert data.
- **exorcised**: legacy succeeds, 0.8 reverts with `Panic(0x11)`.
- **port bug**: any other divergence.

## First graveyard entry

BeautyChain BEC

- Mainnet address: `0xC5d105E63711398aF9bbff092d4B6769C82F793D`
- Compiler: solc 0.4.19, optimizer off
- Cause of death: `batchOverflow`, 2018

## Context

Built for the Kiroween 2026 hackathon, Resurrection category. Submission deadline: 3 Dec 2026.
