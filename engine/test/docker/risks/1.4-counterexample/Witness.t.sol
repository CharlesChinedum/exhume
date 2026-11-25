// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

// The witness is reached only by calling arm(0xA11CE) and later fire(7) from the same run,
// in that order. noise() calls are irrelevant, so shrinking has something to remove.
contract WitnessHandler {
    bool public armed;
    bool public witnessHit;
    uint256 public noiseCalls;

    function noise(uint256 v) external {
        noiseCalls += v % 2 + 1;
    }

    function arm(uint256 key) external {
        if (key % 4 == 1) armed = true;
    }

    function fire(uint256 n) external {
        if (armed && n % 4 == 3) witnessHit = true;
    }
}

abstract contract WitnessBase is StdInvariant, Test {
    WitnessHandler handler;

    function _targets() internal virtual returns (bytes4[] memory);

    function setUp() public {
        handler = new WitnessHandler();
        targetSelector(FuzzSelector({addr: address(handler), selectors: _targets()}));
    }

    function invariant_witness() public view {
        assertTrue(!handler.witnessHit(), "witness hit");
    }
}

// Fails: fire is a target, so arm then fire is reachable.
contract WitnessFailing is WitnessBase {
    function _targets() internal pure override returns (bytes4[] memory s) {
        s = new bytes4[](3);
        s[0] = WitnessHandler.noise.selector;
        s[1] = WitnessHandler.arm.selector;
        s[2] = WitnessHandler.fire.selector;
    }
}

// Passes: fire is not a target, so the witness is unreachable.
contract WitnessPassing is WitnessBase {
    function _targets() internal pure override returns (bytes4[] memory s) {
        s = new bytes4[](2);
        s[0] = WitnessHandler.noise.selector;
        s[1] = WitnessHandler.arm.selector;
    }
}
