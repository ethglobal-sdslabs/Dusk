// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IDuskAdmission {
    function isAdmitted(address account) external view returns (bool);
}

contract DuskEscrow {
    enum State {
        None,
        Funded,
        Committed,
        Settled,
        Refunded
    }

    struct Deal {
        address buyer;
        address worker;
        uint256 amount;
        bytes32 outputHash;
        uint64 commitAt;
        uint64 deadline;
        State state;
    }

    mapping(bytes32 => Deal) public deals;

    bytes32 public constant AUTH_TYPEHASH = keccak256("CommitAuth(bytes32 jobId,address worker)");

    bytes32 public immutable DOMAIN_SEPARATOR;

    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    event Funded(bytes32 indexed jobId, address indexed buyer, uint256 amount, uint64 deadline);
    event Committed(bytes32 indexed jobId, address indexed worker, bytes32 outputHash);
    event Settled(bytes32 indexed jobId, address indexed worker, uint256 amount);
    event Refunded(bytes32 indexed jobId, address indexed buyer, uint256 amount);
    event Rejected(bytes32 indexed jobId, address indexed worker);

    error DealExists();
    error ZeroAmount();
    error EmptyOutputHash();
    error DeadlineInPast();
    error DeadlinePassed();
    error NotFunded();
    error NotCommitted();
    error NotBuyer();
    error NotAuthorised();
    error BuyerIsNotWorker();
    error BadSignature();
    error DeadlineNotReached();
    error TransferFailed();
    error NotAdmitted();

    IDuskAdmission public immutable ADMISSION;

    error ChallengeWindowOpen();
    error ChallengeWindowClosed();
    error NotVerifier();
    error BadConfig();

    uint64 public immutable CHALLENGE_WINDOW;

    address public immutable VERIFIER;

    bytes32 public constant VERDICT_TYPEHASH = keccak256("Verdict(bytes32 jobId,bytes32 outputHash,bool valid)");

    constructor(IDuskAdmission admission, uint64 challengeWindowSeconds, address verifier) {
        if (verifier == address(0)) {
            if (challengeWindowSeconds != 0) revert BadConfig();
        } else if (challengeWindowSeconds == 0 || challengeWindowSeconds > 7 days) {
            revert BadConfig();
        }
        CHALLENGE_WINDOW = challengeWindowSeconds;
        VERIFIER = verifier;
        ADMISSION = admission;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Dusk"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    function fund(bytes32 jobId, uint64 deadline) external payable {
        if (deals[jobId].state != State.None) revert DealExists();
        _requireAdmitted(msg.sender);
        if (msg.value == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert DeadlineInPast();

        deals[jobId] = Deal({
            buyer: msg.sender,
            worker: address(0),
            amount: msg.value,
            outputHash: bytes32(0),
            commitAt: 0,
            deadline: deadline,
            state: State.Funded
        });

        emit Funded(jobId, msg.sender, msg.value, deadline);
    }

    function commit(bytes32 jobId, bytes32 outputHash, bytes calldata buyerAuth) external {
        Deal storage deal = deals[jobId];

        if (deal.state != State.Funded) revert NotFunded();
        _requireAdmitted(msg.sender);
        if (block.timestamp > deal.deadline) revert DeadlinePassed();
        if (outputHash == bytes32(0)) revert EmptyOutputHash();
        if (msg.sender == deal.buyer) revert BuyerIsNotWorker();

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01", DOMAIN_SEPARATOR, keccak256(abi.encode(AUTH_TYPEHASH, jobId, msg.sender))
            )
        );
        if (_recover(digest, buyerAuth) != deal.buyer) revert NotAuthorised();

        deal.worker = msg.sender;
        deal.outputHash = outputHash;
        deal.commitAt = uint64(block.timestamp);
        deal.state = State.Committed;

        emit Committed(jobId, msg.sender, outputHash);
    }

    function settle(bytes32 jobId) external {
        Deal storage deal = deals[jobId];
        if (deal.state != State.Committed) revert NotCommitted();
        if (CHALLENGE_WINDOW != 0 && block.timestamp <= uint256(deal.commitAt) + CHALLENGE_WINDOW) revert ChallengeWindowOpen();
        _settle(jobId, deal);
    }

    function settleVerified(bytes32 jobId, bytes calldata verdict) external {
        Deal storage deal = deals[jobId];
        if (deal.state != State.Committed) revert NotCommitted();
        if (_recover(_verdictDigest(jobId, deal.outputHash, true), verdict) != VERIFIER) revert NotVerifier();
        _settle(jobId, deal);
    }

    function reject(bytes32 jobId, bytes calldata verdict) external {
        Deal storage deal = deals[jobId];
        if (deal.state != State.Committed) revert NotCommitted();
        if (block.timestamp > uint256(deal.commitAt) + CHALLENGE_WINDOW) revert ChallengeWindowClosed();
        if (_recover(_verdictDigest(jobId, deal.outputHash, false), verdict) != VERIFIER) revert NotVerifier();

        uint256 amount = deal.amount;
        address buyer = deal.buyer;
        address worker = deal.worker;
        deal.state = State.Refunded;
        deal.amount = 0;

        emit Rejected(jobId, worker);
        emit Refunded(jobId, buyer, amount);
        _pay(buyer, amount);
    }

    function _verdictDigest(bytes32 jobId, bytes32 outputHash, bool valid) private view returns (bytes32) {
        return keccak256(
            abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, keccak256(abi.encode(VERDICT_TYPEHASH, jobId, outputHash, valid)))
        );
    }

    function _settle(bytes32 jobId, Deal storage deal) private {
        uint256 amount = deal.amount;
        address worker = deal.worker;

        deal.state = State.Settled;
        deal.amount = 0;

        emit Settled(jobId, worker, amount);
        _pay(worker, amount);
    }

    function refund(bytes32 jobId) external {
        Deal storage deal = deals[jobId];
        if (deal.state != State.Funded) revert NotFunded();
        if (msg.sender != deal.buyer) revert NotBuyer();
        if (block.timestamp <= deal.deadline) revert DeadlineNotReached();

        uint256 amount = deal.amount;
        address buyer = deal.buyer;

        deal.state = State.Refunded;
        deal.amount = 0;

        emit Refunded(jobId, buyer, amount);
        _pay(buyer, amount);
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (uint256(s) > HALF_N) revert BadSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }

    function _requireAdmitted(address account) private view {
        if (address(ADMISSION) != address(0) && !ADMISSION.isAdmitted(account)) revert NotAdmitted();
    }

    function _pay(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
