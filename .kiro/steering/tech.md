---
inclusion: always
---

# Tech stack

- **Monorepo**: pnpm workspace.
- **Language/runtime**: TypeScript in strict mode on Node 22.
- **Tests**: vitest, plus fast-check for property-based tests.
- **Solidity tooling**: Foundry for compiling and fuzzing.
  - Legacy files are pinned to their original solc version with `compilation_restrictions`.
  - 0.8 tests load legacy artifacts with `vm.deployCode`.
- **Séance worker**: linux/amd64 Docker image containing Foundry and old solc versions.
- **Web**: Next.js App Router, deployed on Vercel.
- **Contract source**: fetch from Sourcify first, Etherscan second.
