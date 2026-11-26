// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// HAND-WRITTEN FIXTURE (task 8.3): the output the Project_Generator (task 8.5) is expected to produce
// for engine/test/docker/fixtures/token (legacy 0.4.19 Token, 0.8 port). Not generated.
library Targets {
    string internal constant LEGACY_ARTIFACT = "LegacyToken.sol:Token";
    string internal constant PORT_ARTIFACT = "PortToken.sol:Token";
    bool internal constant HAS_TOKEN_SHARES = true; // ABI has transfer(address,uint256) and balanceOf(address)
    uint256 internal constant FUNDING_WEI = 0;
    uint8 internal constant KIND_STATIC = 0; // ParamSlot.encoding "static"
    uint8 internal constant KIND_ARRAY_LEN = 1; // ParamSlot.encoding "dynamicArrayLength"

    struct Assign {
        uint8 paramIndex;
        uint8 kind;
        uint256 value;
    }

    struct Entry {
        Assign[] assigns;
    }

    /// Address arguments are Actor_Set indices (0..4), the other arguments plain integers.
    struct Seed {
        string fn;
        uint8 actorIdx;
        uint256 value;
        uint256[] args;
    }

    struct Getter {
        string name;
        bytes4 selector;
    }

    function ctorArgs() internal pure returns (bytes memory) {
        return hex"";
    }

    /// Seed sequences, flattened in order. One sequence: the deployer transfers 1 unit to actors 1..3.
    function seeds() internal pure returns (Seed[] memory s) {
        s = new Seed[](3);
        for (uint256 i = 0; i < 3; i++) {
            uint256[] memory a = new uint256[](2);
            a[0] = i + 1; // Actor_Set index
            a[1] = 1;
            s[i] = Seed({fn: "transfer", actorIdx: 0, value: 0, args: a});
        }
    }

    function noArgGetters() internal pure returns (Getter[] memory g) {
        g = new Getter[](0);
    }

    function addrGetters() internal pure returns (Getter[] memory g) {
        g = new Getter[](1);
        g[0] = Getter({name: "balanceOf", selector: bytes4(keccak256("balanceOf(address)"))});
    }

    function pairGetters() internal pure returns (Getter[] memory g) {
        g = new Getter[](0);
    }

    function isKnownSelector(bytes4 sel) internal pure returns (bool) {
        return sel == bytes4(keccak256("transfer(address,uint256)")) || sel == bytes4(keccak256("balanceOf(address)"))
            || sel == bytes4(keccak256("batchTransfer(address[],uint256)"));
    }

    /// transfer: no Arithmetic_Site entries.
    function targets_transfer() internal pure returns (Entry[] memory e) {
        e = new Entry[](0);
    }

    /// batchTransfer: (receivers.length = n, _value = ceil(2^256 / n)) for n in 2..24, plus one
    /// out-of-range length (2^200) that the handler must clamp to 24.
    function targets_batchTransfer() internal pure returns (Entry[] memory e) {
        e = new Entry[](24);
        e[0] = _pair(0, KIND_ARRAY_LEN, 2, 1, KIND_STATIC, 57896044618658097711785492504343953926634992332820282019728792003956564819968);
        e[1] = _pair(0, KIND_ARRAY_LEN, 3, 1, KIND_STATIC, 38597363079105398474523661669562635951089994888546854679819194669304376546646);
        e[2] = _pair(0, KIND_ARRAY_LEN, 4, 1, KIND_STATIC, 28948022309329048855892746252171976963317496166410141009864396001978282409984);
        e[3] = _pair(0, KIND_ARRAY_LEN, 5, 1, KIND_STATIC, 23158417847463239084714197001737581570653996933128112807891516801582625927988);
        e[4] = _pair(0, KIND_ARRAY_LEN, 6, 1, KIND_STATIC, 19298681539552699237261830834781317975544997444273427339909597334652188273323);
        e[5] = _pair(0, KIND_ARRAY_LEN, 7, 1, KIND_STATIC, 16541727033902313631938712144098272550467140666520080577065369143987589948563);
        e[6] = _pair(0, KIND_ARRAY_LEN, 8, 1, KIND_STATIC, 14474011154664524427946373126085988481658748083205070504932198000989141204992);
        e[7] = _pair(0, KIND_ARRAY_LEN, 9, 1, KIND_STATIC, 12865787693035132824841220556520878650363331629515618226606398223101458848882);
        e[8] = _pair(0, KIND_ARRAY_LEN, 10, 1, KIND_STATIC, 11579208923731619542357098500868790785326998466564056403945758400791312963994);
        e[9] = _pair(0, KIND_ARRAY_LEN, 11, 1, KIND_STATIC, 10526553567028745038506453182607991623024544060512778549041598546173920876358);
        e[10] = _pair(0, KIND_ARRAY_LEN, 12, 1, KIND_STATIC, 9649340769776349618630915417390658987772498722136713669954798667326094136662);
        e[11] = _pair(0, KIND_ARRAY_LEN, 13, 1, KIND_STATIC, 8907083787485861186428537308360608296405383435818504926112121846762548433842);
        e[12] = _pair(0, KIND_ARRAY_LEN, 14, 1, KIND_STATIC, 8270863516951156815969356072049136275233570333260040288532684571993794974282);
        e[13] = _pair(0, KIND_ARRAY_LEN, 15, 1, KIND_STATIC, 7719472615821079694904732333912527190217998977709370935963838933860875309330);
        e[14] = _pair(0, KIND_ARRAY_LEN, 16, 1, KIND_STATIC, 7237005577332262213973186563042994240829374041602535252466099000494570602496);
        e[15] = _pair(0, KIND_ARRAY_LEN, 17, 1, KIND_STATIC, 6811299366900952671974763824040465167839410862684739061144563765171360567056);
        e[16] = _pair(0, KIND_ARRAY_LEN, 18, 1, KIND_STATIC, 6432893846517566412420610278260439325181665814757809113303199111550729424441);
        e[17] = _pair(0, KIND_ARRAY_LEN, 19, 1, KIND_STATIC, 6094320486174536601240578158351995150172104456086345475760925474100691033681);
        e[18] = _pair(0, KIND_ARRAY_LEN, 20, 1, KIND_STATIC, 5789604461865809771178549250434395392663499233282028201972879200395656481997);
        e[19] = _pair(0, KIND_ARRAY_LEN, 21, 1, KIND_STATIC, 5513909011300771210646237381366090850155713555506693525688456381329196649521);
        e[20] = _pair(0, KIND_ARRAY_LEN, 22, 1, KIND_STATIC, 5263276783514372519253226591303995811512272030256389274520799273086960438179);
        e[21] = _pair(0, KIND_ARRAY_LEN, 23, 1, KIND_STATIC, 5034438662492008496676999348203822080576955855027850610411199304691875201737);
        e[22] = _pair(0, KIND_ARRAY_LEN, 24, 1, KIND_STATIC, 4824670384888174809315457708695329493886249361068356834977399333663047068331);
        e[23] = _pair(0, KIND_ARRAY_LEN, 1606938044258990275541962092341162602522202993782792835301376, 1, KIND_STATIC, 1);
    }

    function _pair(uint8 p0, uint8 k0, uint256 v0, uint8 p1, uint8 k1, uint256 v1) private pure returns (Entry memory e) {
        e.assigns = new Assign[](2);
        e.assigns[0] = Assign(p0, k0, v0);
        e.assigns[1] = Assign(p1, k1, v1);
    }
}
