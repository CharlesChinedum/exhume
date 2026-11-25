// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.0 <0.9.0;

import {Test} from "forge-std/Test.sol";

// Task 1.5: both artifacts share the contract name `Token`; they are told apart only by file name.
contract DeployCodeTest is Test {
    function test_deployBothByFileName() public {
        address legacy = deployCode("LegacyToken.sol:Token");
        address port = deployCode("PortToken.sol:Token");
        assertTrue(legacy != address(0) && port != address(0), "deploy returned zero");
        assertTrue(legacy.code.length > 0 && port.code.length > 0, "empty runtime code");
        bytes32 lh = keccak256(legacy.code);
        bytes32 ph = keccak256(port.code);
        assertTrue(lh != ph, "legacy and port runtime code are identical");
        // Each deployment is the artifact it was named after (no immutables, so equality holds).
        assertEq(lh, keccak256(vm.getDeployedCode("LegacyToken.sol:Token")), "legacy deploy != legacy artifact");
        assertEq(ph, keccak256(vm.getDeployedCode("PortToken.sol:Token")), "port deploy != port artifact");
        vm.writeFile("seance-out/hashes.txt", string.concat(vm.toString(lh), " ", vm.toString(ph)));
    }
}
