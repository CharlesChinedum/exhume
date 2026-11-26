// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// HAND-WRITTEN FIXTURE (task 8.3): expected generator output for the Wallet handler fixture
// (payable function, payable fallback, events, one- and two-address getters, assert, constructor argument).
library Targets {
    string internal constant LEGACY_ARTIFACT = "LegacyWallet.sol:Wallet";
    string internal constant PORT_ARTIFACT = "PortWallet.sol:Wallet";
    bool internal constant HAS_TOKEN_SHARES = false;
    uint256 internal constant FUNDING_WEI = 1 ether;
    uint8 internal constant KIND_STATIC = 0;
    uint8 internal constant KIND_ARRAY_LEN = 1;

    struct Assign {
        uint8 paramIndex;
        uint8 kind;
        uint256 value;
    }

    struct Entry {
        Assign[] assigns;
    }

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
        return abi.encode(uint256(1));
    }

    /// One seed call: actor 1 approves Actor_Set index 4 (address(0)) for 7.
    function seeds() internal pure returns (Seed[] memory s) {
        s = new Seed[](1);
        uint256[] memory a = new uint256[](2);
        a[0] = 4;
        a[1] = 7;
        s[0] = Seed({fn: "approve", actorIdx: 1, value: 0, args: a});
    }

    function noArgGetters() internal pure returns (Getter[] memory g) {
        g = new Getter[](3);
        g[0] = Getter({name: "total", selector: bytes4(keccak256("total()"))});
        g[1] = Getter({name: "hits", selector: bytes4(keccak256("hits()"))});
        g[2] = Getter({name: "lastSenderBalance", selector: bytes4(keccak256("lastSenderBalance()"))});
    }

    function addrGetters() internal pure returns (Getter[] memory g) {
        g = new Getter[](1);
        g[0] = Getter({name: "deposits", selector: bytes4(keccak256("deposits(address)"))});
    }

    function pairGetters() internal pure returns (Getter[] memory g) {
        g = new Getter[](1);
        g[0] = Getter({name: "allowed", selector: bytes4(keccak256("allowed(address,address)"))});
    }

    function isKnownSelector(bytes4 sel) internal pure returns (bool) {
        return sel == bytes4(keccak256("deposit()")) || sel == bytes4(keccak256("approve(address,uint256)"))
            || sel == bytes4(keccak256("crash()")) || sel == bytes4(keccak256("total()"))
            || sel == bytes4(keccak256("hits()")) || sel == bytes4(keccak256("lastSenderBalance()"))
            || sel == bytes4(keccak256("deposits(address)")) || sel == bytes4(keccak256("allowed(address,address)"));
    }

    function targets_deposit() internal pure returns (Entry[] memory e) {
        e = new Entry[](0);
    }

    function targets_approve() internal pure returns (Entry[] memory e) {
        e = new Entry[](0);
    }
}
