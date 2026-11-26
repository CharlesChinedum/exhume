// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

contract Wallet {
    uint256 public total;
    uint256 public hits;
    uint256 public lastSenderBalance;
    mapping(address => uint256) public deposits;
    mapping(address => mapping(address => uint256)) public allowed;

    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed from, uint256 value);

    constructor(uint256 x) {
        require(x != 0);
    }

    function deposit() public payable {
        deposits[msg.sender] += msg.value;
        total += msg.value;
        lastSenderBalance = msg.sender.balance;
        emit Deposit(msg.sender, msg.value);
    }

    function approve(address s, uint256 v) public returns (bool) {
        allowed[msg.sender][s] = v;
        emit Approval(msg.sender, s, v);
        return true;
    }

    function crash() public {
        assert(false);
    }

    fallback() external payable {
        hits += 1;
    }
}
