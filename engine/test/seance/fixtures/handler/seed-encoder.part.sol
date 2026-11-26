    // HAND-WRITTEN FIXTURE: expected generator output for `// @@SEED_ENCODER@@` (token fixture).
    function _seedCalldata(Targets.Seed memory s) internal pure returns (bytes memory) {
        bytes32 h = keccak256(bytes(s.fn));
        if (h == keccak256("transfer")) {
            // arg 0 is an Actor_Set index decoded through `_addr`, arg 1 a plain integer
            return abi.encodeWithSignature("transfer(address,uint256)", _addr(uint8(s.args[0])), s.args[1]);
        }
        revert("UNKNOWN_SEED_FUNCTION");
    }
