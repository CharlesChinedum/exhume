pragma solidity ^0.4.19;

// HANDLER FIXTURE (task 8.3): payable calls, fallback, event logs, address-keyed getters, assert.
contract Wallet {
    uint256 public total;
    uint256 public hits;
    uint256 public lastSenderBalance;
    mapping(address => uint256) public deposits;
    mapping(address => mapping(address => uint256)) public allowed;

    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed from, uint256 value);

    function Wallet(uint256 x) public {
        require(x != 0);
    }

    function deposit() public payable {
        deposits[msg.sender] += msg.value;
        total += msg.value;
        lastSenderBalance = msg.sender.balance;
        Deposit(msg.sender, msg.value);
    }

    function approve(address s, uint256 v) public returns (bool) {
        allowed[msg.sender][s] = v;
        Approval(msg.sender, s, v);
        return true;
    }

    // Legacy assert: invalid opcode, burns all forwarded gas. The port reverts with Panic(0x01).
    function crash() public {
        assert(false);
    }

    function() public payable {
        hits += 1;
    }
}
