    // HAND-WRITTEN FIXTURE: expected generator output for `// @@HANDLER_FUNCTIONS@@` (token fixture).
    // One slot of `p` per ABI parameter: scalar value, or array length. Address parameters take an
    // Actor_Set index. Payable functions would add a `uint256 weiValue` bounded to ACTOR_WEI.

    function handler_transfer(uint256 pick, uint8 actorIdx, uint8 to, uint256 value_) external {
        uint256[] memory p = new uint256[](2);
        p[1] = value_;
        _applyTargets(pick, Targets.targets_transfer(), p);
        bytes memory cd = abi.encodeWithSignature("transfer(address,uint256)", _addr(to), p[1]);
        _differential("transfer", cd, _sender(actorIdx), 0, false);
    }

    function handler_batchTransfer(
        uint256 pick,
        uint8 actorIdx,
        uint8 receivers_len,
        uint256 receivers_idxPack,
        uint256 value_
    ) external {
        uint256[] memory p = new uint256[](2);
        p[0] = receivers_len;
        p[1] = value_;
        _applyTargets(pick, Targets.targets_batchTransfer(), p);
        address[] memory receivers = _addressArray(p[0], receivers_idxPack);
        bytes memory cd = abi.encodeWithSignature("batchTransfer(address[],uint256)", receivers, p[1]);
        _differential("batchTransfer", cd, _sender(actorIdx), 0, false);
    }
