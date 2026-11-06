// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IDuskNameRegistry {
    struct State {
        uint8 status;
        uint64 expiry;
        address latestOwner;
        uint256 tokenId;
        uint256 resource;
    }

    function getState(uint256 anyId) external view returns (State memory);
    function register(string calldata label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry)
        external
        returns (uint256 tokenId);
    function unregister(uint256 anyId) external;
    function renew(uint256 anyId, uint64 newExpiry) external;
}

interface IDuskVerifiableFactory {
    function deployProxy(address implementation, uint256 salt, bytes calldata data) external returns (address);
}

interface IDuskResolverInit {
    struct Grant {
        address account;
        uint256 roleBitmap;
    }

    function initialize(Grant[] calldata grants, bytes[] calldata calls) external;
    function setAddress(bytes calldata name, uint256 coinType, bytes calldata addressBytes) external;
}

contract DuskIdentityController {
    uint256 internal constant REGISTRY_REGISTERED = 2;
    uint256 internal constant RESOLVER_SET_ADDRESS = 1 << 0;
    uint256 internal constant RESOLVER_SET_TEXT = 1 << 4;
    uint256 internal constant RESOLVER_SET_CONTENTHASH = 1 << 8;
    uint256 internal constant RESOLVER_SET_DATA = 1 << 24;
    uint256 public constant MEMBER_RESOLVER_ROLES =
        RESOLVER_SET_ADDRESS | RESOLVER_SET_TEXT | RESOLVER_SET_CONTENTHASH | RESOLVER_SET_DATA;
    uint256 internal constant COIN_TYPE_ETH = 60;

    uint8 public constant ACTION_BAN = 1;
    uint8 public constant ACTION_UNBAN = 2;

    uint32 public constant POLICY_VERSION = 3;
    bytes32 internal constant REVOKER_LABELHASH = keccak256("revoker");

    enum MembershipStatus {
        None,
        Active,
        Expired,
        Lost
    }

    struct Membership {
        string label;
        uint64 generation;
        uint64 enrolledAt;
        address resolver;
    }

    struct Ban {
        bool active;
        uint64 sequence;
        uint16 reasonCode;
        bytes32 decisionId;
    }

    IDuskNameRegistry public immutable REGISTRY;
    IDuskNameRegistry public immutable PARENT_REGISTRY;
    uint256 public immutable PARENT_ID;
    IDuskVerifiableFactory public immutable FACTORY;
    address public immutable RESOLVER_IMPLEMENTATION;
    uint64 public immutable TERM;
    uint64 public immutable MIN_COMMITMENT_AGE;
    uint64 public immutable MAX_COMMITMENT_AGE;

    bytes public parentDnsName;

    address public governance;
    address public pendingGovernance;
    address public revoker;
    address public unbanner;
    bool public registrationsPaused;
    uint256 public revocationsPerDay;

    mapping(address wallet => Membership) internal _memberships;
    address[] private _memberWallets;
    mapping(bytes32 labelhash => address) public holderOf;
    mapping(bytes32 labelhash => uint64) public generationOf;
    mapping(bytes32 labelhash => bool) public reserved;
    mapping(bytes32 commitment => uint64 committedAt) public commitments;
    mapping(address wallet => Ban) internal _bans;
    mapping(bytes32 decisionId => bool) public consumedDecisions;
    mapping(uint256 day => uint256 count) public revocationsOnDay;
    uint64 public moderationSequence;
    uint256 internal _resolverNonce;
    uint256 private _locked = 1;

    event Committed(bytes32 indexed commitment);
    event Registered(address indexed wallet, bytes32 indexed labelhash, string label, uint64 generation, address resolver, uint64 expiry);
    event Renewed(address indexed wallet, bytes32 indexed labelhash, uint64 generation, uint64 expiry);
    event Revoked(address indexed wallet, bytes32 indexed labelhash, uint64 generation, bytes32 indexed decisionId);
    event ModerationDecision(
        address indexed wallet,
        bytes32 indexed decisionId,
        uint64 indexed sequence,
        uint8 action,
        uint16 reasonCode,
        bytes32 evidenceHash,
        uint32 policyVersion
    );
    event ReservedSet(bytes32 indexed labelhash, bool reserved);
    event GovernanceProposed(address indexed next);
    event GovernanceTransferred(address indexed previous, address indexed next);
    event RevokerSet(address indexed revoker);
    event UnbannerSet(address indexed unbanner);
    event RegistrationsPaused(bool paused);
    event RevocationLimitSet(uint256 perDay);

    error NotGovernance();
    error NotPendingGovernance();
    error NotRevoker();
    error NotUnbanner();
    error Reentrancy();
    error ZeroAddress();
    error Paused();
    error NotAnEOA();
    error InvalidLabel();
    error LabelReserved();
    error LabelUnavailable();
    error AlreadyMember();
    error NotMember();
    error WalletBanned();
    error NotBanned();
    error CommitmentExists();
    error CommitmentMissing();
    error CommitmentTooNew();
    error CommitmentTooOld();
    error RenewalTooEarly();
    error DecisionReused();
    error StaleDecision();
    error HasActiveName();
    error RevocationLimitReached();
    error NamespaceExpired();
    error ExpiryCappedByNamespace();

    modifier onlyGovernance() {
        if (msg.sender != governance) revert NotGovernance();
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    struct Deployment {
        IDuskNameRegistry registry;
        IDuskNameRegistry parentRegistry;
        uint256 parentId;
        IDuskVerifiableFactory factory;
        address resolverImplementation;
        bytes parentDnsName;
        address governance;
        address revoker;
        uint64 term;
        uint64 minCommitmentAge;
        uint64 maxCommitmentAge;
        uint256 revocationsPerDay;
        string[] reservedLabels;
    }

    constructor(Deployment memory d) {
        if (address(d.registry) == address(0) || address(d.parentRegistry) == address(0)) revert ZeroAddress();
        if (address(d.factory) == address(0) || d.resolverImplementation == address(0)) revert ZeroAddress();
        if (d.governance == address(0)) revert ZeroAddress();
        require(d.term > 0 && d.minCommitmentAge > 0 && d.maxCommitmentAge > d.minCommitmentAge, "bad timing");
        require(d.parentDnsName.length > 2 && d.parentDnsName[d.parentDnsName.length - 1] == 0x00, "bad parent");
        REGISTRY = d.registry;
        PARENT_REGISTRY = d.parentRegistry;
        PARENT_ID = d.parentId;
        FACTORY = d.factory;
        RESOLVER_IMPLEMENTATION = d.resolverImplementation;
        TERM = d.term;
        MIN_COMMITMENT_AGE = d.minCommitmentAge;
        MAX_COMMITMENT_AGE = d.maxCommitmentAge;
        parentDnsName = d.parentDnsName;
        governance = d.governance;
        revoker = d.revoker;
        unbanner = d.governance;
        revocationsPerDay = d.revocationsPerDay;
        for (uint256 i; i < d.reservedLabels.length; ++i) {
            bytes32 labelhash = keccak256(bytes(d.reservedLabels[i]));
            reserved[labelhash] = true;
            emit ReservedSet(labelhash, true);
        }
    }

    function makeCommitment(string calldata label, address owner, bytes32 secret) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), POLICY_VERSION, label, owner, secret));
    }

    function commit(bytes32 commitment) external {
        uint64 at = commitments[commitment];
        if (at != 0 && block.timestamp <= at + MAX_COMMITMENT_AGE) revert CommitmentExists();
        commitments[commitment] = uint64(block.timestamp);
        emit Committed(commitment);
    }

    function register(string calldata label, bytes32 secret) external nonReentrant returns (address resolver) {
        if (registrationsPaused) revert Paused();
        {
            bool operatorContract = keccak256(bytes(label)) == REVOKER_LABELHASH && msg.sender == revoker && msg.sender.code.length > 0;
            if (!operatorContract && (msg.sender != tx.origin || !isKeyAccount(msg.sender))) revert NotAnEOA();
        }
        if (_bans[msg.sender].active) revert WalletBanned();
        if (!validLabel(label)) revert InvalidLabel();
        bytes32 labelhash = keccak256(bytes(label));
        if (labelhash == REVOKER_LABELHASH && msg.sender != revoker) revert LabelReserved();
        if (reserved[labelhash]) revert LabelReserved();
        if (membershipStatus(msg.sender) == MembershipStatus.Active) revert AlreadyMember();

        bytes32 commitment = makeCommitment(label, msg.sender, secret);
        uint64 at = commitments[commitment];
        if (at == 0) revert CommitmentMissing();
        if (block.timestamp < at + MIN_COMMITMENT_AGE) revert CommitmentTooNew();
        if (block.timestamp > at + MAX_COMMITMENT_AGE) revert CommitmentTooOld();
        delete commitments[commitment];

        IDuskNameRegistry.State memory state = REGISTRY.getState(uint256(labelhash));
        if (state.status != 0) revert LabelUnavailable();

        uint64 generation = ++generationOf[labelhash];
        holderOf[labelhash] = msg.sender;
        if (_memberships[msg.sender].generation == 0) _memberWallets.push(msg.sender);
        _memberships[msg.sender] = Membership(label, generation, uint64(block.timestamp), address(0));
        uint64 expiry = _capped(uint64(block.timestamp) + TERM);

        bytes memory name = dnsName(label);
        IDuskResolverInit.Grant[] memory grants = new IDuskResolverInit.Grant[](1);
        grants[0] = IDuskResolverInit.Grant(msg.sender, MEMBER_RESOLVER_ROLES);
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(IDuskResolverInit.setAddress, (name, COIN_TYPE_ETH, abi.encodePacked(msg.sender)));
        resolver = FACTORY.deployProxy(
            RESOLVER_IMPLEMENTATION, ++_resolverNonce, abi.encodeCall(IDuskResolverInit.initialize, (grants, calls))
        );
        _memberships[msg.sender].resolver = resolver;

        REGISTRY.register(label, msg.sender, address(0), resolver, 0, expiry);
        emit Registered(msg.sender, labelhash, label, generation, resolver, expiry);
    }

    function renew() external nonReentrant returns (uint64 expiry) {
        if (registrationsPaused) revert Paused();
        if (_bans[msg.sender].active) revert WalletBanned();
        MembershipStatus status = membershipStatus(msg.sender);
        if (status != MembershipStatus.Active && status != MembershipStatus.Expired) revert NotMember();
        Membership storage m = _memberships[msg.sender];
        bytes32 labelhash = keccak256(bytes(m.label));
        IDuskNameRegistry.State memory state = REGISTRY.getState(uint256(labelhash));
        uint64 from = state.expiry > block.timestamp ? state.expiry : uint64(block.timestamp);
        if (uint256(from) + TERM > block.timestamp + 2 * uint256(TERM)) revert RenewalTooEarly();
        expiry = _capped(from + TERM);
        if (expiry <= state.expiry) revert ExpiryCappedByNamespace();
        REGISTRY.renew(uint256(labelhash), expiry);
        emit Renewed(msg.sender, labelhash, m.generation, expiry);
    }

    function revokeAndBan(address wallet, uint64 expectedGeneration, bytes32 decisionId, uint16 reasonCode, bytes32 evidenceHash)
        external
        nonReentrant
    {
        _beginDecision(decisionId);
        MembershipStatus status = membershipStatus(wallet);
        Membership storage m = _memberships[wallet];
        if (status == MembershipStatus.None || status == MembershipStatus.Lost || m.generation != expectedGeneration) {
            revert StaleDecision();
        }
        bytes32 labelhash = keccak256(bytes(m.label));
        reserved[labelhash] = true;
        emit ReservedSet(labelhash, true);
        _ban(wallet, decisionId, reasonCode, evidenceHash);
        emit Revoked(wallet, labelhash, m.generation, decisionId);
        if (status == MembershipStatus.Active) REGISTRY.unregister(uint256(labelhash));
    }

    function banWallet(address wallet, bytes32 decisionId, uint16 reasonCode, bytes32 evidenceHash) external {
        _beginDecision(decisionId);
        if (membershipStatus(wallet) == MembershipStatus.Active) revert HasActiveName();
        _ban(wallet, decisionId, reasonCode, evidenceHash);
    }

    function unban(address wallet, bytes32 decisionId, uint16 reasonCode, bytes32 evidenceHash) external {
        if (msg.sender != unbanner) revert NotUnbanner();
        if (consumedDecisions[decisionId]) revert DecisionReused();
        if (!_bans[wallet].active) revert NotBanned();
        consumedDecisions[decisionId] = true;
        uint64 sequence = ++moderationSequence;
        _bans[wallet] = Ban(false, sequence, reasonCode, decisionId);
        emit ModerationDecision(wallet, decisionId, sequence, ACTION_UNBAN, reasonCode, evidenceHash, POLICY_VERSION);
    }

    function _capped(uint64 expiry) internal view returns (uint64) {
        uint64 parentExpiry = PARENT_REGISTRY.getState(PARENT_ID).expiry;
        if (parentExpiry <= block.timestamp) revert NamespaceExpired();
        return expiry < parentExpiry ? expiry : parentExpiry;
    }

    function _beginDecision(bytes32 decisionId) internal {
        if (msg.sender != revoker) revert NotRevoker();
        if (decisionId == bytes32(0) || consumedDecisions[decisionId]) revert DecisionReused();
        uint256 day = block.timestamp / 1 days;
        if (revocationsOnDay[day] >= revocationsPerDay) revert RevocationLimitReached();
        ++revocationsOnDay[day];
        consumedDecisions[decisionId] = true;
    }

    function _ban(address wallet, bytes32 decisionId, uint16 reasonCode, bytes32 evidenceHash) internal {
        if (wallet == address(0)) revert ZeroAddress();
        uint64 sequence = ++moderationSequence;
        _bans[wallet] = Ban(true, sequence, reasonCode, decisionId);
        emit ModerationDecision(wallet, decisionId, sequence, ACTION_BAN, reasonCode, evidenceHash, POLICY_VERSION);
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

    function setRevoker(address next) external onlyGovernance {
        revoker = next;
        emit RevokerSet(next);
    }

    function setUnbanner(address next) external onlyGovernance {
        if (next == address(0)) revert ZeroAddress();
        unbanner = next;
        emit UnbannerSet(next);
    }

    function setRegistrationsPaused(bool paused) external onlyGovernance {
        registrationsPaused = paused;
        emit RegistrationsPaused(paused);
    }

    function setRevocationsPerDay(uint256 perDay) external onlyGovernance {
        revocationsPerDay = perDay;
        emit RevocationLimitSet(perDay);
    }

    function setReserved(bytes32 labelhash, bool value) external onlyGovernance {
        reserved[labelhash] = value;
        emit ReservedSet(labelhash, value);
    }

    function validLabel(string memory label) public pure returns (bool) {
        bytes memory b = bytes(label);
        uint256 n = b.length;
        if (n < 3 || n > 32) return false;
        if (b[0] == "x" && b[1] == "n" && b[2] == "-") return false;
        for (uint256 i; i < n; ++i) {
            bytes1 c = b[i];
            bool alnum = (c >= "a" && c <= "z") || (c >= "0" && c <= "9");
            if (alnum) continue;
            if (c != "-" || i == 0 || i == n - 1 || b[i - 1] == "-") return false;
        }
        return true;
    }

    function isKeyAccount(address account) public view returns (bool) {
        bytes memory code = account.code;
        if (code.length == 0) return true;
        return code.length == 23 && code[0] == 0xef && code[1] == 0x01 && code[2] == 0x00;
    }

    function dnsName(string memory label) public view returns (bytes memory) {
        return abi.encodePacked(uint8(bytes(label).length), label, parentDnsName);
    }

    function membershipStatus(address wallet) public view returns (MembershipStatus) {
        Membership storage m = _memberships[wallet];
        if (bytes(m.label).length == 0) return MembershipStatus.None;
        bytes32 labelhash = keccak256(bytes(m.label));
        if (holderOf[labelhash] != wallet || generationOf[labelhash] != m.generation) return MembershipStatus.Lost;
        IDuskNameRegistry.State memory state = REGISTRY.getState(uint256(labelhash));
        if (state.latestOwner != wallet) return MembershipStatus.Lost;
        return state.status == REGISTRY_REGISTERED ? MembershipStatus.Active : MembershipStatus.Expired;
    }

    function membershipOf(address wallet)
        external
        view
        returns (string memory label, uint64 generation, address resolver, uint64 expiry, MembershipStatus status)
    {
        Membership storage m = _memberships[wallet];
        status = membershipStatus(wallet);
        if (status == MembershipStatus.None) return (label, 0, address(0), 0, status);
        expiry = REGISTRY.getState(uint256(keccak256(bytes(m.label)))).expiry;
        return (m.label, m.generation, m.resolver, expiry, status);
    }

    function banOf(address wallet) external view returns (bool active, uint64 sequence, uint16 reasonCode, bytes32 decisionId) {
        Ban storage b = _bans[wallet];
        return (b.active, b.sequence, b.reasonCode, b.decisionId);
    }

    function isBanned(address wallet) external view returns (bool) {
        return _bans[wallet].active;
    }

    function memberCount() external view returns (uint256) { return _memberWallets.length; }

    function memberWallets(uint256 offset, uint256 limit) external view returns (address[] memory wallets) {
        require(limit <= 100, "page too large");
        if (offset >= _memberWallets.length) return new address[](0);
        uint256 count = _memberWallets.length - offset;
        if (count > limit) count = limit;
        wallets = new address[](count);
        for (uint256 i; i < count; ++i) wallets[i] = _memberWallets[offset + i];
    }

    function available(string calldata label) external view returns (bool) {
        return availableTo(label, address(0));
    }

    function availableTo(string calldata label, address wallet) public view returns (bool) {
        if (!validLabel(label)) return false;
        bytes32 labelhash = keccak256(bytes(label));
        if (labelhash == REVOKER_LABELHASH && (wallet == address(0) || wallet != revoker)) return false;
        return !reserved[labelhash] && REGISTRY.getState(uint256(labelhash)).status == 0;
    }
}
