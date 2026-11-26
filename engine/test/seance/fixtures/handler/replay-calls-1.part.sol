        // HAND-WRITTEN FIXTURE: expected generator output for `// @@REPLAY_CALLS_1@@` (token fixture).
        // One call: batchTransfer with 2 receivers and value 2^255 (cnt * value == 2^256 overflows).
        // The calldata decoding of a real counterexample into these statements is done by the generator (task 8.5).
        // pick = 3 has odd keccak parity, so no target entry replaces the arguments.
        handler.handler_batchTransfer(3, 1, 2, 0, 57896044618658097711785492504343953926634992332820282019728792003956564819968);
