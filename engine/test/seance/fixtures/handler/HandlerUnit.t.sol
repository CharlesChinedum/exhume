// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// THROWAWAY unit tests (task 8.3) for the handler's pure helpers, run against the token fixture.
// They inherit the handler to reach its internal functions.
import {Test} from "forge-std/Test.sol";
import {DifferentialHandler} from "./handler/DifferentialHandler.sol";
import {Targets} from "./handler/Targets.sol";

contract HandlerHarness is DifferentialHandler {
    function pickTarget(uint256 pick, uint256 n) external pure returns (bool, uint256) {
        return _pickTarget(pick, n);
    }

    function addr(uint8 i) external pure returns (address) {
        return _addr(i);
    }

    function sender(uint8 i) external pure returns (address) {
        return _sender(i);
    }

    function addressArray(uint256 len, uint256 pack) external pure returns (address[] memory) {
        return _addressArray(len, pack);
    }

    function boundLen(uint256 x) external pure returns (uint256) {
        return _boundLen(x);
    }

    function applyTargets(uint256 pick, Targets.Entry[] memory e, uint256[] memory p)
        external
        pure
        returns (uint256[] memory)
    {
        _applyTargets(pick, e, p);
        return p;
    }

    function unknownCalldata(bytes memory data) external pure returns (bytes memory) {
        return _unknownCalldata(data);
    }
}

contract HandlerUnitTest is Test {
    HandlerHarness h;

    function setUp() public {
        h = new HandlerHarness();
    }

    function test_pickTarget_parityAndIndex() public view {
        uint256[7] memory picks = [uint256(0), 1, 2, 3, 12345, type(uint256).max, type(uint256).max - 1];
        bool sawEven;
        bool sawOdd;
        for (uint256 i = 0; i < picks.length; i++) {
            uint256 hh = uint256(keccak256(abi.encode(picks[i])));
            (bool use, uint256 index) = h.pickTarget(picks[i], 7);
            assertEq(use, hh % 2 == 0);
            assertEq(index, (hh >> 1) % 7);
            (bool use0,) = h.pickTarget(picks[i], 0);
            assertFalse(use0);
            if (hh % 2 == 0) sawEven = true;
            else sawOdd = true;
        }
        assertTrue(sawEven && sawOdd);
    }

    function test_addr_actorSetPlusZero() public view {
        assertEq(h.addr(0), address(0xD0));
        assertEq(h.addr(1), address(0xA1));
        assertEq(h.addr(2), address(0xA2));
        assertEq(h.addr(3), address(0xA3));
        assertEq(h.addr(4), address(0));
        assertEq(h.addr(5), address(0xD0)); // wraps modulo 5
        for (uint8 i = 0; i < 8; i++) {
            assertTrue(h.sender(i) != address(0));
        }
        assertEq(h.sender(4), address(0xD0)); // senders wrap modulo 4
    }

    function test_addressArray_fromLenAndPack() public view {
        // byte j of the pack is the actor index of element j
        uint256 pack = uint256(4) | (uint256(2) << 8) | (uint256(1) << 16);
        address[] memory a = h.addressArray(3, pack);
        assertEq(a.length, 3);
        assertEq(a[0], address(0));
        assertEq(a[1], address(0xA2));
        assertEq(a[2], address(0xA1));
        assertEq(h.addressArray(0, pack).length, 0);
    }

    function test_boundLen_isAlwaysAtMost24() public view {
        assertEq(h.boundLen(0), 0);
        assertEq(h.boundLen(24), 24);
        assertEq(h.boundLen(25), 0);
        assertEq(h.boundLen(type(uint256).max) <= 24, true);
        assertEq(h.addressArray(type(uint256).max, 0).length, type(uint256).max % 25);
    }

    function _firstUsingPick(uint256 n) internal view returns (uint256 pick) {
        for (pick = 0; pick < 1000; pick++) {
            (bool use,) = h.pickTarget(pick, n);
            if (use) return pick;
        }
        revert("no pick");
    }

    function test_applyTargets_clampsLengthAndIgnoresOutOfRangeSlots() public view {
        Targets.Entry[] memory e = new Targets.Entry[](1);
        e[0].assigns = new Targets.Assign[](3);
        e[0].assigns[0] = Targets.Assign(0, Targets.KIND_ARRAY_LEN, 1 << 200); // generator gap: above 24
        e[0].assigns[1] = Targets.Assign(1, Targets.KIND_STATIC, 77);
        e[0].assigns[2] = Targets.Assign(9, Targets.KIND_STATIC, 5); // no such parameter: ignored
        uint256[] memory p = new uint256[](2);
        p[0] = 3;
        p[1] = 4;
        uint256[] memory out = h.applyTargets(_firstUsingPick(1), e, p);
        assertEq(out[0], 24);
        assertEq(out[1], 77);
        // an entry with no assignments leaves the fuzzed values alone
        Targets.Entry[] memory empty = new Targets.Entry[](1);
        empty[0].assigns = new Targets.Assign[](0);
        uint256[] memory q = new uint256[](2);
        q[0] = 3;
        q[1] = 4;
        uint256[] memory out2 = h.applyTargets(_firstUsingPick(1), empty, q);
        assertEq(out2[0], 3);
        assertEq(out2[1], 4);
    }

    function test_unknownCalldata_selectorNotInAbiAndBodyCapped() public view {
        bytes memory big = new bytes(300);
        bytes memory cd = h.unknownCalldata(big);
        assertEq(cd.length, 4 + 256);
        assertFalse(Targets.isKnownSelector(bytes4(cd)));
        assertEq(h.unknownCalldata("").length, 4);
    }
}
