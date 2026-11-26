# Implementation Plan: Séance Engine

## Overview

The plan is in four parts. First, an integration task checks every Known risk in the design before any TypeScript exists. Each risk script runs twice: natively with the local Foundry 1.5.1 on macOS arm64 (first run), then in the linux/amd64 Docker image (second run). Second, the core path is built in this order: types and schemas, classifier, input generator, project generator and templates, report builder, runner, entry point and CLI. Third, the BEC acceptance run proves the path end to end (project generation, build, bytecode check, discovery, witness shrinking, replay, report written, exorcism in `batchTransfer`, zero port bugs). It uses a hand-made golden port and a hand-written Autopsy report for BEC (task 13.0). Fourth, the planted-bug acceptance run is required, and the dropped-emit mutation run and the timeout and deadline edge-case tests are optional.

Implementation language is TypeScript (strict, Node 24, pnpm workspace, vitest, fast-check). The design says Node 22. The user decided on Node 24 (`">=24 <25"`) everywhere, and this plan follows that decision. Generated Solidity is tested with Foundry in the linux/amd64 Docker image.

The design's Known risks section lists eight bullets, not five. Sub-tasks 1.2 to 1.9 cover all eight, one each, in the order the design lists them.

## Tasks

- [x] 1. Docker integration test: verify the design's Known risks before writing any TypeScript
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
      - native (forge 1.5.1, macOS arm64): PASS with a design change (corrected script). `vm.writeLine` works in invariant runs with the scoped `fs_permissions`, with no permission error. 16,448 lines for runs=256 depth=64 = 16,384 campaign lines + one identical 64-line replay of the final run. `idx == 0` starts: 257 (256 + 1 replay); last campaign sequence at line 16,321, trailing replay at line 16,385, first difference: none (identical line for line). All 3 writes outside `./seance-out` (sibling file, `..` traversal, `src/injected.txt`) were rejected, and no file was created outside `./seance-out`. Invariant result: `[PASS] invariant_always_true() (runs: 256, calls: 16384, reverts: 0)`, 1.09 s. An earlier probe with runs=10 depth=5 gave 55 lines (50 + 5).
      - docker (linux/amd64, forge 1.5.1): PENDING (deferred; Docker Desktop paused). The earlier Docker file `findings/1.2.docker.md` predates the corrected criterion and is stale; it is not a result.
      - Design change: keep `vm.writeLine` and do not switch to buffered `vm.writeFile`. Handler storage resets every run, so a buffer would not remove the duplicate run. The Report_Builder keeps the first `INVARIANT_RUNS` sequences (counted by `idx == 0` starts), verifies that the remaining lines form exactly one sequence identical to the last kept sequence, and fails with `SEANCE_FAILED` naming the first difference otherwise. Affects tasks 9.1, 9.5, and 10.4.
      - Follow-up: the script and `findings/1.2.native.md` now apply the corrected criterion (native run recorded above). `findings/1.2.docker.md` and `findings/1.2-writeline.docker.md` are stale until the Docker pass.
    - _Requirements: 3.2, 7.1_

  - [x] 1.3 Risk 2: handler storage reverts per invariant run and `setUp` runs once per forge process
    - PASS: a counter in handler storage restarts at its post-`setUp` value at the start of every run (the first call of each run sees `idx == 0`), and a setup-time marker line is written exactly once in the whole process.
    - FAIL consequence: the `idx == 0` sequence boundary and the once-per-process setup records need a different mechanism. Update decisions 4 and 10 in the design.
    - Findings:
      - native (forge 1.5.1, macOS arm64): PASS. 16,449 lines in `seance-out/records.jsonl`: 1 setup marker (idx == -1, first line, count 1 in the whole process) + 16,384 campaign lines + 64 trailing replay lines. Campaign: 256 sequence starts (`idx == 0`), 0 lines where `idx != position mod 64`, max idx 63, 256 distinct sequences. The trailing 64 lines are one sequence starting at idx 0, byte-identical to the last campaign sequence, with the marker count still 1 and the file not truncated, so the replay did not re-run `setUp`; it ran from restored post-setUp handler storage. `[PASS] invariant_always_true() (runs: 256, calls: 16384, reverts: 0)`, 1.01 s. Design change needed: none (confirms decision 13's trailing replay).
      - docker (linux/amd64, forge 1.5.1): PENDING (deferred; Docker Desktop paused).
    - _Requirements: 5.4, 5.5_

  - [x] 1.4 Risk 3: `forge test --json` exposes the failed invariant's `counterexample` as a handler-call list
    - Run a failing `invariant_witness` fixture and a passing one with the pinned Foundry version.
    - PASS: the result is found by iterating the `"<file>:<contract>"` keys of the top-level JSON and the `test_results` under each. For the failing run, the calls are in `counterexample.Sequence[1]`, an ordered list where each call has a sender, hex calldata, and call details. `Sequence[0]` is the pre-shrink length, which the parser records as `originalLength`. For the passing run, `counterexample` is `null`, which means no counterexample.
    - Save both JSON outputs from the native run as fixtures at `engine/test/fixtures/forge-json/failing.json` and `passing.json`. The Docker run's JSON is compared with them for shape only (same keys and nesting), not saved as fixtures.
    - Fresh directory per run: forge replays saved failures from `cache/invariant`, so the script must copy the fixture into a fresh scratch directory on every run, native and Docker. The script may include a negative check that reuses a directory and shows the cached failure being replayed.
    - Shape only: the Docker JSON is compared with the native fixtures for shape (same keys, and the same structure of `counterexample.Sequence[1]`: ordered calls with `sender`, `calldata`, and the other per-call keys). Shrunk sequences are not compared. They are expected to differ, because forge 1.5.1's fuzzer is not reproducible from a seed (see 1.11).
    - FAIL consequence: rewrite the `foundry-json.ts` contract in the design to match the real shape.
    - Findings:
      - native (forge 1.5.1, macOS arm64): PASS with a wording-level design change. Failing run exit 1, passing run exit 0, each stdout a single JSON document. Result is at `.["<file>:<contract>"].test_results["invariant_witness()"]`. Failing: status `Failure`, `counterexample` is an object `{"Sequence": [15, [<call>, <call>]]}`, not a bare list. `Sequence[0]` = 15 (pre-shrink length), `Sequence[1]` has 2 calls (`arm(uint256)` then `fire(uint256)`), each with keys `addr, args, calldata, contract_name, func_name, raw_args, sender, signature`, hex calldata and 20-byte sender. Passing: status `Success`, `counterexample` is JSON `null` (key present). Negative check: reusing a directory replayed the cached failure from `cache/invariant` (identical shrunk calls with a different seed) and `Sequence[0]` became 2 (the shrunk length) and `reason` changed, so a fresh directory per séance is required. Fixtures written to `engine/test/fixtures/forge-json/{failing,passing}.json`. Seed 0x1badc0de; shrunk sequence saved to `findings/1.4.native.sequence.json`.
      - docker (linux/amd64, forge 1.5.1): PENDING (deferred; Docker Desktop paused). The Docker run compares its JSON with the native fixtures for shape only (see Pending Docker runs). `findings/1.4.docker.md` and `findings/1.4-counterexample.docker.md` predate the changed criteria and are stale.
    - _Requirements: 8.1, 8.2_

  - [x] 1.5 Risk 4: per-file legacy optimizer profile and `vm.deployCode` name resolution
    - Build the fixture with `compilation_restrictions` pinning `src/legacy/LegacyToken.sol` to 0.4.19 with the optimizer disabled, and the port in `src/port/PortToken.sol` with the same contract name, with `additional_compiler_profiles` for the optimizer.
    - PASS: one `forge build` produces both artifacts. `vm.deployCode("LegacyToken.sol:Token")` and `vm.deployCode("PortToken.sol:Token")` deploy different runtime code. Repeat with the legacy optimizer enabled at runs 200 and check the legacy runtime code differs from the optimizer-off build.
    - FAIL consequence: change the artifact naming or profile scheme in the design (decision 9, `foundry.toml` section).
    - Findings:
      - native (forge 1.5.1, macOS arm64): PASS with a design change to the `foundry.toml` scheme. One `forge build` (rc 0) produced both artifacts in all three builds. OFF: legacy compiled with `0.4.19+commit.c4cbbb05`, optimizer `{"enabled":false,"runs":1}`; port `0.8.28+commit.7893614a`, optimizer off. `vm.deployCode("LegacyToken.sol:Token")` and `vm.deployCode("PortToken.sol:Token")` deploy different code (keccak legacy `0xe370a85d...7d1c`, port `0x6a27b612...0b86`), and each equals `vm.getDeployedCode` of its own artifact. ON (`min_optimizer_runs = 200`): legacy optimizer `{"enabled":true,"runs":200}`, port still off, legacy code differs from OFF (`0xc5bc8db6...0e`). BOTH: port optimizer also on; legacy code identical to ON. Restriction keys `settings`, `profile`, `optimizer` were silently ignored (legacy stayed `enabled:false`, rc 0). A top-level `solc = "0.8.28"` with the legacy restriction fails the build (rc 1, no solc matches `^0.4.19, =0.4.19`). Working snippet (exact, from `findings/1.5.native.md`; the `allow_paths` value is the local forge-std checkout):
```toml
[profile.default]
src = "src"
out = "out"
allow_paths = ["/Users/chinedum/Desktop/my_projects/personal_projects/web3/exhume/engine/test/docker/.cache/forge-std"]
fs_permissions = [{ access = "read", path = "./out" }, { access = "read-write", path = "./seance-out" }]
optimizer = false
optimizer_runs = 1

additional_compiler_profiles = [{ name = "legacy_opt", optimizer = true, optimizer_runs = 200 }]
compilation_restrictions = [
  { paths = "src/legacy/LegacyToken.sol", version = "=0.4.19", min_optimizer_runs = 200 },
  { paths = "src/port/PortToken.sol", version = "=0.8.28" },
]
```
      - docker (linux/amd64, forge 1.5.1): PENDING (deferred; Docker Desktop paused).
    - _Requirements: 1.2, 1.3, 1.4, 1.6, 1.7_

  - [x] 1.6 Risk 5: artifact path layout for the bytecode check
    - PASS: `out/LegacyToken.sol/Token.json` exists after `forge build` and its `deployedBytecode.object` is readable, and a Metadata_Suffix strip (CBOR length in the last two bytes) of that code equals the stripped on-chain code for the fixture.
    - FAIL consequence: update the artifact path the Runner reads.
    - Findings:
      - native (forge 1.5.1, macOS arm64): PASS, no path change. `out/LegacyToken.sol/Token.json` exists and `deployedBytecode.object` is readable (0x-prefixed, 1,454 hex chars); `out/PortToken.sol/Token.json` exists. Stripped artifact code equals stripped on-chain code via `vm.deployCode`, `vm.getDeployedCode` and a raw `CREATE` of the creation code (unstripped also equal, since same compile). Suffix: solc 0.4.19 ends `0029` (41), total suffix 43 bytes, starts `a165627a7a72305820` (bzzr0); solc 0.8.28 ends `0033` (51), total suffix 53 bytes, contains `ipfs` and `solc` keys. Negative checks: a changed body byte fails the stripped comparison; a changed metadata-hash byte passes it. `linkReferences` is `{}` and `immutableReferences` is `null` in both artifacts. The Runner reads `deployedBytecode.object`, not `bytecode.object`.
      - docker (linux/amd64, forge 1.5.1): PENDING (deferred; Docker Desktop paused).
    - _Requirements: 1.8, 1.9_

  - [x] 1.7 Risk 6: pinned forge-std resolves through `remappings.txt` and `allow_paths`
    - Generate the minimal project with `remappings.txt` containing `forge-std/=/opt/forge-std/src/` and `allow_paths = ["/opt/forge-std"]`, no `lib/` directory, and no network.
    - PASS: `forge build` succeeds offline, and the checkout at `/opt/forge-std` matches `FORGE_STD_PIN`.
    - FAIL consequence: change decision 11 (vendoring scheme).
    - Findings:
      - native (forge 1.5.1, macOS arm64): PASS, with a generator addition on top of the 1.5 scheme. forge-std HEAD `1eea5bae12ae557d589f9f0f0edae2faa47cb262` equals `v1.9.4^{commit}` (matches `FORGE_STD_PIN` prefix `1eea5bae`), 0 modified files, no `lib/` directory. `forge build --offline` rc 0 and `forge test --offline --match-contract ImportsTest` rc 0 with `remappings.txt` and `allow_paths`; `Test`, `StdInvariant` and `Vm` all compiled with `0.8.28+commit.7893614a`. `--offline` is listed in `forge build --help` ("Do not access the network"), and a build needing the uninstalled `=0.8.31` fails with rc 1, so solc 0.4.19 and 0.8.28 must be pre-installed. A build without `--offline` but with a dead proxy also gave rc 0. Offline is not proven at OS level (no firewall or network namespace natively). Negative check: without `allow_paths`, the build still succeeded (rc 0), so `allow_paths` was not strictly required natively; it stays harmless and in the generated file. Without `remappings.txt` the build fails (rc 1, `forge-std/Test.sol` not found). Native has many 0.8.x installed (0.8.9 to 0.8.37), and forge still picked 0.8.28 for an unrestricted forge-std, but that depends on forge's grouping, so the generator adds explicit restrictions. A probe with `=0.8.30` on the forge-std and `test/**` paths was honoured (forge-std compiled with 0.8.30). Exact snippet (from `findings/1.7.native.md`; paths are the local forge-std checkout):
```toml
[profile.default]
src = "src"
out = "out"
allow_paths = ["/Users/chinedum/Desktop/my_projects/personal_projects/web3/exhume/engine/test/docker/.cache/forge-std"]
fs_permissions = [{ access = "read", path = "./out" }, { access = "read-write", path = "./seance-out" }]
optimizer = false
optimizer_runs = 1
additional_compiler_profiles = [{ name = "legacy_opt", optimizer = true, optimizer_runs = 200 }]
compilation_restrictions = [
  { paths = "src/legacy/LegacyToken.sol", version = "=0.4.19", min_optimizer_runs = 200 },
  { paths = "src/port/PortToken.sol", version = "=0.8.28" },
  { paths = "/Users/chinedum/Desktop/my_projects/personal_projects/web3/exhume/engine/test/docker/.cache/forge-std/src/**", version = "=0.8.28" },
  { paths = "test/**", version = "=0.8.28" },
]
```
        with `remappings.txt` containing `forge-std/=/Users/chinedum/Desktop/my_projects/personal_projects/web3/exhume/engine/test/docker/.cache/forge-std/src/`.
      - docker (linux/amd64, forge 1.5.1): PENDING (deferred; Docker Desktop paused). In Docker only solc 0.4.19 and 0.8.28 are installed and forge-std is at `/opt/forge-std`.
    - _Requirements: 1.6_

  - [x] 1.8 Risk 7: wall-clock time of discovery with recording on
    - Run a fixture handler with two capped low-level calls, two capped state reads, `vm.recordLogs`, and one `vm.writeLine` per call, at `runs = 256` and `depth = 64`.
    - PASS: record seconds per call and total seconds for both the native run and the Docker run, and the native total is under 150 s (half the 300 s default, leaving room for build, witness, and replay). Record both numbers either way.
    - The Docker timing on Apple Silicon is emulated (linux/amd64 under emulation) and is not representative. Record it, label it as emulated, and do not use it for the PASS decision.
    - FAIL consequence: apply the design's mitigations in order (raise the default timeout for graveyard runs, buffered writes, skip state reads for double reverts, lower `depth`) and update the design.
    - Findings:
      - native (forge 1.5.1, macOS arm64): PASS. Recording ON: 3.13 s total for runs=256 depth=64 (16,384 calls reported, 0.000191 s per call, 0 reverts), against the 150 s threshold. Recording OFF baseline: 1.21 s (0.000074 s per call). Recording overhead: 1.92 s, 0.000117 s per call. Cold build 0.73 s, warm build 0.12 s (excluded). Record file: 16,448 lines (= 16,384 + 64 replay), 16,106,159 bytes, 257 lines with idx 0; recording OFF created no file. Benchmark is worst case (does not stop after `exorcised`, so all depth lines are written): match=5,124, reason-modernised=68, exorcised=2,686, port-bug=8,570 (port-bug is expected once legacy balances wrap and the benchmark keeps going). The 64-call replay adds about 0.01 s (0.39% of executed calls). No wall-clock mitigation is needed natively.
      - docker (linux/amd64, forge 1.5.1): PENDING (deferred; Docker Desktop paused). When it runs, its timing will be labelled emulated on Apple Silicon and will not be used for the PASS decision.
    - _Requirements: 12.7, 12.8, 12.10_

  - [x] 1.9 Risk 8: witness campaign wall-clock time with recording off
    - Run one `invariant_witness` fixture campaign with default shrinking and `SEANCE_RECORD=0`.
    - PASS: record seconds per campaign for both the native run and the Docker run. The native estimate for 10 pairs plus replays fits in the remaining budget after discovery, or the design is updated to say that a deadline there is the expected case.
    - The Docker timing on Apple Silicon is emulated (linux/amd64 under emulation) and is not representative. Record it, label it as emulated, and do not use it for the PASS decision.
    - FAIL consequence: lower the `INVARIANT_RUNS` used by witness campaigns, or document the expected `deadline` outcome in the design.
    - Findings:
      - native (forge 1.5.1, macOS arm64): PASS. `SEANCE_RECORD=0`, runs=256 depth=64, forge default `shrink_run_limit` 5000. Campaign seconds (build excluded): early (any exorcised `batchTransfer`) 0.11 to 0.17 s, failing after 0 completed runs, shrunk to 1 call; rare (about 6e-4 per call) 0.17 to 0.18 s, failing after 1 to 12 runs, shrunk to 1 call; never (no input satisfies it) 1.25 to 1.27 s, runs all 256, no shrinking. Shrinking took about 0.02 s (early) and about 0.00 s (rare). Forge stops at the first failure. Replay with recording ON: 0.10 to 0.12 s. Estimate for 10 pairs: 10 x 1.27 s + 10 x 0.12 s = 13.90 s against 296.21 s remaining after discovery (3.13 s) and a 0.66 s cold build. It fits, so a deadline in the witness phase is not the expected case natively. Design change needed: none.
      - Surprise: a fixed `--fuzz-seed 42` did not always give the same campaign. With the shipped conditions, matching default and `shrink_run_limit=0` campaigns needed 1 attempt each, but with an earlier, rarer condition (about 1e-4 per call) one invocation failed at run 33 and the next invocations of the same command passed all 256 runs. Without `--fuzz-seed`, the rare campaign failed at runs 6, 7 and 1.
      - docker (linux/amd64, forge 1.5.1): PENDING (deferred; Docker Desktop paused). When it runs, its timing will be labelled emulated on Apple Silicon and will not be used for the PASS decision.
    - _Requirements: 8.1, 12.11_

  - [x] 1.10 Record findings in this file and flag design changes
    - Copy each sub-task's native result and Docker result into its Findings line above, as two separate entries labelled `native (forge 1.5.1, macOS arm64)` and `docker (linux/amd64, forge 1.5.1)`. For 1.8 and 1.9, include both timings, with the Docker timing labelled as emulated on Apple Silicon.
    - Treat a native/Docker disagreement (one PASS and one FAIL, or different observed values for the same check, other than timings) as a finding. List it with both observed values and the suspected cause.
    - For each FAIL and each disagreement, list the design change needed and which later tasks it affects, and stop to ask the user before continuing past checkpoint 2.
    - Status: only the native half is recorded. The Docker half is PENDING (deferred by the user's decision; Docker Desktop is paused). 1.10 is NOT fully resolved. Native result: no risk FAILED (1.2 to 1.9 all PASS). The design changes flagged below were reviewed by the user, and item (g) is resolved (decision recorded in (g)). Only the Docker pass remains pending. This task did not edit the design.
    - Design changes flagged for review (design.md and requirements.md not edited):
      - (a) 1.2 / decision 13 (already recorded in the design): `vm.writeLine` works, and the record file ends with one identical replay of the final run (16,448 lines for 256 x 64, 55 for 10 x 5). The native run of the corrected script confirms 16,448 lines, 257 `idx == 0` starts, an identical replay, and 3 rejected outside writes. Affects tasks 9.1, 9.5, and 10.4. 1.3 confirms the replay does not re-run `setUp` (the setup marker count stays 1).
      - (b) 1.4 / decisions 14 and 15 (already recorded in the design): `counterexample` is an object `{"Sequence": [originalLength, [calls...]]}`, so the parser reads `result.counterexample?.Sequence?.[1] ?? []` and must tolerate other enum variants of forge's `CounterExample` (only `Sequence` was observed). A passing run has `counterexample: null` (key present). Reusing a directory replays the cached failure and changes `Sequence[0]` from 15 to 2 (the shrunk length), so each séance needs a fresh directory.
      - (c) 1.5 / `foundry.toml` scheme (NOT yet in the design). Profiles are selected through `additional_compiler_profiles = [{ name = "legacy_opt", optimizer = true, optimizer_runs = 200 }]` plus `min_optimizer_runs = 200` in the legacy restriction. The restriction keys `profile`, `settings` and `optimizer` are silently ignored (rc 0, the legacy optimizer stays off). The default profile must set `optimizer = false` and `optimizer_runs = 1`. The port is pinned by its own restriction `{ paths = "src/port/PortToken.sol", version = "=0.8.28" }`, and a top-level `solc = "0.8.28"` breaks the build (rc 1, no solc matches `^0.4.19, =0.4.19`). Decision 9 (artifact names) holds. Needs updating to match: the `foundry.toml` section of design.md (it describes a top-level `solc = "0.8.28"` pin at about line 240, and "a per-file additional compiler profile, omitting `optimizer_runs` when disabled"), decision 12 (it says "an exact port `solc = "0.8.28"`"), Property 2, the project generator task 8.1, and the fixture check in task 8.6. When the legacy optimizer is enabled with runs R, the generator must emit `min_optimizer_runs = R` and `max_optimizer_runs = R` and a profile with `optimizer_runs = R`; the recorded 1.5 run only verified R = 200 with `min_optimizer_runs` alone. Note: the R = 0 bug (the min bound alone also matches the default profile, so forge picked the default) was found later by task 8.1's smoke test, which is why the generator emits both bounds. The recorded 1.5 findings and the snippets below are left as recorded. The exact snippet from `findings/1.5.native.md`:
```toml
[profile.default]
src = "src"
out = "out"
allow_paths = ["/Users/chinedum/Desktop/my_projects/personal_projects/web3/exhume/engine/test/docker/.cache/forge-std"]
fs_permissions = [{ access = "read", path = "./out" }, { access = "read-write", path = "./seance-out" }]
optimizer = false
optimizer_runs = 1

additional_compiler_profiles = [{ name = "legacy_opt", optimizer = true, optimizer_runs = 200 }]
compilation_restrictions = [
  { paths = "src/legacy/LegacyToken.sol", version = "=0.4.19", min_optimizer_runs = 200 },
  { paths = "src/port/PortToken.sol", version = "=0.8.28" },
]
```
      - (d) 1.7 / forge-std (extends (c)). forge-std also needs explicit restrictions `{ paths = "<forge-std dir>/src/**", version = "=0.8.28" }` and `{ paths = "test/**", version = "=0.8.28" }`, so that its solc selection is deterministic: with only the legacy and port entries named, forge chose 0.8.28 for forge-std through its own grouping (natively many 0.8.x versions are installed), which the generator does not control. A probe with `=0.8.30` on both paths was honoured. Decision 11's `remappings.txt` + `allow_paths` scheme works with no `lib/` directory. `allow_paths` was not strictly required natively (the negative check without it still built, rc 0); it stays in the generated file as harmless. Without `remappings.txt` the build fails. Offline is not proven at the OS level: `--offline` exists and an uninstalled solc fails under it, but no firewall or network namespace was used, so the no-network claim rests on `--offline` plus a dead proxy. In Docker only solc 0.4.19 and 0.8.28 are installed, so this must be re-checked there. The `<forge-std dir>` in the generated restriction is the path used for `allow_paths` and the remapping (`/opt/forge-std` in Docker). Affects design.md decision 11 and the `foundry.toml` section, Property 2, and tasks 8.1 and 8.6. Where the snippet shows `min_optimizer_runs = 200`, the generator emits `min_optimizer_runs = R` and `max_optimizer_runs = R` (the R = 0 bug was found later by task 8.1's smoke test). The exact snippet from `findings/1.7.native.md` (local checkout paths, as recorded):
```toml
[profile.default]
src = "src"
out = "out"
allow_paths = ["/Users/chinedum/Desktop/my_projects/personal_projects/web3/exhume/engine/test/docker/.cache/forge-std"]
fs_permissions = [{ access = "read", path = "./out" }, { access = "read-write", path = "./seance-out" }]
optimizer = false
optimizer_runs = 1
additional_compiler_profiles = [{ name = "legacy_opt", optimizer = true, optimizer_runs = 200 }]
compilation_restrictions = [
  { paths = "src/legacy/LegacyToken.sol", version = "=0.4.19", min_optimizer_runs = 200 },
  { paths = "src/port/PortToken.sol", version = "=0.8.28" },
  { paths = "/Users/chinedum/Desktop/my_projects/personal_projects/web3/exhume/engine/test/docker/.cache/forge-std/src/**", version = "=0.8.28" },
  { paths = "test/**", version = "=0.8.28" },
]
```
        with `remappings.txt` containing `forge-std/=/Users/chinedum/Desktop/my_projects/personal_projects/web3/exhume/engine/test/docker/.cache/forge-std/src/`.
      - (e) 1.6 / artifact path: no change. The Runner reads `out/<File>.sol/<Contract>.json` and `deployedBytecode.object` (not `bytecode.object`). Metadata_Suffix lengths are 43 bytes for solc 0.4.19 (last two bytes `0029` = 41, plus 2) and 53 bytes for solc 0.8.28 (`0033` = 51, plus 2). Stripping with the CBOR length in the last two bytes works on both. `immutableReferences` is `null` and `linkReferences` is `{}` for both artifacts.
      - (f) 1.8 and 1.9 / timings (native, representative). Discovery with recording ON: 3.13 s total (0.000191 s per call, 16,384 calls), recording OFF 1.21 s, against a 150 s threshold. Witness campaigns: early 0.11 to 0.17 s, rare 0.17 to 0.18 s, never (full 256 x 64) 1.25 to 1.27 s, replay 0.10 to 0.12 s, and 13.90 s for 10 pairs plus replays against 296.21 s remaining. No wall-clock mitigation (raise timeout, buffered writes, skip state reads, lower `depth`) is needed natively, and the design does not need to say that a deadline in the witness phase is the expected case. These margins are about 50x and 20x, so even a several-fold slowdown in Docker would still fit. 1.8 caveat: the benchmark deliberately does not set `stopped` after an `exorcised` record (worst case, all `depth` lines written) and writes no setup records. 1.9 shows forge stops at the first failure, so a failing campaign costs only the calls up to the first failing run plus shrinking.
      - (g) 1.9 and 1.11 / seed determinism: RESOLVED by the user's decision. Forge 1.5.1's fuzzer is not reproducible from a seed (1.11 records five same-seed discovery runs that all differed, and a rare witness found at different runs). Decision, options 1 and 2 together: (1) Requirement 7.11 now compares totals only (`totalCalls` and `runs`), not Classification counts. Requirement 12.12 passes the seed to Foundry on a best-effort basis, with no reproducibility claim. (2) Stored sequences replay without the seed (the replay is calldata-driven, not seed-driven), and acceptance criteria are thresholds, not exact counts. The design's expectation that the same `--fuzz-seed` gives identical shrunk sequences native and Docker is dropped. Property and integration tests must not assert equality of Classification counts or shrunk sequences between two same-seed séances. The requirements and design documents are updated separately; this file only follows the decision.
      - (h) Other observations from the findings (no design change required, listed for the record). 1.4: the passing and failing contracts used seed `0x1badc0de`; per-call fields `addr`, `args`, `contract_name`, `func_name`, `raw_args`, `signature` exist beyond `sender` and `calldata`; `Sequence[0]` is the pre-shrink length only on a fresh run. 1.5: `runs` is reported in optimizer metadata even when `enabled` is false, and the legacy-off artifact differs from the legacy-on artifact only because of the optimizer (hashes in the 1.5 Findings). 1.9: forge's default `shrink_run_limit` is 5000 (read with `forge config --json`), shrunk witnesses for the test conditions reduced to 1 call, and the reported run count at failure varied between 0 and 12. 1.3: the setup marker appears once in the whole process and the replay starts from restored post-setUp storage (idx back to 0). No native/Docker disagreement can be reported yet, because no Docker result exists.
    - Pending Docker runs (Docker Desktop paused, all deferred by the user's decision to one pass at the end):
      - Single command when Docker is unpaused: `engine/test/docker/run-risks.sh`.
      - Refresh the Docker results for 1.2, 1.3, 1.4 (with the changed criteria: counterexample shape, fresh directory per run, shape-only JSON comparison with the native fixtures), 1.5, 1.6, 1.7, 1.8 and 1.9. The existing `*.docker.md` files for 1.2, 1.3 and 1.4 are stale (they predate the amendments) and are not results.
      - 1.4 is compared for shape only (keys and `counterexample.Sequence[1]` structure against the native fixtures). Shrunk sequences are not compared.
      - Docker timings for 1.8 and 1.9 will be labelled emulated on Apple Silicon (linux/amd64 under emulation) and are not used for the PASS decision.
      - Checks that need the Docker image specifically: 1.7 with only solc 0.4.19 and 0.8.28 installed and forge-std at `/opt/forge-std`, and the 1.5 scheme with those two solc versions.
      - The native/Docker disagreement analysis required by this task cannot be completed until the Docker pass has run. After it, the 1.10 Findings need a final update (Docker entries replacing PENDING, disagreements listed with both values and suspected cause). The user has already reviewed the flagged design changes. The Docker pass is a prerequisite of task 10 (the Runner), not of tasks 3 to 9.
    - _Requirements: 1.6, 12.8_

  - [x] 1.11 Risk 9: seed determinism of discovery and of a rare witness (native only)
    - Depends on 1.8 and 1.9. A runnable script under `engine/test/docker/risks/` (like 1.2 to 1.9), writes its result to `engine/test/docker/findings/1.11.native.md`. Native only (forge 1.5.1, macOS arm64).
    - This task is a recorded finding, not a blocker. The script's exit code stays 1 when discovery is not seed-deterministic, by design, and that non-zero exit is expected and documented here. The task is complete when the findings are recorded.
    - Part 1, discovery. Use the 1.8 campaign (`engine/test/docker/risks/1.8-wallclock/Bench.t.sol`, recording on). Run it 5 times with `--fuzz-seed 42`, each in a fresh scratch directory. For each run record the sha256 of the record file and the class counts (match, reason-modernised, exorcised, port-bug).
    - Result rule for part 1: the outcome is a recorded finding. If all 5 hashes and all 5 count sets are identical, record "discovery seed-deterministic". Otherwise record "discovery not seed-deterministic" (the script exits 1). Either way, record both parts and continue.
    - Part 2, rare witness. Read `engine/test/docker/findings/1.9.native.md` and the 1.9 fixture. Use the first, rarer condition from 1.9 (about 1e-4 per call: exorcised `batchTransfer` by a specific actor pair with a specific receiver pattern). Run it 5 times with the same `--fuzz-seed 42`, each in a fresh scratch directory. For each run record the run number at which it failed, or "passed" (all 256 runs passed).
    - Record the five outcomes of each part, whatever they are. A varying part 2 is a finding, not a script failure.
    - No Docker run of 1.11 is needed. A Docker run would not change the conclusion (the non-determinism is inside forge 1.5.1's fuzzer, see the causes below), so 1.11 is not part of the Docker pass.
    - Findings:
      - native (forge 1.5.1, macOS arm64): FINDING RECORDED, discovery is not seed-deterministic. Part 1 (five runs, `--fuzz-seed 42`, fresh directory each): all five record-file hashes differ. Line count (16,448) and forge's reported calls (16,384) are identical in all runs. Class counts vary: exorcised 2,697 to 2,705, port-bug 8,552 to 8,572, reason-modernised 72 to 75 (match 5,106 to 5,122). Script exit code 1, as designed. Part 2 (rare witness, about 1e-4 per call, `--fuzz-seed 42`): failed at run 136 in 3 of 5 runs and at runs 124 and 109 in the other two, shrunk length 1 in all five. The shipped 6e-4 condition failed at run 2 in all five runs. Full tables in `engine/test/docker/findings/1.11.native.md`.
      - Causes checked by the user outside the repo: (1) with `--threads 1`, seeded runs still differ, from line 19. (2) With `dictionary_weight = 0`, two seeded runs match for 97 lines and differ at line 98, where only the fuzzed actor index differs. So the non-determinism is inside forge 1.5.1's fuzzer, not in our handler and not in threading.
      - Consequence: see 1.10 item (g). Requirement 7.11 compares totals only, 12.12 passes the seed best effort, stored sequences replay without the seed, and acceptance criteria are thresholds.
    - _Requirements: 7.11, 12.12_

- [x] 2. Checkpoint - Risk verification gate
  - Passed on the native results: every Known risk (1.2 to 1.9) is PASS natively, and the flagged design changes (including the seed-determinism decision in 1.10 item (g)) were reviewed by the user. The Docker pass is still pending. It does not block tasks 3 to 9. It is a prerequisite of task 10 (see below).
  - Docker pass: run `engine/test/docker/run-risks.sh`, refresh the Docker findings for 1.2 to 1.9, and record any native/Docker disagreement in 1.10. A FAIL or a disagreement needs an agreed design change before task 10 starts. Ask the user if questions arise.

- [x] 3. Scaffold the engine package and shared types
  - [x] 3.1 Set up the `engine/` package
    - Create the pnpm workspace entry, `tsconfig.json` in strict mode for Node 24, vitest config, and a fast-check dependency, plus the `engine/src/seance/` and `engine/test/seance/` directories.
    - Create or update the root `package.json` with `"packageManager": "pnpm@11.25.0"` (the installed version) and `"engines": { "node": ">=24 <25" }`. Use `@types/node` `^24` in `engine/package.json` and set the same `engines` pin there.
    - Note: the workspace steering rule `tech` (`.kiro` steering) still says Node 22. The user should update it to Node 24. This task does not edit steering files.
    - _Requirements: 12.1_

  - [x] 3.2 Define shared types and error model
    - Create `engine/src/seance/types.ts` with `SeanceInput`, `SeanceError` (including `phase` and `partialCounts`), error code union, `Result`, `Classification`, `CallRecord`, `NormLog`, `RecordLine`, `OrderedRecord`, `SeanceReport`, `Finding`, `UnshrunkReason`, `AutopsyReport`, `ArithmeticSite`, `Operand`, `TargetPlan`, `ParamSlot`, `AbiFunction`.
    - Keep one module so later tasks do not edit each other's types.
    - _Requirements: 4.8, 7.3, 7.4, 8.8, 11.1, 12.4_

- [x] 4. Autopsy contract and schemas
  - [x] 4.1 Write the JSON schemas
    - Create `engine/src/seance/schemas/autopsy-v1.schema.json` and `engine/src/seance/schemas/seance-report.schema.json`. The report schema requires `runs`, `depth`, `totalCalls`, `counts`, the `shrinking` object with its seven fields, and `unshrunk` plus `unshrunkReason` on unshrunk findings.
    - Source-location `line` and `column` are 1-based, with a minimum of 1.
    - The schema `$id` values are `https://github.com/CharlesChinedum/exhume/blob/main/engine/src/seance/schemas/<file>`, where `<file>` is the schema file name.
    - _Requirements: 7.8, 7.12, 11.1, 11.5_

  - [x] 4.2 Implement `autopsy-contract.ts`
    - Implement `parseAutopsyReport` with the check order: empty, over 10 MB, JSON syntax, `schemaVersion` present, supported (`["1"]`), Ajv schema validation with all violations and JSON pointers, then the ABI cross-check naming every unknown function. Implement `serializeAutopsyReport` with canonical key order.
    - Load the schema with a JSON import attribute: `import schema from "./schemas/autopsy-v1.schema.json" with { type: "json" }`. Do not use `readFileSync`, so loading works after a build and in the worker image.
    - Reject any site located in the constructor, fallback, or receive function with `site <id> is in the constructor, which takes no fuzzable arguments; only ABI functions can be targeted`.
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
  - [x] 6.1 Implement `classify.ts`
    - Implement `classify` per the decision table (including the exact 36-byte `Panic(0x11)` check and `invalidRecord` for malformed input), `classifyConstructors`, and log normalisation with the `SELF` emitter sentinel and empty logs for reverted calls.
    - _Requirements: 2.6, 2.7, 3.8, 3.9, 3.10, 3.11, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10_

  - [x] 6.2 Create the shared classification vectors
    - Write `engine/test/vectors/classification.json` covering every row of the decision table, empty versus non-empty revert data, a single differing `allowed` value, and malformed records. A vitest example test runs them against `classify`.
    - Each vector has a `scope` field, either `"both"` or `"ts-only"`. The 27 malformed-record vectors (those expecting `invalidRecord`) are `ts-only`. The vitest test also checks that every `invalidRecord` vector is `ts-only`.
    - Topic and emitter width rule for `both` vectors: the vitest test checks that every topic of a `both` vector is exactly 32 bytes and every non-SELF emitter is exactly 20 bytes. `ts-only` vectors are exempt.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 10.5_

  - [x] 6.3 Write property test for the decision table
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

  - [x] 6.7 Implement `taint.ts`
    - Implement `computeTaint(sequence, setupDiverged)` and `verifyTaint(records)`, which returns `SEANCE_FAILED` naming the first record whose `afterDivergence` differs from the recomputed value.
    - _Requirements: 5.5, 8.4_

  - [ ] 6.8 Write property test for divergence taint and finding selection
    - **Property 12: Divergence taint flags later records and excludes them from findings**
    - Includes the `selectFindingPairs` checks, so this test runs after task 9.2.
    - **Validates: Requirements 5.5, 8.4**

- [x] 7. Targeted-value input generator
  - [x] 7.1 Implement `input-generator.ts`
    - Implement `generateTargets` with the rules table (`x * k`, `a + b`, `a - b`, `x * y`, `x ** y`, array length times value), narrower-type widths, ParamSlot computation (`static` and `dynamicArrayLength`), paired assignments in one entry, seed sequences of at most 10 calls, and `unreachable` sites. Cap entries at 64 per site. Use `bigint` throughout.
    - When every entry of a site has an empty assignments list, the generator sets `unreachable: true` for that site so it appears in `unreachableSites`. Cover this with a unit test that builds such a site and checks the flag and the `unreachableSites` entry.
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.10, 6.11, 6.12_

  - [x] 7.2 Write property test for multiplication targets
    - **Property 13: Multiplication targets overflow and wrap**
    - **Validates: Requirements 6.2, 6.6, 6.13**

  - [x] 7.3 Write property test for array-length-times-value pairs
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
  - [x] 8.1 Implement `forge-std-pin.ts` and `foundry-config.ts`
    - Export `FORGE_STD_PIN`, `INVARIANT_RUNS = 256`, `INVARIANT_DEPTH = 64`, the `remappings.txt` text, and the `allow_paths` text. `foundry-config.ts` renders `foundry.toml` (`compilation_restrictions`, legacy optimizer profile, `fs_permissions`, `gas_limit`, `[invariant]`). Adjust to any change recorded by task 1.
    - `FORGE_STD_DIR` is a generator parameter, default `/opt/forge-std` (the Docker image path). Generated files contain the parameter value and never a local checkout path.
    - Emit the scheme verified by risks 1.5 and 1.7:
      - `remappings.txt` contains `forge-std/=<FORGE_STD_DIR>/src/`, and `foundry.toml` has `allow_paths = ["<FORGE_STD_DIR>"]`.
      - The default profile sets `optimizer = false` and `optimizer_runs = r0`, where r0 differs from the legacy runs R, per the design's rule (use 1, or 2 when R == 1).
      - No top-level `solc`. The port is pinned by its own restriction `{ paths = "src/port/Port<Name>.sol", version = "=0.8.28" }`.
      - Explicit restrictions `{ paths = "<FORGE_STD_DIR>/src/**", version = "=0.8.28" }` and `{ paths = "test/**", version = "=0.8.28" }`.
      - When the legacy optimizer is enabled with runs R, emit `additional_compiler_profiles = [{ name = "legacy_opt", optimizer = true, optimizer_runs = R }]` and put both `min_optimizer_runs = R` and `max_optimizer_runs = R` on the legacy restriction, and on the port restriction too when `portSharesLegacyOptimizer` is set. When it is disabled, emit neither the additional profile nor `min_optimizer_runs` nor `max_optimizer_runs`.
      - Reason for both bounds: with R = 0 the `min_optimizer_runs = 0` bound alone also matches the default profile, so forge picked the default profile and the legacy artifact was built with the optimizer off. Found by building the rendered config natively.
      - Forge-build smoke test: render the config and run `forge build` natively for R = 0, 1 and 200. Assert the legacy artifact's `metadata.settings.optimizer` is `{ enabled: true, runs: R }` and the port artifact's has `enabled: false`.
      - Witness override: `FOUNDRY_INVARIANT_SHRINK_RUN_LIMIT=5000` overrides the file's `shrink_run_limit = 0` for witness campaigns.
      - Never emit the `profile`, `settings`, or `optimizer` keys in a restriction. Forge silently ignores them (finding 1.5).
    - _Requirements: 1.2, 1.3, 1.4, 1.5_

  - [x] 8.2 Write `templates/Classifier.sol`
    - Solidity mirror of `classify`, including the `Panic(0x11)` check, deterministic and pure.
    - It mirrors only the vectors whose `scope` is `"both"` (or absent). In Solidity a Call_Record is built from typed EVM values and cannot be malformed, so `ts-only` vectors (the malformed-record vectors) have no Solidity counterpart and the template does not handle them.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9_

  - [x] 8.3 Write `templates/Handler.sol`
    - Implement the `DifferentialHandler` template: Actor_Set with the deployer, `_addr`, `init` (deploy by artifact name with identical constructor args and funding, constructor outcome classification, token shares, seed sequences), `_pickTarget`, typed handler functions per the parameter mapping table, fallback handlers, `_differential` (stopped check, `idx`-derived warp and roll, `vm.deal` before each side for payable calls, capped `call` and `staticcall`, classification, taint, JSONL record), `setOutputPath`, `setWitness`, and Observable_State reading including address-keyed mapping getters.
    - Address arguments in seed calls (the seed-sequence runner in `init`/`setUp`, and the generator that emits seed sequences into `Targets.sol`) are Actor_Set indices written as decimal strings. The handler decodes each one as an index into the Actor_Set (through `_addr`), not as a literal address.
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
    - Add these fixture checks, asserting on the parsed TOML:
      - (1) With R = 1 and the legacy optimizer enabled, the default profile's `optimizer_runs` differs from R, and the legacy restriction's `min_optimizer_runs` and `max_optimizer_runs` are both equal to R, so it matches only the `legacy_opt` additional profile. Repeat the both-bounds-equal-R check for R = 0 and R = 200.
      - (2) There is no top-level `solc`.
      - (3) No restriction contains a `profile`, `settings`, or `optimizer` key.
      - (4) The `<FORGE_STD_DIR>/src/**` and `test/**` restrictions (both `=0.8.28`) are present.
      - (5) Generate with two different `FORGE_STD_DIR` values. In each output, `remappings.txt`, `allow_paths`, and the forge-std restriction contain that value, and no generated file contains a local checkout path or the other value.
      - (6) With the legacy optimizer disabled, there is no `additional_compiler_profiles` entry and no `min_optimizer_runs` or `max_optimizer_runs`.
    - _Requirements: 1.3, 1.4_

  - [ ]* 8.7 Write property tests for handler coverage and target-only fuzzing
    - **Property 5: Handler coverage and parameter mapping match the ABI**
    - **Property 6: The discovery test targets only the handler**
    - **Validates: Requirements 2.4, 3.1, 3.3, 10.4**

  - [ ] 8.8 Write the required forge tests: classifier vectors and the legacy assert gas cap
    - Run natively with forge 1.5.1 and in the Docker image.
    - `Classifier.sol` against the shared vectors in `engine/test/vectors/classification.json`, so the Solidity classifier matches the TypeScript one. The forge parity test reads that file and runs only vectors whose `scope` is `"both"` (or absent). It skips `ts-only` vectors (the malformed-record vectors), because a Solidity Call_Record is built from typed EVM values and cannot be malformed, so the test must not depend on how `vm.parseJson` handles bad input. State keys are enumerated with `vm.parseJsonKeys`. `differingFields` are compared as sorted by bytes (state field names are ASCII, so UTF-16 order equals byte order).
    - In the shared vectors, every `both` vector must have topics of exactly 32 bytes and non-SELF emitters of exactly 20 bytes, because `Classifier.sol` takes `bytes32` topics and `address` emitters (EVM topics are always 32 bytes). The vitest test in 6.2 enforces this rule. The `both` vectors' short topics (such as `0x01` and `0xAB`) were rewritten as full left-padded 32-byte words.
    - A fixture whose legacy contract hits an `assert` (invalid opcode) returns control to the handler within `GAS_CAP`, the handler records the call, and the séance continues.
    - _Requirements: 3.7, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.9_

  - [ ]* 8.9 Write the remaining forge tests for the templates
    - `_pickTarget` with fixed picks; the payable-fixture sender balance check; `_addr` and the `address[]` builder; handler fixtures for identical constructor args, one record per deployment, reverts recorded, no calls after `stopped`, and `afterDivergence` set only after the first `port-bug`.
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 3.1, 3.2, 3.5, 5.4, 5.5, 6.9_

- [ ] 9. Report builder
  - [ ] 9.1 Implement record parsing, grouping, and counts in `report.ts`
    - `parseRecords` assigns 1-based ordinals from line order, discards a truncated last line, assigns `fuzzOrdinal` only to `idx >= 0`. Group sequences by `idx == 0`, group setup records by `idx == -1`, drop records after an `exorcised` record, record `exorcisedAtIndex`, count all four Classifications including tainted records.
    - Keep the first `INVARIANT_RUNS` sequences, counted by `idx == 0` starts. Treat any later lines as Foundry's post-campaign replay of the final run. Verify they form exactly one sequence identical to the last kept sequence (calldata, sender, results, flags), and fail with `SEANCE_FAILED` naming the first difference if not. The replay lines are not counted. A discovery run killed by timeout has no replay, so partial counts are unaffected.
    - `parseRecords` rejects a record file with `SEANCE_FAILED`, naming the line (1-based line number of the first offending line), when a fuzz sequence does not start at `idx == 0` or when `idx` within a sequence does not increase by exactly 1. Setup records (`idx == -1`) are exempt from the continuity check. `verifyTaint` from 6.7 stays tolerant on purpose and relies on `parseRecords` having validated the stream.
    - _Requirements: 5.1, 5.2, 5.3, 5.6, 7.3, 7.10_

  - [ ] 9.2 Implement finding selection and dispositions in `report.ts`
    - `selectFindingPairs` (first untainted record per pair, setup pairs separate, `exorcised` before `port-bug`, cap 10), `assignDispositions`, and `chooseReported`.
    - _Requirements: 7.12, 8.1, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8_

  - [ ] 9.3 Implement report construction, validation, and writing in `report.ts`
    - `buildReport` (including `taintedCalls`, `setupCalls`, `sequenceResults`, `shrinking`, `unreachableSites`, site attribution through ParamSlots with the `unattributed` marker, both Call_Records for port bugs), `validateReport`, canonical `serializeReport` and `parseReport`, and `writeReportAtomic` via temp file and rename with `REPORT_WRITE_FAILED`.
    - `validateReport` loads the report schema with a JSON import attribute: `import reportSchema from "./schemas/seance-report.schema.json" with { type: "json" }`. This is the same pattern as the autopsy schema in 4.2. Do not use `readFileSync`, so loading works after a build and in the worker image.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 7.12_

  - [ ] 9.4 Write property test for exorcism truncation
    - **Property 11: Exorcism truncates a sequence**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.5, 5.6**

  - [ ]* 9.5 Write property test for counts and ordinals
    - **Property 21: Report counts are complete and consistent, ordinals follow line order**
    - The record-stream generator appends a replay tail (a copy of the last sequence) after the first `INVARIANT_RUNS` sequences, and the test checks that counts and ordinals ignore the tail. Add a tampered-tail case (one changed calldata, sender, result, or flag, or a wrong tail length) that must fail with `SEANCE_FAILED` naming the first difference. Add a no-tail case (timeout-killed discovery) that leaves partial counts unchanged.
    - Add idx continuity cases, each rejected with `SEANCE_FAILED` naming the 1-based line number of the first offending line: a dropped line (idx jumps), a skipped idx, and a sequence starting at idx > 0.
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
  - Prerequisite for task 10 and all its sub-tasks: the Docker pass from checkpoint 2 is done (run `engine/test/docker/run-risks.sh`, refresh the 1.2 to 1.9 Docker findings, record any native/Docker disagreement in 1.10). The Runner is the first task that depends on Docker behaviour. The dependency graph is JSON and has no comment syntax, so this prerequisite is stated here only.
  - Node version for images: the Docker image used for the séance runner and worker, and any image that runs the TypeScript Runner, must use Node 24 and the pnpm version pinned in the root `package.json` `packageManager` field. `engine/test/docker/Dockerfile` is a forge-only image and may not need Node. The Node 24 requirement applies to the future worker image and to any image that runs the Runner.

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
    - Checks only that the Runner puts the given seed, unchanged, into the forge arguments (best effort). It makes no claim that two runs with the same seed give the same counts or sequences, because forge 1.5.1's fuzzer is not reproducible from a seed (1.11).
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
    - Write `graveyard/bec/autopsy.json`, listing the unchecked arithmetic sites of the legacy BEC source by hand, including `batchTransfer`'s `cnt * _value` as an `arrayLength` operand times a `param` operand (both uint256, with the `_receivers` array length site), and the other `+`, `-`, and `*` sites in `transfer`, `transferFrom`, and the other functions, each with site id, function, operator, operands with types, and source location. Set `schemaVersion` to `"1"` and conform to `engine/src/seance/schemas/autopsy-v1.schema.json`. Include precondition hints where a site needs a balance or an `approve`.
    - Note: BEC's constructor arithmetic (constants only) is left out of `autopsy.json` on purpose. Sites in the constructor take no fuzzable arguments, and the parser rejects them with `site <id> is in the constructor, which takes no fuzzable arguments; only ABI functions can be targeted`.
    - Check `autopsy.json` with `parseAutopsyReport` from task 4.2 against the legacy BEC ABI, and check that `port.golden.sol` compiles with solc 0.8.x in `forge build`.
    - Note: the future Resurrection spec will use `graveyard/bec/port.golden.sol` as its expected output. Do not change it later to make the Resurrection output match without a recorded reason.
    - _Requirements: 9.1, 11.1, 11.5, 11.6, 11.8_

  - [ ] 13.1 Add BEC inputs under `graveyard/bec/`
    - Depends on: 13.0.
    - Use the legacy BEC source from the `graveyard/bec/` entry (solc 0.4.19, optimizer off), `graveyard/bec/port.golden.sol` as the Port_Contract, `graveyard/bec/autopsy.json` as the Autopsy_Report, and the mainnet runtime code for `0xC5d105E63711398aF9bbff092d4B6769C82F793D`. Do not wait for the Resurrection stage.
    - Add the loader that assembles these four inputs into a `SeanceInput` for the acceptance run. If the runtime code is not yet stored in the entry, say so and ask the user for it.
    - _Requirements: 9.1_

  - [ ] 13.2 Implement `acceptance.ts`
    - Wrap `runSeance` and check: an `exorcised` finding in `batchTransfer`, zero `port-bug` counts, first exorcism `fuzzOrdinal` at most 2,000, shrunk `_receivers` length 2 to 20 with `length * _value >= 2^256` and wrapped product at most the sender's legacy balance, and replay-confirmed (not `unshrunk`). All checks are thresholds or invariants (the Classification counts sum to `totalCalls`), never exact counts, because forge 1.5.1's fuzzer is not reproducible from a seed. On failure return `ACCEPTANCE_FAILED` naming the condition or `unshrunkReason`, and do not overwrite `graveyard/bec/seance-report.json`.
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.7, 9.8_

  - [ ] 13.3 Run the BEC acceptance in Docker
    - Run the CLI on BEC in the linux/amd64 image: generate project, build, bytecode check, discovery, witness shrinking, replay, report written. Assert the report is stored in `graveyard/bec/`, `setupCalls` equals actor count minus one plus seed calls, and the `batchTransfer` finding is shrunk with zero port bugs. If it fails, fix the cause or apply the design adjustment from task 1.
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 12.1_

  - [ ]* 13.4 Add a same-seed totals integration test
    - Run BEC twice with the same seed and check only totals and thresholds. `totalCalls` and `runs` are equal across the two reports. In each report the Classification counts sum to `totalCalls`, there are zero `port-bug` counts, the first exorcism `fuzzOrdinal` is at most 2,000, and the `batchTransfer` finding is shrunk and replay-confirmed.
    - Do not assert equality of Classification counts, `fuzzOrdinal` values, or shrunk sequences between the two runs. Forge 1.5.1's fuzzer is not reproducible from a seed (1.11).
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
- Node 24 (`">=24 <25"`) replaces Node 22 throughout this plan. The steering rule `tech` still says Node 22 and the user should update it. Steering files were not edited.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "1.8", "1.9"] },
    { "id": 2, "tasks": ["1.10", "1.11"] },
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
