// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

// Appends exactly one line per call, tagged with a per-run call index (handler storage resets every
// run, so each sequence starts at idx 0). Never reverts, so fail_on_revert cannot cut a run short.
contract Handler is Test {
    string constant FILE = "./seance-out/records.jsonl";
    uint256 public idx;

    function record(uint256 x) external {
        vm.writeLine(FILE, string.concat('{"idx":', vm.toString(idx), ',"x":', vm.toString(x), "}"));
        idx++;
    }
}

contract WriteLineInvariant is StdInvariant, Test {
    Handler handler;

    function setUp() public {
        // Truncate/create the record file once per campaign.
        vm.writeFile("./seance-out/records.jsonl", "");
        handler = new Handler();
        targetContract(address(handler));
    }

    function invariant_always_true() public pure {
        assertTrue(true);
    }
}

// Writes outside ./seance-out must be rejected by fs_permissions.
contract OutsideWrite is Test {
    function _attempt(string memory label, string memory path) internal returns (bool failed) {
        try vm.writeLine(path, "x") {
            console.log(string.concat("OUTSIDE_WRITE_SUCCEEDED:", label));
            return false;
        } catch Error(string memory reason) {
            console.log(string.concat("OUTSIDE_ERR:", label, ":", reason));
            return true;
        } catch (bytes memory raw) {
            console.log(string.concat("OUTSIDE_ERR:", label, ":raw:", vm.toString(raw)));
            return true;
        }
    }

    function test_outside_write_rejected() public {
        bool a = _attempt("sibling", "./outside.txt");
        bool b = _attempt("traversal", "./seance-out/../outside2.txt");
        bool c = _attempt("src", "./src/injected.txt");
        assertTrue(a && b && c, "a write outside ./seance-out succeeded");
    }
}
