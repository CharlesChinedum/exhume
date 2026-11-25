# Requirements Document

## Introduction

The Séance_Engine is the fourth stage of the Exhume flow (graveyard, autopsy, resurrection, séance). It takes a legacy pre-0.8 Solidity contract, compiled with its original solc version and optimizer settings, and its deterministic 0.8 port. It generates a Foundry project that compiles both side by side, and a stateful differential handler that sends identical calldata from the same sender to both deployed bytecodes. Every call is classified as match, reason-modernised, exorcised, or port bug. Observable state includes emitted event logs, so a port that drops an `emit` is a port bug.

Inputs are legacy-aware: for each unchecked arithmetic site reported by the Autopsy, the Input_Generator produces values known to overflow that site and, for guarded sites, to wrap to a small result that passes later checks. Plain fuzzing missed BEC's `batchOverflow` in 16k calls, so targeted inputs are mandatory. The engine emits a JSON report with counts and the shrunk calldata of each exorcism and port bug. Shrinking uses Foundry's built-in invariant shrinking.

The generator lives in `engine/` and is invoked through a local command-line and library Entry_Point that runs `forge` and writes per-contract output under `graveyard/<name>/`. The `worker/` HTTP service, which runs séances inside a linux/amd64 Docker image containing Foundry and old solc versions, is specified separately. In this spec the Worker is only a future consumer of the Entry_Point and the environment where `forge` runs.

## Glossary

- **Séance_Engine**: The `engine/` component that generates the Foundry project and runs a séance for one Legacy_Contract and Port_Contract pair.
- **Entry_Point**: The local command-line interface and library function of the Séance_Engine that accepts séance inputs, runs `forge`, and returns or writes the Séance_Report.
- **Project_Generator**: The part of the Séance_Engine that writes the Foundry_Project to disk.
- **Foundry_Project**: A generated Foundry project containing both contracts, `foundry.toml`, the Differential_Handler, and the invariant test.
- **Legacy_Contract**: The original pre-0.8 Solidity source, compiled with its original solc version and optimizer setting.
- **Port_Contract**: The Solidity 0.8 output of the deterministic Resurrection stage for the Legacy_Contract.
- **Legacy_Artifact**: The compiled bytecode and ABI of the Legacy_Contract, loaded by 0.8 tests through `vm.deployCode`.
- **On_Chain_Runtime_Code**: The deployed runtime bytecode of the Legacy_Contract, stored with the graveyard entry and supplied to the Séance_Engine as input, so that no network access is needed.
- **Metadata_Suffix**: The trailing Swarm or metadata hash appended by solc to runtime bytecode.
- **Compilation_Restriction**: A Foundry `compilation_restrictions` entry that pins a source file to a specific solc version.
- **Differential_Handler**: The Solidity handler contract, driven by Foundry stateful fuzzing, that sends identical calls to both deployments and compares results.
- **Legacy_Deployment**: The deployed instance of the Legacy_Artifact bytecode inside the Foundry EVM.
- **Port_Deployment**: The deployed instance of the Port_Contract bytecode inside the Foundry EVM.
- **Autopsy**: The Exhume stage that flags legacy syntax and dangerous patterns.
- **Arithmetic_Site**: One unchecked arithmetic operation (`+`, `-`, `*`, or `**`) in the Legacy_Contract that the Autopsy reports, identified by site id, function, operator, operand information and types, and source location.
- **Autopsy_Report**: The Autopsy output listing the Arithmetic_Sites of one Legacy_Contract, carrying a `schemaVersion` field.
- **Schema_Version**: The value of the `schemaVersion` field of an Autopsy_Report.
- **Input_Generator**: The part of the Séance_Engine that produces Targeted_Values for each Arithmetic_Site.
- **Targeted_Value**: A value chosen so that an Arithmetic_Site overflows or underflows. For `x * k` the values lie near `2^256 / k` and include `ceil(2^256 / k)`, so that the product wraps to a result smaller than `k`. For `a + b` the values lie near `2^256 - 1 - a`.
- **Wrapped_Product**: The product of two values modulo `M`, where `M` is `2^256` or the type-based replacement defined in Requirement 6.
- **Event_Log**: One emitted log of a call, consisting of the emitter, the topics, and the data.
- **Call_Record**: The tuple of calldata, sender, return data or revert data, success flag, Event_Logs, and Observable_State for one call to one deployment.
- **Observable_State**: The state compared after each call: the return data, the Event_Logs of the call, the `balance` of each deployment, the values returned by every `view` or `pure` function of the ABI that takes no arguments, and the values of public mapping getters for each address in the Actor_Set.
- **Actor_Set**: The fixed set of sender addresses used by the Differential_Handler.
- **Divergence_Taint**: The Call_Record flag `afterDivergence=true`, set on every Call_Record that follows the first `port-bug` in the same call sequence. A Call_Record with Divergence_Taint is counted but is never reported as a finding.
- **Classification**: One of `match`, `reason-modernised`, `exorcised`, or `port-bug`.
- **Exorcism**: A call classified as `exorcised`.
- **Port_Bug**: A call classified as `port-bug`.
- **Panic_0x11**: Solidity revert data beginning with selector `0x4e487b71` followed by the ABI-encoded uint256 `0x11`.
- **Séance_Report**: The JSON document produced by a séance.
- **Foundry_Shrinking**: Foundry's built-in invariant shrinking of a failing call sequence.
- **Fuzz_Seed_Note**: The fuzz seed is best effort, because Foundry 1.5.1 does not reproduce an invariant campaign from the fuzz seed, so the stored finding sequences are the reproducible artifact.
- **Worker**: The `worker/` HTTP service, specified separately, that is a future consumer of the Entry_Point and the environment where `forge` runs.
- **BEC**: BeautyChain, mainnet address `0xC5d105E63711398aF9bbff092d4B6769C82F793D`, solc 0.4.19, optimizer off.
- **Setup_Record**: A Call_Record produced during setup (constructor, token-share transfer, or seed call) and marked `idx == -1`.
- **Fuzz_Record**: A Call_Record produced by a fuzzed handler call, marked `idx >= 0`.
- **Finding_Pair**: A (function, Classification) pair, with Classification `exorcised` or `port-bug`, whose first record with `afterDivergence=false` yields one finding.
- **Discovery_Phase**: The séance phase that runs the fuzz campaign and collects Call_Records.
- **Witness_Phase**: The séance phase that runs one Foundry_Shrinking campaign per selected Finding_Pair.
- **Replay_Phase**: The séance phase that re-executes each shrunk sequence on freshly deployed instances.
- **Deadline**: The single time limit, started when the Entry_Point starts and shared by `forge build`, the Discovery_Phase, the Witness_Phase, and the Replay_Phase.
- **Witness_Cap**: The maximum number of Finding_Pairs taken from Fuzz_Records into the Witness_Phase, equal to 10.
- **Unshrunk_Reason**: The reason a finding is reported unshrunk, one of `setup`, `witness-cap`, `witness-not-failed`, `replay-mismatch`, `deadline`.
- **Planted_Port_Bug**: A test-only Port_Contract mutation in which an allowance is not decremented during `transferFrom`.
- **Dropped_Emit_Mutation**: A test-only Port_Contract mutation in which an `emit` of an event that the Legacy_Contract emits is removed.

## Requirements

### Requirement 1: Generate the Foundry project

**User Story:** As a smart contract auditor, I want a Foundry project that compiles the legacy contract and its port side by side, so that I can run the séance reproducibly.

#### Acceptance Criteria

1. WHEN the Project_Generator receives a Legacy_Contract, a Port_Contract, the legacy solc version, the legacy optimizer setting, the legacy optimizer runs value, and the On_Chain_Runtime_Code, THE Project_Generator SHALL write a Foundry_Project containing `foundry.toml`, the Legacy_Contract source, the Port_Contract source, the Differential_Handler, and an invariant test.
2. THE Project_Generator SHALL write a Compilation_Restriction in `foundry.toml` that pins every Legacy_Contract source file to the legacy solc version and to no other solc version.
3. WHERE the legacy optimizer setting is enabled, THE Project_Generator SHALL set the optimizer in `foundry.toml` for the Legacy_Contract to enabled with the legacy optimizer runs value (an integer from 0 to 4,294,967,295).
4. WHERE the legacy optimizer setting is disabled, THE Project_Generator SHALL set the optimizer in `foundry.toml` for the Legacy_Contract to disabled and omit the optimizer runs value.
5. THE Project_Generator SHALL write the Port_Contract compile settings with a solc version in the 0.8.x series.
6. WHEN the Foundry_Project is compiled with a single `forge build` invocation, THE Project_Generator SHALL cause that invocation to produce both a Legacy_Artifact and a Port_Contract artifact.
7. THE Differential_Handler SHALL deploy the Legacy_Deployment by calling `vm.deployCode` with the Legacy_Artifact path.
8. WHEN `forge build` succeeds, THE Séance_Engine SHALL compare the runtime bytecode of the Legacy_Artifact with the On_Chain_Runtime_Code after removing the Metadata_Suffix from both, and SHALL run the séance only when the two are byte-identical.
9. IF the runtime bytecode of the Legacy_Artifact differs from the On_Chain_Runtime_Code after removing the Metadata_Suffix, THEN THE Séance_Engine SHALL return an error that reports the bytecode mismatch, and SHALL NOT run the séance.
10. IF the legacy solc version is absent from the environment where `forge` runs, THEN THE Séance_Engine SHALL return an error that names the missing solc version, and SHALL NOT invoke `forge build`.
11. IF `forge build` exits with a non-zero status, THEN THE Séance_Engine SHALL return an error that contains the complete compiler output and the name of each failing source file, and SHALL NOT run the séance.
12. IF an input is missing, empty, or has a legacy solc version that is not a valid 0.x.y version below 0.8.0, THEN THE Project_Generator SHALL return an error that names the invalid input, and SHALL NOT write any files.
13. FOR ALL valid inputs, generating the Foundry_Project twice from identical inputs SHALL produce byte-identical files with identical relative paths (determinism property).

### Requirement 2: Deploy both contracts identically

**User Story:** As an auditor, I want both contracts deployed under identical conditions, so that every divergence is attributable to the port.

#### Acceptance Criteria

1. WHEN the Differential_Handler is set up, THE Differential_Handler SHALL deploy the Legacy_Deployment and the Port_Deployment with byte-for-byte identical ABI-encoded constructor arguments.
2. WHEN the Differential_Handler is set up, THE Differential_Handler SHALL fund the Legacy_Deployment and the Port_Deployment with the same ether balance, in wei, so that the balance difference between the two deployments is 0 wei immediately after setup.
3. WHEN the Differential_Handler is set up, THE Differential_Handler SHALL assign the same deployer address to both deployments, so that the `msg.sender` seen by each constructor is identical.
4. THE Differential_Handler SHALL use only addresses in the Actor_Set as the sender of every call to the Legacy_Deployment and the Port_Deployment after setup.
5. WHEN a call is issued, THE Differential_Handler SHALL execute the call to the Legacy_Deployment and the call to the Port_Deployment with the same sender, the same block timestamp, the same block number, the same calldata, and the same ether value.
6. IF the constructor of the Legacy_Deployment and the constructor of the Port_Deployment differ in outcome (one succeeds and the other reverts), THEN THE Séance_Engine SHALL classify the séance as `port-bug`, report the ABI-encoded constructor arguments and the revert data of the reverting constructor, and end the séance without issuing further calls.
7. IF the constructor of the Legacy_Deployment and the constructor of the Port_Deployment both revert, THEN THE Séance_Engine SHALL classify the séance as `reason-modernised` when the revert data differs and as `match` when the revert data is identical, and end the séance without issuing further calls.

### Requirement 3: Differential call execution

**User Story:** As an auditor, I want identical calldata sent from the same sender to both bytecodes, so that I can compare behaviour directly.

#### Acceptance Criteria

1. WHEN the Differential_Handler issues a call, THE Differential_Handler SHALL send byte-for-byte identical calldata, an identical `msg.value`, and the same sender address to the Legacy_Deployment and to the Port_Deployment.
2. WHEN a call completes on both deployments, THE Differential_Handler SHALL record exactly one Call_Record per deployment, each containing the function selector, calldata, `msg.value`, sender address, success flag, return or revert data, and the ordered list of Event_Logs.
3. THE Differential_Handler SHALL expose exactly one handler function for every non-constructor function in the ABI of the Legacy_Contract whose state mutability is `nonpayable` or `payable`.
4. WHEN a call completes on both deployments, THE Differential_Handler SHALL compare the success flag, the return data or revert data, and the Observable_State of the two deployments, and SHALL assign exactly one Classification to the call.
5. WHEN a call to a `view` or `pure` function completes on both deployments, THE Differential_Handler SHALL compare the success flag and the return data or revert data of the two deployments.
6. WHERE the ABI of the Legacy_Contract contains a `fallback` function, THE Differential_Handler SHALL issue, per séance run, at least one call with empty calldata and at least one call with non-empty calldata whose first four bytes match no function selector in the ABI.
7. IF a call reverts on one deployment or on both, THEN THE Differential_Handler SHALL still record a Call_Record for each deployment with the success flag set to false and the revert data captured, and SHALL continue the séance with the next call.
8. IF the Legacy_Deployment and the Port_Deployment differ in Observable_State after a call, THEN THE Differential_Handler SHALL classify the call as `port-bug` unless the call was classified as `exorcised` or `reason-modernised`, and SHALL report the differing state fields.
9. WHEN a call succeeds on both deployments, THE Differential_Handler SHALL compare the Event_Logs of the two deployments by count, by order, by topics, and by data, where an emitter that is the deployment itself on one side SHALL match only an emitter that is the deployment itself on the other side, and any other emitter SHALL match only the identical address.
10. THE Differential_Handler SHALL compare Event_Logs at the log level, so that a Legacy_Contract event emitted without the `emit` keyword and a Port_Contract event emitted with `emit` produce identical Event_Logs when topics, data, and order are equal.
11. WHERE a call reverts on a deployment, THE Differential_Handler SHALL treat the Event_Logs of that deployment for the call as an empty list.

### Requirement 4: Classification

**User Story:** As an auditor, I want every call classified into a fixed set of classes, so that I can tell intended 0.8 behaviour from port defects.

#### Acceptance Criteria

1. WHEN both the Legacy_Deployment and the Port_Deployment succeed with byte-identical return data, identical Event_Logs, and equal Observable_State after the call, THE Séance_Engine SHALL classify the call as `match`.
2. WHEN both deployments revert with byte-identical revert data, THE Séance_Engine SHALL classify the call as `match`.
3. WHEN both deployments revert and their revert data differs in at least one byte, including the case where one revert has empty revert data and the other does not, THE Séance_Engine SHALL classify the call as `reason-modernised`.
4. WHEN the Legacy_Deployment succeeds and the Port_Deployment reverts with revert data that is exactly the ABI encoding of `Panic(uint256)` with code `0x11`, THE Séance_Engine SHALL classify the call as `exorcised`.
5. WHEN the Legacy_Deployment succeeds and the Port_Deployment reverts with any revert data other than the `Panic(0x11)` encoding, THE Séance_Engine SHALL classify the call as `port-bug`.
6. WHEN the Legacy_Deployment reverts and the Port_Deployment succeeds, THE Séance_Engine SHALL classify the call as `port-bug`.
7. WHEN both deployments succeed and the return data differs in at least one byte, the Event_Logs differ in count, order, topics, or data, or the Observable_State differs in at least one value, THE Séance_Engine SHALL classify the call as `port-bug`.
8. THE Séance_Engine SHALL assign exactly one Classification, drawn from `match`, `reason-modernised`, `exorcised` and `port-bug`, to every call.
9. THE Séance_Engine SHALL compute the Classification as a pure function of the two Call_Records, so that identical Call_Record pairs always yield the same Classification and no other input, clock, or randomness affects the result.
10. IF a Call_Record is missing, malformed, or lacks a success or revert outcome, THEN THE Séance_Engine SHALL classify the call as `port-bug` and flag the call as having an invalid Call_Record.

### Requirement 5: Stop comparing after an exorcism

**User Story:** As an auditor, I want comparison to stop once the legacy and port states have legitimately diverged, so that later differences are not reported as port bugs.

#### Acceptance Criteria

1. WHEN a call is classified as `exorcised` (the legacy deployment succeeds and the 0.8 deployment reverts with `Panic(0x11)`), THE Differential_Handler SHALL stop comparing the two deployments for the remainder of the call sequence.
2. WHEN a call is classified as `exorcised`, THE Séance_Engine SHALL record the call sequence prefix up to and including the exorcised call, in original call order, with the index of the exorcised call.
3. WHILE comparison is stopped for a call sequence, THE Differential_Handler SHALL send zero further calls to either deployment in that sequence and SHALL report zero further divergences, of any class, for that sequence.
4. WHEN a new call sequence starts, THE Differential_Handler SHALL deploy a fresh legacy deployment and a fresh 0.8 deployment, each with no state carried over from any previous sequence, and SHALL resume comparison from the first call of the new sequence.
5. IF a call is classified as `port-bug` or `reason-modernised`, THEN THE Differential_Handler SHALL continue comparing and counting the remaining calls in the call sequence, and SHALL set `afterDivergence=true` (Divergence_Taint) on every Call_Record that follows the first `port-bug` of the scope defined as follows: IF a Setup_Record is classified as `port-bug`, THEN the scope SHALL be every fuzz call sequence, so that every Fuzz_Record carries `afterDivergence=true`; otherwise the scope SHALL be the single call sequence that contains the first `port-bug`.
6. WHEN a call sequence ends in the stopped state, THE Séance_Engine SHALL report that sequence as ending in an `exorcised` result, with the index of the exorcised call.

### Requirement 6: Legacy-aware input generation

**User Story:** As an auditor, I want inputs aimed at each unchecked arithmetic site, so that overflows such as BEC's `batchOverflow` are found within a bounded number of calls, including overflows whose wrapped result must pass a later guard.

#### Acceptance Criteria

1. WHEN the Input_Generator receives an Autopsy_Report, THE Input_Generator SHALL produce at least 1 and at most 64 Targeted_Values, counting each value or pair once, for every Arithmetic_Site in the report.
2. WHEN an Arithmetic_Site has the form `x * k` with a known factor `k` greater than 1, THE Input_Generator SHALL produce every value `x` from `ceil(M / k) - 2` to `ceil(M / k) + 2`, inclusive, clamped to the range 0 to `M - 1`, where `M` is `2^256` or the type-based replacement defined in criterion 6, so that the produced values include `floor(M / k)` and `ceil(M / k)` and number at most 5.
3. WHEN an Arithmetic_Site has the form `a + b` with a known operand `a`, THE Input_Generator SHALL produce every value `b` from `M - 1 - a - 2` to `M - 1 - a + 2`, inclusive, clamped to the range 0 to `M - 1`.
4. WHEN an Arithmetic_Site has the form `a - b` with a known operand `a`, THE Input_Generator SHALL produce every value `b` from `a - 2` to `a + 2`, inclusive, clamped to the range 0 to `M - 1`.
5. WHEN an Arithmetic_Site has the form `x * y` with both operands unknown, THE Input_Generator SHALL produce at least 1 pair `(x, y)` where `x * y` is at least `M` and the Wrapped_Product is smaller than both `x` and `y`, including the pair `(2^(N/2), 2^(N/2))`, which for uint256 operands is `(2^128, 2^128)` with a Wrapped_Product of 0, and SHALL produce at most 64 pairs.
6. WHEN an Arithmetic_Site operand has a type narrower than uint256, THE Input_Generator SHALL use `2^N` in place of `2^256` and `2^N - 1` in place of `2^256 - 1`, where `N` is the bit width of the narrowest operand type, and `M` in criteria 2 to 5 and 8 SHALL equal `2^N`.
7. WHEN an Arithmetic_Site is reached through a function parameter, THE Input_Generator SHALL map each Targeted_Value to the calldata position of that parameter in the function's ABI encoding.
8. WHEN an Arithmetic_Site is reached through a product of a dynamic array length and a value, as in BEC's `cnt * _value`, THE Input_Generator SHALL produce, for every array length `n` from 2 to 24 inclusive, the pair of `n` and the value `ceil(M / n)`, so that each product is at least `M` and the Wrapped_Product is smaller than `n`.
9. WHILE the Differential_Handler is drawing a value for a parameter that reaches at least one Arithmetic_Site and Targeted_Values exist, THE Differential_Handler SHALL use a Targeted_Value for every draw whose `keccak256(abi.encode(pick))` is even, selecting the entry at index `(hash >> 1) % n` where `n` is the number of entries, and SHALL use unconstrained fuzz input for every draw whose hash is odd, so that Targeted_Values are used about 50 percent of draws in expectation.
10. WHEN an Arithmetic_Site is reachable only after a state precondition, THE Input_Generator SHALL include a seed call sequence of at most 10 calls that establishes that precondition, such as a balance set by a constructor, a prior transfer, or an `approve`, before the call that reaches the site.
11. IF the Autopsy_Report contains no Arithmetic_Site, THEN THE Input_Generator SHALL return an empty Targeted_Value set and THE Differential_Handler SHALL use unconstrained fuzz input only.
12. IF the Input_Generator cannot determine a seed call sequence that reaches an Arithmetic_Site, THEN THE Input_Generator SHALL mark that site as unreachable in its output, produce Targeted_Values for it anyway, and not fail the run.
13. FOR ALL Arithmetic_Sites of the form `x * k` with a known factor `k` greater than 1, at least one Targeted_Value `x` SHALL satisfy both `x * k >= M` (overflow in the unchecked 0.4 semantics) and a Wrapped_Product smaller than `k` (overflow-and-wrap property).
14. FOR ALL array-length-times-value pairs produced under criterion 8, each pair SHALL satisfy both a product of at least `M` and a Wrapped_Product smaller than the array length.

### Requirement 7: Séance report

**User Story:** As a user of the web app, I want a JSON report with counts and shrunk calldata, so that I can see what the séance found.

#### Acceptance Criteria

1. WHEN a séance finishes, THE Séance_Engine SHALL write a Séance_Report as a single JSON file to `graveyard/<name>/`, where `<name>` is the contract's graveyard directory name.
2. IF the Séance_Engine cannot write the Séance_Report, THEN THE Séance_Engine SHALL report the séance as failed with an error indicating the write failure, and SHALL leave any previously existing Séance_Report in `graveyard/<name>/` unchanged.
3. THE Séance_Report SHALL contain the count of calls for each Classification (`match`, `reason-modernised`, `exorcised`, `port-bug`), with a count of 0 for any Classification that has no calls, the total number of calls, the fuzz seed, the number of runs in the field `runs`, the invariant depth in the field `depth`, the contract name, and the `shrinking` object of criterion 12 (which carries `pairsSetup` and `deadlineReached`).
4. THE Séance_Report SHALL contain, for each Exorcism and each Port_Bug, the function name, the calldata as a hex string (shrunk, or original when the finding is unshrunk), the sender address, the `msg.value` in wei as a decimal string, and the ordered sequence of preceding calls required to reproduce the call (an empty sequence when none are required), and, WHERE the finding is unshrunk, the field `unshrunk` set to true and the field `unshrunkReason` set to one Unshrunk_Reason.
5. WHERE the Séance_Engine can attribute an Arithmetic_Site to an Exorcism, THE Séance_Report SHALL contain that Arithmetic_Site, identified by site id and source location, for the Exorcism.
6. IF the Séance_Engine cannot attribute an Arithmetic_Site to an Exorcism, THEN THE Séance_Report SHALL mark the Arithmetic_Site of that Exorcism as unattributed.
7. THE Séance_Report SHALL contain, for each Port_Bug, the legacy Call_Record and the port Call_Record, including the Event_Logs of each.
8. THE Séance_Report SHALL validate against a published JSON schema that requires the fields `runs`, `depth`, `totalCalls`, `counts`, the `shrinking` object of criterion 12, and, on each unshrunk finding, `unshrunk` and `unshrunkReason`.
9. FOR ALL valid Séance_Report objects, serializing, then parsing, then serializing SHALL produce a byte-identical document to the first serialization (round-trip property).
10. THE Séance_Report SHALL contain Classification counts whose sum equals the total number of calls.
11. WHEN the same inputs and the same fuzz seed are used in two séances, THE Séance_Engine SHALL produce Séance_Reports with an identical total number of calls and an identical number of runs, where the Classification counts of each Séance_Report satisfy criterion 10.
12. THE Séance_Report SHALL contain a `shrinking` object with the required fields `witnessCap`, `pairsFound`, `pairsSetup`, `pairsShrunk`, `pairsUnshrunk`, `pairsOverCap`, and `deadlineReached`, where `pairsSetup` is the number of Finding_Pairs reported with Unshrunk_Reason `setup`, `pairsOverCap` is the number reported with `witness-cap`, `pairsUnshrunk` is the number reported with `witness-not-failed`, `replay-mismatch`, or `deadline`, `deadlineReached` is true when the Deadline was reached during the Witness_Phase or the Replay_Phase, and `pairsFound` equals the sum of `pairsSetup`, `pairsShrunk`, `pairsUnshrunk`, and `pairsOverCap`.

### Requirement 8: Shrinking

**User Story:** As an auditor, I want minimal reproducing calldata, so that I can understand each finding quickly.

#### Acceptance Criteria

1. WHEN Fuzz_Records yield Finding_Pairs, THE Séance_Engine SHALL shrink the call sequence of every `exorcised` or `port-bug` Finding_Pair using Foundry_Shrinking, ordering `exorcised` pairs before `port-bug` pairs and each group by first ordinal, except for Finding_Pairs reported unshrunk under criterion 5 (`setup`), criterion 6 (`witness-cap`), or Requirement 12 criterion 11 (`deadline`).
2. WHEN Foundry_Shrinking finishes for a Finding_Pair, THE Séance_Engine SHALL replay the shrunk sequence once against freshly deployed instances of the original bytecode and the port, and SHALL compare the replay Classification with the original Classification.
3. IF the replay of a shrunk sequence yields a Classification different from the original, THEN THE Séance_Engine SHALL report the original unshrunk sequence with `unshrunk` set to true and `unshrunkReason` set to `replay-mismatch`, and retain the original Classification.
4. WHEN several failing sequences share the same function and the same Classification, THE Séance_Engine SHALL report exactly one sequence for that (function, Classification) pair, selected only from Call_Records that have `afterDivergence=false`, and SHALL include every Call_Record with `afterDivergence=true` in the Classification counts of the Séance_Report.
5. WHEN the first Call_Record with `afterDivergence=false` of a Finding_Pair is a Setup_Record, THE Séance_Engine SHALL report the finding as-is with `unshrunk` set to true and `unshrunkReason` set to `setup`, SHALL NOT run the Witness_Phase or the Replay_Phase for that Finding_Pair, and SHALL NOT count that Finding_Pair toward the Witness_Cap.
6. WHEN Fuzz_Record Finding_Pairs exceed the Witness_Cap, THE Séance_Engine SHALL report each Finding_Pair beyond the Witness_Cap with its original sequence, `unshrunk` set to true, and `unshrunkReason` set to `witness-cap`.
7. IF the Foundry_Shrinking campaign of a Finding_Pair completes without reproducing the finding, THEN THE Séance_Engine SHALL report the original sequence with `unshrunk` set to true and `unshrunkReason` set to `witness-not-failed`.
8. THE Séance_Engine SHALL assign `unshrunkReason` only from the closed set `setup`, `witness-cap`, `witness-not-failed`, `replay-mismatch`, and `deadline`.
9. THE Séance_Engine SHALL store with every reported finding the sequence that reproduces it without the fuzz seed, where the stored sequence of a shrunk finding is the shrunk sequence, whose Classification is verified by the replay of criterion 2, and the stored sequence of an unshrunk finding, whatever its Unshrunk_Reason, is the original sequence recorded in the Discovery_Phase Call_Records, whose Classification is the one recorded in the Discovery_Phase and is not verified by replay.

### Requirement 9: BEC acceptance

**User Story:** As the Exhume maintainer, I want BEC to be the reference acceptance case, so that I can show the séance reproduces `batchOverflow`.

#### Acceptance Criteria

1. WHEN a séance runs on the BEC original bytecode (mainnet address `0xC5d105E63711398aF9bbff092d4B6769C82F793D`, compiled with solc 0.4.19, optimizer off) and its 0.8 port, THE Séance_Engine SHALL classify at least one divergence in `batchTransfer` as `exorcised` (legacy succeeds, 0.8 reverts with `Panic(0x11)`).
2. WHEN a séance runs on BEC and its 0.8 port, THE Séance_Engine SHALL report zero divergences classified as `port-bug` across all functions.
3. WHEN a séance runs on BEC and its 0.8 port, THE Séance_Engine SHALL find the first `batchTransfer` exorcised divergence within 2,000 fuzz calls, using inputs generated from the autopsy-identified unchecked arithmetic sites.
4. WHEN a séance on BEC reports the `batchTransfer` exorcised divergence, THE Séance_Report SHALL contain shrunk calldata in which the `_receivers` array length is between 2 and 20 inclusive, the product of the `_receivers` array length and `_value` is at least `2^256`, and the Wrapped_Product is less than or equal to the sender's balance in the Legacy_Deployment at the time of the call.
5. WHEN a séance on BEC reports the `batchTransfer` exorcised divergence, THE Séance_Engine SHALL accept the divergence only when the finding is shrunk and the replay of Requirement 8 criterion 2 on freshly deployed instances yields the Classification `exorcised`.
6. WHEN a séance on BEC completes and the BEC acceptance run has not failed, THE Exhume system SHALL store the Séance_Report in the `graveyard/bec/` directory, so that it is available as the precomputed report for the BEC entry.
7. IF the séance on BEC finds no exorcised divergence in `batchTransfer` within 2,000 calls, or reports one or more `port-bug` divergences, THEN THE Séance_Engine SHALL fail the BEC acceptance run with the error code `ACCEPTANCE_FAILED` naming the failing condition (missing exorcism, call budget exceeded, or port bug count), SHALL NOT overwrite an existing stored Séance_Report in `graveyard/bec/`, and SHALL return a non-zero failure indication to the caller.
8. IF the `batchTransfer` finding of the BEC séance is reported unshrunk with any Unshrunk_Reason (`setup`, `witness-cap`, `witness-not-failed`, `replay-mismatch`, or `deadline`), THEN THE Séance_Engine SHALL fail the BEC acceptance run with the error code `ACCEPTANCE_FAILED` naming that Unshrunk_Reason as `unshrunkReason`, SHALL NOT overwrite an existing stored Séance_Report in `graveyard/bec/`, and SHALL return a non-zero failure indication to the caller.

### Requirement 10: Planted port bug acceptance

**User Story:** As the Exhume maintainer, I want planted port bugs to be caught, so that I know the séance can detect real defects and does not only report successes.

#### Acceptance Criteria

1. WHEN a séance completes on the BEC Legacy_Contract and a Port_Contract containing the Planted_Port_Bug, THE Séance_Engine SHALL report at least one divergence classified as `port-bug` and SHALL report zero divergences classified as `match` for the inputs that trigger the Planted_Port_Bug.
2. WHEN a séance completes with the Planted_Port_Bug, THE Séance_Engine SHALL attribute at least one reported Port_Bug to the `transferFrom` function.
3. WHEN a séance completes with the Planted_Port_Bug, THE Séance_Report SHALL contain, for at least one Port_Bug attributed to `transferFrom`, shrunk calldata and a preceding call sequence of 3 calls or fewer, excluding the failing call itself, where the preceding call sequence may contain the `approve` call that establishes the allowance.
4. THE Séance_Engine SHALL include in the Observable_State the `allowed` mapping value for every ordered (owner, spender) pair in the Actor_Set, and SHALL compare these values between the Legacy_Deployment and the Port_Deployment after each call.
5. IF the `allowed` value for any ordered (owner, spender) pair differs between the Legacy_Deployment and the Port_Deployment after a call that returned the same result in both, THEN THE Séance_Engine SHALL classify the divergence as `port-bug`.
6. IF a séance on the Planted_Port_Bug Port_Contract reports zero Port_Bug divergences, THEN THE Séance_Engine SHALL mark the acceptance check as failed and SHALL return a non-zero failure indication to the caller.
7. WHEN a séance completes on the BEC Legacy_Contract and a Port_Contract containing the Dropped_Emit_Mutation, THE Séance_Engine SHALL report at least one divergence for the `transfer` function classified as `port-bug` that arises from the token-share `transfer` in setup, whose differing field is the Event_Logs, whose `unshrunkReason` is `setup`, and SHALL report the legacy Event_Logs and the port Event_Logs for that divergence, without requiring a shrunk finding.
8. IF a séance on the Dropped_Emit_Mutation Port_Contract reports zero Port_Bug divergences, THEN THE Séance_Engine SHALL mark the acceptance check as failed and SHALL return a non-zero failure indication to the caller.

### Requirement 11: Autopsy input contract

**User Story:** As a maintainer, I want the séance to consume the Autopsy output through a minimal, versioned contract, so that the two stages stay decoupled.

#### Acceptance Criteria

1. THE Autopsy_Report SHALL contain a required `schemaVersion` field and, for each Arithmetic_Site, only the fields the séance needs: site id, function, operator, operand information and types, and source location.
2. WHEN the Séance_Engine receives an Autopsy_Report, THE Séance_Engine SHALL check the Schema_Version before any other validation.
3. IF the Schema_Version is not supported by the Séance_Engine, THEN THE Séance_Engine SHALL reject the Autopsy_Report, return an error that names the unsupported Schema_Version, and generate no séance inputs.
4. IF the `schemaVersion` field is missing, THEN THE Séance_Engine SHALL reject the Autopsy_Report, return an error that names the missing `schemaVersion` field, and generate no séance inputs.
5. WHEN the Autopsy_Report has a supported Schema_Version, THE Séance_Engine SHALL validate the Autopsy_Report against the published JSON schema for that version before reading any Arithmetic_Site.
6. WHEN the Autopsy_Report validates against the schema, THE Séance_Engine SHALL read every Arithmetic_Site in the Autopsy_Report and make each one available for séance input generation.
7. IF the Autopsy_Report does not validate against the schema, THEN THE Séance_Engine SHALL reject the Autopsy_Report, return an error that lists every schema violation with the location of each violation in the document, and generate no séance inputs.
8. IF an Arithmetic_Site refers to a function that does not exist in the Legacy_Contract ABI, THEN THE Séance_Engine SHALL reject the Autopsy_Report, return an error that names every such function, and generate no séance inputs.
9. FOR ALL valid Autopsy_Report objects, serializing, then parsing, then serializing SHALL produce a document equal to the first serialization, and parsing the serialized document SHALL produce an object deeply equal to the original (round-trip property).
10. IF the Autopsy_Report is empty, is not parseable as JSON, or exceeds 10 MB, THEN THE Séance_Engine SHALL return an error that states which of these conditions occurred and generate no séance inputs.

### Requirement 12: Local entry point

**User Story:** As a developer, I want a local command-line and library entry point in `engine/`, so that I can run a séance without the Worker and so that the Worker can later call the same code.

#### Acceptance Criteria

1. WHEN the Entry_Point receives a contract name, the legacy source, the port source, the Autopsy_Report, the legacy solc version, the legacy optimizer setting, the On_Chain_Runtime_Code, and an optional fuzz seed, THE Entry_Point SHALL run `forge` on the generated Foundry_Project, write the Séance_Report to `graveyard/<name>/`, and return the Séance_Report to the caller.
2. WHEN the Entry_Point returns a Séance_Report, THE Entry_Point SHALL ensure that every call in the Séance_Report is classified as exactly one of `match`, `reason-modernised`, `exorcised`, or `port-bug`.
3. WHEN the Entry_Point is invoked as a command-line program and the séance completes, THE Entry_Point SHALL exit with status 0.
4. IF an input is missing, THEN THE Entry_Point SHALL return a structured error containing an error code and a message that names every missing input, SHALL NOT start a run, and SHALL exit with a non-zero status when invoked as a command-line program.
5. IF an input is present but invalid (a contract name that is empty or longer than 128 characters, an optimizer setting that is not a boolean, or source text that is empty or larger than 1 MiB), THEN THE Entry_Point SHALL return a structured error containing an error code and a message that names every invalid input, SHALL NOT start a run, and SHALL exit with a non-zero status when invoked as a command-line program.
6. IF a séance fails for any other reason, THEN THE Entry_Point SHALL return a structured error containing an error code and a message, and SHALL exit with a non-zero status when invoked as a command-line program.
7. WHERE a timeout is configured, THE Entry_Point SHALL use that timeout in seconds, and WHERE no timeout is configured, THE Entry_Point SHALL use a timeout of 300 seconds.
8. IF the Deadline is reached during `forge build` or the Discovery_Phase, THEN THE Entry_Point SHALL stop `forge` within 5 seconds of the Deadline, write no Séance_Report, return a structured error with the error code `TIMEOUT` and a `phase` field, and exit with a non-zero status when invoked as a command-line program.
9. IF the Deadline is reached during `forge build`, THEN THE Entry_Point SHALL set the `phase` field of the `TIMEOUT` error to `build` and SHALL include no partial counts in the error.
10. IF the Deadline is reached during the Discovery_Phase, THEN THE Entry_Point SHALL set the `phase` field of the `TIMEOUT` error to `discovery` and SHALL include in the error the partial counts collected so far for each Classification.
11. IF the Deadline is reached during the Witness_Phase or the Replay_Phase, THEN THE Entry_Point SHALL stop `forge` within 5 seconds of the Deadline, launch no further `forge` runs, return no `TIMEOUT` error, report every Finding_Pair not yet shrunk and replayed with its original sequence, `unshrunk` set to true, and `unshrunkReason` set to `deadline`, set `deadlineReached` to true, write the Séance_Report, and exit with status 0 when invoked as a command-line program.
12. WHEN a fuzz seed is supplied, THE Entry_Point SHALL pass the fuzz seed to Foundry unchanged and SHALL record the fuzz seed in the Séance_Report, as a best-effort aid only, because Foundry 1.5.1 does not reproduce an invariant campaign from the fuzz seed.
