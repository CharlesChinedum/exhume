// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// THROWAWAY (task 8.3): probes setWitness / witnessHit. Task 8.4 writes the real Witness.t.sol.
import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {DifferentialHandler} from "./handler/DifferentialHandler.sol";
import {Classifier} from "./handler/Classifier.sol";

abstract contract WitnessBase is StdInvariant, Test {
    DifferentialHandler handler;

    function _setUp(string memory fn, Classifier.Class cls) internal {
        handler = new DifferentialHandler();
        handler.setOutputPath("seance-out/witness.jsonl");
        handler.init();
        handler.setWitness(fn, cls);
        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](2);
        sels[0] = DifferentialHandler.handler_transfer.selector;
        sels[1] = DifferentialHandler.handler_batchTransfer.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    function invariant_witness() public view {
        assertFalse(handler.witnessHit());
    }
}

/// The pair occurs: the invariant must fail.
contract WitnessHit is WitnessBase {
    function setUp() public {
        _setUp("batchTransfer", Classifier.Class.Exorcised);
    }
}

/// The pair never occurs on the unmodified port: the invariant must pass.
contract WitnessMiss is WitnessBase {
    function setUp() public {
        _setUp("transfer", Classifier.Class.Exorcised);
    }
}
