// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// THROWAWAY (task 8.3): minimal stand-in for the real Seance.t.sol that task 8.4 writes.
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {DifferentialHandler} from "./handler/DifferentialHandler.sol";

contract SeanceDiscovery is StdInvariant, Test {
    DifferentialHandler handler;

    function setUp() public {
        handler = new DifferentialHandler();
        handler.setOutputPath("seance-out/records.jsonl");
        handler.init();
        targetContract(address(handler));
        excludeContract(handler.legacy());
        excludeContract(handler.port());
        excludeSender(handler.legacy());
        excludeSender(handler.port());
        bytes4[] memory sels = new bytes4[](5);
        sels[0] = DifferentialHandler.handler_deposit.selector;
        sels[1] = DifferentialHandler.handler_approve.selector;
        sels[2] = DifferentialHandler.handler_crash.selector;
        sels[3] = DifferentialHandler.handler_fallback_empty.selector;
        sels[4] = DifferentialHandler.handler_fallback_unknown.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    function invariant_discovery() public view {}
}
