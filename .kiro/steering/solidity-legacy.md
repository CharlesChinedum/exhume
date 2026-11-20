---
inclusion: always
---

# Porting legacy Solidity to 0.8

## Hard rule

Never change logic while porting. Bug fixes must come only from 0.8's built-in checks, so the séance can prove them.

## Rewrite rules

- **R1**: SafeMath calls → checked operators.
- **R2**: contract-named constructors → `constructor`.
- **R3**: `abstract` / `virtual` / `override` are resolved with real C3 linearization, never regex.
- **R4**: arrays in external functions → `calldata`.
- **R5**: `constant` functions → `view`.
- **R6**: event calls → `emit`.
- **R7**: `function ()` → `fallback()`.

## Séance inputs

Plain fuzzing missed BEC's overflow in 16k calls. Séance inputs must target each unchecked arithmetic site the autopsy finds. For `x * k`, use values near `2^256 / k`.
