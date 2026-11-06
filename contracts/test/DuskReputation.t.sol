// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DuskReputation} from "../src/DuskReputation.sol";
import {DuskIdentityController} from "../src/DuskIdentityController.sol";

contract ReputationControllerMock {
    address public governance;
    address public revoker;
    uint256 public remaining = 10;
    mapping(address => bool) public isBanned;
    mapping(address => uint64) public moderationSequences;
    mapping(address => uint64) public generations;
    mapping(address => string) public labels;
    mapping(address => bool) public lost;
    constructor(address owner) { governance = owner; }
    function parentDnsName() external pure returns (bytes memory) { return hex"046475736b0365746800"; }
    function setRevoker(address value) external { revoker = value; }
    function setRemaining(uint256 value) external { remaining = value; }
    function enroll(address wallet, uint64 generation, string memory label) external { generations[wallet] = generation; labels[wallet] = label; }
    function setLost(address wallet) external { lost[wallet] = true; }
    function banOf(address wallet) external view returns (bool, uint64, uint16, bytes32) { return (isBanned[wallet], moderationSequences[wallet], 0, bytes32(0)); }
    function appeal(address wallet) external { isBanned[wallet] = false; ++moderationSequences[wallet]; }
    function membershipOf(address wallet) external view returns (string memory, uint64, address, uint64, DuskIdentityController.MembershipStatus) {
        return (labels[wallet], generations[wallet], address(0), uint64(block.timestamp + 1 days),
            generations[wallet] == 0 ? DuskIdentityController.MembershipStatus.None : lost[wallet] ? DuskIdentityController.MembershipStatus.Lost : DuskIdentityController.MembershipStatus.Active);
    }
    function revokeAndBan(address wallet, uint64 generation, bytes32, uint16, bytes32) external {
        require(msg.sender == revoker && generations[wallet] == generation, "wrong role or generation");
        require(remaining > 0, "daily cap");
        --remaining; isBanned[wallet] = true; ++moderationSequences[wallet];
    }
    function banWallet(address wallet, bytes32, uint16, bytes32) external {
        require(msg.sender == revoker && lost[wallet] && remaining > 0, "cannot ban");
        --remaining; isBanned[wallet] = true; ++moderationSequences[wallet];
    }
}

contract ReputationForwarderMock {
    function deliver(DuskReputation target, bytes memory metadata, bytes memory report) external { target.onReport(metadata, report); }
}

contract DuskReputationTest is Test {
    address company = makeAddr("company");
    address workflowOwner = makeAddr("workflow owner");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    bytes32 workflowId = keccak256("company-approved-workflow");
    bytes32 sources = keccak256("pinned escrow and Arkiv chains");
    ReputationControllerMock controller;
    ReputationForwarderMock forwarder;
    DuskReputation reputation;

    function setUp() public {
        vm.warp(1_800_000_000);
        controller = new ReputationControllerMock(company);
        forwarder = new ReputationForwarderMock();
        reputation = new DuskReputation(DuskIdentityController(address(controller)), sources);
        controller.setRevoker(address(reputation));
        controller.enroll(alice, 1, "alice");
        controller.enroll(bob, 1, "bob");
        vm.startPrank(company);
        reputation.configureWorkflow(address(forwarder), workflowOwner, workflowId);
        reputation.setPaused(false);
        vm.stopPrank();
    }

    // Policy v2: a late canary is exactly -10, so a score in steps of 10 is that many late findings.
    function _evaluation(address wallet, uint16 score, uint32 jobs) internal view returns (DuskReputation.Evaluation memory e) {
        DuskReputation.Finding[] memory findings = new DuskReputation.Finding[]((100 - score) / 10);
        for (uint256 i; i < findings.length; ++i) findings[i] = DuskReputation.Finding(keccak256(abi.encode(wallet, i)), 3);
        e = DuskReputation.Evaluation(wallet, 1, score, jobs, 0, 0, 0, (100 - score) / 10, 0, 2,
            uint64(block.timestamp), 100, 200, keccak256(abi.encode(wallet, score, jobs)), keccak256("public Swarm evidence"), findings);
    }
    function _with(address wallet, uint32 jobs, uint8[] memory kinds, uint32 offset) internal view returns (DuskReputation.Evaluation memory e) {
        DuskReputation.Finding[] memory findings = new DuskReputation.Finding[](kinds.length);
        for (uint256 i; i < kinds.length; ++i) findings[i] = DuskReputation.Finding(keccak256(abi.encode(wallet, "job", i + offset)), kinds[i]);
        e = DuskReputation.Evaluation(wallet, 1, 0, jobs, 0, 0, 0, 0, 0, 2,
            uint64(block.timestamp), 100, 200, keccak256(abi.encode(wallet, jobs, offset)), keccak256("public Swarm evidence"), findings);
    }
    function _metadata() internal view returns (bytes memory) { return abi.encodePacked(workflowId, bytes10("dusk-rep"), workflowOwner, bytes2(0)); }
    function _report(DuskReputation.Evaluation[] memory list) internal view returns (bytes memory) {
        return abi.encode(block.chainid, address(reputation), reputation.policyEpoch(), sources, list);
    }
    function _deliver(DuskReputation.Evaluation memory e) internal {
        DuskReputation.Evaluation[] memory list = new DuskReputation.Evaluation[](1); list[0] = e;
        forwarder.deliver(reputation, _metadata(), _report(list));
    }

    function test_onlyTheApprovedWorkflowCanPublishAndUsersCannotSetTheirScore() public {
        DuskReputation.Evaluation memory e = _evaluation(alice, 100, 3);
        DuskReputation.Evaluation[] memory list = new DuskReputation.Evaluation[](1); list[0] = e;
        bytes memory report = _report(list);
        vm.prank(alice);
        vm.expectRevert(DuskReputation.UntrustedReport.selector);
        reputation.onReport(_metadata(), report);
        vm.prank(alice);
        vm.expectRevert(DuskReputation.NotSelf.selector);
        reputation.processEvaluation(e);
        assertEq(reputation.reputationOf(alice).sequence, 0, "missing is unassessed");
        _deliver(e);
        assertEq(reputation.reputationOf(alice).score, 100);
    }

    function test_companyAloneControlsPolicyWorkflowPauseAndOwnership() public {
        vm.startPrank(alice);
        vm.expectRevert(DuskReputation.NotCompany.selector); reputation.configurePolicy(90, 1, 600, sources);
        vm.expectRevert(DuskReputation.NotCompany.selector); reputation.configureWorkflow(address(forwarder), alice, workflowId);
        vm.expectRevert(DuskReputation.NotCompany.selector); reputation.setPaused(true);
        vm.expectRevert(DuskReputation.NotCompany.selector); reputation.proposeCompany(alice);
        vm.expectRevert(DuskReputation.NotCompany.selector); reputation.commitOperatorName(bytes32(0));
        vm.expectRevert(DuskReputation.NotCompany.selector); reputation.registerOperatorName(bytes32(0));
        vm.expectRevert(DuskReputation.NotCompany.selector); reputation.dismissFinding(alice, bytes32(uint256(1)), 1, bytes32(uint256(1)));
        vm.stopPrank();
    }

    function test_below50AndAtLeastThreeResolvedJobsRevokes() public {
        _deliver(_evaluation(alice, 40, 3));
        assertTrue(controller.isBanned(alice));
        DuskReputation.Reputation memory record = reputation.reputationOf(alice);
        assertEq(record.score, 40);
        assertEq(record.resolvedJobs, 3);
        assertEq(uint8(record.standing), uint8(DuskReputation.Standing.Banned));
        assertEq(record.generation, 1);
        assertEq(record.evaluatedAt, block.timestamp);
        assertEq(record.publishedAtBlock, block.number);
    }

    function test_exactly50AndAnInsufficientSampleNeverRevoke() public {
        _deliver(_evaluation(alice, 50, 3));
        _deliver(_evaluation(bob, 0, 2));
        assertFalse(controller.isBanned(alice));
        assertFalse(controller.isBanned(bob));
        assertEq(uint8(reputation.reputationOf(bob).standing), uint8(DuskReputation.Standing.New));
    }

    function test_rejectedJobsCountAsResolved() public {
        DuskReputation.Evaluation memory e = _evaluation(alice, 40, 1); e.rejectedJobs = 2;
        _deliver(e);
        assertTrue(controller.isBanned(alice));
    }

    function test_wrongWorkflowOwnerIdOrMetadataLengthIsRefused() public {
        DuskReputation.Evaluation[] memory list = new DuskReputation.Evaluation[](1); list[0] = _evaluation(alice, 40, 3);
        bytes memory report = _report(list);
        vm.expectRevert(DuskReputation.UntrustedReport.selector);
        forwarder.deliver(reputation, abi.encodePacked(workflowId, bytes10("dusk-rep"), alice, bytes2(0)), report);
        vm.expectRevert(DuskReputation.UntrustedReport.selector);
        forwarder.deliver(reputation, abi.encodePacked(keccak256("another workflow"), bytes10("dusk-rep"), workflowOwner, bytes2(0)), report);
        vm.expectRevert(DuskReputation.UntrustedReport.selector);
        forwarder.deliver(reputation, abi.encodePacked(workflowId, bytes10("dusk-rep"), workflowOwner), report);
    }

    function test_reportsAreBoundToChainContractEpochAndSources() public {
        DuskReputation.Evaluation[] memory list = new DuskReputation.Evaluation[](1); list[0] = _evaluation(alice, 40, 3);
        uint32 epoch = reputation.policyEpoch();
        vm.expectRevert(DuskReputation.WrongDomain.selector);
        forwarder.deliver(reputation, _metadata(), abi.encode(block.chainid + 1, address(reputation), epoch, sources, list));
        vm.expectRevert(DuskReputation.WrongDomain.selector);
        forwarder.deliver(reputation, _metadata(), abi.encode(block.chainid, alice, epoch, sources, list));
        vm.expectRevert(DuskReputation.WrongDomain.selector);
        forwarder.deliver(reputation, _metadata(), abi.encode(block.chainid, address(reputation), epoch, bytes32(0), list));
        bytes memory oldReport = _report(list);
        vm.prank(company); reputation.configurePolicy(50, 3, 3600, sources);
        vm.expectRevert(DuskReputation.WrongDomain.selector);
        forwarder.deliver(reputation, _metadata(), oldReport);
    }

    function test_duplicateOldFutureOrForgedScoresNeverReplaceARecord() public {
        DuskReputation.Evaluation memory good = _evaluation(alice, 100, 3);
        _deliver(good);
        uint64 original = reputation.reputationOf(alice).sequence;
        _deliver(good);
        DuskReputation.Evaluation memory bad = _evaluation(alice, 40, 3);
        bad.evaluatedAt += 100; _deliver(bad);
        vm.warp(block.timestamp + 2 hours); _deliver(bad);
        bad.evaluatedAt = uint64(block.timestamp); bad.late = 0; _deliver(bad);
        bad.late = 6; bad.generation = 2; _deliver(bad);
        bad.generation = 1; bad.galileoBlock = 99; _deliver(bad);
        bad.galileoBlock = 100; bad.arkivBlock = 199; _deliver(bad);
        assertEq(reputation.reputationOf(alice).sequence, original);
        assertFalse(controller.isBanned(alice));
    }

    function test_partialFailureAndDailyCapDoNotPreventOtherPublications() public {
        controller.setRemaining(0);
        DuskReputation.Evaluation[] memory list = new DuskReputation.Evaluation[](3);
        list[0] = _evaluation(alice, 40, 3); list[0].generation = 999;
        list[1] = _evaluation(bob, 40, 3);
        list[2] = _evaluation(alice, 100, 3);
        forwarder.deliver(reputation, _metadata(), _report(list));
        assertEq(reputation.reputationOf(alice).score, 100);
        assertEq(reputation.reputationOf(bob).score, 40);
        assertFalse(controller.isBanned(bob));
        controller.setRemaining(1); vm.warp(block.timestamp + 4 hours);
        _deliver(_evaluation(bob, 40, 3));
        assertTrue(controller.isBanned(bob));
    }

    function test_lostMembershipBansOnlyTheOriginalWallet() public {
        controller.setLost(alice);
        _deliver(_evaluation(alice, 40, 3));
        assertTrue(controller.isBanned(alice));
        assertFalse(controller.isBanned(bob));
    }

    function test_pauseInvalidatesQueuedReportsAndCompanyTransferRequiresAcceptance() public {
        DuskReputation.Evaluation[] memory list = new DuskReputation.Evaluation[](1); list[0] = _evaluation(alice, 40, 3);
        bytes memory queued = _report(list);
        vm.prank(company); reputation.setPaused(true);
        vm.expectRevert(DuskReputation.Paused.selector); forwarder.deliver(reputation, _metadata(), queued);
        vm.prank(company); reputation.setPaused(false);
        vm.expectRevert(DuskReputation.WrongDomain.selector); forwarder.deliver(reputation, _metadata(), queued);
        vm.prank(company); reputation.proposeCompany(bob);
        vm.prank(alice); vm.expectRevert(DuskReputation.NotPendingCompany.selector); reputation.acceptCompany();
        vm.prank(bob); reputation.acceptCompany();
        vm.prank(company); vm.expectRevert(DuskReputation.NotCompany.selector); reputation.setPaused(true);
        vm.prank(bob); reputation.setPaused(true);
    }

    function test_defaultIsPausedAndInvalidConfigurationCannotBeEnabled() public {
        DuskReputation fresh = new DuskReputation(DuskIdentityController(address(controller)), sources);
        assertTrue(fresh.paused());
        vm.startPrank(company);
        vm.expectRevert(DuskReputation.InvalidConfiguration.selector); fresh.setPaused(false);
        vm.expectRevert(DuskReputation.InvalidConfiguration.selector); fresh.configureWorkflow(alice, workflowOwner, workflowId);
        vm.expectRevert(DuskReputation.InvalidConfiguration.selector); fresh.configurePolicy(101, 3, 3600, sources);
        vm.expectRevert(DuskReputation.InvalidConfiguration.selector); fresh.configurePolicy(50, 0, 3600, sources);
        vm.stopPrank();
    }

    function testFuzz_thresholdAndSampleSize(uint8 penalties, uint8 jobs) public {
        penalties = uint8(bound(penalties, 0, 10));
        jobs = uint8(bound(jobs, 0, 20));
        uint16 score = 100 - uint16(penalties) * 10;
        _deliver(_evaluation(alice, score, jobs));
        assertEq(controller.isBanned(alice), score < 50 && jobs >= 3);
    }

    function test_expiredOrDeletedEvidenceCannotErasePublishedFindings() public {
        _deliver(_evaluation(alice, 50, 3));
        assertEq(reputation.lateOf(alice), 5);
        vm.warp(block.timestamp + 4 hours);
        _deliver(_evaluation(alice, 100, 3));
        assertEq(reputation.reputationOf(alice).score, 50, "forgetting records cannot heal the score");
        DuskReputation.Evaluation memory refreshed = _evaluation(alice, 50, 3);
        refreshed.findings = new DuskReputation.Finding[](0);
        _deliver(refreshed);
        assertEq(reputation.reputationOf(alice).evaluatedAt, block.timestamp);
        assertEq(reputation.lateOf(alice), 5, "repeated evidence is counted once");
    }

    function test_companyCanDismissAFindingAndItCannotBeReintroducedByTheWorker() public {
        _deliver(_evaluation(alice, 50, 3));
        bytes32 job = keccak256(abi.encode(alice, uint256(4)));
        vm.prank(company); reputation.dismissFinding(alice, job, 3, keccak256("review"));
        assertEq(reputation.lateOf(alice), 4);
        vm.warp(block.timestamp + 4 hours);
        _deliver(_evaluation(alice, 50, 3));
        assertEq(reputation.lateOf(alice), 4);
        _deliver(_evaluation(alice, 60, 3));
        assertEq(reputation.reputationOf(alice).score, 60);
    }

    function test_anAppealCannotBeUndoneByTheSameOldFindings() public {
        _deliver(_evaluation(alice, 40, 3));
        controller.appeal(alice);
        vm.warp(block.timestamp + 4 hours);
        _deliver(_evaluation(alice, 40, 3));
        assertFalse(controller.isBanned(alice));
        vm.warp(block.timestamp + 4 hours);
        _deliver(_evaluation(alice, 30, 4));
        assertTrue(controller.isBanned(alice), "new authenticated misconduct may trigger a new decision");
    }

    // ───────────────────────────────────────────── policy v2: canary scoring

    function _kinds(uint8 a) internal pure returns (uint8[] memory k) { k = new uint8[](1); k[0] = a; }
    function _kinds(uint8 a, uint8 b) internal pure returns (uint8[] memory k) { k = new uint8[](2); k[0] = a; k[1] = b; }
    function _kinds(uint8 a, uint8 b, uint8 c, uint8 d) internal pure returns (uint8[] memory k) {
        k = new uint8[](4); k[0] = a; k[1] = b; k[2] = c; k[3] = d;
    }

    function test_v2_scoresEachKindAndStaysWithin0To100() public {
        // empty -20, illegal -50, late -10, pass +10, all on different jobs: 100 - 70 = 30
        DuskReputation.Evaluation memory e = _with(alice, 0, _kinds(1, 2, 3, 4), 0);
        e.badAnswers = 1; e.illegal = 1; e.late = 1; e.passed = 1; e.score = 30;
        _deliver(e);
        assertEq(reputation.reputationOf(alice).score, 30);
        assertEq(reputation.reputationOf(alice).late, 1);
        assertEq(reputation.reputationOf(alice).passed, 1);
        // passes never lift a score above 100
        DuskReputation.Evaluation memory b = _with(bob, 0, _kinds(4, 4), 10);
        b.findings[1].job = keccak256("another job");
        b.passed = 2; b.score = 100;
        _deliver(b);
        assertEq(reputation.reputationOf(bob).score, 100);
    }

    function test_v2_refusesTheOldFormulaAndUnknownKinds() public {
        DuskReputation.Evaluation memory e = _with(alice, 0, _kinds(1), 0);
        e.badAnswers = 1; e.score = 90; // v1 said -10; v2 says -20
        _deliver(e);
        assertEq(reputation.reputationOf(alice).sequence, 0, "a v1 score is refused");
        DuskReputation.Evaluation memory k = _with(alice, 0, _kinds(5), 0);
        k.score = 100;
        _deliver(k);
        assertEq(reputation.reputationOf(alice).sequence, 0, "kind 5 is refused");
    }

    function test_v2_oneFindingPerJobTheWorstWins() public {
        // pass then late on the same job: late replaces pass (no +10 and -10 for one job)
        DuskReputation.Evaluation memory e = _with(alice, 0, _kinds(4, 3), 0);
        e.findings[1].job = e.findings[0].job;
        e.late = 1; e.score = 90;
        _deliver(e);
        assertEq(reputation.passedOf(alice), 0);
        assertEq(reputation.lateOf(alice), 1);
        // a lesser finding never replaces a worse one later
        vm.warp(block.timestamp + 1 hours);
        DuskReputation.Evaluation memory later = _with(alice, 0, _kinds(4), 0);
        later.late = 1; later.score = 90;
        _deliver(later);
        assertEq(reputation.lateOf(alice), 1);
        assertEq(reputation.passedOf(alice), 0);
        assertEq(reputation.reputationOf(alice).score, 90);
    }

    function test_v2_dismissedFindingsStayDismissedForEveryKind() public {
        DuskReputation.Evaluation memory e = _with(alice, 0, _kinds(1), 0);
        e.badAnswers = 1; e.score = 80;
        _deliver(e);
        vm.prank(company); reputation.dismissFinding(alice, e.findings[0].job, 1, keccak256("appeal"));
        assertEq(reputation.badAnswersOf(alice), 0);
        vm.warp(block.timestamp + 1 hours);
        DuskReputation.Evaluation memory again = _with(alice, 0, _kinds(1), 0);
        again.score = 100;
        _deliver(again);
        assertEq(reputation.badAnswersOf(alice), 0, "a dismissed finding is not re-counted");
        assertEq(reputation.reputationOf(alice).score, 100);
        vm.prank(company); vm.expectRevert(DuskReputation.InvalidEvaluation.selector);
        reputation.dismissFinding(alice, e.findings[0].job, 5, keccak256("no such kind"));
    }

    function test_v2_evaluationStateReportsAllFourCounts() public {
        DuskReputation.Evaluation memory e = _with(alice, 0, _kinds(1, 2, 3, 4), 0);
        e.badAnswers = 1; e.illegal = 1; e.late = 1; e.passed = 1; e.score = 30;
        _deliver(e);
        bytes32[] memory jobs = new bytes32[](1); jobs[0] = e.findings[2].job;
        (uint32 bad, uint32 illegal, uint32 late, uint32 passed, uint8[] memory flags) = reputation.evaluationState(alice, jobs);
        assertEq(bad, 1); assertEq(illegal, 1); assertEq(late, 1); assertEq(passed, 1);
        assertEq(flags[0], 4, "late is bit 1<<(3-1)");
    }
}
