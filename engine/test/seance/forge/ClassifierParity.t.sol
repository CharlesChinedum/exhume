// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
// Task 8.8 (A): parity of the Solidity Classifier with the TypeScript classifier.
// Reads the shared vectors file at runtime (vm.readFile + vm.parseJson*) and runs every vector whose
// `scope` is "both" or absent. `ts-only` vectors (malformed records) are skipped without being parsed
// past their scope. State keys are enumerated with vm.parseJsonKeys and read by key with bracket
// notation, because keys such as `allowed(0xA1,0xA2)` contain parentheses and commas.
// The vitest runner (classifier-parity.test.ts) lays out the scratch project, sets EXPECTED_VECTORS
// to the number of `both` vectors it counted in TypeScript, and copies the vectors to
// ./vectors/classification.json (the only path foundry.toml allows for reading).
import {Test} from "forge-std/Test.sol";
import {Classifier} from "./handler/Classifier.sol";

contract ClassifierParityTest is Test {
    string internal constant VECTORS = "vectors/classification.json";

    function test_classifierMatchesSharedVectors() public {
        string memory json = vm.readFile(VECTORS);
        uint256 total;
        uint256 ran;
        uint256 skipped;
        while (vm.keyExistsJson(json, _vec(total))) {
            string memory p = _vec(total);
            string memory name = vm.parseJsonString(json, string.concat(p, ".name"));
            if (_isTsOnly(json, p, name)) {
                skipped++;
            } else {
                _runVector(json, p, name);
                ran++;
            }
            total++;
        }
        emit log_named_uint("PARITY_VECTORS_TOTAL", total);
        emit log_named_uint("PARITY_VECTORS_SKIPPED", skipped);
        emit log_named_uint("PARITY_VECTORS_RUN", ran);
        assertGt(total, 0, "no vectors found");
        assertEq(ran + skipped, total, "ran + skipped != total");
        assertEq(ran, vm.envUint("EXPECTED_VECTORS"), "vectors run != number of both-scope vectors");
    }

    function _vec(uint256 i) internal pure returns (string memory) {
        return string.concat("$.vectors[", vm.toString(i), "]");
    }

    function _isTsOnly(string memory json, string memory p, string memory name) internal view returns (bool) {
        string memory sp = string.concat(p, ".scope");
        if (!vm.keyExistsJson(json, sp)) return false;
        string memory scope = vm.parseJsonString(json, sp);
        bytes32 h = keccak256(bytes(scope));
        if (h == keccak256("ts-only")) return true;
        require(h == keccak256("both"), string.concat("unknown scope in vector ", name));
        return false;
    }

    function _runVector(string memory json, string memory p, string memory name) internal view {
        Classifier.CallRec memory legacy = _rec(json, string.concat(p, ".legacy"));
        Classifier.CallRec memory port = _rec(json, string.concat(p, ".port"));
        (Classifier.Class cls, string[] memory fields) = Classifier.classify(legacy, port);
        string memory expectCls = vm.parseJsonString(json, string.concat(p, ".expect.classification"));
        string[] memory expectFields = vm.parseJsonStringArray(json, string.concat(p, ".expect.differingFields"));
        assertEq(_className(cls), expectCls, string.concat("classification differs in vector: ", name));
        assertEq(fields, expectFields, string.concat("differingFields differ in vector: ", name));
    }

    function _rec(string memory json, string memory p) internal view returns (Classifier.CallRec memory r) {
        r.success = vm.parseJsonBool(json, string.concat(p, ".success"));
        r.data = vm.parseJsonBytes(json, string.concat(p, ".data"));
        r.logs = _logs(json, string.concat(p, ".logs"));
        r.state = _state(json, string.concat(p, ".state"));
    }

    function _logs(string memory json, string memory p) internal view returns (Classifier.LogRec[] memory out) {
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(p, "[", vm.toString(n), "]"))) n++;
        out = new Classifier.LogRec[](n);
        for (uint256 j = 0; j < n; j++) {
            string memory lp = string.concat(p, "[", vm.toString(j), "]");
            string memory em = vm.parseJsonString(json, string.concat(lp, ".emitter"));
            if (keccak256(bytes(em)) == keccak256("SELF")) {
                out[j].self = true;
            } else {
                out[j].emitter = vm.parseJsonAddress(json, string.concat(lp, ".emitter"));
            }
            out[j].topics = vm.parseJsonBytes32Array(json, string.concat(lp, ".topics"));
            out[j].data = vm.parseJsonBytes(json, string.concat(lp, ".data"));
        }
    }

    function _state(string memory json, string memory p)
        internal
        pure
        returns (Classifier.StateEntry[] memory out)
    {
        string[] memory keys = vm.parseJsonKeys(json, p);
        out = new Classifier.StateEntry[](keys.length);
        for (uint256 k = 0; k < keys.length; k++) {
            out[k].name = keys[k];
            out[k].value = vm.parseJsonBytes(json, string.concat(p, "['", keys[k], "']"));
        }
    }

    function _className(Classifier.Class c) internal pure returns (string memory) {
        if (c == Classifier.Class.Match) return "match";
        if (c == Classifier.Class.ReasonModernised) return "reason-modernised";
        if (c == Classifier.Class.Exorcised) return "exorcised";
        return "port-bug";
    }
}
