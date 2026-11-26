// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// =============================================================================
// Discovery invariant test template (task 8.4). Generated to test/Seance.t.sol.
//
// PLACEHOLDER MECHANISM (for the Project_Generator, task 8.5)
// -----------------------------------------------------------
// The file is a complete, compilable contract. The generator replaces the one marker
// LINE (the whole line, whatever its indentation, `// @@HANDLER_SELECTORS@@`) with
// statements that fill `sels`, one per typed handler function (every `handler_*`
// external function and nothing else), for example:
//
//         sels = new bytes4[](2);
//         sels[0] = DifferentialHandler.handler_transfer.selector;
//         sels[1] = DifferentialHandler.handler_batchTransfer.selector;
//
// Phase 1 (discovery) runs `--match-contract '^SeanceDiscovery$' --match-test invariant_discovery`
// with SEANCE_RECORD=1. `invariant_discovery` is the ONLY `invariant_` function: Foundry stops a
// campaign at the first failing invariant, which would truncate the record counts. It asserts
// nothing, so it fails only when the handler itself reverts (`fail_on_revert = true` makes that
// an engine fault, HANDLER_FAULT). Classification results are read from the records, never asserted.
// =============================================================================

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {DifferentialHandler} from "./handler/DifferentialHandler.sol";

contract SeanceDiscovery is StdInvariant, Test {
    DifferentialHandler internal handler;

    function setUp() public {
        handler = new DifferentialHandler();
        // Before init: creates ./seance-out and truncates the file when recording is on.
        handler.setOutputPath("seance-out/records.jsonl");
        // Deploys both bytecodes, token shares, seed sequences.
        handler.init();
        // The handler is the only fuzz target; the deployments are never fuzzed directly.
        targetContract(address(handler));
        excludeContract(handler.legacy());
        excludeContract(handler.port());
        excludeSender(handler.legacy());
        excludeSender(handler.port());
        targetSelector(FuzzSelector({addr: address(handler), selectors: handlerSelectors()}));
    }

    /// Only the typed `handler_*` functions are fuzz entry points.
    function handlerSelectors() internal pure returns (bytes4[] memory sels) {
        // @@HANDLER_SELECTORS@@
    }

    /// The only `invariant_` function of this contract.
    function invariant_discovery() public view {}
}
