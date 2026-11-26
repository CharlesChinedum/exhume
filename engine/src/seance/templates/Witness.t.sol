// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// =============================================================================
// Witness test template (task 8.4). Generated to test/Witness.t.sol.
//
// One file holds `WitnessBase` and the ten contracts `Witness1` .. `Witness10`. They are identical
// except for the index passed to `_setUp`, and are independent of each other: `Witness<k>` reads only
// its own pair through `_pair(k)`. The Runner selects one with `--match-contract '^Witness<k>$'`
// (anchored, because `Witness1` would also match `Witness10`), SEANCE_RECORD=0 and
// FOUNDRY_INVARIANT_SHRINK_RUN_LIMIT=5000.
//
// PLACEHOLDER MECHANISM (for the Project_Generator, task 8.5)
// -----------------------------------------------------------
// The file compiles as it stands. The generator replaces each marker LINE (the whole line,
// whatever its indentation) with generated Solidity:
//
//   // @@HANDLER_SELECTORS@@   statements filling `sels`, as in Seance.t.sol.
//   // @@WITNESS_PAIRS@@      the body of `_pair(uint256 k)`: one `if (k == <k>) return ("<fn>",
//                             Classifier.Class.<Exorcised|PortBug>);` per selected pair (k = 1..10,
//                             `<fn>` the handler's function name string, the same one written as
//                             `function` in the records). Indices without a pair are not written;
//                             the trailing `revert` then makes an unused `Witness<k>` fail loudly.
//
// `invariant_witness` fails once the handler has recorded an untainted fuzz record with the pair
// (`handler.witnessHit()`); forge then shrinks the call sequence and reports it in
// `counterexample.Sequence[1]`.
// =============================================================================

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {DifferentialHandler} from "./handler/DifferentialHandler.sol";
import {Classifier} from "./handler/Classifier.sol";

abstract contract WitnessBase is StdInvariant, Test {
    DifferentialHandler internal handler;

    function _setUp(uint256 k) internal {
        (string memory fn, Classifier.Class cls) = _pair(k);
        handler = new DifferentialHandler();
        // Recording is off for witness campaigns; the path only keeps files apart if it is ever on.
        handler.setOutputPath(string.concat("seance-out/witness-", vm.toString(k), ".jsonl"));
        handler.init();
        handler.setWitness(fn, cls);
        targetContract(address(handler));
        excludeContract(handler.legacy());
        excludeContract(handler.port());
        excludeSender(handler.legacy());
        excludeSender(handler.port());
        targetSelector(FuzzSelector({addr: address(handler), selectors: handlerSelectors()}));
    }

    function handlerSelectors() internal pure returns (bytes4[] memory sels) {
        // @@HANDLER_SELECTORS@@
    }

    function _pair(uint256 k) internal pure returns (string memory fn, Classifier.Class cls) {
        // @@WITNESS_PAIRS@@
        k;
        fn;
        cls;
        revert("WITNESS_UNUSED");
    }

    /// Fails when the witnessed (function, class) pair was observed on an untainted fuzz record.
    function invariant_witness() public view {
        assertFalse(handler.witnessHit());
    }
}

contract Witness1 is WitnessBase {
    function setUp() public { _setUp(1); }
}

contract Witness2 is WitnessBase {
    function setUp() public { _setUp(2); }
}

contract Witness3 is WitnessBase {
    function setUp() public { _setUp(3); }
}

contract Witness4 is WitnessBase {
    function setUp() public { _setUp(4); }
}

contract Witness5 is WitnessBase {
    function setUp() public { _setUp(5); }
}

contract Witness6 is WitnessBase {
    function setUp() public { _setUp(6); }
}

contract Witness7 is WitnessBase {
    function setUp() public { _setUp(7); }
}

contract Witness8 is WitnessBase {
    function setUp() public { _setUp(8); }
}

contract Witness9 is WitnessBase {
    function setUp() public { _setUp(9); }
}

contract Witness10 is WitnessBase {
    function setUp() public { _setUp(10); }
}
