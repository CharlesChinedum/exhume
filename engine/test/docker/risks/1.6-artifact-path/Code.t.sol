// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.8.0 <0.9.0;
import {Test} from "forge-std/Test.sol";
// Task 1.6: record the runtime code that is actually deployed, for comparison with the artifact's deployedBytecode.
contract CodeTest is Test {
    function _create(bytes memory init) internal returns (address a) {
        assembly { a := create(0, add(init, 0x20), mload(init)) }
    }
    function test_recordDeployedCode() public {
        address legacy = deployCode("LegacyToken.sol:Token");
        address port = deployCode("PortToken.sol:Token");
        // Second route: raw CREATE from the creation bytecode in the artifact (no cheatcode deploy).
        address legacyRaw = _create(vm.getCode("LegacyToken.sol:Token"));
        assertTrue(legacy.code.length > 0 && port.code.length > 0 && legacyRaw.code.length > 0, "empty runtime code");
        vm.writeFile("seance-out/legacy.deploycode.hex", vm.toString(legacy.code));
        vm.writeFile("seance-out/legacy.rawcreate.hex", vm.toString(legacyRaw.code));
        vm.writeFile("seance-out/legacy.getdeployed.hex", vm.toString(vm.getDeployedCode("LegacyToken.sol:Token")));
        vm.writeFile("seance-out/port.deploycode.hex", vm.toString(port.code));
    }
}
