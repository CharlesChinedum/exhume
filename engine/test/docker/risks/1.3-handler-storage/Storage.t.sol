// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

// One record per call: {"idx":<n>,"v":<fuzzed arg>}. idx lives in handler storage and is set to its
// post-setUp value (0) by setUp. Never reverts.
contract Handler is Test {
    string constant FILE = "./seance-out/records.jsonl";
    uint256 public idx;

    // Called from setUp. Writes the setup marker line (idx == -1) and leaves idx at 0.
    function setupRecord() external {
        vm.writeLine(FILE, '{"idx":-1,"kind":"setup"}');
        idx = 0;
    }

    // The fuzzed argument is recorded too, so sequences are distinguishable from each other.
    function record(uint256 v) external {
        vm.writeLine(FILE, string.concat('{"idx":', vm.toString(idx), ',"v":', vm.toString(v), "}"));
        idx += 1;
    }
}

contract StorageInvariant is StdInvariant, Test {
    Handler handler;

    function setUp() public {
        vm.writeFile("./seance-out/records.jsonl", "");
        handler = new Handler();
        handler.setupRecord();
        // setupRecord is external, so it must be excluded from fuzzing: only record() is a target.
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = Handler.record.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function invariant_always_true() public pure {
        assertTrue(true);
    }
}
