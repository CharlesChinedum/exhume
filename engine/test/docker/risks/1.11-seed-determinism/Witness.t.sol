// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

// Task 1.11 copy of the task 1.9 witness fixture with an added mode "rare1e4" (SEANCE_WITNESS=rare1e4).
// Task 1.9 benchmark: a witness campaign. The handler is the task 1.8 handler (same per-call work) with
// a generated-style witness condition added: the handler sets `hit` when a specific (function, class)
// condition is reached, and `invariant_witness` asserts `hit` is false, so the campaign FAILS when the
// condition is reached. SEANCE_WITNESS selects how rare the condition is:
//   early: batchTransfer classified exorcised (hit within the first handful of calls)
//   rare:  exorcised batchTransfer from actor 0xA3 with 7 receivers and receiver[0] == address(0)
//          (about 6e-4 per call)
//   never: a condition no input satisfies (campaign runs to completion, no shrink)
// SEANCE_RECORD=0 turns off recordLogs, getRecordedLogs and writeLine (the witness campaign setting).
contract Handler is Test {
    string constant FILE = "./seance-out/records.jsonl";
    uint256 constant GAS_CAP = 10_000_000;
    uint256 constant ACTOR_WEI = 10_000 ether;
    address constant DEPLOYER = address(0xD0);

    address public legacy;
    address public port;
    bool public record;
    uint256 public idx;
    bool public diverged;
    bool public hit;
    uint256 public mode; // 0 early, 1 rare, 2 never
    bool lastExorcised;

    function _actor(uint256 i) internal pure returns (address) {
        uint256 k = i % 4;
        if (k == 0) return DEPLOYER;
        if (k == 1) return address(0xA1);
        if (k == 2) return address(0xA2);
        return address(0xA3);
    }

    function _addr(uint256 i) internal pure returns (address) {
        uint256 k = i % 5;
        return k == 4 ? address(0) : _actor(k);
    }

    function init(bool rec) external {
        record = rec;
        string memory w = vm.envOr("SEANCE_WITNESS", string("early"));
        bytes32 wh = keccak256(bytes(w));
        mode = wh == keccak256("rare") ? 1 : wh == keccak256("never") ? 2 : wh == keccak256("rare1e4") ? 3 : 0;
        vm.startPrank(DEPLOYER);
        legacy = vm.deployCode("LegacyToken.sol:Token");
        port = vm.deployCode("PortToken.sol:Token");
        vm.stopPrank();
        for (uint256 i = 1; i < 4; i++) {
            bytes memory cd = abi.encodeWithSignature("transfer(address,uint256)", _actor(i), uint256(250_000));
            vm.prank(DEPLOYER);
            (bool a,) = legacy.call{gas: GAS_CAP}(cd);
            vm.prank(DEPLOYER);
            (bool b,) = port.call{gas: GAS_CAP}(cd);
            require(a && b, "share transfer failed");
        }
    }

    function _logsHash(Vm.Log[] memory logs) internal pure returns (bytes32 h) {
        for (uint256 i = 0; i < logs.length; i++) {
            h = keccak256(abi.encode(h, logs[i].topics, logs[i].data));
        }
    }

    function _isPanic11(bytes memory r) internal pure returns (bool) {
        if (r.length != 36) return false;
        bytes4 sel;
        uint256 code;
        assembly {
            sel := mload(add(r, 32))
            code := mload(add(r, 36))
        }
        return sel == 0x4e487b71 && code == 0x11;
    }

    function _classify(bool lok, bytes memory lret, bool pok, bytes memory pret, bool same)
        internal
        pure
        returns (string memory)
    {
        if (lok && pok) return same ? "match" : "port-bug";
        if (!lok && !pok) return keccak256(lret) == keccak256(pret) ? "match" : "reason-modernised";
        if (lok && !pok) return _isPanic11(pret) ? "exorcised" : "port-bug";
        return "port-bug";
    }

    struct Side {
        bool ok;
        bytes ret;
        bytes32 logs;
        bytes state;
    }

    function _callSide(address target, address actor, bytes memory cd, uint256 value)
        internal
        returns (Side memory s)
    {
        if (value > 0) vm.deal(actor, ACTOR_WEI);
        if (record) vm.recordLogs();
        vm.prank(actor);
        (s.ok, s.ret) = target.call{value: value, gas: GAS_CAP}(cd);
        if (record) s.logs = _logsHash(vm.getRecordedLogs());
    }

    function _readSide(address target, address actor, Side memory s) internal view {
        (bool ok, bytes memory r) = target.staticcall{gas: GAS_CAP}(abi.encodeWithSignature("balanceOf(address)", actor));
        s.state = ok ? r : bytes("read-failed");
    }

    function _differential(address actor, bytes memory cd, uint256 value) internal {
        vm.warp(1_700_000_000 + idx);
        vm.roll(18_000_000 + idx);

        Side memory l = _callSide(legacy, actor, cd, value);
        Side memory p = _callSide(port, actor, cd, value);
        _readSide(legacy, actor, l);
        _readSide(port, actor, p);

        bool same = keccak256(l.ret) == keccak256(p.ret) && l.logs == p.logs
            && keccak256(l.state) == keccak256(p.state);
        string memory cls = _classify(l.ok, l.ret, p.ok, p.ret, same);
        bool after_ = diverged;
        if (keccak256(bytes(cls)) == keccak256("port-bug")) diverged = true;
        lastExorcised = keccak256(bytes(cls)) == keccak256("exorcised");

        if (record) _write(after_, actor, value, cd, l, p, cls);
        idx++;
    }

    function _side(Side memory s) internal pure returns (string memory) {
        return string.concat(
            '{"ok":', s.ok ? "true" : "false", ',"ret":"', vm.toString(s.ret),
            '","logs":"', vm.toString(s.logs), '","bal":"', vm.toString(s.state), '"}'
        );
    }

    function _write(bool after_, address actor, uint256 value, bytes memory cd, Side memory l, Side memory p, string memory cls)
        internal
    {
        string memory head = string.concat(
            '{"idx":', vm.toString(idx), ',"afterDivergence":', after_ ? "true" : "false",
            ',"sender":"', vm.toString(actor), '","value":"', vm.toString(value), '","calldata":"', vm.toString(cd)
        );
        vm.writeLine(FILE, string.concat(head, '","legacy":', _side(l), ',"port":', _side(p), ',"class":"', cls, '"}'));
    }

    function handler_transfer(uint256 pick, uint8 actorIdx, uint8 toIdx, uint256 amount, uint256 weiValue) external {
        address actor = _actor(actorIdx);
        uint256 h = uint256(keccak256(abi.encode(pick)));
        uint256 value = h % 8 == 0 ? (weiValue % ACTOR_WEI) : 0;
        uint256 amt = amount % 400_000;
        _differential(actor, abi.encodeWithSignature("transfer(address,uint256)", _addr(toIdx), amt), value);
    }

    function handler_batchTransfer(uint256 pick, uint8 actorIdx, uint8 n, uint256 idxPack, uint256 val) external {
        address actor = _actor(actorIdx);
        uint256 cnt = uint256(n) % 22;
        address[] memory rcv = new address[](cnt);
        for (uint256 i = 0; i < cnt; i++) {
            rcv[i] = _addr(uint8(idxPack >> (8 * i)));
        }
        uint256 h = uint256(keccak256(abi.encode(pick)));
        uint256 value;
        if (h % 2 == 0 && cnt >= 2) {
            value = type(uint256).max / cnt + 1;
        } else {
            value = val % 100_000;
        }
        _differential(actor, abi.encodeWithSignature("batchTransfer(address[],uint256)", rcv, value), 0);

        // Witness condition for this (function, class) pair.
        if (lastExorcised) {
            if (mode == 0) {
                hit = true;
            } else if (mode == 1) {
                if (actor == address(0xA3) && cnt == 7 && rcv[0] == address(0)) hit = true;
            } else if (mode == 3) {
                // Task 1.11: the rare condition plus one more receiver constraint (about 1e-4 per call).
                if (actor == address(0xA3) && cnt == 7 && rcv[0] == address(0) && rcv[1] == address(0)) hit = true;
            } else if (cnt == 1000) {
                hit = true;
            }
        }
    }
}

contract SeanceWitness is StdInvariant, Test {
    Handler handler;

    function setUp() public {
        bool rec = vm.envOr("SEANCE_RECORD", uint256(1)) != 0;
        if (rec) vm.writeFile("./seance-out/records.jsonl", "");
        handler = new Handler();
        handler.init(rec);
        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](2);
        sels[0] = Handler.handler_transfer.selector;
        sels[1] = Handler.handler_batchTransfer.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    function invariant_witness() public view {
        assertFalse(handler.hit(), "witness hit");
    }
}
