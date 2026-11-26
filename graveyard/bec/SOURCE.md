# BEC (BeautyChain) — legacy entry

- Address: `0xC5d105E63711398aF9bbff092d4B6769C82F793D` (Ethereum mainnet)
- Contract: `BecToken` in `BecToken.sol` (single file, `pragma solidity ^0.4.16`)
- Compiler: `0.4.19+commit.c4cbbb05`, optimizer disabled (metadata `runs: 0`)
- Source and metadata: Sourcify, full match (`runtimeMatch: "match"`), fetched 2026-11-26
- Runtime code (`runtime.hex`): `eth_getCode` at `latest` from a public mainnet RPC, fetched 2026-11-26, 5,777 bytes
- Check: compiling `BecToken.sol` with forge 1.5.1 and solc 0.4.19 (optimizer off) gives runtime code equal to `runtime.hex` once the 43-byte metadata suffix is stripped from both. Only the metadata hash differs, because the file path differs.

Files:

| File | Content |
|---|---|
| `BecToken.sol` | Verified legacy source, unchanged |
| `metadata.json` | solc metadata from Sourcify |
| `abi.json` | ABI from the metadata |
| `runtime.hex` | Mainnet runtime code, `0x`-prefixed, one line |
