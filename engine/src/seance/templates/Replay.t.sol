// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// =============================================================================
// Replay test template (task 8.4). Generated to test/Replay.t.sol.
//
// One file holds `ReplayBase` and the ten contracts `SeanceReplay1` .. `SeanceReplay10`, one per
// shrunk sequence. Each contract has its own `setUp` and its own record file
// `seance-out/replay-<k>.jsonl`, set BEFORE `init`, so replays never share a file (two may run in
// parallel). The Runner selects one with `--match-contract '^SeanceReplay<k>$'` (anchored, because
// `SeanceReplay1` would also match `SeanceReplay10`) and SEANCE_RECORD=1.
//
// `test_replay` runs the shrunk handler calls, in order, on a fresh `setUp` (fresh deployments, seed
// calls, recording on). The handler derives block time from `idx` and picks the sender from the
// `actorIdx` argument, so no `vm.prank` is needed and the replay is deterministic. The engine then
// reads the replay records: the setup records followed by one record per replayed call.
//
// PLACEHOLDER MECHANISM (for the Project_Generator, task 8.5)
// -----------------------------------------------------------
// The file compiles as it stands, and every `test_replay` is then an empty body. After phase 2 the
// generator replaces the marker LINE `// @@REPLAY_CALLS_<k>@@` (the whole line, whatever its
// indentation; k = 1..10, matching the witness index) of each shrunk pair with one Solidity
// statement per call of `counterexample.Sequence[1]`, in order:
//
//         handler.handler_batchTransfer(<arg0>, <arg1>, ...);
//
// The function is named by the call's `func_name`. The arguments are decoded from the call's
// `calldata` (after the 4-byte selector) with the handler function's own signature: a `uint256` or
// `uint8` parameter becomes a decimal literal, a `bytes` parameter (fallback with unknown selector)
// becomes a `hex"..."` literal. Array parameters never reach the handler's signature (they are
// lengths, packs and seeds). A pair without a shrunk sequence keeps its marker line untouched.
// The call encoding is the generator's concern; this file only fixes the markers.
// =============================================================================

import {Test} from "forge-std/Test.sol";
import {DifferentialHandler} from "./handler/DifferentialHandler.sol";

abstract contract ReplayBase is Test {
    DifferentialHandler internal handler;

    /// `path` must be under `seance-out/` and unique per replay contract.
    function _setUp(string memory path) internal {
        handler = new DifferentialHandler();
        handler.setOutputPath(path); // before init
        handler.init();
    }
}

contract SeanceReplay1 is ReplayBase {
    function setUp() public { _setUp("seance-out/replay-1.jsonl"); }

    function test_replay() public {
        // @@REPLAY_CALLS_1@@
    }
}

contract SeanceReplay2 is ReplayBase {
    function setUp() public { _setUp("seance-out/replay-2.jsonl"); }

    function test_replay() public {
        // @@REPLAY_CALLS_2@@
    }
}

contract SeanceReplay3 is ReplayBase {
    function setUp() public { _setUp("seance-out/replay-3.jsonl"); }

    function test_replay() public {
        // @@REPLAY_CALLS_3@@
    }
}

contract SeanceReplay4 is ReplayBase {
    function setUp() public { _setUp("seance-out/replay-4.jsonl"); }

    function test_replay() public {
        // @@REPLAY_CALLS_4@@
    }
}

contract SeanceReplay5 is ReplayBase {
    function setUp() public { _setUp("seance-out/replay-5.jsonl"); }

    function test_replay() public {
        // @@REPLAY_CALLS_5@@
    }
}

contract SeanceReplay6 is ReplayBase {
    function setUp() public { _setUp("seance-out/replay-6.jsonl"); }

    function test_replay() public {
        // @@REPLAY_CALLS_6@@
    }
}

contract SeanceReplay7 is ReplayBase {
    function setUp() public { _setUp("seance-out/replay-7.jsonl"); }

    function test_replay() public {
        // @@REPLAY_CALLS_7@@
    }
}

contract SeanceReplay8 is ReplayBase {
    function setUp() public { _setUp("seance-out/replay-8.jsonl"); }

    function test_replay() public {
        // @@REPLAY_CALLS_8@@
    }
}

contract SeanceReplay9 is ReplayBase {
    function setUp() public { _setUp("seance-out/replay-9.jsonl"); }

    function test_replay() public {
        // @@REPLAY_CALLS_9@@
    }
}

contract SeanceReplay10 is ReplayBase {
    function setUp() public { _setUp("seance-out/replay-10.jsonl"); }

    function test_replay() public {
        // @@REPLAY_CALLS_10@@
    }
}
