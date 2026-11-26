// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
// Task 8.8 (B): one handler call that reaches `crash()` (legacy `assert(false)` = invalid opcode,
// which burns every unit of gas it was given), measured from the test contract.
// The handler forwards at most GAS_CAP = 10,000,000 to each deployment, so the whole handler call
// must cost about GAS_CAP and never approach the 1,000,000,000 block gas limit of foundry.toml.
// The call must return (a revert here fails the test), and the handler must keep going afterwards.
import {Test} from "forge-std/Test.sol";
import {DifferentialHandler} from "./handler/DifferentialHandler.sol";

contract GasCapTest is Test {
    DifferentialHandler internal handler;

    function setUp() public {
        handler = new DifferentialHandler();
        handler.setOutputPath("seance-out/records.jsonl");
        handler.init();
    }

    function test_assertReturnsControlWithinCap() public {
        uint256 before_ = gasleft();
        handler.handler_crash(0, 1);
        uint256 used = before_ - gasleft();
        emit log_named_uint("CRASH_GAS_USED", used);
        // Never near the block gas limit; two capped sides at most, plus handler work.
        assertLt(used, 2 * 10_000_000 + 2_000_000, "handler call exceeded two caps plus overhead");
        assertFalse(handler.stopped(), "handler stopped after the crash call");
        // Control came back: the next calls are recorded.
        uint256 beforeNext = gasleft();
        handler.handler_approve(0, 1, 1, 5);
        emit log_named_uint("NEXT_CALL_GAS_USED", beforeNext - gasleft());
        handler.handler_deposit(0, 2, 3);
    }
}
