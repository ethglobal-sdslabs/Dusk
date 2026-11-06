// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DuskAdmission} from "../src/DuskAdmission.sol";
import {DuskEscrow, IDuskAdmission} from "../src/DuskEscrow.sol";

contract DuskAdmissionTest is Test {
    uint256 constant SEPOLIA = 11155111;
    address constant CONTROLLER = address(0xC0);
    uint64 constant MAX_VALIDITY = 1 days;

    DuskAdmission admission;
    address governance = makeAddr("governance");
    uint256[3] keys;
    address[3] attesters;
    address buyer = makeAddr("buyer");
    address worker = makeAddr("worker");

    function setUp() public {
        vm.warp(1_800_000_000);
        uint256[3] memory candidates = [uint256(0xA11CE), 0xB0B, 0xCA401];
        for (uint256 i; i < 3; ++i) {
            for (uint256 j = i + 1; j < 3; ++j) {
                if (vm.addr(candidates[j]) < vm.addr(candidates[i])) (candidates[i], candidates[j]) = (candidates[j], candidates[i]);
            }
        }
        address[] memory list = new address[](3);
        for (uint256 i; i < 3; ++i) {
            keys[i] = candidates[i];
            attesters[i] = vm.addr(candidates[i]);
            list[i] = attesters[i];
        }
        admission = new DuskAdmission(SEPOLIA, CONTROLLER, MAX_VALIDITY, governance, list, 2);
    }

    function _status(address wallet, bool admitted, uint64 sourceBlock) internal view returns (DuskAdmission.Status memory) {
        return DuskAdmission.Status(SEPOLIA, CONTROLLER, wallet, admitted, sourceBlock, uint64(block.timestamp + 6 hours), admission.epoch());
    }

    function _sign(DuskAdmission.Status memory s, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 sv) = vm.sign(key, this.digestOf(s));
        return abi.encodePacked(r, sv, v);
    }

    function digestOf(DuskAdmission.Status calldata s) external view returns (bytes32) {
        return admission.statusDigest(s);
    }

    function _sigs(DuskAdmission.Status memory s, uint256 count) internal view returns (bytes[] memory sigs) {
        sigs = new bytes[](count);
        for (uint256 i; i < count; ++i) sigs[i] = _sign(s, keys[i]);
    }

    function _admit(address wallet, bool admitted, uint64 sourceBlock) internal {
        DuskAdmission.Status memory s = _status(wallet, admitted, sourceBlock);
        admission.submit(s, _sigs(s, 2));
    }

    function test_submit_storesAQuorumSignedStatus_fromAnySubmitter() public {
        DuskAdmission.Status memory s = _status(worker, true, 100);
        bytes[] memory sigs = _sigs(s, 2);
        vm.prank(makeAddr("anyone"));
        admission.submit(s, sigs);
        assertTrue(admission.isAdmitted(worker));
    }

    function test_submit_belowQuorumIsRefused() public {
        DuskAdmission.Status memory s = _status(worker, true, 100);
        bytes[] memory sigs = _sigs(s, 1);
        vm.expectRevert(abi.encodeWithSelector(DuskAdmission.QuorumNotMet.selector, 1, 2));
        admission.submit(s, sigs);
    }

    function test_submit_oneAttesterSigningTwiceIsNotAQuorum() public {
        DuskAdmission.Status memory s = _status(worker, true, 100);
        bytes[] memory sigs = new bytes[](2);
        sigs[0] = _sign(s, keys[0]);
        sigs[1] = _sign(s, keys[0]);
        vm.expectRevert(DuskAdmission.SignersNotSorted.selector);
        admission.submit(s, sigs);
    }

    function test_submit_aStrangersSignatureDoesNotCount() public {
        DuskAdmission.Status memory s = _status(worker, true, 100);
        uint256 stranger = 0xDEAD;
        bytes[] memory sigs = new bytes[](2);
        (sigs[0], sigs[1]) = vm.addr(stranger) < attesters[0] ? (_sign(s, stranger), _sign(s, keys[0])) : (_sign(s, keys[0]), _sign(s, stranger));
        vm.expectRevert(abi.encodeWithSelector(DuskAdmission.UnknownAttester.selector, vm.addr(stranger)));
        admission.submit(s, sigs);
    }

    function test_submit_aSignatureCannotBeMovedToAnotherWalletOrVerdict() public {
        DuskAdmission.Status memory s = _status(worker, false, 100);
        bytes[] memory sigs = _sigs(s, 2);
        s.admitted = true;
        vm.expectRevert();
        admission.submit(s, sigs);
        s.admitted = false;
        s.wallet = buyer;
        vm.expectRevert();
        admission.submit(s, sigs);
    }

    function test_submit_isBoundToThisDeployment() public {
        DuskAdmission.Status memory s = _status(worker, true, 100);
        bytes[] memory sigs = _sigs(s, 2);
        address[] memory list = new address[](3);
        for (uint256 i; i < 3; ++i) list[i] = attesters[i];
        DuskAdmission other = new DuskAdmission(SEPOLIA, CONTROLLER, MAX_VALIDITY, governance, list, 2);
        vm.expectRevert();
        other.submit(s, sigs);
    }

    function test_submit_rejectsAForeignSourceOrController() public {
        DuskAdmission.Status memory s = _status(worker, true, 100);
        s.sourceChainId = 1;
        bytes[] memory sigs = _sigs(s, 2);
        vm.expectRevert(DuskAdmission.WrongSource.selector);
        admission.submit(s, sigs);
        s = _status(worker, true, 100);
        s.controller = address(0xBAD);
        sigs = _sigs(s, 2);
        vm.expectRevert(DuskAdmission.WrongSource.selector);
        admission.submit(s, sigs);
    }

    function test_submit_anOlderObservationCannotRollBackABan() public {
        _admit(worker, true, 100);
        _admit(worker, false, 200);
        DuskAdmission.Status memory old = _status(worker, true, 150);
        bytes[] memory sigs = _sigs(old, 2);
        vm.expectRevert(DuskAdmission.StaleStatus.selector);
        admission.submit(old, sigs);
        assertFalse(admission.isAdmitted(worker));
        DuskAdmission.Status memory same = _status(worker, false, 200);
        sigs = _sigs(same, 2);
        vm.expectRevert(DuskAdmission.StaleStatus.selector);
        admission.submit(same, sigs);
    }

    function test_isAdmitted_failsClosedWithoutAStatusAndAfterExpiry() public {
        assertFalse(admission.isAdmitted(worker), "never attested");
        _admit(worker, true, 100);
        assertTrue(admission.isAdmitted(worker));
        vm.warp(block.timestamp + 6 hours);
        assertFalse(admission.isAdmitted(worker), "expired");
    }

    function test_submit_validityIsBounded() public {
        DuskAdmission.Status memory s = _status(worker, true, 100);
        s.validUntil = uint64(block.timestamp + MAX_VALIDITY + 1);
        bytes[] memory sigs = _sigs(s, 2);
        vm.expectRevert(DuskAdmission.BadValidity.selector);
        admission.submit(s, sigs);
        s.validUntil = uint64(block.timestamp);
        sigs = _sigs(s, 2);
        vm.expectRevert(DuskAdmission.BadValidity.selector);
        admission.submit(s, sigs);
    }

    function test_bumpEpoch_invalidatesEveryStoredStatus() public {
        _admit(worker, true, 100);
        vm.prank(governance);
        admission.bumpEpoch();
        assertFalse(admission.isAdmitted(worker));
        DuskAdmission.Status memory s = _status(worker, true, 50);
        admission.submit(s, _sigs(s, 2));
        assertTrue(admission.isAdmitted(worker));
    }

    function test_resetRecord_unfreezesOneWalletWithoutTouchingOthers() public {
        _admit(buyer, true, 100);
        _admit(worker, true, type(uint64).max);
        DuskAdmission.Status memory ban = _status(worker, false, 200);
        bytes[] memory sigs = _sigs(ban, 2);
        vm.expectRevert(DuskAdmission.StaleStatus.selector);
        admission.submit(ban, sigs);

        vm.expectRevert(DuskAdmission.NotGovernance.selector);
        admission.resetRecord(worker);
        vm.prank(governance);
        admission.resetRecord(worker);
        assertFalse(admission.isAdmitted(worker), "a reset record admits nobody");
        assertTrue(admission.isAdmitted(buyer), "other wallets are untouched");
        admission.submit(ban, sigs);
        (bool admitted, uint64 sourceBlock,,) = admission.records(worker);
        assertFalse(admitted);
        assertEq(sourceBlock, 200);
    }

    function test_governance_onlyGovernanceManagesAttestersAndQuorum() public {
        vm.expectRevert(DuskAdmission.NotGovernance.selector);
        admission.setQuorum(1);
        vm.expectRevert(DuskAdmission.NotGovernance.selector);
        admission.setAttester(makeAddr("x"), true);
        vm.expectRevert(DuskAdmission.NotGovernance.selector);
        admission.bumpEpoch();
        vm.startPrank(governance);
        vm.expectRevert(DuskAdmission.BadQuorum.selector);
        admission.setQuorum(4);
        admission.setAttester(attesters[2], false);
        vm.expectRevert(DuskAdmission.BadQuorum.selector);
        admission.setAttester(attesters[1], false);
        vm.stopPrank();
    }

    function _escrow() internal returns (DuskEscrow escrow) {
        escrow = new DuskEscrow(IDuskAdmission(address(admission)), 600, address(0xBEEF));
        vm.deal(buyer, 1 ether);
    }

    function _commitAuth(DuskEscrow escrow, bytes32 jobId, address who, uint256 buyerKey) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(escrow.AUTH_TYPEHASH(), jobId, who));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerKey, keccak256(abi.encodePacked("\x19\x01", escrow.DOMAIN_SEPARATOR(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function test_escrow_anUnadmittedBuyerCannotFund() public {
        DuskEscrow escrow = _escrow();
        vm.prank(buyer);
        vm.expectRevert(DuskEscrow.NotAdmitted.selector);
        escrow.fund{value: 1000}(keccak256("job"), uint64(block.timestamp + 1 hours));
    }

    function test_escrow_aWorkerBannedMidJobCannotCommit_andTheBuyerIsRefunded() public {
        uint256 buyerKey = 0xB1;
        buyer = vm.addr(buyerKey);
        DuskEscrow escrow = _escrow();
        _admit(buyer, true, 100);
        _admit(worker, true, 100);
        bytes32 jobId = keccak256("job");
        vm.prank(buyer);
        escrow.fund{value: 1000}(jobId, uint64(block.timestamp + 1 hours));
        bytes memory auth = _commitAuth(escrow, jobId, worker, buyerKey);

        _admit(worker, false, 101);
        vm.prank(worker);
        vm.expectRevert(DuskEscrow.NotAdmitted.selector);
        escrow.commit(jobId, keccak256("out"), auth);

        _admit(buyer, false, 102);
        vm.warp(block.timestamp + 1 hours + 1);
        uint256 before = buyer.balance;
        vm.prank(buyer);
        escrow.refund(jobId);
        assertEq(buyer.balance, before + 1000);
    }

    function test_escrow_aBanNeverBlocksSettlingWorkAlreadyCommitted() public {
        uint256 buyerKey = 0xB1;
        buyer = vm.addr(buyerKey);
        DuskEscrow escrow = _escrow();
        _admit(buyer, true, 100);
        _admit(worker, true, 100);
        bytes32 jobId = keccak256("job");
        vm.prank(buyer);
        escrow.fund{value: 1000}(jobId, uint64(block.timestamp + 1 hours));
        bytes memory auth = _commitAuth(escrow, jobId, worker, buyerKey);
        vm.prank(worker);
        escrow.commit(jobId, keccak256("out"), auth);

        _admit(worker, false, 101);
        uint256 before = worker.balance;
        vm.warp(block.timestamp + 601);
        escrow.settle(jobId);
        assertEq(worker.balance, before + 1000);
    }

    function test_escrow_withoutAGateBehavesAsBefore() public {
        DuskEscrow escrow = new DuskEscrow(IDuskAdmission(address(0)), 600, address(0xBEEF));
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        escrow.fund{value: 1000}(keccak256("job"), uint64(block.timestamp + 1 hours));
    }

    function test_escrow_admissionWorksWithoutAVerifierService_andBanCannotBlockEarnedSettlement() public {
        uint256 buyerKey = 0xB1;
        buyer = vm.addr(buyerKey);
        DuskEscrow escrow = new DuskEscrow(IDuskAdmission(address(admission)), 0, address(0));
        vm.deal(buyer, 1 ether);
        _admit(buyer, true, 100);
        _admit(worker, true, 100);
        bytes32 jobId = keccak256("without-verifier");
        vm.prank(buyer);
        escrow.fund{value: 1000}(jobId, uint64(block.timestamp + 1 hours));
        bytes memory auth = _commitAuth(escrow, jobId, worker, buyerKey);
        vm.prank(worker);
        escrow.commit(jobId, keccak256("output"), auth);
        _admit(worker, false, 101);
        uint256 before = worker.balance;
        escrow.settle(jobId);
        assertEq(worker.balance, before + 1000);
        vm.prank(worker);
        vm.expectRevert(DuskEscrow.NotAdmitted.selector);
        escrow.fund{value: 1}(keccak256("new-job"), uint64(block.timestamp + 1 hours));
    }
}
