// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DuskReputation} from "../../src/DuskReputation.sol";
import {
    DuskIdentityController,
    IDuskNameRegistry,
    IDuskVerifiableFactory
} from "../../src/DuskIdentityController.sol";

interface IUserRegistry {
    struct Grant {
        address account;
        uint256 roleBitmap;
    }

    function initialize(Grant[] calldata grants) external;
    function setParent(address parent, string calldata label) external;
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function revokeRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function register(string calldata label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry)
        external
        returns (uint256);
    function getState(uint256 anyId) external view returns (IDuskNameRegistry.State memory);
    function getResolver(string calldata label) external view returns (address);
    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external;
    function setResolver(uint256 anyId, address resolver) external;
    function hasRootRoles(uint256 roleBitmap, address account) external view returns (bool);
}

interface IEthRegistry {
    function setSubregistry(uint256 anyId, address registry) external;
    function getState(uint256 anyId) external view returns (IDuskNameRegistry.State memory);
    function getSubregistry(string calldata label) external view returns (address);
}

interface IResolver {
    function setText(bytes calldata name, string calldata key, string calldata value) external;
    function setAddress(bytes calldata name, uint256 coinType, bytes calldata addressBytes) external;
    function upgradeToAndCall(address impl, bytes calldata data) external;
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
}

interface IUniversalResolver {
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory, address);
}

contract Erc1155Receiver {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }
}

contract ConstructorRegistrant {
    constructor(DuskIdentityController controller, string memory label, bytes32 secret) {
        controller.register(label, secret);
    }
}

contract DuskIdentityControllerForkTest is Test {
    address constant ETH_REGISTRY = 0xD4eBcbBdF463C9c45784603Db0dDD499BC44A8B4;
    address constant FACTORY = 0xDa70306C98E97eCe36F997a21368e53298572991;
    address constant USER_REGISTRY_IMPL = 0x9BD8a88719068D09ecee662f36C0E3856708366a;
    address constant RESOLVER_IMPL = 0x115eb53F0c60696633855F90b138178Fb40b2b2C;
    address constant UNIVERSAL_RESOLVER = 0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe;
    address constant OWNER = 0x1DCbDe884e9fb92E0f73034eF994080eDc3b6068;

    uint256 constant ROLE_REGISTRAR = 1 << 0;
    uint256 constant ROLE_SET_PARENT = 1 << 8;
    uint256 constant ROLE_UNREGISTER = 1 << 12;
    uint256 constant ROLE_RENEW = 1 << 16;
    uint256 constant ROLE_UPGRADE = 1 << 124;
    uint256 constant CONTROLLER_ROLES = ROLE_REGISTRAR | ROLE_UNREGISTER | ROLE_RENEW;
    uint256 constant GOVERNANCE_ROLES = ROLE_SET_PARENT | ROLE_UPGRADE | (ROLE_UPGRADE << 128) | (ROLE_REGISTRAR << 128)
        | (ROLE_UNREGISTER << 128) | (ROLE_RENEW << 128) | (ROLE_SET_PARENT << 128);

    bytes constant PARENT_DNS = hex"046475736b0365746800";
    uint64 constant TERM = 30 days;

    IUserRegistry child;
    DuskIdentityController controller;
    address revoker = makeAddr("dusk-ens-revoker");
    address alice = makeAddr("dusk-ens-alice");
    address bob = makeAddr("dusk-ens-bob");
    address mallory = makeAddr("dusk-ens-mallory");

    function setUp() public {
        string memory rpc = vm.envOr("SEPOLIA_RPC_URL", string("https://ethereum-sepolia-rpc.publicnode.com"));
        vm.createSelectFork(rpc);
        vm.createSelectFork(rpc, block.number - 10);
        assertEq(ETH_REGISTRY.codehash, 0xddb7698fc2857f7a9e726491025fead241791f113a19714149db8cbf87688e98, "ETHRegistry drifted");
        assertEq(USER_REGISTRY_IMPL.codehash, 0xed6d71bc90b0882fa63ef78a8dddabff2730b4c1cab9eab2ad91fa2aacd269f7, "UserRegistry drifted");
        assertEq(RESOLVER_IMPL.codehash, 0x02d6c15c6443251e5d3c5acbd971d66057c8e13ee0d0f046d5c65cd27a20b007, "Resolver drifted");
        assertEq(FACTORY.codehash, 0x141dc0d5ee8c60ae9b9cce12c870d3babc28719602238ee0f77016a9f1916265, "Factory drifted");

        vm.etch(revoker, "");
        vm.etch(alice, "");
        vm.etch(bob, "");
        vm.etch(mallory, "");

        vm.startPrank(OWNER);
        IUserRegistry.Grant[] memory grants = new IUserRegistry.Grant[](1);
        grants[0] = IUserRegistry.Grant(OWNER, GOVERNANCE_ROLES);
        child = IUserRegistry(
            IDuskVerifiableFactory(FACTORY).deployProxy(
                USER_REGISTRY_IMPL, uint256(keccak256("dusk.eth child registry")), abi.encodeCall(IUserRegistry.initialize, (grants))
            )
        );
        string memory fixture = vm.readFile("test/fixtures/ens-labels.json");
        string[] memory reservedLabels = vm.parseJsonStringArray(fixture, ".reserved");
        controller = new DuskIdentityController(
            DuskIdentityController.Deployment({
                registry: IDuskNameRegistry(address(child)),
                parentRegistry: IDuskNameRegistry(ETH_REGISTRY),
                parentId: _id("dusk"),
                factory: IDuskVerifiableFactory(FACTORY),
                resolverImplementation: RESOLVER_IMPL,
                parentDnsName: PARENT_DNS,
                governance: OWNER,
                revoker: revoker,
                term: TERM,
                minCommitmentAge: 60,
                maxCommitmentAge: 1 days,
                revocationsPerDay: 10,
                reservedLabels: reservedLabels
            })
        );
        child.grantRootRoles(CONTROLLER_ROLES, address(controller));
        child.setParent(ETH_REGISTRY, "dusk");
        IEthRegistry(ETH_REGISTRY).setSubregistry(_id("dusk"), address(child));
        vm.stopPrank();
    }

    function _id(string memory label) internal pure returns (uint256) {
        return uint256(keccak256(bytes(label)));
    }

    function _node(string memory label) internal pure returns (bytes32) {
        bytes32 eth = keccak256(abi.encodePacked(bytes32(0), keccak256("eth")));
        bytes32 dusk = keccak256(abi.encodePacked(eth, keccak256("dusk")));
        return keccak256(abi.encodePacked(dusk, keccak256(bytes(label))));
    }

    function _enroll(address who, string memory label) internal returns (address resolver) {
        bytes32 secret = keccak256(abi.encode(who, label));
        bytes32 commitment = controller.makeCommitment(label, who, secret);
        vm.prank(who);
        controller.commit(commitment);
        vm.warp(block.timestamp + 61);
        vm.prank(who, who);
        resolver = controller.register(label, secret);
    }

    function _commit(address who, string memory label, bytes32 secret) internal {
        bytes32 commitment = controller.makeCommitment(label, who, secret);
        vm.prank(who);
        controller.commit(commitment);
    }

    function _resolveAddr(string memory label) internal view returns (address) {
        (bytes memory result,) = IUniversalResolver(UNIVERSAL_RESOLVER).resolve(
            controller.dnsName(label), abi.encodeWithSignature("addr(bytes32)", _node(label))
        );
        return abi.decode(result, (address));
    }

    function _resolveText(string memory label, string memory key) internal view returns (string memory) {
        (bytes memory result,) = IUniversalResolver(UNIVERSAL_RESOLVER).resolve(
            controller.dnsName(label), abi.encodeWithSignature("text(bytes32,string)", _node(label), key)
        );
        return abi.decode(result, (string));
    }

    function test_namespace_isAttachedAndRolesAreScoped() public view {
        assertEq(IEthRegistry(ETH_REGISTRY).getSubregistry("dusk"), address(child));
        assertTrue(child.hasRootRoles(CONTROLLER_ROLES, address(controller)));
        assertFalse(child.hasRootRoles(ROLE_UPGRADE, address(controller)), "controller must not upgrade");
        assertFalse(child.hasRootRoles(ROLE_REGISTRAR, revoker), "revoker holds no registry role");
    }

    function test_register_issuesANameThatResolvesThroughTheRealHierarchy() public {
        address resolver = _enroll(alice, "alice");
        IDuskNameRegistry.State memory s = child.getState(_id("alice"));
        assertEq(s.status, 2);
        assertEq(s.latestOwner, alice);
        assertEq(child.getResolver("alice"), resolver);
        assertEq(_resolveAddr("alice"), alice, "Universal Resolver must return the owner");
        (string memory label, uint64 generation, address r,, DuskIdentityController.MembershipStatus status) = controller.membershipOf(alice);
        assertEq(label, "alice");
        assertEq(generation, 1);
        assertEq(r, resolver);
        assertEq(uint8(status), uint8(DuskIdentityController.MembershipStatus.Active));
    }

    function test_register_requiresAnAgedCommitment() public {
        bytes32 secret = keccak256("s");
        vm.prank(alice, alice);
        vm.expectRevert(DuskIdentityController.CommitmentMissing.selector);
        controller.register("alice", secret);

        _commit(alice, "alice", secret);
        vm.prank(alice, alice);
        vm.expectRevert(DuskIdentityController.CommitmentTooNew.selector);
        controller.register("alice", secret);

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(alice, alice);
        vm.expectRevert(DuskIdentityController.CommitmentTooOld.selector);
        controller.register("alice", secret);
    }

    function test_register_aCopiedRevealIsUselessToTheCopier() public {
        bytes32 secret = keccak256("alice's secret");
        _commit(alice, "alice", secret);
        vm.warp(block.timestamp + 61);
        vm.prank(mallory, mallory);
        vm.expectRevert(DuskIdentityController.CommitmentMissing.selector);
        controller.register("alice", secret);
        vm.prank(alice, alice);
        controller.register("alice", secret);
    }

    function test_register_oneNamePerWallet() public {
        _enroll(alice, "alice");
        bytes32 secret = keccak256("second");
        _commit(alice, "alice2", secret);
        vm.warp(block.timestamp + 61);
        vm.prank(alice, alice);
        vm.expectRevert(DuskIdentityController.AlreadyMember.selector);
        controller.register("alice2", secret);
    }

    function test_register_aTakenLabelIsUnavailable() public {
        _enroll(alice, "alice");
        bytes32 secret = keccak256("bob");
        _commit(bob, "alice", secret);
        vm.warp(block.timestamp + 61);
        vm.prank(bob, bob);
        vm.expectRevert(DuskIdentityController.LabelUnavailable.selector);
        controller.register("alice", secret);
    }

    function test_register_enforcesTheLabelPolicyOnChain() public {
        string[9] memory bad = ["Alice", "ab", "a--b", "-ab", "ab-", "xn-abc", "al.ce", "al ce", "abcdefghijabcdefghijabcdefghijabc"];
        for (uint256 i; i < bad.length; ++i) {
            assertFalse(controller.validLabel(bad[i]), bad[i]);
        }
        assertTrue(controller.validLabel("a-1"));
        bytes32 secret = keccak256("r");
        _commit(alice, "admin", secret);
        vm.warp(block.timestamp + 61);
        vm.prank(alice, alice);
        vm.expectRevert(DuskIdentityController.LabelReserved.selector);
        controller.register("admin", secret);
    }

    function test_validLabel_agreesWithTheTypeScriptPolicy() public view {
        string memory fixture = vm.readFile("test/fixtures/ens-labels.json");
        string[] memory valid = vm.parseJsonStringArray(fixture, ".valid");
        string[] memory invalid = vm.parseJsonStringArray(fixture, ".invalid");
        string[] memory reservedLabels = vm.parseJsonStringArray(fixture, ".reserved");
        for (uint256 i; i < valid.length; ++i) assertTrue(controller.validLabel(valid[i]), valid[i]);
        for (uint256 i; i < invalid.length; ++i) assertFalse(controller.validLabel(invalid[i]), invalid[i]);
        for (uint256 i; i < reservedLabels.length; ++i) {
            assertTrue(controller.reserved(keccak256(bytes(reservedLabels[i]))), reservedLabels[i]);
            assertFalse(controller.available(reservedLabels[i]), reservedLabels[i]);
        }
    }

    function test_revokerName_requiresTheConfiguredWalletAndResolvesToIt() public {
        assertFalse(controller.available("revoker"), "not a public registration");
        assertFalse(controller.availableTo("revoker", alice));
        assertTrue(controller.availableTo("revoker", revoker));
        bytes32 secret = keccak256("squatter");
        _commit(alice, "revoker", secret);
        vm.warp(block.timestamp + 61);
        vm.prank(alice, alice);
        vm.expectRevert(DuskIdentityController.LabelReserved.selector);
        controller.register("revoker", secret);

        _enroll(revoker, "revoker");
        assertEq(_resolveAddr("revoker"), revoker);
        assertEq(controller.holderOf(keccak256("revoker")), revoker);
        assertFalse(child.hasRootRoles(CONTROLLER_ROLES, revoker), "name confers no registry authority");
        assertFalse(controller.availableTo("revoker", revoker));
    }

    function test_revokerName_rotationInvalidatesThePreviousWalletsPendingReveal() public {
        bytes32 secret = keccak256("pending role name");
        _commit(revoker, "revoker", secret);
        vm.warp(block.timestamp + 61);
        vm.prank(OWNER);
        controller.setRevoker(bob);
        vm.prank(revoker, revoker);
        vm.expectRevert(DuskIdentityController.LabelReserved.selector);
        controller.register("revoker", secret);
        assertFalse(controller.availableTo("revoker", revoker));
        assertTrue(controller.availableTo("revoker", bob));
        _enroll(bob, "revoker");
        assertEq(_resolveAddr("revoker"), bob);
    }

    function test_revokerName_neverBypassesATombstoneAfterUnbanOrRotation() public {
        _enroll(revoker, "revoker");
        vm.prank(revoker);
        controller.revokeAndBan(revoker, 1, keccak256("role name ban"), 1, bytes32(0));
        vm.prank(OWNER);
        controller.unban(revoker, keccak256("role name appeal"), 0, bytes32(0));
        assertFalse(controller.availableTo("revoker", revoker));
        bytes32 secret = keccak256("cannot recycle");
        _commit(revoker, "revoker", secret);
        vm.warp(block.timestamp + 61);
        vm.prank(revoker, revoker);
        vm.expectRevert(DuskIdentityController.LabelReserved.selector);
        controller.register("revoker", secret);
        vm.prank(OWNER);
        controller.setRevoker(bob);
        assertFalse(controller.availableTo("revoker", bob));
    }

    function test_revokerName_isUnavailableWhenTheRoleIsDisabled() public {
        vm.prank(OWNER);
        controller.setRevoker(address(0));
        assertFalse(controller.available("revoker"));
        assertFalse(controller.availableTo("revoker", address(0)));
        assertFalse(controller.availableTo("revoker", revoker));
    }

    function test_reputationContractOwnsItsOperatorNameButCannotEnrollOtherContracts() public {
        DuskReputation reputation = new DuskReputation(controller, keccak256("sources"));
        vm.prank(OWNER);
        controller.setRevoker(address(reputation));
        bytes32 secret = keccak256("operator name secret");
        bytes32 commitment = controller.makeCommitment("revoker", address(reputation), secret);
        vm.prank(OWNER); reputation.commitOperatorName(commitment);
        vm.warp(block.timestamp + 61);
        vm.prank(OWNER); reputation.registerOperatorName(secret);
        assertEq(_resolveAddr("revoker"), address(reputation));
        assertEq(controller.holderOf(keccak256("revoker")), address(reputation));
        assertFalse(child.hasRootRoles(CONTROLLER_ROLES, address(reputation)));
        vm.prank(alice); vm.expectRevert(DuskReputation.NotCompany.selector);
        reputation.registerOperatorName(secret);
        vm.prank(address(reputation), OWNER); vm.expectRevert(DuskIdentityController.NotAnEOA.selector);
        controller.register("ordinary", secret);
    }

    function test_memberInventoryRetainsRevokedAndExpiredWalletsWithoutDuplicates() public {
        _enroll(alice, "alice");
        _enroll(bob, "bob");
        assertEq(controller.memberCount(), 2);
        address[] memory first = controller.memberWallets(0, 1);
        assertEq(first.length, 1); assertEq(first[0], alice);
        address[] memory second = controller.memberWallets(1, 100);
        assertEq(second.length, 1); assertEq(second[0], bob);
        vm.prank(revoker);
        controller.revokeAndBan(alice, 1, keccak256("inventory ban"), 1, bytes32(0));
        vm.prank(OWNER); controller.unban(alice, keccak256("inventory appeal"), 0, bytes32(0));
        _enroll(alice, "alice-new");
        vm.warp(block.timestamp + TERM + 1);
        assertEq(controller.memberCount(), 2);
        assertEq(controller.memberWallets(2, 100).length, 0);
        assertEq(controller.memberWallets(0, 0).length, 0);
        vm.expectRevert(); controller.memberWallets(0, 101);
    }

    function test_register_refusesContractCallers() public {
        bytes32 secret = keccak256("c");
        vm.prank(address(this));
        controller.commit(controller.makeCommitment("thiscontract", address(this), secret));
        vm.warp(block.timestamp + 61);
        vm.expectRevert(DuskIdentityController.NotAnEOA.selector);
        controller.register("thiscontract", secret);
    }

    function test_register_acceptsAnEip7702DelegatedEoa() public {
        address delegated = makeAddr("dusk-ens-7702");
        vm.etch(delegated, abi.encodePacked(hex"ef0100", address(new Erc1155Receiver())));
        assertTrue(controller.isKeyAccount(delegated));
        _enroll(delegated, "delegated");
        assertEq(child.getState(_id("delegated")).latestOwner, delegated);
    }

    function test_register_aDelegateWithoutTheReceiverHookRevertsCleanly() public {
        address delegated = 0x328809Bc894f92807417D2dAD6b7C998c1aFdac6;
        assertEq(delegated.code.length, 23);
        assertTrue(controller.isKeyAccount(delegated));
        bytes32 secret = keccak256("d");
        bytes32 commitment = controller.makeCommitment("delegated", delegated, secret);
        vm.prank(delegated);
        controller.commit(commitment);
        vm.warp(block.timestamp + 61);
        vm.prank(delegated, delegated);
        vm.expectRevert();
        controller.register("delegated", secret);
        assertEq(uint8(controller.membershipStatus(delegated)), uint8(DuskIdentityController.MembershipStatus.None));
        assertEq(controller.generationOf(keccak256("delegated")), 0);
        assertTrue(controller.available("delegated"));
    }

    function test_register_refusesAContractRevealingFromItsConstructor() public {
        bytes32 secret = keccak256("ctor");
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        bytes32 commitment = controller.makeCommitment("ctorname", predicted, secret);
        controller.commit(commitment);
        vm.warp(block.timestamp + 61);
        vm.expectRevert(DuskIdentityController.NotAnEOA.selector);
        new ConstructorRegistrant(controller, "ctorname", secret);
        assertTrue(controller.available("ctorname"));
    }

    function test_isKeyAccount_refusesOrdinaryContracts() public {
        assertFalse(controller.isKeyAccount(address(controller)));
        assertFalse(controller.isKeyAccount(FACTORY));
        vm.etch(mallory, hex"600060005500000000000000000000000000000000000000");
        assertFalse(controller.isKeyAccount(mallory));
    }

    function test_register_pausedByGovernance() public {
        vm.prank(OWNER);
        controller.setRegistrationsPaused(true);
        bytes32 secret = keccak256("p");
        _commit(alice, "alice", secret);
        vm.warp(block.timestamp + 61);
        vm.prank(alice, alice);
        vm.expectRevert(DuskIdentityController.Paused.selector);
        controller.register("alice", secret);
    }

    function test_profile_ownerEditsOwnRecordsAndNobodyElseCan() public {
        address aliceResolver = _enroll(alice, "alice");
        address bobResolver = _enroll(bob, "bob");
        bytes memory aliceName = controller.dnsName("alice");
        bytes memory bobName = controller.dnsName("bob");

        vm.prank(alice);
        IResolver(aliceResolver).setText(aliceName, "description", "GPU holder");
        assertEq(_resolveText("alice", "description"), "GPU holder");

        vm.prank(alice);
        vm.expectRevert();
        IResolver(bobResolver).setText(bobName, "description", "pwned");
        vm.prank(alice);
        IResolver(aliceResolver).setText(bobName, "description", "pwned");
        assertEq(_resolveText("bob", "description"), "");

        vm.prank(address(controller));
        vm.expectRevert();
        IResolver(aliceResolver).setText(aliceName, "description", "x");
        vm.prank(revoker);
        vm.expectRevert();
        IResolver(aliceResolver).setText(aliceName, "description", "x");
    }

    function test_profile_memberCannotUpgradeOrDelegateTheirResolver() public {
        address resolver = _enroll(alice, "alice");
        vm.startPrank(alice);
        vm.expectRevert();
        IResolver(resolver).upgradeToAndCall(address(0xdead), "");
        vm.expectRevert();
        IResolver(resolver).grantRootRoles(1 << 4, bob);
        vm.stopPrank();
    }

    function test_profile_anAddressChangeIsVisibleAsAMismatch() public {
        address resolver = _enroll(alice, "alice");
        bytes memory name = controller.dnsName("alice");
        vm.prank(alice);
        IResolver(resolver).setAddress(name, 60, abi.encodePacked(bob));
        assertEq(_resolveAddr("alice"), bob);
        assertEq(child.getState(_id("alice")).latestOwner, alice);
    }

    function test_names_areNotTransferable() public {
        _enroll(alice, "alice");
        uint256 tokenId = child.getState(_id("alice")).tokenId;
        vm.prank(alice);
        vm.expectRevert();
        child.safeTransferFrom(alice, bob, tokenId, 1, "");
        vm.prank(alice);
        vm.expectRevert();
        child.setResolver(tokenId, address(0xbad));
    }

    function test_renew_extendsAndRevivesButCannotStackTerms() public {
        _enroll(alice, "alice");
        uint64 first = child.getState(_id("alice")).expiry;
        vm.prank(alice);
        assertEq(controller.renew(), first + TERM, "one early renewal: two terms ahead");
        vm.prank(alice);
        vm.expectRevert(DuskIdentityController.RenewalTooEarly.selector);
        controller.renew();

        vm.warp(first + TERM + 1);
        assertEq(uint8(controller.membershipStatus(alice)), uint8(DuskIdentityController.MembershipStatus.Expired));
        vm.prank(alice);
        uint64 revived = controller.renew();
        uint64 parentExpiry = IEthRegistry(ETH_REGISTRY).getState(_id("dusk")).expiry;
        uint64 wanted = uint64(block.timestamp) + TERM;
        assertEq(revived, wanted < parentExpiry ? wanted : parentExpiry);
        assertEq(uint8(controller.membershipStatus(alice)), uint8(DuskIdentityController.MembershipStatus.Active));
        assertEq(_resolveAddr("alice"), alice);
    }

    function test_expiry_neverOutlivesTheNamespace() public {
        uint64 parentExpiry = IEthRegistry(ETH_REGISTRY).getState(_id("dusk")).expiry;
        vm.warp(parentExpiry - 10 days);
        _enroll(alice, "alice");
        assertEq(child.getState(_id("alice")).expiry, parentExpiry, "capped at dusk.eth's own expiry");
        vm.prank(alice);
        vm.expectRevert(DuskIdentityController.ExpiryCappedByNamespace.selector);
        controller.renew();

        vm.warp(parentExpiry);
        bytes32 secret = keccak256("late");
        bytes32 commitment = controller.makeCommitment("bob", bob, secret);
        vm.prank(bob);
        controller.commit(commitment);
        vm.warp(block.timestamp + 61);
        vm.prank(bob, bob);
        vm.expectRevert(DuskIdentityController.NamespaceExpired.selector);
        controller.register("bob", secret);
    }

    function test_expiry_aNewHolderGetsANewGenerationAndTheOldOneLosesIt() public {
        _enroll(alice, "alice");
        vm.warp(child.getState(_id("alice")).expiry + 1);
        _enroll(bob, "alice");
        (, uint64 generation,,,) = controller.membershipOf(bob);
        assertEq(generation, 2);
        assertEq(uint8(controller.membershipStatus(alice)), uint8(DuskIdentityController.MembershipStatus.Lost));
        assertEq(_resolveAddr("alice"), bob);
        vm.prank(alice);
        vm.expectRevert(DuskIdentityController.NotMember.selector);
        controller.renew();
    }

    function test_revokeAndBan_removesTheNameAndBansTheWalletAtomically() public {
        _enroll(alice, "alice");
        vm.prank(revoker);
        controller.revokeAndBan(alice, 1, keccak256("decision-1"), 7, keccak256("evidence"));

        IDuskNameRegistry.State memory s = child.getState(_id("alice"));
        assertEq(s.status, 0, "unregistered");
        assertEq(s.latestOwner, address(0));
        assertTrue(controller.isBanned(alice));
        (bool active, uint64 sequence, uint16 reason, bytes32 decision) = controller.banOf(alice);
        assertTrue(active);
        assertEq(sequence, 1);
        assertEq(reason, 7);
        assertEq(decision, keccak256("decision-1"));
        assertTrue(controller.reserved(keccak256("alice")), "revoked label is tombstoned");
    }

    function test_revokeAndBan_aBannedWalletCannotReEnrollOrRenew() public {
        _enroll(alice, "alice");
        vm.prank(revoker);
        controller.revokeAndBan(alice, 1, keccak256("d"), 1, bytes32(0));

        bytes32 secret = keccak256("again");
        _commit(alice, "alice-two", secret);
        vm.warp(block.timestamp + 61);
        vm.prank(alice, alice);
        vm.expectRevert(DuskIdentityController.WalletBanned.selector);
        controller.register("alice-two", secret);
        vm.prank(alice);
        vm.expectRevert(DuskIdentityController.WalletBanned.selector);
        controller.renew();
    }

    function test_revokeAndBan_theRevokedLabelCannotBeTakenByAnImpersonator() public {
        _enroll(alice, "alice");
        vm.prank(revoker);
        controller.revokeAndBan(alice, 1, keccak256("d"), 1, bytes32(0));
        bytes32 secret = keccak256("m");
        _commit(mallory, "alice", secret);
        vm.warp(block.timestamp + 61);
        vm.prank(mallory, mallory);
        vm.expectRevert(DuskIdentityController.LabelReserved.selector);
        controller.register("alice", secret);
    }

    function test_revokeAndBan_rejectsStaleAndDuplicateDecisions() public {
        _enroll(alice, "alice");
        vm.startPrank(revoker);
        vm.expectRevert(DuskIdentityController.StaleDecision.selector);
        controller.revokeAndBan(alice, 2, keccak256("wrong generation"), 1, bytes32(0));
        vm.expectRevert(DuskIdentityController.StaleDecision.selector);
        controller.revokeAndBan(bob, 1, keccak256("no name"), 1, bytes32(0));
        controller.revokeAndBan(alice, 1, keccak256("d"), 1, bytes32(0));
        vm.expectRevert(DuskIdentityController.DecisionReused.selector);
        controller.revokeAndBan(alice, 1, keccak256("d"), 1, bytes32(0));
        vm.stopPrank();
    }

    function test_revokeAndBan_aDecisionAboutTheOldHolderCannotHitTheNewOne() public {
        _enroll(alice, "alice");
        vm.warp(child.getState(_id("alice")).expiry + 1);
        _enroll(bob, "alice");
        vm.prank(revoker);
        vm.expectRevert(DuskIdentityController.StaleDecision.selector);
        controller.revokeAndBan(alice, 1, keccak256("late"), 1, bytes32(0));
        assertEq(child.getState(_id("alice")).latestOwner, bob);
    }

    function test_revokeAndBan_rollsBackEntirelyWhenUnregisterFails() public {
        _enroll(alice, "alice");
        vm.prank(OWNER);
        child.revokeRootRoles(ROLE_UNREGISTER, address(controller));
        vm.prank(revoker);
        vm.expectRevert();
        controller.revokeAndBan(alice, 1, keccak256("d"), 1, bytes32(0));
        assertFalse(controller.isBanned(alice), "no half-applied ban");
        assertFalse(controller.consumedDecisions(keccak256("d")));
        assertEq(child.getState(_id("alice")).latestOwner, alice);
    }

    function test_revoker_authorityIsNarrow() public {
        _enroll(alice, "alice");
        vm.startPrank(mallory);
        vm.expectRevert(DuskIdentityController.NotRevoker.selector);
        controller.revokeAndBan(alice, 1, keccak256("d"), 1, bytes32(0));
        vm.stopPrank();

        vm.prank(revoker);
        controller.banWallet(bob, keccak256("b"), 1, bytes32(0));
        vm.startPrank(revoker);
        vm.expectRevert(DuskIdentityController.NotUnbanner.selector);
        controller.unban(bob, keccak256("u"), 0, bytes32(0));
        vm.expectRevert(DuskIdentityController.NotGovernance.selector);
        controller.setRevoker(mallory);
        vm.expectRevert();
        child.register("revoker", revoker, address(0), address(0), 0, uint64(block.timestamp + 1 days));
        vm.stopPrank();
    }

    function test_revoker_isRateLimitedPerDay() public {
        vm.prank(OWNER);
        controller.setRevocationsPerDay(2);
        vm.startPrank(revoker);
        controller.banWallet(makeAddr("w1"), keccak256("1"), 1, bytes32(0));
        controller.banWallet(makeAddr("w2"), keccak256("2"), 1, bytes32(0));
        vm.expectRevert(DuskIdentityController.RevocationLimitReached.selector);
        controller.banWallet(makeAddr("w3"), keccak256("3"), 1, bytes32(0));
        vm.warp(block.timestamp + 1 days);
        controller.banWallet(makeAddr("w3"), keccak256("3"), 1, bytes32(0));
        vm.stopPrank();
    }

    function test_banWallet_refusesAWalletThatStillHoldsAName() public {
        _enroll(alice, "alice");
        vm.prank(revoker);
        vm.expectRevert(DuskIdentityController.HasActiveName.selector);
        controller.banWallet(alice, keccak256("b"), 1, bytes32(0));
    }

    function test_unban_liftsTheBanButRestoresNothing() public {
        _enroll(alice, "alice");
        vm.prank(revoker);
        controller.revokeAndBan(alice, 1, keccak256("d"), 1, bytes32(0));
        vm.prank(OWNER);
        controller.unban(alice, keccak256("appeal"), 0, bytes32(0));
        (bool active, uint64 sequence,,) = controller.banOf(alice);
        assertFalse(active);
        assertEq(sequence, 2, "moderation sequence is monotonic across ban and unban");
        assertTrue(controller.reserved(keccak256("alice")), "the old label stays tombstoned");
        assertEq(child.getState(_id("alice")).latestOwner, address(0));
        _enroll(alice, "alice-again");
        assertEq(_resolveAddr("alice-again"), alice);
    }

    function test_governance_twoStepTransfer() public {
        vm.prank(OWNER);
        controller.proposeGovernance(bob);
        assertEq(controller.governance(), OWNER);
        vm.prank(mallory);
        vm.expectRevert(DuskIdentityController.NotPendingGovernance.selector);
        controller.acceptGovernance();
        vm.prank(bob);
        controller.acceptGovernance();
        assertEq(controller.governance(), bob);
    }
}
