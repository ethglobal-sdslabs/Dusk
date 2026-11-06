// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

contract DuskAdmission {
    struct Status {
        uint256 sourceChainId;
        address controller;
        address wallet;
        bool admitted;
        uint64 sourceBlock;
        uint64 validUntil;
        uint32 epoch;
    }

    struct Record {
        bool admitted;
        uint64 sourceBlock;
        uint64 validUntil;
        uint32 epoch;
    }

    bytes32 public constant STATUS_TYPEHASH = keccak256(
        "Status(uint256 sourceChainId,address controller,address wallet,bool admitted,uint64 sourceBlock,uint64 validUntil,uint32 epoch)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 public immutable DOMAIN_SEPARATOR;
    uint256 public immutable SOURCE_CHAIN_ID;
    address public immutable CONTROLLER;
    uint64 public immutable MAX_VALIDITY;

    address public governance;
    address public pendingGovernance;
    mapping(address => bool) public isAttester;
    uint256 public attesterCount;
    uint256 public quorum;
    uint32 public epoch;
    mapping(address wallet => Record) public records;

    event StatusUpdated(address indexed wallet, bool admitted, uint64 sourceBlock, uint64 validUntil, uint32 epoch, address submitter);
    event AttesterSet(address indexed attester, bool allowed);
    event QuorumSet(uint256 quorum);
    event EpochBumped(uint32 epoch);
    event RecordReset(address indexed wallet);
    event GovernanceProposed(address indexed next);
    event GovernanceTransferred(address indexed previous, address indexed next);

    error NotGovernance();
    error NotPendingGovernance();
    error WrongSource();
    error WrongEpoch();
    error BadValidity();
    error StaleStatus();
    error BadSignature();
    error UnknownAttester(address signer);
    error SignersNotSorted();
    error QuorumNotMet(uint256 have, uint256 need);
    error BadQuorum();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    constructor(uint256 sourceChainId, address controller, uint64 maxValidity, address governance_, address[] memory attesters, uint256 quorum_) {
        require(controller != address(0) && governance_ != address(0) && maxValidity > 0, "bad config");
        SOURCE_CHAIN_ID = sourceChainId;
        CONTROLLER = controller;
        MAX_VALIDITY = maxValidity;
        governance = governance_;
        for (uint256 i; i < attesters.length; ++i) _setAttester(attesters[i], true);
        _setQuorum(quorum_);
        epoch = 1;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("DuskAdmission"), keccak256("1"), block.chainid, address(this))
        );
    }

    function statusDigest(Status calldata s) public view returns (bytes32) {
        return keccak256(abi.encodePacked(
            "\x19\x01",
            DOMAIN_SEPARATOR,
            keccak256(abi.encode(STATUS_TYPEHASH, s.sourceChainId, s.controller, s.wallet, s.admitted, s.sourceBlock, s.validUntil, s.epoch))
        ));
    }

    function submit(Status calldata s, bytes[] calldata signatures) external {
        if (s.sourceChainId != SOURCE_CHAIN_ID || s.controller != CONTROLLER) revert WrongSource();
        if (s.epoch != epoch) revert WrongEpoch();
        if (s.validUntil <= block.timestamp || s.validUntil > block.timestamp + MAX_VALIDITY) revert BadValidity();
        Record storage r = records[s.wallet];
        if (r.epoch == epoch && s.sourceBlock <= r.sourceBlock) revert StaleStatus();

        bytes32 digest = statusDigest(s);
        address last;
        uint256 valid;
        for (uint256 i; i < signatures.length; ++i) {
            address signer = _recover(digest, signatures[i]);
            if (signer <= last) revert SignersNotSorted();
            if (!isAttester[signer]) revert UnknownAttester(signer);
            last = signer;
            ++valid;
        }
        if (valid < quorum) revert QuorumNotMet(valid, quorum);

        records[s.wallet] = Record(s.admitted, s.sourceBlock, s.validUntil, s.epoch);
        emit StatusUpdated(s.wallet, s.admitted, s.sourceBlock, s.validUntil, s.epoch, msg.sender);
    }

    function isAdmitted(address wallet) external view returns (bool) {
        Record storage r = records[wallet];
        return r.admitted && r.epoch == epoch && block.timestamp < r.validUntil;
    }

    function setAttester(address attester, bool allowed) external onlyGovernance {
        _setAttester(attester, allowed);
        if (quorum > attesterCount) revert BadQuorum();
    }

    function setQuorum(uint256 quorum_) external onlyGovernance {
        _setQuorum(quorum_);
    }

    function resetRecord(address wallet) external onlyGovernance {
        delete records[wallet];
        emit RecordReset(wallet);
    }

    function bumpEpoch() external onlyGovernance {
        emit EpochBumped(++epoch);
    }

    function proposeGovernance(address next) external onlyGovernance {
        pendingGovernance = next;
        emit GovernanceProposed(next);
    }

    function acceptGovernance() external {
        if (msg.sender != pendingGovernance || msg.sender == address(0)) revert NotPendingGovernance();
        emit GovernanceTransferred(governance, msg.sender);
        governance = msg.sender;
        pendingGovernance = address(0);
    }

    function _setAttester(address attester, bool allowed) private {
        require(attester != address(0), "zero attester");
        if (isAttester[attester] == allowed) return;
        isAttester[attester] = allowed;
        if (allowed) ++attesterCount;
        else --attesterCount;
        emit AttesterSet(attester, allowed);
    }

    function _setQuorum(uint256 quorum_) private {
        if (quorum_ == 0 || quorum_ > attesterCount) revert BadQuorum();
        quorum = quorum_;
        emit QuorumSet(quorum_);
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address signer) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        if (v != 27 && v != 28) revert BadSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
    }
}
