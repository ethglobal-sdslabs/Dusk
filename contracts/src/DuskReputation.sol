// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DuskIdentityController} from "./DuskIdentityController.sol";

contract DuskReputation {
    // Policy v2 (canary scoring, packages/core/src/canary-score.ts): one finding per job,
    // worst wins. Kinds: 1 empty/no-delivery (-20), 2 illegal (-50), 3 late (-10),
    // 4 delivered (+10). Score = clamp(100 + 10*passed - 10*late - 20*empty - 50*illegal).
    uint32 public constant SCORE_POLICY_VERSION = 2;
    uint256 public constant MAX_BATCH = 20;
    uint16 public constant AUTOMATIC_REASON = 20;

    enum Standing { Banned, New, Trusted, Good, Disputed }

    struct Finding { bytes32 job; uint8 kind; }

    struct Evaluation {
        address wallet;
        uint64 generation;
        uint16 score;
        uint32 settledJobs;
        uint32 rejectedJobs;
        uint32 badAnswers;
        uint32 illegal;
        uint32 late;
        uint32 passed;
        uint32 policyVersion;
        uint64 evaluatedAt;
        uint64 galileoBlock;
        uint64 arkivBlock;
        bytes32 evidenceHash;
        bytes32 evidenceRef;
        Finding[] findings;
    }

    struct Reputation {
        uint16 score;
        Standing standing;
        uint32 policyVersion;
        uint32 policyEpoch;
        uint64 generation;
        uint64 sequence;
        uint64 evaluatedAt;
        uint64 publishedAtBlock;
        uint64 galileoBlock;
        uint64 arkivBlock;
        uint32 resolvedJobs;
        uint32 badAnswers;
        uint32 illegal;
        uint32 late;
        uint32 passed;
        bytes32 evidenceHash;
        bytes32 namehash;
        bytes32 sourceContextHash;
        bytes32 evidenceRef;
    }

    DuskIdentityController public immutable CONTROLLER;
    bytes32 public immutable PARENT_NODE;
    address public company;
    address public pendingCompany;
    address public forwarder;
    address public workflowOwner;
    bytes32 public workflowId;
    bytes32 public sourceContextHash;
    bool public paused = true;
    uint16 public revokeBelow = 50;
    uint32 public minimumResolved = 3;
    uint64 public maxReportAge = 1 hours;
    uint32 public policyEpoch = 1;
    uint64 public publicationSequence;
    bool private _processing;
    mapping(address => Reputation) private _reputation;
    mapping(address => mapping(bytes32 => uint8)) private _findingFlags;
    mapping(address => uint32) public badAnswersOf;
    mapping(address => uint32) public illegalOf;
    mapping(address => uint32) public lateOf;
    mapping(address => uint32) public passedOf;
    mapping(address => uint64) private _lastAutomaticBan;
    mapping(address => uint64) private _findingsAtLastBan;

    function reputationOf(address wallet) external view returns (Reputation memory) { return _reputation[wallet]; }

    event ReputationPublished(address indexed wallet, bytes32 indexed namehash, uint64 indexed generation, string label, Reputation reputation);
    event FindingRecorded(address indexed wallet, bytes32 indexed job, uint8 kind, bytes32 evidenceHash);
    event FindingDismissed(address indexed wallet, bytes32 indexed job, uint8 kind, bytes32 decisionId, uint32 epoch);
    event EvaluationRejected(address indexed wallet, bytes4 reason);
    event RevocationDeferred(address indexed wallet, uint64 indexed sequence, bytes4 reason);
    event AutomaticallyRevoked(address indexed wallet, uint64 indexed sequence, bytes32 decisionId);
    event WorkflowConfigured(address forwarder, address workflowOwner, bytes32 workflowId, uint32 epoch);
    event PolicyConfigured(uint16 revokeBelow, uint32 minimumResolved, uint64 maxReportAge, bytes32 sourceContextHash, uint32 epoch);
    event PausedSet(bool paused, uint32 epoch);
    event CompanyProposed(address indexed next);
    event CompanyTransferred(address indexed previous, address indexed next);

    error NotCompany();
    error NotPendingCompany();
    error NotSelf();
    error InvalidConfiguration();
    error Paused();
    error UntrustedReport();
    error WrongDomain();
    error InvalidEvaluation();
    error StaleEvaluation();
    error StaleGeneration();
    error Reentrancy();

    modifier onlyCompany() {
        if (msg.sender != company) revert NotCompany();
        _;
    }

    constructor(DuskIdentityController controller, bytes32 sources) {
        if (address(controller).code.length == 0 || sources == bytes32(0)) revert InvalidConfiguration();
        CONTROLLER = controller;
        company = controller.governance();
        sourceContextHash = sources;
        bytes memory parent = controller.parentDnsName();
        if (parent.length > 255) revert InvalidConfiguration();
        PARENT_NODE = _namehash(parent, 0);
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == this.onReport.selector || id == 0x4e2312e0;
    }

    function onReport(bytes calldata metadata, bytes calldata report) external {
        if (paused) revert Paused();
        if (msg.sender != forwarder || metadata.length != 64 ||
            bytes32(metadata[0:32]) != workflowId || address(bytes20(metadata[42:62])) != workflowOwner) revert UntrustedReport();
        if (_processing) revert Reentrancy();
        _processing = true;
        (uint256 chainId, address receiver, uint32 epoch, bytes32 sources, Evaluation[] memory evaluations) =
            abi.decode(report, (uint256, address, uint32, bytes32, Evaluation[]));
        if (chainId != block.chainid || receiver != address(this) || epoch != policyEpoch || sources != sourceContextHash) revert WrongDomain();
        if (evaluations.length == 0 || evaluations.length > MAX_BATCH) revert InvalidEvaluation();
        for (uint256 i; i < evaluations.length; ++i) {
            try this.processEvaluation(evaluations[i]) {} catch (bytes memory reason) {
                emit EvaluationRejected(evaluations[i].wallet, _selector(reason));
            }
        }
        _processing = false;
    }

    function processEvaluation(Evaluation calldata e) external {
        if (msg.sender != address(this)) revert NotSelf();
        _validate(e);
        (string memory label, uint64 generation,, , DuskIdentityController.MembershipStatus membership) = CONTROLLER.membershipOf(e.wallet);
        if (generation == 0 || generation != e.generation || membership == DuskIdentityController.MembershipStatus.None) revert StaleGeneration();
        uint32 resolved = e.settledJobs + e.rejectedJobs;
        uint64 sequence = ++publicationSequence;
        bool banned = _enforce(e, membership, sequence, resolved);
        Standing standing = banned ? Standing.Banned : resolved < minimumResolved ? Standing.New :
            e.score < revokeBelow ? Standing.Disputed :
            uint256(e.settledJobs) * 100 >= uint256(resolved) * 95 ? Standing.Trusted :
            uint256(e.settledJobs) * 100 >= uint256(resolved) * 80 ? Standing.Good : Standing.Disputed;
        _record(e, label, sequence, resolved, standing);
    }

    function _validate(Evaluation calldata e) private {
        if (e.wallet == address(0) || e.score > 100 || e.policyVersion != SCORE_POLICY_VERSION || e.evidenceHash == bytes32(0) || e.evidenceRef == bytes32(0) ||
            e.evaluatedAt > block.timestamp || block.timestamp - e.evaluatedAt > maxReportAge) revert InvalidEvaluation();
        if (e.findings.length > 200) revert InvalidEvaluation();
        for (uint256 i; i < e.findings.length; ++i) {
            Finding calldata finding = e.findings[i];
            if (finding.job == bytes32(0) || finding.kind < 1 || finding.kind > 4) revert InvalidEvaluation();
            if (_applyFinding(e.wallet, finding.job, finding.kind)) emit FindingRecorded(e.wallet, finding.job, finding.kind, e.evidenceHash);
        }
        if (e.badAnswers != badAnswersOf[e.wallet] || e.illegal != illegalOf[e.wallet] ||
            e.late != lateOf[e.wallet] || e.passed != passedOf[e.wallet]) revert InvalidEvaluation();
        if (e.score != _score(e.badAnswers, e.illegal, e.late, e.passed)) revert InvalidEvaluation();
        Reputation storage previous = _reputation[e.wallet];
        if (e.evaluatedAt <= previous.evaluatedAt || e.galileoBlock < previous.galileoBlock || e.arkivBlock < previous.arkivBlock) revert StaleEvaluation();
        if (uint256(e.settledJobs) + e.rejectedJobs > type(uint32).max) revert InvalidEvaluation();
    }

    function _enforce(Evaluation calldata e, DuskIdentityController.MembershipStatus membership, uint64 sequence, uint32 resolved) private returns (bool banned) {
        uint64 moderationSequence;
        (banned, moderationSequence,,) = CONTROLLER.banOf(e.wallet);
        uint64 findingCount = uint64(e.badAnswers) + e.illegal + e.late;
        if (!banned && _lastAutomaticBan[e.wallet] != 0 && moderationSequence > _lastAutomaticBan[e.wallet] && findingCount <= _findingsAtLastBan[e.wallet]) return false;
        if (!banned && e.score < revokeBelow && resolved >= minimumResolved) {
            bytes32 decision = keccak256(abi.encode(block.chainid, address(this), policyEpoch, e.wallet, e.generation, sequence, e.evidenceHash));
            if (membership == DuskIdentityController.MembershipStatus.Active || membership == DuskIdentityController.MembershipStatus.Expired) {
                try CONTROLLER.revokeAndBan(e.wallet, e.generation, decision, AUTOMATIC_REASON, e.evidenceHash) {
                    banned = true;
                    (, _lastAutomaticBan[e.wallet],,) = CONTROLLER.banOf(e.wallet);
                    _findingsAtLastBan[e.wallet] = findingCount;
                    emit AutomaticallyRevoked(e.wallet, sequence, decision);
                } catch (bytes memory reason) { emit RevocationDeferred(e.wallet, sequence, _selector(reason)); }
            } else {
                try CONTROLLER.banWallet(e.wallet, decision, AUTOMATIC_REASON, e.evidenceHash) {
                    banned = true;
                    (, _lastAutomaticBan[e.wallet],,) = CONTROLLER.banOf(e.wallet);
                    _findingsAtLastBan[e.wallet] = findingCount;
                    emit AutomaticallyRevoked(e.wallet, sequence, decision);
                } catch (bytes memory reason) { emit RevocationDeferred(e.wallet, sequence, _selector(reason)); }
            }
        }
    }

    function _record(Evaluation calldata e, string memory label, uint64 sequence, uint32 resolved, Standing standing) private {
        Reputation storage r = _reputation[e.wallet];
        r.score = e.score; r.standing = standing; r.policyVersion = e.policyVersion; r.policyEpoch = policyEpoch;
        r.generation = e.generation; r.sequence = sequence; r.evaluatedAt = e.evaluatedAt; r.publishedAtBlock = uint64(block.number);
        r.galileoBlock = e.galileoBlock; r.arkivBlock = e.arkivBlock; r.resolvedJobs = resolved;
        r.badAnswers = e.badAnswers; r.illegal = e.illegal; r.late = e.late; r.passed = e.passed; r.evidenceHash = e.evidenceHash;
        r.namehash = keccak256(abi.encodePacked(PARENT_NODE, keccak256(bytes(label))));
        r.sourceContextHash = sourceContextHash;
        r.evidenceRef = e.evidenceRef;
        emit ReputationPublished(e.wallet, r.namehash, e.generation, label, r);
    }

    function findingFlagsOf(address wallet, bytes32[] calldata jobs) external view returns (uint8[] memory flags) {
        if (jobs.length > 200) revert InvalidEvaluation();
        flags = new uint8[](jobs.length);
        for (uint256 i; i < jobs.length; ++i) flags[i] = _findingFlags[wallet][jobs[i]];
    }

    function evaluationState(address wallet, bytes32[] calldata jobs) external view returns (uint32 badAnswers, uint32 illegal, uint32 late, uint32 passed, uint8[] memory flags) {
        if (jobs.length > 200) revert InvalidEvaluation();
        flags = new uint8[](jobs.length);
        for (uint256 i; i < jobs.length; ++i) flags[i] = _findingFlags[wallet][jobs[i]];
        return (badAnswersOf[wallet], illegalOf[wallet], lateOf[wallet], passedOf[wallet], flags);
    }

    function dismissFinding(address wallet, bytes32 job, uint8 kind, bytes32 decisionId) external onlyCompany {
        if (wallet == address(0) || job == bytes32(0) || kind < 1 || kind > 4 || decisionId == bytes32(0)) revert InvalidEvaluation();
        uint8 bit = uint8(1 << (kind - 1));
        uint8 flags = _findingFlags[wallet][job];
        if ((flags & (bit << 4)) != 0) revert StaleEvaluation();
        if ((flags & bit) != 0) _adjust(wallet, kind, false);
        _findingFlags[wallet][job] = (flags & ~bit) | (bit << 4);
        emit FindingDismissed(wallet, job, kind, decisionId, ++policyEpoch);
    }

    /// One finding per job, worst wins (illegal > empty > late > pass) — the same rule as
    /// applyFinding in packages/core/src/canary-score.ts. Flags: kind k is bit 1<<(k-1),
    /// dismissed is that bit << 4. A dismissed or already-recorded kind is ignored; so is
    /// one outranked by a finding the job already has. A worse finding clears the job's
    /// lesser ones, taking back their points. Returns whether anything changed.
    function _applyFinding(address wallet, bytes32 job, uint8 kind) private returns (bool) {
        uint8 flags = _findingFlags[wallet][job];
        uint8 bit = uint8(1 << (kind - 1));
        if ((flags & (bit << 4)) != 0 || (flags & bit) != 0) return false;
        uint8 rank = _rank(kind);
        for (uint8 k = 1; k <= 4; ++k) {
            uint8 b = uint8(1 << (k - 1));
            if ((flags & b) != 0 && _rank(k) > rank) return false;
        }
        for (uint8 k = 1; k <= 4; ++k) {
            uint8 b = uint8(1 << (k - 1));
            if ((flags & b) != 0 && _rank(k) < rank) { flags &= ~b; _adjust(wallet, k, false); }
        }
        _findingFlags[wallet][job] = flags | bit;
        _adjust(wallet, kind, true);
        return true;
    }

    function _rank(uint8 kind) private pure returns (uint8) {
        return kind == 2 ? 4 : kind == 1 ? 3 : kind == 3 ? 2 : 1;
    }

    function _adjust(address wallet, uint8 kind, bool up) private {
        if (kind == 1) { if (up) ++badAnswersOf[wallet]; else --badAnswersOf[wallet]; }
        else if (kind == 2) { if (up) ++illegalOf[wallet]; else --illegalOf[wallet]; }
        else if (kind == 3) { if (up) ++lateOf[wallet]; else --lateOf[wallet]; }
        else { if (up) ++passedOf[wallet]; else --passedOf[wallet]; }
    }

    function _score(uint32 empty, uint32 illegal, uint32 late, uint32 passed) private pure returns (uint16) {
        int256 s = 100 + 10 * int256(uint256(passed)) - 10 * int256(uint256(late)) - 20 * int256(uint256(empty)) - 50 * int256(uint256(illegal));
        return s <= 0 ? 0 : s >= 100 ? 100 : uint16(uint256(s));
    }

    function configureWorkflow(address forwarder_, address owner_, bytes32 id_) external onlyCompany {
        if (forwarder_.code.length == 0 || owner_ == address(0) || id_ == bytes32(0)) revert InvalidConfiguration();
        forwarder = forwarder_; workflowOwner = owner_; workflowId = id_;
        emit WorkflowConfigured(forwarder_, owner_, id_, ++policyEpoch);
    }

    function configurePolicy(uint16 below, uint32 minimum, uint64 age, bytes32 sources) external onlyCompany {
        if (below > 100 || minimum == 0 || age == 0 || age > 1 days || sources == bytes32(0)) revert InvalidConfiguration();
        revokeBelow = below; minimumResolved = minimum; maxReportAge = age; sourceContextHash = sources;
        emit PolicyConfigured(below, minimum, age, sources, ++policyEpoch);
    }

    function setPaused(bool value) external onlyCompany {
        if (!value && (forwarder == address(0) || workflowId == bytes32(0) || CONTROLLER.revoker() != address(this))) revert InvalidConfiguration();
        paused = value;
        emit PausedSet(value, ++policyEpoch);
    }

    function proposeCompany(address next) external onlyCompany {
        if (next == address(0)) revert InvalidConfiguration();
        pendingCompany = next;
        emit CompanyProposed(next);
    }

    function acceptCompany() external {
        if (msg.sender != pendingCompany) revert NotPendingCompany();
        emit CompanyTransferred(company, msg.sender);
        company = msg.sender; pendingCompany = address(0);
    }

    function commitOperatorName(bytes32 commitment) external onlyCompany {
        CONTROLLER.commit(commitment);
    }

    function registerOperatorName(bytes32 secret) external onlyCompany {
        CONTROLLER.register("revoker", secret);
    }

    function renewOperatorName() external onlyCompany { CONTROLLER.renew(); }

    function onERC1155Received(address, address from, uint256, uint256 value, bytes calldata) external view returns (bytes4) {
        if (msg.sender != address(CONTROLLER.REGISTRY()) || from != address(0) || value != 1) revert UntrustedReport();
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external pure returns (bytes4) {
        revert UntrustedReport();
    }

    function _selector(bytes memory reason) private pure returns (bytes4 selector) {
        if (reason.length >= 4) assembly { selector := mload(add(reason, 32)) }
    }

    function _namehash(bytes memory dns, uint256 offset) private pure returns (bytes32) {
        if (offset >= dns.length) revert InvalidConfiguration();
        uint256 length = uint8(dns[offset]);
        if (length == 0) {
            if (offset + 1 != dns.length) revert InvalidConfiguration();
            return bytes32(0);
        }
        if (length > 63 || offset + 1 + length >= dns.length) revert InvalidConfiguration();
        bytes memory label = new bytes(length);
        for (uint256 i; i < length; ++i) label[i] = dns[offset + 1 + i];
        return keccak256(abi.encodePacked(_namehash(dns, offset + 1 + length), keccak256(label)));
    }
}
