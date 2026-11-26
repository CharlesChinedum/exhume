// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Classifier
/// @notice Solidity mirror of `classify` in engine/src/seance/classify.ts.
/// Pure and deterministic: no storage, no external calls, no block/msg/tx reads.
/// Only the "both"-scope shared vectors apply. A Solidity CallRec is built from
/// typed EVM values and cannot be malformed, so there is no `invalidRecord` path.
/// The handler normalises log emitters (own deployment -> `self = true`) before
/// calling `classify`.
library Classifier {
    /// Order maps to the strings: match, reason-modernised, exorcised, port-bug.
    enum Class {
        Match,
        ReasonModernised,
        Exorcised,
        PortBug
    }

    /// One normalised log. When `self` is true the emitter is the deployment
    /// itself and `emitter` is ignored. `self` matches only `self`.
    struct LogRec {
        bool self;
        address emitter;
        bytes32[] topics;
        bytes data;
    }

    /// One Observable_State entry. `name` is ASCII and unique within a record.
    struct StateEntry {
        string name;
        bytes value;
    }

    struct CallRec {
        bool success;
        bytes data;
        LogRec[] logs;
        StateEntry[] state;
    }

    /// True only for exactly 0x4e487b71 followed by the 32-byte word 0x11 (36 bytes).
    function isPanic0x11(bytes memory d) internal pure returns (bool) {
        if (d.length != 36) return false;
        if (d[0] != 0x4e || d[1] != 0x48 || d[2] != 0x7b || d[3] != 0x71) return false;
        for (uint256 i = 4; i < 35; i++) {
            if (d[i] != 0) return false;
        }
        return d[35] == 0x11;
    }

    /// Decision table. `differingFields` is non-empty only for `PortBug`; it is
    /// sorted by bytes ascending, without duplicates.
    function classify(CallRec memory legacy, CallRec memory port)
        internal
        pure
        returns (Class cls, string[] memory differingFields)
    {
        if (!legacy.success && !port.success) {
            cls = _bytesEq(legacy.data, port.data) ? Class.Match : Class.ReasonModernised;
            return (cls, new string[](0));
        }
        if (legacy.success && !port.success) {
            if (isPanic0x11(port.data)) return (Class.Exorcised, new string[](0));
            return (Class.PortBug, _oneSided(legacy.data, port.data));
        }
        if (!legacy.success && port.success) {
            return (Class.PortBug, _oneSided(legacy.data, port.data));
        }

        // Both succeeded.
        string[] memory buf = new string[](2 + legacy.state.length + port.state.length);
        uint256 n = 0;
        if (!_bytesEq(legacy.data, port.data)) buf[n++] = "returnData";
        if (!_logsEq(legacy.logs, port.logs)) buf[n++] = "logs";
        n = _diffState(legacy.state, port.state, buf, n);
        if (n == 0) return (Class.Match, new string[](0));
        return (Class.PortBug, _sortUnique(buf, n));
    }

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    function _oneSided(bytes memory a, bytes memory b) private pure returns (string[] memory out) {
        if (_bytesEq(a, b)) {
            out = new string[](1);
            out[0] = "success";
        } else {
            out = new string[](2);
            out[0] = "returnData";
            out[1] = "success";
        }
    }

    function _bytesEq(bytes memory a, bytes memory b) private pure returns (bool) {
        if (a.length != b.length) return false;
        for (uint256 i = 0; i < a.length; i++) {
            if (a[i] != b[i]) return false;
        }
        return true;
    }

    function _logEq(LogRec memory x, LogRec memory y) private pure returns (bool) {
        if (x.self != y.self) return false;
        if (!x.self && x.emitter != y.emitter) return false;
        if (x.topics.length != y.topics.length) return false;
        for (uint256 j = 0; j < x.topics.length; j++) {
            if (x.topics[j] != y.topics[j]) return false;
        }
        return _bytesEq(x.data, y.data);
    }

    function _logsEq(LogRec[] memory a, LogRec[] memory b) private pure returns (bool) {
        if (a.length != b.length) return false;
        for (uint256 i = 0; i < a.length; i++) {
            if (!_logEq(a[i], b[i])) return false;
        }
        return true;
    }

    /// Returns the index of `name` in `s`, or `s.length` when absent.
    function _find(StateEntry[] memory s, string memory name) private pure returns (uint256) {
        bytes memory nb = bytes(name);
        for (uint256 i = 0; i < s.length; i++) {
            if (_bytesEq(bytes(s[i].name), nb)) return i;
        }
        return s.length;
    }

    function _prefixed(string memory name) private pure returns (string memory) {
        return string.concat("state.", name);
    }

    /// Appends `state.<name>` for every key that differs or is present on one side only.
    function _diffState(StateEntry[] memory a, StateEntry[] memory b, string[] memory buf, uint256 n)
        private
        pure
        returns (uint256)
    {
        for (uint256 i = 0; i < a.length; i++) {
            uint256 k = _find(b, a[i].name);
            if (k == b.length || !_bytesEq(a[i].value, b[k].value)) buf[n++] = _prefixed(a[i].name);
        }
        for (uint256 i = 0; i < b.length; i++) {
            if (_find(a, b[i].name) == a.length) buf[n++] = _prefixed(b[i].name);
        }
        return n;
    }

    /// Lexicographic byte comparison. A shorter prefix sorts first.
    function _lt(bytes memory a, bytes memory b) private pure returns (bool) {
        uint256 m = a.length < b.length ? a.length : b.length;
        for (uint256 i = 0; i < m; i++) {
            if (a[i] != b[i]) return uint8(a[i]) < uint8(b[i]);
        }
        return a.length < b.length;
    }

    /// Insertion sort of the first `n` entries, then drop duplicates.
    function _sortUnique(string[] memory buf, uint256 n) private pure returns (string[] memory out) {
        for (uint256 i = 1; i < n; i++) {
            string memory key = buf[i];
            uint256 j = i;
            while (j > 0 && _lt(bytes(key), bytes(buf[j - 1]))) {
                buf[j] = buf[j - 1];
                j--;
            }
            buf[j] = key;
        }
        uint256 u = 0;
        for (uint256 i = 0; i < n; i++) {
            if (i == 0 || !_bytesEq(bytes(buf[i]), bytes(buf[i - 1]))) u++;
        }
        out = new string[](u);
        uint256 w = 0;
        for (uint256 i = 0; i < n; i++) {
            if (i == 0 || !_bytesEq(bytes(buf[i]), bytes(buf[i - 1]))) out[w++] = buf[i];
        }
    }
}
