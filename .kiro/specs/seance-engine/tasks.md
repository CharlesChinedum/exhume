# Implementation Plan: Séance Engine

## Overview

The plan is in four parts. First, an integration task checks every Known risk in the design before any TypeScript exists. Each risk script runs twice: natively with the local Foundry 1.5.1 on macOS arm64 (first run), then in the linux/amd64 Docker image (second run). Second, the core path is built in this order: types and schemas, classifier, input generator, project generator and templates, report builder, runner, entry point and CLI. Third, the BEC acceptance run proves the path end to end (project generation, build, bytecode check, discovery, witness shrinking, replay, report written, exorcism in `batchTransfer`, zero port bugs). It uses a hand-made golden port and a hand-written Autopsy report for BEC (task 13.0). Fourth, the planted-bug acceptance run is required, and the dropped-emit mutation run and the timeout and deadline edge-case tests are optional.

Implementation language is TypeScript (strict, Node 22, pnpm workspace, vitest, fast-check), as set by the design. Generated Solidity is tested with Foundry in the linux/amd64 Docker image.

The design's Known risks section lists eight bullets, not five. Sub-tasks 1.2 to 1.9 cover all eight, one each, in the order the design lists them.

## Tasks

- [ ] 1. Docker integration test: verify the design's Known risks before writing any TypeScript
  - Every risk script runs twice. The first run is native, with the local forge 1.5.1 on macOS arm64. The second run is in the linux/amd64 Docker image with Foundry 1.5.1, forge-std pinned at `/opt/forge-std`, and solc 0.4.19.
  - Each risk sub-task is a runnable script plus a small Solidity fixture under `engine/test/docker/risks/`, and exits non-zero on failure. The same script and fixture serve both runs.
  - Each sub-task writes one result file per run (PASS or FAIL, observed values, and the design change needed on FAIL) to `engine/test/docker/findings/<sub-task>.native.md` and `engine/test/docker/findings/<sub-task>.docker.md`. Sub-task 1.10 copies these into the Findings lines below.
  - If solc 0.4.19 cannot be installed or run natively on macOS arm64, the native run for the affected risks is recorded as FAIL with the reason. That is a finding, not a reason to skip the run.
  - Docker on Apple Silicon runs linux/amd64 under emulation, so Docker timings measured there are not representative. Native timings are the representative ones.
  - _Requirements: 1.6, 3.7, 5.4, 7.11, 8.1, 12.8_

  - [x] 1.1 Create the native and Docker harnesses and fixtures
    - Add `engine/test/docker/Dockerfile` (or reuse the worker image definition if it exists) for linux/amd64 with Foundry pinned to 1.5.1, solc 0.4.19, one solc 0.8.x, and forge-std checked out at `/opt/forge-std` at the version recorded in `FORGE_STD_PIN`. Replace any `latest` or unpinned Foundry install with an install of exactly 1.5.1 (for example `foundryup --install 1.5.1`), and add a build step that fails if `forge --version` does not report 1.5.1.
    - Add `engine/test/docker/run-risks-native.sh`, which checks that the local `forge --version` reports 1.5.1 and runs each risk script natively in a scratch copy of a fixture project. Native runs use a local forge-std checkout at the `FORGE_STD_PIN` version, and the script records its path.
    - Add `engine/test/docker/run-risks.sh`, which builds the image and runs each risk script in a scratch copy of a fixture project.
    - Add a minimal fixture: a 0.4.19 token (`transfer`, `balanceOf`, `batchTransfer` with unchecked `cnt * _value`) and a 0.8 port with the same contract name in a different file.
    - _Requirements: 1.6_

  - [x] 1.2 Risk 1: `vm.writeLine` inside invariant runs with scoped `fs_permissions`
    - Use `fs_permissions = [{ access = "read", path = "./out" }, { access = "read-write", path = "./seance-out" }]`.
    - PASS: a handler that appends one line per call inside `invariant_` runs produces a file with `runs * depth` lines (256 x 64 = 16,384 for the fixture settings) followed by exactly one replay of the final run (`depth` identical lines, 64 for the fixture settings), and no permission error. Writes outside `./seance-out` must fail.
    - FAIL consequence: switch recording to the buffered `vm.writeFile` fallback in the design's wall-clock mitigation (2).
    - Findings:
      - native (forge 1.5.1, macOS arm64): PASS with a design change. `vm.writeLine` works in invariant runs with the scoped `fs_permissions`, and writes outside `./seance-out` are rejected. Observed 16,448 lines for runs=256 depth=64, which is 16,384 plus a post-campaign replay of the final run (64 duplicate lines). A probe with runs=10 depth=5 gave 55 lines (50 + 5).
      - docker (linux/amd64, forge 1.5.1): PASS with a design change. Same observations as the native run: scoped writes work, writes outside `./seance-out` are rejected, 16,448 lines for runs=256 depth=64, and 55 lines for the runs=10 depth=5 probe.
      - Design change: keep `vm.writeLine` and do not switch to buffered `vm.writeFile`. Handler storage resets every run, so a buffer would not remove the duplicate run. The Report_Builder keeps the first `INVARIANT_RUNS` sequences (counted by `idx == 0` starts), verifies that the remaining lines form exactly one sequence identical to the last kept sequence, and fails with `SEANCE_FAILED` naming the first difference otherwise. Affects tasks 9.1, 9.5, and 10.4.
      - Follow-up: `engine/test/docker/risks/1.2-writeline.sh`, its fixture, and the files `findings/1.2-writeline.native.md`, `findings/1.2.native.md`, and `findings/1.2.docker.md` still apply the original literal criterion (`runs * depth` lines exactly). Update them to the corrected criterion the next time that script is touched.
    - _Requirements: 3.2, 7.1_

  - [x] 1.3 Risk 2: handler storage reverts per invariant run and `setUp` runs once per forge process
    - PASS: a counter in handler storage restarts at its post-`setUp` value at the start of every run (the first call of each run sees `idx == 0`), and a setup-time marker line is written exactly once in the whole process.
    - FAIL consequence: the `idx == 0` sequence boundary and the once-per-process setup records need a different mechanism. Update decisions 4 and 10 in the design.
    - Findings: _(filled in by 1.10)_
    - _Requirements: 5.4, 5.5_

  - [-] 1.4 Risk 3: `forge test --json` exposes the failed invariant's `counterexample` as a handler-call list
    - Run a failing `invariant_witness` fixture and a passing one with the pinned Foundry version.
    - PASS: the result is found by iterating the `"<file>:<contract>"` keys of the top-level JSON and the `test_results` under each. For the failing run, the calls are in `counterexample.Sequence[1]`, an ordered list where each call has a sender, hex calldata, and call details. `Sequence[0]` is the pre-shrink length, which the parser records as `originalLength`. For the passing run, `counterexample` is `null`, which means no counterexample.
    - Save both JSON outputs from the native run as fixtures at `engine/test/fixtures/forge-json/failing.json` and `passing.json`. The Docker run's JSON is compared with them for shape only (same keys and nesting), not saved as fixtures.
    - Fresh directory per run: forge replays saved failures from `cache/invariant`, so the script must copy the fixture into a fresh scratch directory on every run, native and Docker. The script may include a negative check that reuses a directory and shows the cached failure being replayed.
    - Seed agreement: run the native and the Docker witness fixtures with the same `--fuzz-seed` and compare the shrunk sequences. Record whether they are identical. A mismatch is a finding to list in 1.10, not a task failure. The Docker run is emulated (linux/amd64 on Apple Silicon), which affects timing only and is not a cause to expect different sequences.
    - FAIL consequence: rewrite the `foundry-json.ts` contract in the design to match the real shape.
    - Findings: _(filled in by 1.10)_
    - _Requirements: 8.1, 8.2_

  - [ ] 1.5 Risk 4: per-file legacy optimizer profile and `vm.deployCode` name resolution
    - Build the fixture with `compilation_restrictions` pinning `src/legacy/LegacyToken.sol` to 0.4.19 with the optimizer disabled, and the port in `src/port/PortToken.sol` with the same contract name, with `additional_compiler_profiles` for the optimizer.
    - PASS: one `forge build` produces both artifacts. `vm.deployCode("LegacyToken.sol:Token")` and `vm.deployCode("PortToken.sol:Token")` deploy different runtime code. Repeat with the legacy optimizer enabled at runs 200 and check the legacy runtime code differs from the optimizer-off build.
    - FAIL consequence: change the artifact naming or profile scheme in the design (decision 9, `foundry.toml` section).
    - Findings: _(filled in by 1.10)_
    - _Requirements: 1.2, 1.3, 1.4, 1.6, 1.7_

  - [ ] 1.6 Risk 5: artifact path layout for the bytecode check
    - PASS: `out/LegacyToken.sol/Token.json` exists after `forge build` and its `deployedBytecode.object` is readable, and a Metadata_Suffix strip (CBOR length in the last two bytes) of that code equals the stripped on-chain code for the fixture.
    - FAIL consequence: update the artifact path the Runner reads.
    - Findings: _(filled in by 1.10)_
    - _Requirements: 1.8, 1.9_

  - [ ] 1.7 Risk 6: pinned forge-std resolves through `remappings.txt` and `allow_paths`
    - Generate the minimal project with `remappings.txt` containing `forge-std/=/opt/forge-std/src/` and `allow_paths = ["/opt/forge-std"]`, no `lib/` directory, and no network.
    - PASS: `forge build` succeeds offline, and the checkout at `/opt/forge-std` matches `FORGE_STD_PIN`.
    - FAIL consequence: change decision 11 (vendoring scheme).
    - Findings: _(filled in by 1.10)_
    - _Requirements: 1.6_

  - [ ] 1.8 Risk 7: wall-clock time of discovery with recording on
    - Run a fixture handler with two capped low-level calls, two capped state reads, `vm.recordLogs`, and one `vm.writeLine` per call, at `runs = 256` and `depth = 64`.
    - PASS: record seconds per call and total seconds for both the native run and the Docker run, and the native total is under 150 s (half the 300 s default, leaving room for build, witness, and replay). Record both numbers either way.
    - The Docker timing on Apple Silicon is emulated (linux/amd64 under emulation) and is not representative. Record it, label it as emulated, and do not use it for the PASS decision.
    - FAIL consequence: apply the design's mitigations in order (raise the default timeout for graveyard runs, buffered writes, skip state reads for double reverts, lower `depth`) and update the design.
    - Findings: _(filled in by 1.10)_
    - _Requirements: 12.7, 12.8, 12.10_

  - [ ] 1.9 Risk 8: witness campaign wall-clock time with recording off
    - Run one `invariant_witness` fixture campaign with default shrinking and `SEANCE_RECORD=0`.
    - PASS: record seconds per campaign for both the native run and the Docker run. The native estimate for 10 pairs plus replays fits in the remaining budget after discovery, or the design is updated to say that a deadline there is the expected case.
    - The Docker timing on Apple Silicon is emulated (linux/amd64 under emulation) and is not representative. Record it, label it as emulated, and do not use it for the PASS decision.
    - FAIL consequence: lower the `INVARIANT_RUNS` used by witness campaigns, or document the expected `deadline` outcome in the design.
    - Findings: _(filled in by 1.10)_
    - _Requirements: 8.1, 12.11_

  - [ ] 1.10 Record findings in this file and flag design changes
    - Copy each sub-task's native result and Docker result into its Findings line above, as two separate entries labelled `native (forge 1.5.1, macOS arm64)` and `docker (linux/amd64, forge 1.5.1)`. For 1.8 and 1.9, include both timings, with the Docker timing labelled as emulated on Apple Silicon.
    - Treat a native/Docker disagreement (one PASS and one FAIL, or different observed values for the same check, other than timings) as a finding. List it with both observed values and the suspected cause.
    - For each FAIL and each disagreement, list the design change needed and which later tasks it affects, and stop to ask the user before continuing past checkpoint 2.
    - _Requirements: 1.6, 12.8_

- [ ] 2. Checkpoint - Risk verification gate
  - Ensure every Known risk is PASS in the native run and the Docker run, or that each FAIL and each native/Docker disagreement has an agreed design change. Ask the user if questions arise.

- [ ] 3. Scaffold the engine package and shared types
  - [ ] 3.1 Set up the `engine/` package
    - Create the pnpm workspace entry, `tsconfig.json` in strict mode for Node 22, vitest config, and a fast-check dependency, plus the `engine/src/seance/` and `engine/test/seance/` directories.
    - _Requirements: 12.1_

  - [ ] 3.2 Define shared types and error model
    - Create `engine/src/seance/types.ts` with `SeanceInput`, `SeanceError` (including `phase` and `partialCounts`), error code union, `Result`, `Classification`, `CallRecord`, `NormLog`, `RecordLine`, `OrderedRecord`, `SeanceReport`, `Finding`, `UnshrunkReason`, `AutopsyReport`, `ArithmeticSite`, `Operand`, `TargetPlan`, `ParamSlot`, `AbiFunction`.
    - Keep one module so later tasks do not edit each other's types.
    - _Requirements: 4.8, 7.3, 7.4, 8.8, 11.1, 12.4_

- [ ] 4. Autopsy contract and schemas
  - [ ] 4.1 Write the JSON schemas
    - Create `schemas/autopsy-v1.schema.json` and `schemas/seance-report.schema.json`. The report schema requires `runs`, `depth`, `totalCalls`, `counts`, the `shrinking` object with its seven fields, and `unshrunk` plus `unshrunkReason` on unshrunk findings.
    - _Requirements: 7.8, 7.12, 11.1, 11.5_

  - [ ] 4.2 Implement `autopsy-contract.ts`
    - Implement `parseAutopsyReport` with the check order: empty, over 10 MB, JSON syntax, `schemaVersion` present, supported (`["1"]`), Ajv schema validation with all violations and JSON pointers, then the ABI cross-check naming every unknown function. Implement `serializeAutopsyReport` with canonical key order.
    - _Requirements: 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.10_

  - [ ]* 4.3 Write property test for the Autopsy round trip
    - **Property 18: Autopsy report round trip**
    - **Validates: Requirements 11.9**

  - [ ]* 4.4 Write property test for ordered, exhaustive Autopsy rejection
    - **Property 19: Autopsy rejection is ordered and exhaustive**
    - **Validates: Requirements 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.10**

- [ ] 5. Entry input validation
  - [ ] 5.1 Implement `inputs.ts`
    - Implement `validateInput` collecting every missing field (`MISSING_INPUT`) or every invalid field (`INVALID_INPUT`) in one error: contract name 1..128 chars, boolean optimizer, optimizer runs 0..4294967295 only when enabled, sources non-empty and at most 1 MiB, solc version `0.x.y` with minor below 8, `0x` runtime code.
    - _Requirements: 1.12, 12.4, 12.5_

  - [ ]* 5.2 Write property test for input validation
    - **Property 3: Input validation names every bad input and writes nothing**
    - **Validates: Requirements 1.12, 12.4, 12.5**

- [ ] 6. Classifier and taint
  - [ ] 6.1 Implement `classify.ts`
    - Implement `classify` per the decision table (including the exact 36-byte `Panic(0x11)` check and `invalidRecord` for malformed input), `classifyConstructors`, and log normalisation with the `SELF` emitter sentinel and empty logs for reverted calls.
    - _Requirements: 2.6, 2.7, 3.8, 3.9, 3.10, 3.11, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10_

  - [ ] 6.2 Create the shared classification vectors
    - Write `engine/test/vectors/classification.json` covering every row of the decision table, empty versus non-empty revert data, a single differing `allowed` value, and malformed records. A vitest example test runs them against `classify`.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 10.5_

  - [ ] 6.3 Write property test for the decision table
    - **Property 8: Classification follows the decision table**
    - **Validates: Requirements 3.4, 3.8, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 10.5**

  - [ ]* 6.4 Write property test for purity and malformed records
    - **Property 9: Classification is pure and rejects malformed records**
    - **Validates: Requirements 4.9, 4.10**

  - [ ]* 6.5 Write property test for constructor outcomes
    - **Property 10: Constructor outcome classification**
    - **Validates: Requirements 2.6, 2.7**

  - [ ]* 6.6 Write property test for log normalisation
    - **Property 7: Log normalisation and comparison**
    - **Validates: Requirements 3.9, 3.10, 3.11**

  - [ ] 6.7 Implement `taint.ts`
    - Implement `computeTaint(sequence, setupDiverged)` and `verifyTaint(records)`, which returns `SEANCE_FAILED` naming the first record whose `afterDivergence` differs from the recomputed value.
    - _Requirements: 5.5, 8.4_

  - [ ] 6.8 Write property test for divergence taint and finding selection
    - **Property 12: Divergence taint flags later records and excludes them from findings**
    - Includes the `selectFindingPairs` checks, so this test runs after task 9.2.
    - **Validates: Requirements 5.5, 8.4**

- [ ] 7. Targeted-value input generator
  - [ ] 7.1 Implement `input-generator.ts`
    - Implement `generateTargets` with the rules table (`x * k`, `a + b`, `a - b`, `x * y`, `x ** y`, array length times value), narrower-type widths, ParamSlot computation (`static` and `dynamicArrayLength`), paired assignments in one entry, seed sequences of at most 10 calls, and `unreachable` sites. Cap entries at 64 per site. Use `bigint` throughout.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.10, 6.11, 6.12_

  - [ ] 7.2 Write property test for multiplication targets
    - **Property 13: Multiplication targets overflow and wrap**
    - **Validates: Requirements 6.2, 6.6, 6.13**

  - [ ] 7.3 Write property test for array-length-times-value pairs
    - **Property 16: Array length times value pairs overflow and wrap**
    - **Validates: Requirements 6.8, 6.14**

  - [ ]* 7.4 Write property test for entry bounds and slots
    - **Property 17: Every site gets bounded entries with correct slots, paired values stay together**
    - **Validates: Requirements 6.1, 6.7, 6.8, 6.10, 6.11, 6.12**

  - [ ]* 7.5 Write property tests for addition, subtraction, and unknown-operand targets
    - **Property 14: Addition and subtraction targets are windows around the boundary**
    - **Property 15: Unknown-operand multiplication pairs overflow and wrap**
    - **Validates: Requirements 6.3, 6.4, 6.5, 6.6**

- [ ] 8. Project generator and Solidity templates
  - [ ] 8.1 Implement `forge-std-pin.ts` and `foundry-config.ts`
    - Export `FORGE_STD_PIN`, `INVARIANT_RUNS = 256`, `INVARIANT_DEPTH = 64`, the `remappings.txt` text, and the `allow_paths` text. `foundry-config.ts` renders `foundry.toml` (port solc 0.8.x, `compilation_restrictions` for legacy files, legacy optimizer profile, `fs_permissions`, `gas_limit`, `[invariant]`). Adjust to any change recorded by task 1.
    - _Requirements: 1.2, 1.3, 1.4, 1.5_

  - [ ] 8.2 Write `templates/Classifier.sol`
    - Solidity mirror of `classify`, including the `Panic(0x11)` check, deterministic and pure.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9_

  - [ ] 8.3 Write `templates/Handler.sol`
    - Implement the `DifferentialHandler` template: Actor_Set with the deployer, `_addr`, `init` (deploy by artifact name with identical constructor args and funding, constructor outcome classification, token shares, seed sequences), `_pickTarget`, typed handler functions per the parameter mapping table, fallback handlers, `_differential` (stopped check, `idx`-derived warp and roll, `vm.deal` before each side for payable calls, capped `call` and `staticcall`, classification, taint, JSONL record), `setOutputPath`, `setWitness`, and Observable_State reading including address-keyed mapping getters.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.5, 3.6, 3.7, 3.8, 5.1, 5.3, 5.5, 6.9, 10.4_

  - [ ] 8.4 Write `templates/Seance.t.sol`, `Witness.t.sol`, and `Replay.t.sol`
    - `SeanceDiscovery` with the single `invariant_discovery`; `Witness1..10` with `invariant_witness`; `SeanceReplay1..10` each with its own output path and `test_replay`.
    - _Requirements: 2.4, 3.1, 8.1, 8.2_

  - [ ] 8.5 Implement `project-generator.ts`
    - Implement `generateProject` (pure and deterministic, sorted paths, LF newlines, `Targets.sol` constants, no `lib/`) and `writeProject` (validate first, then write; no files for invalid input). Also expose a function that regenerates only `Replay.t.sol` from shrunk calldata.
    - _Requirements: 1.1, 1.2, 1.5, 1.6, 1.7, 1.12, 1.13_

  - [ ]* 8.6 Write property tests for determinism and layout
    - **Property 1: Project generation is deterministic**
    - **Property 2: Generated project layout, foundry.toml, and artifact names**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 1.13**
    - Add a `foundry.toml` fixture check to Property 2. For every generated project, parse the `compilation_restrictions` entries from the emitted `foundry.toml` and assert that each legacy restriction's version is exactly `=<legacy version>` (for example `=0.4.19`), with the leading `=` and no range operators, and that the port solc is an exact 0.8.x version (`0.8.<patch>`, no `^`, `~`, `>=`, or range). A bare version such as `0.4.19` in `compilation_restrictions` fails the check.
    - Add a negative fixture: a stored `foundry.toml` whose legacy restriction is a bare `0.4.19`. The check must reject it. A second negative test passes a legacy version to the renderer from task 8.1 and asserts the output never contains a bare `0.4.19` restriction, so the generator cannot emit one.
    - Run the check natively with forge 1.5.1 on the generated fixture project too: `forge build` must resolve the legacy file to solc 0.4.19 with the `=0.4.19` form.
    - _Requirements: 1.3, 1.4_

  - [ ]* 8.7 Write property tests for handler coverage and target-only fuzzing
    - **Property 5: Handler coverage and parameter mapping match the ABI**
    - **Property 6: The discovery test targets only the handler**
    - **Validates: Requirements 2.4, 3.1, 3.3, 10.4**

  - [ ] 8.8 Write the required forge tests: classifier vectors and the legacy assert gas cap
    - Run natively with forge 1.5.1 and in the Docker image.
    - `Classifier.sol` against the shared vectors in `engine/test/vectors/classification.json`, so the Solidity classifier matches the TypeScript one.
    - A fixture whose legacy contract hits an `assert` (invalid opcode) returns control to the handler within `GAS_CAP`, the handler records the call, and the séance continues.
    - _Requirements: 3.7, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.9_

  - [ ]* 8.9 Write the remaining forge tests for the templates
    - `_pickTarget` with fixed picks; the payable-fixture sender balance check; `_addr` and the `address[]` builder; handler fixtures for identical constructor args, one record per deployment, reverts recorded, no calls after `stopped`, and `afterDivergence` set only after the first `port-bug`.
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 3.1, 3.2, 3.5, 5.4, 5.5, 6.9_

- [ ] 9. Report builder
  - [ ] 9.1 Implement record parsing, grouping, and counts in `report.ts`
    - `parseRecords` assigns 1-based ordinals from line order, discards a truncated last line, assigns `fuzzOrdinal` only to `idx >= 0`. Group sequences by `idx == 0`, group setup records by `idx == -1`, drop records after an `exorcised` record, record `exorcisedAtIndex`, count all four Classifications including tainted records.
    - Keep the first `INVARIANT_RUNS` sequences, counted by `idx == 0` starts. Treat any later lines as Foundry's post-campaign replay of the final run. Verify they form exactly one sequence identical to the last kept sequence (calldata, sender, results, flags), and fail with `SEANCE_FAILED` naming the first difference if not. The replay lines are not counted. A discovery run killed by timeout has no replay, so partial counts are unaffected.
    - _Requirements: 5.1, 5.2, 5.3, 5.6, 7.3, 7.10_

  - [ ] 9.2 Implement finding selection and dispositions in `report.ts`
    - `selectFindingPairs` (first untainted record per pair, setup pairs separate, `exorcised` before `port-bug`, cap 10), `assignDispositions`, and `chooseReported`.
    - _Requirements: 7.12, 8.1, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8_

  - [ ] 9.3 Implement report construction, validation, and writing in `report.ts`
    - `buildReport` (including `taintedCalls`, `setupCalls`, `sequenceResults`, `shrinking`, `unreachableSites`, site attribution through ParamSlots with the `unattributed` marker, both Call_Records for port bugs), `validateReport`, canonical `serializeReport` and `parseReport`, and `writeReportAtomic` via temp file and rename with `REPORT_WRITE_FAILED`.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.12_

  - [ ] 9.4 Write property test for exorcism truncation
    - **Property 11: Exorcism truncates a sequence**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.5, 5.6**

  - [ ]* 9.5 Write property test for counts and ordinals
    - **Property 21: Report counts are complete and consistent, ordinals follow line order**
    - The record-stream generator appends a replay tail (a copy of the last sequence) after the first `INVARIANT_RUNS` sequences, and the test checks that counts and ordinals ignore the tail. Add a tampered-tail case (one changed calldata, sender, result, or flag, or a wrong tail length) that must fail with `SEANCE_FAILED` naming the first difference. Add a no-tail case (timeout-killed discovery) that leaves partial counts unchanged.
    - Property 21 in `design.md` does not yet describe the replay tail. Update the property text there, and the property name if it changes, before running this task.
    - **Validates: Requirements 7.3, 7.4, 7.7, 7.10, 12.2**

  - [ ] 9.6 Write property test for finding selection and fallback
    - **Property 22: One finding per function and class, cap, and unshrunk fallback**
    - **Validates: Requirements 7.12, 8.1, 8.3, 8.4, 8.5, 8.6, 8.7**

  - [ ]* 9.7 Write property test for the report round trip
    - **Property 20: Report round trip and schema validity**
    - **Validates: Requirements 7.8, 7.9**

  - [ ]* 9.8 Write property test for dispositions under a deadline
    - **Property 26: A deadline in witness or replay leaves pairs unshrunk and never fails the run**
    - **Validates: Requirements 7.12, 8.1, 8.3, 8.5, 8.6, 8.7, 12.11**

- [ ] 10. Runner
  - [ ] 10.1 Implement deadline and forge arguments in `runner.ts`
    - `makeDeadline`, `phaseBudgetMs`, and `buildForgeArgs` for discovery, witness k, and replay k, with anchored `--match-contract` regexes, the unchanged `--fuzz-seed`, and the `SEANCE_RECORD` environment.
    - _Requirements: 12.7, 12.12_

  - [ ] 10.2 Implement `foundry-json.ts`
    - `parseCounterexample(json)` iterates the `"<file>:<contract>"` keys and their `test_results`, reads the ordered handler calls from `counterexample.Sequence[1]`, keeps `Sequence[0]` as `originalLength`, and treats `counterexample: null` as no counterexample. Never parse text output.
    - The runner never reuses a project directory. Each séance generates a fresh temp project, because forge replays saved failures from `cache/invariant`.
    - The unit test uses the saved fixtures `engine/test/fixtures/forge-json/failing.json` and `passing.json` from task 1.4.
    - _Requirements: 8.1, 8.2_

  - [ ] 10.3 Implement the solc and bytecode checks
    - A solc-presence check (`SOLC_MISSING` before any build) and a runtime-code comparison that strips the Metadata_Suffix from both sides (`BYTECODE_MISMATCH` reporting both hashes). Put them in `bytecode.ts`.
    - _Requirements: 1.8, 1.9, 1.10_

  - [ ] 10.4 Implement run orchestration in `runner.ts`
    - Run `forge build` (`BUILD_FAILED` with full output and failing files), the bytecode check, discovery, `verifyTaint`, finding selection, per-pair witness campaigns, regeneration of `Replay.t.sol`, per-pair replay, and report building. Share one deadline with SIGTERM then SIGKILL kills. Deadline during build or discovery gives `TIMEOUT` with `phase` (and `partialCounts` for discovery). Deadline during witness or replay marks pairs `deadline` and still writes the report. Map a failed `invariant_discovery` to `HANDLER_FAULT` with partial counts minus the last sequence. Remove the temp project on success and keep it on failure.
    - _Requirements: 1.6, 1.8, 1.9, 1.10, 1.11, 8.1, 8.2, 8.3, 8.5, 8.6, 8.7, 12.8, 12.9, 12.10, 12.11_

  - [ ]* 10.5 Write property test for seed pass-through
    - **Property 24: Fuzz seed is passed through unchanged**
    - **Validates: Requirements 12.12**

  - [ ]* 10.6 Write property test for the shared deadline
    - **Property 25: One shared deadline bounds build and all phases**
    - **Validates: Requirements 12.7, 12.8, 12.9, 12.10, 12.11**

  - [ ]* 10.7 Write property test for the metadata-stripping comparison
    - **Property 4: Runtime bytecode comparison ignores only the metadata suffix**
    - **Validates: Requirements 1.8**

  - [ ]* 10.8 Write unit tests for `parseCounterexample` and forge arguments
    - Use the failing and passing JSON fixtures, and check that `Witness1` does not select `Witness10`.
    - _Requirements: 8.1, 8.7_

- [ ] 11. Entry point and CLI
  - [ ] 11.1 Implement `entry.ts`
    - `runSeance(input, opts)` validates input, parses the Autopsy report, generates targets and the project, runs the Runner, writes `graveyard/<name>/seance-report.json`, and returns the report or rejects with a `SeanceError`. Wrap unexpected failures as `SEANCE_FAILED`.
    - _Requirements: 12.1, 12.2, 12.4, 12.5, 12.6, 12.7_

  - [ ] 11.2 Implement the CLI binary
    - Read inputs from arguments or a JSON file, print the report or structured error as JSON, and exit 0 on success and non-zero on any error.
    - _Requirements: 12.3, 12.4, 12.5, 12.6_

  - [ ]* 11.3 Write unit tests for the Entry_Point with a mocked runner
    - Cover `MISSING_INPUT`, `INVALID_INPUT`, `AUTOPSY_REJECTED`, `SOLC_MISSING` with no build, `BUILD_FAILED`, `BYTECODE_MISMATCH` stopping before discovery, default timeout of 300 s, `HANDLER_FAULT`, `REPORT_WRITE_FAILED` leaving an existing report unchanged, and CLI exit codes.
    - _Requirements: 1.9, 1.10, 1.11, 7.2, 12.3, 12.4, 12.5, 12.6, 12.7_

- [ ] 12. Checkpoint - Core path complete
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 13. BEC end-to-end acceptance
  - [ ] 13.0 Hand-write the golden BEC port and the BEC Autopsy report
    - Depends on: the legacy BEC source in the `graveyard/bec/` entry, and tasks 4.1 and 4.2 (the Autopsy schema and parser).
    - Read the legacy BEC source from the existing `graveyard/bec/` entry (solc 0.4.19, optimizer off). Fetching it (Sourcify first, Etherscan second) is the fetcher's concern and not part of this task. If the `graveyard/bec/` source or metadata is missing, say so and ask the user before continuing.
    - Write `graveyard/bec/port.golden.sol`, a hand-made Solidity 0.8 port of BEC with no logic changes, applying the workspace rewrite rules: SafeMath calls become checked operators (R1), the contract-named constructor becomes `constructor` (R2), `abstract`, `virtual`, and `override` follow real C3 linearization semantics and are not guessed by pattern (R3), arrays in external functions become `calldata` (R4), `constant` functions become `view` (R5), event calls become `emit` (R6), and `function ()` becomes `fallback()` (R7). Keep the contract name `BecToken` as in the legacy source, so artifact names match. Bug fixes come only from 0.8's built-in checks.
    - Write `graveyard/bec/autopsy.json`, listing the unchecked arithmetic sites of the legacy BEC source by hand, including `batchTransfer`'s `cnt * _value` as an `arrayLength` operand times a `param` operand (both uint256, with the `_receivers` array length site), and the other `+`, `-`, and `*` sites in `transfer`, `transferFrom`, and the other functions, each with site id, function, operator, operands with types, and source location. Set `schemaVersion` to `"1"` and conform to `schemas/autopsy-v1.schema.json`. Include precondition hints where a site needs a balance or an `approve`.
    - Check `autopsy.json` with `parseAutopsyReport` from task 4.2 against the legacy BEC ABI, and check that `port.golden.sol` compiles with solc 0.8.x in `forge build`.
    - Note: the future Resurrection spec will use `graveyard/bec/port.golden.sol` as its expected output. Do not change it later to make the Resurrection output match without a recorded reason.
    - _Requirements: 9.1, 11.1, 11.5, 11.6, 11.8_

  - [ ] 13.1 Add BEC inputs under `graveyard/bec/`
    - Depends on: 13.0.
    - Use the legacy BEC source from the `graveyard/bec/` entry (solc 0.4.19, optimizer off), `graveyard/bec/port.golden.sol` as the Port_Contract, `graveyard/bec/autopsy.json` as the Autopsy_Report, and the mainnet runtime code for `0xC5d105E63711398aF9bbff092d4B6769C82F793D`. Do not wait for the Resurrection stage.
    - Add the loader that assembles these four inputs into a `SeanceInput` for the acceptance run. If the runtime code is not yet stored in the entry, say so and ask the user for it.
    - _Requirements: 9.1_

  - [ ] 13.2 Implement `acceptance.ts`
    - Wrap `runSeance` and check: an `exorcised` finding in `batchTransfer`, zero `port-bug` counts, first exorcism `fuzzOrdinal` at most 2,000, shrunk `_receivers` length 2 to 20 with `length * _value >= 2^256` and wrapped product at most the sender's legacy balance, and replay-confirmed (not `unshrunk`). On failure return `ACCEPTANCE_FAILED` naming the condition or `unshrunkReason`, and do not overwrite `graveyard/bec/seance-report.json`.
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.7, 9.8_

  - [ ] 13.3 Run the BEC acceptance in Docker
    - Run the CLI on BEC in the linux/amd64 image: generate project, build, bytecode check, discovery, witness shrinking, replay, report written. Assert the report is stored in `graveyard/bec/`, `setupCalls` equals actor count minus one plus seed calls, and the `batchTransfer` finding is shrunk with zero port bugs. If it fails, fix the cause or apply the design adjustment from task 1.
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 12.1_

  - [ ]* 13.4 Add a same-seed determinism integration test
    - Run BEC twice with the same seed and compare counts, total calls, and runs.
    - _Requirements: 7.11, 12.12_

- [ ] 14. Checkpoint - BEC acceptance passes
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 15. Planted port bug acceptance
  - [ ] 15.1 Add the Planted_Port_Bug fixture and acceptance check
    - Create a test fixture that edits `graveyard/bec/port.golden.sol` with a string-level change so `transferFrom` does not decrement the allowance. Extend `acceptance.ts` to require at least one `port-bug` attributed to `transferFrom`, zero `match` for the triggering inputs, and return a non-zero failure when none is reported. Make sure the Input_Generator emits the `approve` seed.
    - _Requirements: 10.1, 10.2, 10.4, 10.5, 10.6_

  - [ ] 15.2 Run the planted-bug integration test in Docker
    - Assert a shrunk, replay-confirmed `transferFrom` finding with at most 3 preceding calls.
    - _Requirements: 10.1, 10.2, 10.3_

- [ ] 16. Dropped-emit mutation acceptance
  - [ ]* 16.1 Add the Dropped_Emit_Mutation fixture and acceptance check
    - Create a fixture that removes the `Transfer` emit from the port's `transfer` path. Extend `acceptance.ts` to require a `port-bug` for `transfer` with `unshrunkReason: "setup"`, Event_Logs among the differing fields, and both Event_Logs lists reported. Do not require a shrunk finding.
    - _Requirements: 10.7, 10.8_

  - [ ]* 16.2 Run the dropped-emit integration test in Docker
    - Assert the setup finding, that phases 2 and 3 launched no process for it, and that every fuzz record carries `afterDivergence = true`.
    - _Requirements: 5.5, 8.5, 10.7_

- [ ] 17. Timeout and deadline edge cases
  - [ ]* 17.1 Write mock-runner tests for a build timeout
    - A deadline during `forge build` gives `TIMEOUT` with `phase: "build"`, no `partialCounts`, no report, and no discovery process. A zero budget launches no process. A slow build leaves discovery only the remainder.
    - _Requirements: 12.8, 12.9_

  - [ ]* 17.2 Write tests for discovery timeout and partial counts
    - A deadline during discovery gives `TIMEOUT` with `phase: "discovery"` and partial counts from complete lines. Include a handler fault test with the last sequence removed.
    - **Property 23: Partial counts on discovery timeout and handler fault, none on build timeout**
    - **Validates: Requirements 12.8, 12.9, 12.10**

  - [ ]* 17.3 Write witness and replay deadline tests
    - With a mocked runner: a deadline during witness and one during replay each give a written report, exit 0, `deadlineReached = true`, and `unshrunkReason: "deadline"` for unfinished pairs, while finished pairs stay shrunk. A zero budget before the witness phase launches no process. In Docker, check a real kill stops `forge` within 5 s.
    - _Requirements: 8.1, 12.8, 12.11_

- [ ] 18. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP. Task 1 (risk verification, native and Docker), task 13 (BEC end to end), and task 15 (planted port bug) are required. Tasks 16 and 17 are optional.
- Required property tests: Properties 8, 11, 12, 13, 16, and 22. Required forge tests: the classifier vectors and the legacy assert gas cap (8.8). Properties 14 and 15 (7.5) and the other forge tests (8.9) are optional.
- Task 1 runs before any TypeScript. Each risk script runs natively with forge 1.5.1 on macOS arm64 first and in Docker second. A FAIL or a native/Docker disagreement means the design is adjusted first, and affected later tasks are updated. Docker timings on Apple Silicon are emulated and not representative.
- `graveyard/bec/port.golden.sol` is hand-made and is the expected output for the future Resurrection spec.
- Each task references requirements by their numbers in `requirements.md`, and property tests reference the property numbers in `design.md`.
- Property tests validate universal correctness properties. Unit tests and forge tests cover specific examples and edge cases.
- Tasks that write to `report.ts` and `runner.ts` run in separate waves to avoid file conflicts.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "1.8", "1.9"] },
    { "id": 2, "tasks": ["1.10"] },
    { "id": 3, "tasks": ["2"] },
    { "id": 4, "tasks": ["3.1"] },
    { "id": 5, "tasks": ["3.2"] },
    { "id": 6, "tasks": ["4.1", "5.1", "6.1", "6.7", "7.1", "8.1", "10.1", "10.2"] },
    { "id": 7, "tasks": ["4.2", "5.2", "6.2", "6.3", "6.4", "6.5", "6.6", "7.2", "7.3", "7.4", "9.1", "10.3", "10.5", "10.6", "10.8"] },
    { "id": 8, "tasks": ["4.3", "4.4", "7.5", "8.2", "8.3", "8.4", "9.2", "9.4", "10.7", "13.0"] },
    { "id": 9, "tasks": ["6.8", "8.5", "9.3", "9.6", "9.8"] },
    { "id": 10, "tasks": ["8.6", "8.7", "8.8", "8.9", "9.5", "9.7", "10.4"] },
    { "id": 11, "tasks": ["11.1"] },
    { "id": 12, "tasks": ["11.2", "11.3"] },
    { "id": 13, "tasks": ["12"] },
    { "id": 14, "tasks": ["13.1", "13.2"] },
    { "id": 15, "tasks": ["13.3"] },
    { "id": 16, "tasks": ["13.4"] },
    { "id": 17, "tasks": ["14"] },
    { "id": 18, "tasks": ["15.1", "16.1", "17.1", "17.2"] },
    { "id": 19, "tasks": ["15.2", "16.2", "17.3"] },
    { "id": 20, "tasks": ["18"] }
  ]
}
```
