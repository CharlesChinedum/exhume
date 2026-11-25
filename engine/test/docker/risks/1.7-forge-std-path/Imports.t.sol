// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.0 <0.9.0;
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Vm} from "forge-std/Vm.sol";

// Task 1.7: the imports used by the generated invariant test must resolve.
// Test already inherits StdInvariant, so it is imported here for a standalone contract.
contract Probe is StdInvariant {
    function targets() external view returns (uint256) {
        return targetContracts().length;
    }
}

contract ImportsTest is Test {
    function test_importsResolve() public {
        Vm v = vm;
        v.recordLogs();
        Vm.Log[] memory logs = v.getRecordedLogs();
        assertEq(logs.length, 0);
        assertEq(new Probe().targets(), 0);
        assertEq(targetContracts().length, 0);
    }
}
