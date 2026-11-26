// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// =============================================================================
// DifferentialHandler template (task 8.3). Generated to test/handler/DifferentialHandler.sol.
//
// PLACEHOLDER MECHANISM (for the Project_Generator, task 8.5)
// -----------------------------------------------------------
// The file is a complete, compilable contract. Everything that depends on the
// ABI is outside of it or in two marked sections; the generator replaces each
// marker LINE (the whole line, `// @@NAME@@`) with generated Solidity, and
// writes `test/handler/Targets.sol` next to the handler.
//
//   // @@SEED_ENCODER@@       one `function _seedCalldata(Targets.Seed memory s)
//                            internal pure returns (bytes memory)`: encodes a
//                            seed call by function name. Address arguments are
//                            Actor_Set indices: decode with `_addr(uint8(s.args[i]))`.
//                            Revert for an unknown name (that is an engine fault).
//   // @@HANDLER_FUNCTIONS@@  the typed `handler_<name>` external functions (one per
//                            nonpayable/payable ABI function) and, when the ABI has
//                            a fallback, `handler_fallback_empty` and
//                            `handler_fallback_unknown`. Each one fills a
//                            `uint256[] p` with one slot per ABI parameter
//                            (scalar value, or array length), calls
//                            `_applyTargets(pick, Targets.targets_<name>(), p)`,
//                            builds the calldata with `abi.encodeWithSelector`
//                            and calls `_differential(name, cd, _sender(actorIdx),
//                            value, isPayable)`.
//
// `Targets.sol` is a `library Targets` that must provide (see the fixture in
// engine/test/seance/fixtures/handler/ for the exact shapes):
//   string  constant LEGACY_ARTIFACT, PORT_ARTIFACT      "LegacyX.sol:X", "PortX.sol:X"
//   bool    constant HAS_TOKEN_SHARES                    ABI has transfer(address,uint256) and balanceOf(address)
//   uint256 constant FUNDING_WEI                         identical extra balance for both deployments
//   uint8   constant KIND_STATIC = 0, KIND_ARRAY_LEN = 1 mirrors ParamSlot.encoding
//   structs Assign, Entry, Seed, Getter
//   function ctorArgs() returns (bytes memory)
//   function seeds() returns (Seed[] memory)             seed sequences flattened in order
//   function noArgGetters() / addrGetters() / pairGetters() returns (Getter[] memory)
//   function isKnownSelector(bytes4) returns (bool)
//   function targets_<name>() returns (Entry[] memory)   one per handler function
// =============================================================================

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {Classifier} from "./Classifier.sol";
import {Targets} from "./Targets.sol";

contract DifferentialHandler is Test {
    // ---- constants (design: Gas cap, Actor_Set, differential call) ----------
    uint256 internal constant GAS_CAP = 10_000_000;
    uint256 internal constant ACTOR_WEI = 10_000 ether;
    /// Largest array length the handler ever builds. Lengths are bounded to 0..24.
    uint256 internal constant MAX_ARRAY_LEN = 24;
    uint256 internal constant BASE_TIMESTAMP = 1_700_000_000;
    uint256 internal constant BASE_BLOCK = 18_000_000;
    address internal constant DEPLOYER = address(0xD0);
    address internal constant A1 = address(0xA1);
    address internal constant A2 = address(0xA2);
    address internal constant A3 = address(0xA3);
    /// Actor_Set size. `_addr` accepts one more index (address(0)); `_sender` does not.
    uint256 internal constant ACTOR_COUNT = 4;
    bytes internal constant READ_FAILED = bytes("STATE_READ_FAILED");

    // ---- storage (all of it reverts to its post-setUp value at the start of every run) ----
    address public legacy;
    address public port;
    /// Next fuzz record index. Setup records use -1 and do not advance it.
    uint256 public idx;
    bool public stopped;
    /// True after the first port-bug (including one in setup).
    bool public diverged;
    bool public inSetup;
    bool public initialised;
    /// SEANCE_RECORD != 0 (default 1). Only gates the JSONL output, never the comparison.
    bool public record;
    string public outputPath = "seance-out/records.jsonl";

    bytes32 public witnessFn;
    Classifier.Class public witnessClass;
    bool public witnessSet;
    bool public witnessHit;

    constructor() {
        record = vm.envOr("SEANCE_RECORD", uint256(1)) != 0;
    }

    // =========================================================================
    // Configuration
    // =========================================================================

    /// Must be called before `init`. When recording is on, creates `./seance-out` (vm.writeFile does
    /// not create directories) and truncates the file. `path` must be under `seance-out/`
    /// (the only writable `fs_permissions` entry).
    function setOutputPath(string calldata path) external {
        require(!initialised, "SET_PATH_AFTER_INIT");
        outputPath = path;
        if (record) {
            vm.createDir("seance-out", true);
            vm.writeFile(path, "");
        }
    }

    /// Witness condition: the (function name, class) pair. `witnessHit` becomes true when a
    /// FUZZ record (idx >= 0) with this pair is observed and is not tainted (afterDivergence false).
    function setWitness(string calldata fn, Classifier.Class cls) external {
        witnessFn = keccak256(bytes(fn));
        witnessClass = cls;
        witnessSet = true;
    }

    // =========================================================================
    // Actor_Set
    // =========================================================================

    function _actor(uint256 k) internal pure returns (address) {
        k = k % ACTOR_COUNT;
        if (k == 0) return DEPLOYER;
        if (k == 1) return A1;
        if (k == 2) return A2;
        return A3;
    }

    /// Senders: ACTORS[i % 4], never address(0).
    function _sender(uint8 i) internal pure returns (address) {
        return _actor(i);
    }

    /// Address arguments: ACTORS[i % 5], the extra index is address(0).
    function _addr(uint8 i) internal pure returns (address) {
        uint256 k = uint256(i) % (ACTOR_COUNT + 1);
        return k == ACTOR_COUNT ? address(0) : _actor(k);
    }

    // =========================================================================
    // Target selection and argument helpers
    // =========================================================================

    /// Even parity of keccak256(abi.encode(pick)) with n > 0 uses a target, entry (h >> 1) % n.
    function _pickTarget(uint256 pick, uint256 n) internal pure returns (bool use, uint256 index) {
        uint256 h = uint256(keccak256(abi.encode(pick)));
        use = (n > 0) && (h % 2 == 0);
        index = n == 0 ? 0 : (h >> 1) % n;
    }

    /// Applies one picked entry to `p` (one slot per ABI parameter, indexed by paramIndex).
    /// Static and array-length assignments both write `p[paramIndex]`. A targeted array length
    /// above MAX_ARRAY_LEN is saturated to MAX_ARRAY_LEN (the generator can emit lengths such as
    /// ceil(2^256 / k) that no handler can allocate). An entry without assignments changes nothing.
    function _applyTargets(uint256 pick, Targets.Entry[] memory ents, uint256[] memory p) internal pure {
        (bool use, uint256 i) = _pickTarget(pick, ents.length);
        if (!use) return;
        Targets.Assign[] memory a = ents[i].assigns;
        for (uint256 j = 0; j < a.length; j++) {
            if (a[j].paramIndex >= p.length) continue;
            uint256 v = a[j].value;
            if (a[j].kind == Targets.KIND_ARRAY_LEN && v > MAX_ARRAY_LEN) v = MAX_ARRAY_LEN;
            p[a[j].paramIndex] = v;
        }
    }

    /// Array length rule: any fuzzed or targeted length x becomes x % 25, so 0..24 and never a revert.
    /// (Targeted lengths were saturated to 24 by `_applyTargets` first, and 24 % 25 == 24.)
    function _boundLen(uint256 x) internal pure returns (uint256) {
        return x % (MAX_ARRAY_LEN + 1);
    }

    /// address[]: element j is `_addr(byte j of idxPack)`, length is `_boundLen(len)`.
    function _addressArray(uint256 len, uint256 idxPack) internal pure returns (address[] memory out) {
        uint256 n = _boundLen(len);
        out = new address[](n);
        for (uint256 j = 0; j < n; j++) {
            out[j] = _addr(uint8(idxPack >> (8 * (j % 32))));
        }
    }

    /// Element seed for other dynamic arrays: element j derives from keccak256(seed, j).
    function _elemSeed(uint256 seed, uint256 j) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, j)));
    }

    /// Calldata for `handler_fallback_unknown`: a 4-byte selector that is not in the ABI, then `data`
    /// (capped at 256 bytes). The selector starts from keccak256(data) and is incremented until unknown.
    function _unknownCalldata(bytes memory data) internal pure returns (bytes memory) {
        uint256 take = data.length > 256 ? 256 : data.length;
        bytes memory body = new bytes(take);
        for (uint256 i = 0; i < take; i++) {
            body[i] = data[i];
        }
        uint32 sel = uint32(bytes4(keccak256(body)));
        for (uint256 tries = 0; tries < 64 && Targets.isKnownSelector(bytes4(sel)); tries++) {
            sel += 1;
        }
        return abi.encodePacked(bytes4(sel), body);
    }

    // =========================================================================
    // Setup
    // =========================================================================

    function init() external {
        require(!initialised, "INIT_TWICE");
        initialised = true;
        inSetup = true;
        _setBlock();
        vm.deal(DEPLOYER, ACTOR_WEI);

        bytes memory args = Targets.ctorArgs();
        vm.startPrank(DEPLOYER);
        (address l, bool lok, bytes memory ldata) = _deploy(Targets.LEGACY_ARTIFACT, args);
        (address p, bool pok, bytes memory pdata) = _deploy(Targets.PORT_ARTIFACT, args);
        vm.stopPrank();
        legacy = l;
        port = p;

        // Constructor outcome: classified like any call (no logs, no state).
        Classifier.CallRec memory lc = _bareRec(lok, ldata);
        Classifier.CallRec memory pc = _bareRec(pok, pdata);
        _finish("constructor", args, DEPLOYER, 0, lc, pc);
        if (!(lok && pok)) {
            // Outcomes differ or both revert: the séance ends with the setup records.
            stopped = true;
            inSetup = false;
            return;
        }

        if (Targets.FUNDING_WEI > 0) {
            vm.deal(l, Targets.FUNDING_WEI);
            vm.deal(p, Targets.FUNDING_WEI);
        }

        if (Targets.HAS_TOKEN_SHARES) {
            uint256 share = _balanceOf(l, DEPLOYER) / ACTOR_COUNT;
            for (uint8 i = 1; i < ACTOR_COUNT; i++) {
                bytes memory cd = abi.encodeWithSignature("transfer(address,uint256)", _actor(i), share);
                _differential("transfer", cd, DEPLOYER, 0, false);
            }
        }

        Targets.Seed[] memory seeds = Targets.seeds();
        for (uint256 s = 0; s < seeds.length; s++) {
            _differential(
                seeds[s].fn, _seedCalldata(seeds[s]), _sender(seeds[s].actorIdx), seeds[s].value, seeds[s].value > 0
            );
        }

        // A port-bug or exorcised setup record ends the séance with zero fuzz calls.
        // `stopped` is already set by an exorcism; a port-bug set `diverged`.
        if (diverged) stopped = true;
        inSetup = false;
    }

    function _deploy(string memory artifact, bytes memory args)
        internal
        returns (address a, bool ok, bytes memory data)
    {
        try vm.deployCode(artifact, args) returns (address d) {
            return (d, true, "");
        } catch (bytes memory reason) {
            return (address(0), false, reason);
        }
    }

    function _balanceOf(address target, address who) internal view returns (uint256) {
        (bool ok, bytes memory r) =
            target.staticcall{gas: GAS_CAP}(abi.encodeWithSignature("balanceOf(address)", who));
        if (!ok || r.length < 32) return 0;
        return abi.decode(r, (uint256));
    }

    function _withoutState(Classifier.CallRec memory r) internal pure returns (Classifier.CallRec memory o) {
        o.success = r.success;
        o.data = r.data;
        o.logs = r.logs;
        o.state = new Classifier.StateEntry[](0);
    }

    function _bareRec(bool ok, bytes memory data) internal pure returns (Classifier.CallRec memory r) {
        r.success = ok;
        r.data = data;
        r.logs = new Classifier.LogRec[](0);
        r.state = new Classifier.StateEntry[](0);
    }

    // @@SEED_ENCODER@@

    // =========================================================================
    // Differential call
    // =========================================================================

    /// Block context from `idx` only, so a replay reproduces it. Setup runs one second before
    /// the first fuzz call. Both deployments see the same values.
    function _setBlock() internal {
        if (inSetup) {
            vm.warp(BASE_TIMESTAMP - 1);
            vm.roll(BASE_BLOCK - 1);
        } else {
            vm.warp(BASE_TIMESTAMP + idx);
            vm.roll(BASE_BLOCK + idx);
        }
    }

    function _differential(string memory fnName, bytes memory cd, address sender, uint256 value, bool isPayable)
        internal
    {
        if (stopped) return;
        _setBlock();
        Classifier.CallRec memory l = _side(legacy, sender, cd, value, isPayable);
        Classifier.CallRec memory p = _side(port, sender, cd, value, isPayable);
        _finish(fnName, cd, sender, value, l, p);
    }

    /// One call into one deployment. Low-level, gas-capped: cannot revert the handler.
    /// vm.deal does not consume the pending prank; recordLogs is called before the prank.
    function _side(address target, address sender, bytes memory cd, uint256 value, bool isPayable)
        internal
        returns (Classifier.CallRec memory r)
    {
        if (isPayable) vm.deal(sender, ACTOR_WEI);
        vm.recordLogs();
        vm.prank(sender);
        (bool ok, bytes memory ret) = target.call{value: value, gas: GAS_CAP}(cd);
        Vm.Log[] memory raw = vm.getRecordedLogs();
        r.success = ok;
        r.data = ret;
        // A reverted call has no logs (Requirement 3.11).
        r.logs = ok ? _normLogs(raw, target) : new Classifier.LogRec[](0);
        r.state = _readState(target);
    }

    /// Emitter == the deployment itself becomes the SELF sentinel (`self = true`).
    function _normLogs(Vm.Log[] memory raw, address target) internal pure returns (Classifier.LogRec[] memory out) {
        out = new Classifier.LogRec[](raw.length);
        for (uint256 i = 0; i < raw.length; i++) {
            bool self = raw[i].emitter == target;
            out[i] = Classifier.LogRec({
                self: self, emitter: self ? address(0) : raw[i].emitter, topics: raw[i].topics, data: raw[i].data
            });
        }
    }

    /// Classify, taint, witness, stop, record. Shared by the constructor record and every call.
    function _finish(
        string memory fnName,
        bytes memory cd,
        address sender,
        uint256 value,
        Classifier.CallRec memory l,
        Classifier.CallRec memory p
    ) internal {
        bytes32 lh = keccak256(abi.encode(l.state));
        bytes32 ph = keccak256(abi.encode(p.state));
        // Speed only: equal state hashes mean equal Observable_State, so the (quadratic, bytewise)
        // state comparison in Classifier.classify is skipped. The result is the same.
        (Classifier.Class cls, string[] memory diff) = lh == ph
            ? Classifier.classify(_withoutState(l), _withoutState(p))
            : Classifier.classify(l, p);
        bool after_ = diverged;
        if (cls == Classifier.Class.PortBug) diverged = true;
        if (cls == Classifier.Class.Exorcised) stopped = true;
        if (
            !inSetup && witnessSet && !after_ && cls == witnessClass && keccak256(bytes(fnName)) == witnessFn
        ) witnessHit = true;
        if (record) {
            _write(_Line(inSetup ? int256(-1) : int256(idx), fnName, cd, sender, value, cls, diff, after_), l, p, lh, ph);
        }
        if (!inSetup) idx++;
    }

    // =========================================================================
    // Observable_State
    // =========================================================================

    /// balance, every no-argument getter, every one-address getter over `_addr(0..4)`
    /// (Actor_Set plus address(0)) and every two-address getter over the ordered pairs of
    /// ACTORS (4 x 4, no address(0)). A failed read is the fixed READ_FAILED sentinel.
    function _readState(address target) internal view returns (Classifier.StateEntry[] memory s) {
        Targets.Getter[] memory g0 = Targets.noArgGetters();
        Targets.Getter[] memory g1 = Targets.addrGetters();
        Targets.Getter[] memory g2 = Targets.pairGetters();
        uint256 a1 = ACTOR_COUNT + 1;
        s = new Classifier.StateEntry[](1 + g0.length + a1 * g1.length + ACTOR_COUNT * ACTOR_COUNT * g2.length);
        uint256 n = 0;
        s[n++] = Classifier.StateEntry({name: "balance", value: abi.encode(target.balance)});
        for (uint256 i = 0; i < g0.length; i++) {
            s[n++] = Classifier.StateEntry({name: g0[i].name, value: _read(target, abi.encodeWithSelector(g0[i].selector))});
        }
        for (uint256 i = 0; i < g1.length; i++) {
            for (uint8 a = 0; a < a1; a++) {
                s[n++] = Classifier.StateEntry({
                    name: string(abi.encodePacked(g1[i].name, "(", _digit(a), ")")),
                    value: _read(target, abi.encodeWithSelector(g1[i].selector, _addr(a)))
                });
            }
        }
        for (uint256 i = 0; i < g2.length; i++) {
            for (uint8 a = 0; a < ACTOR_COUNT; a++) {
                for (uint8 b = 0; b < ACTOR_COUNT; b++) {
                    s[n++] = Classifier.StateEntry({
                        name: string(abi.encodePacked(g2[i].name, "(", _digit(a), ",", _digit(b), ")")),
                        value: _read(target, abi.encodeWithSelector(g2[i].selector, _addr(a), _addr(b)))
                    });
                }
            }
        }
    }

    /// Index 0..9 as one ASCII digit (indices here are at most 4); no cheatcode call per name.
    function _digit(uint8 i) internal pure returns (bytes1) {
        return bytes1(uint8(0x30) + i);
    }

    function _read(address target, bytes memory cd) internal view returns (bytes memory) {
        (bool ok, bytes memory r) = target.staticcall{gas: GAS_CAP}(cd);
        return ok ? r : READ_FAILED;
    }

    // =========================================================================
    // JSONL record (design: Record line)
    // =========================================================================

    struct _Line {
        int256 idx;
        string fn;
        bytes cd;
        address sender;
        uint256 value;
        Classifier.Class cls;
        string[] diff;
        bool afterDivergence;
    }

    function _write(
        _Line memory ln,
        Classifier.CallRec memory l,
        Classifier.CallRec memory p,
        bytes32 lh,
        bytes32 ph
    ) internal {
        bool pb = ln.cls == Classifier.Class.PortBug;
        bytes memory sel = ln.cd.length >= 4 ? abi.encodePacked(bytes4(ln.cd)) : new bytes(0);
        string memory head = string.concat(
            '{"idx":', vm.toString(ln.idx),
            ',"function":"', ln.fn,
            '","selector":"', vm.toString(sel),
            '","calldata":"', vm.toString(ln.cd),
            '","sender":"', vm.toString(ln.sender),
            '","value":"', vm.toString(ln.value), '"'
        );
        string memory tail = string.concat(
            ',"classification":"', _className(ln.cls),
            '","differingFields":', _strArray(ln.diff),
            ',"invalidRecord":false,"afterDivergence":', ln.afterDivergence ? "true" : "false", "}"
        );
        vm.writeLine(
            outputPath,
            string.concat(head, ',"legacy":', _wire(l, lh, pb), ',"port":', _wire(p, ph, pb), tail)
        );
    }

    function _wire(Classifier.CallRec memory r, bytes32 stateHash, bool withFields) internal pure returns (string memory) {
        string memory s = string.concat(
            '{"success":', r.success ? "true" : "false",
            ',"data":"', vm.toString(r.data),
            '","logs":', _logsJson(r.logs),
            ',"stateHash":"', vm.toString(stateHash), '"'
        );
        if (withFields) s = string.concat(s, ',"stateFields":', _stateJson(r.state));
        return string.concat(s, "}");
    }

    function _logsJson(Classifier.LogRec[] memory ls) internal pure returns (string memory out) {
        out = "[";
        for (uint256 i = 0; i < ls.length; i++) {
            string memory topics = "[";
            for (uint256 j = 0; j < ls[i].topics.length; j++) {
                topics = string.concat(topics, j > 0 ? "," : "", '"', vm.toString(ls[i].topics[j]), '"');
            }
            out = string.concat(
                out, i > 0 ? "," : "",
                '{"emitter":"', ls[i].self ? "SELF" : vm.toString(ls[i].emitter),
                '","topics":', topics, "]",
                ',"data":"', vm.toString(ls[i].data), '"}'
            );
        }
        out = string.concat(out, "]");
    }

    function _stateJson(Classifier.StateEntry[] memory st) internal pure returns (string memory out) {
        out = "{";
        for (uint256 i = 0; i < st.length; i++) {
            out = string.concat(out, i > 0 ? "," : "", '"', st[i].name, '":"', vm.toString(st[i].value), '"');
        }
        out = string.concat(out, "}");
    }

    function _strArray(string[] memory a) internal pure returns (string memory out) {
        out = "[";
        for (uint256 i = 0; i < a.length; i++) {
            out = string.concat(out, i > 0 ? "," : "", '"', a[i], '"');
        }
        out = string.concat(out, "]");
    }

    function _className(Classifier.Class c) internal pure returns (string memory) {
        if (c == Classifier.Class.Match) return "match";
        if (c == Classifier.Class.ReasonModernised) return "reason-modernised";
        if (c == Classifier.Class.Exorcised) return "exorcised";
        return "port-bug";
    }

    // =========================================================================
    // Typed handler functions (generated)
    // =========================================================================

    // @@HANDLER_FUNCTIONS@@
}
