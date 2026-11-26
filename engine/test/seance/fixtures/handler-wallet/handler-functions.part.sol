    // HAND-WRITTEN FIXTURE: expected generator output for `// @@HANDLER_FUNCTIONS@@` (Wallet fixture).

    function handler_deposit(uint256 pick, uint8 actorIdx, uint256 weiValue) external {
        uint256[] memory p = new uint256[](0);
        _applyTargets(pick, Targets.targets_deposit(), p);
        bytes memory cd = abi.encodeWithSignature("deposit()");
        _differential("deposit", cd, _sender(actorIdx), weiValue % (ACTOR_WEI + 1), true);
    }

    function handler_approve(uint256 pick, uint8 actorIdx, uint8 s, uint256 v) external {
        uint256[] memory p = new uint256[](2);
        p[1] = v;
        _applyTargets(pick, Targets.targets_approve(), p);
        bytes memory cd = abi.encodeWithSignature("approve(address,uint256)", _addr(s), p[1]);
        _differential("approve", cd, _sender(actorIdx), 0, false);
    }

    function handler_crash(uint256 pick, uint8 actorIdx) external {
        pick;
        _differential("crash", abi.encodeWithSignature("crash()"), _sender(actorIdx), 0, false);
    }

    // The ABI has a payable fallback, so both fallback handlers exist (Requirement 3.6).
    function handler_fallback_empty(uint256 pick, uint8 actorIdx, uint256 weiValue) external {
        pick;
        _differential("fallback", "", _sender(actorIdx), weiValue % (ACTOR_WEI + 1), true);
    }

    function handler_fallback_unknown(uint256 pick, uint8 actorIdx, bytes calldata data, uint256 weiValue) external {
        pick;
        _differential("fallback", _unknownCalldata(data), _sender(actorIdx), weiValue % (ACTOR_WEI + 1), true);
    }
