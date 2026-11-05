// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {DuskEscrow, IDuskAdmission} from "../src/DuskEscrow.sol";

contract DuskEscrowTest is Test {
    DuskEscrow escrow;

    uint256 buyerKey = 0xB0;
    uint256 workerKey = 0x0001;
    uint256 worker2Key = 0x0002;

    address buyer;
    address worker;
    address worker2;

    bytes32 domainSeparator;
    bytes32 authTypehash;

    bytes32 constant JOB = keccak256("job-1");
    bytes32 constant OUTPUT_HASH = keccak256("output");
    uint256 constant AMOUNT = 1 ether;

    function setUp() public {
        buyer = vm.addr(buyerKey);
        worker = vm.addr(workerKey);
        worker2 = vm.addr(worker2Key);

        escrow = new DuskEscrow(IDuskAdmission(address(0)), 600, address(0xBEEF));
        domainSeparator = escrow.DOMAIN_SEPARATOR();
        authTypehash = escrow.AUTH_TYPEHASH();
        vm.deal(buyer, 10 ether);
    }

    function _fund(uint64 secs) internal returns (uint64 deadline) {
        deadline = uint64(block.timestamp) + secs;
        vm.prank(buyer);
        escrow.fund{value: AMOUNT}(JOB, deadline);
    }

    function _auth(uint256 signerKey, bytes32 jobId, address forWorker) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(authTypehash, jobId, forWorker));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _fundAndCommit() internal {
        _fund(1 hours);
        bytes memory auth = _auth(buyerKey, JOB, worker);
        vm.prank(worker);
        escrow.commit(JOB, OUTPUT_HASH, auth);
    }

    function test_fund_recordsDealAndHoldsValue() public {
        uint64 deadline = _fund(1 hours);

        (
            address dealBuyer,
            address dealWorker,
            uint256 amount,
            bytes32 outputHash,
            uint64 commitAt,
            uint64 dealDeadline,
            DuskEscrow.State state
        ) = escrow.deals(JOB);

        assertEq(dealBuyer, buyer);
        assertEq(dealWorker, address(0));
        assertEq(amount, AMOUNT);
        assertEq(outputHash, bytes32(0));
        assertEq(commitAt, 0);
        assertEq(dealDeadline, deadline);
        assertEq(uint8(state), uint8(DuskEscrow.State.Funded));
        assertEq(address(escrow).balance, AMOUNT);
    }

    function test_commit_recordsTheAuthorisedCaller() public {
        _fundAndCommit();

        (, address dealWorker,, bytes32 outputHash,,, DuskEscrow.State state) = escrow.deals(JOB);
        assertEq(dealWorker, worker, "commit records msg.sender, which is what the auth named");
        assertEq(outputHash, OUTPUT_HASH);
        assertEq(uint8(state), uint8(DuskEscrow.State.Committed));
    }

    function test_settle_paysWorkerImmediatelyAfterCommit() public {
        _fundAndCommit();

        uint256 before = worker.balance;
        vm.warp(block.timestamp + 601);
        escrow.settle(JOB);

        assertEq(worker.balance - before, AMOUNT);
        assertEq(address(escrow).balance, 0);
    }

    function test_refund_returnsToBuyerAfterDeadlineWhenUncommitted() public {
        uint64 deadline = _fund(1 hours);
        vm.warp(deadline + 1);

        uint256 before = buyer.balance;
        vm.prank(buyer);
        escrow.refund(JOB);

        assertEq(buyer.balance - before, AMOUNT);
        assertEq(address(escrow).balance, 0);
    }

    function test_commit_revertsForAStrangerWithNoAuthorisation() public {
        _fund(1 hours);

        vm.prank(worker2);
        vm.expectRevert(DuskEscrow.BadSignature.selector);
        escrow.commit(JOB, keccak256("x"), "");
    }

    function test_commit_revertsWhenTheAuthorisationNamesAnotherWorker() public {
        _fund(1 hours);

        bytes memory auth = _auth(buyerKey, JOB, worker);
        vm.prank(worker2);
        vm.expectRevert(DuskEscrow.NotAuthorised.selector);
        escrow.commit(JOB, OUTPUT_HASH, auth);
    }

    function test_commit_revertsWhenTheAuthorisationIsForAnotherJob() public {
        _fund(1 hours);
        bytes32 otherJob = keccak256("job-2");
        vm.prank(buyer);
        escrow.fund{value: AMOUNT}(otherJob, uint64(block.timestamp) + 1 hours);

        bytes memory auth = _auth(buyerKey, JOB, worker);
        vm.prank(worker);
        vm.expectRevert(DuskEscrow.NotAuthorised.selector);
        escrow.commit(otherJob, OUTPUT_HASH, auth);
    }

    function test_commit_revertsWhenSignedByAnyoneButTheBuyer() public {
        _fund(1 hours);

        bytes memory auth = _auth(worker2Key, JOB, worker);
        vm.prank(worker);
        vm.expectRevert(DuskEscrow.NotAuthorised.selector);
        escrow.commit(JOB, OUTPUT_HASH, auth);
    }

    function test_commit_revertsWhenTheBuyerCommitsItsOwnDeal() public {
        _fund(1 hours);

        bytes memory auth = _auth(buyerKey, JOB, buyer);
        vm.prank(buyer);
        vm.expectRevert(DuskEscrow.BuyerIsNotWorker.selector);
        escrow.commit(JOB, OUTPUT_HASH, auth);
    }

    function test_commit_revertsOnAMalformedSignature() public {
        _fund(1 hours);

        vm.prank(worker);
        vm.expectRevert(DuskEscrow.BadSignature.selector);
        escrow.commit(JOB, OUTPUT_HASH, hex"dead");
    }

    function test_commit_revertsOnAnUnrecoverableSignature() public {
        _fund(1 hours);
        bytes memory bad = abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(1)), uint8(1));

        vm.prank(worker);
        vm.expectRevert(DuskEscrow.BadSignature.selector);
        escrow.commit(JOB, OUTPUT_HASH, bad);
    }

    function test_commit_revertsOnAMalleableHighSSignature() public {
        _fund(1 hours);
        bytes memory good = _auth(buyerKey, JOB, worker);

        bytes32 r;
        bytes32 s;
        uint8 v;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            r := mload(add(good, 32))
            s := mload(add(good, 64))
            v := byte(0, mload(add(good, 96)))
        }
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory flipped = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));

        vm.prank(worker);
        vm.expectRevert(DuskEscrow.BadSignature.selector);
        escrow.commit(JOB, OUTPUT_HASH, flipped);
    }

    function test_domainSeparator_bindsChainIdAndContract() public {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Dusk"),
                keccak256("1"),
                block.chainid,
                address(escrow)
            )
        );
        assertEq(escrow.DOMAIN_SEPARATOR(), expected);

        DuskEscrow other = new DuskEscrow(IDuskAdmission(address(0)), 600, address(0xBEEF));
        assertTrue(other.DOMAIN_SEPARATOR() != escrow.DOMAIN_SEPARATOR(), "a second deployment is a different domain");
    }

    function test_commit_revertsWhenAnAuthorisationIsReusedAfterTheFirstCommit() public {
        _fundAndCommit();

        bytes memory auth = _auth(buyerKey, JOB, worker);
        vm.prank(worker);
        vm.expectRevert(DuskEscrow.NotFunded.selector);
        escrow.commit(JOB, OUTPUT_HASH, auth);
    }

    function test_commit_firstWriterWins_secondCommitReverts() public {
        _fund(1 hours);

        bytes memory authForWorker = _auth(buyerKey, JOB, worker);
        vm.prank(worker);
        escrow.commit(JOB, OUTPUT_HASH, authForWorker);

        bytes memory authForWorker2 = _auth(buyerKey, JOB, worker2);
        vm.prank(worker2);
        vm.expectRevert(DuskEscrow.NotFunded.selector);
        escrow.commit(JOB, keccak256("other output"), authForWorker2);

        (, address dealWorker,,,,,) = escrow.deals(JOB);
        assertEq(dealWorker, worker, "first committer owns the deal");
    }

    function test_refund_revertsBeforeDeadline() public {
        _fund(1 hours);
        vm.prank(buyer);
        vm.expectRevert(DuskEscrow.DeadlineNotReached.selector);
        escrow.refund(JOB);
    }

    function test_refund_revertsAfterCommit() public {
        uint64 deadline = uint64(block.timestamp) + 1 hours;
        _fundAndCommit();

        vm.warp(deadline + 1);
        vm.prank(buyer);
        vm.expectRevert(DuskEscrow.NotFunded.selector);
        escrow.refund(JOB);
    }

    function test_commit_revertsAfterDeadline() public {
        uint64 deadline = _fund(1 hours);
        vm.warp(deadline + 1);

        bytes memory auth = _auth(buyerKey, JOB, worker);
        vm.prank(worker);
        vm.expectRevert(DuskEscrow.DeadlinePassed.selector);
        escrow.commit(JOB, OUTPUT_HASH, auth);
    }

    function test_commit_succeedsRightUpToTheDeadline() public {
        uint64 deadline = _fund(1 hours);
        vm.warp(deadline);

        bytes memory auth = _auth(buyerKey, JOB, worker);
        vm.prank(worker);
escrow.commit(JOB, OUTPUT_HASH, auth);
        (, address dealWorker,,,,,) = escrow.deals(JOB);
        assertEq(dealWorker, worker);
    }

    function test_refund_revertsWhenCallerIsNotTheBuyer() public {
        uint64 deadline = _fund(1 hours);
        vm.warp(deadline + 1);

        vm.prank(worker);
        vm.expectRevert(DuskEscrow.NotBuyer.selector);
        escrow.refund(JOB);
    }

    function test_settle_canBePushedByAnyoneAndAlwaysPaysTheWorker() public {
        _fundAndCommit();
        address stranger = address(0xDEAD);
        vm.deal(stranger, 1 ether);

        uint256 workerBefore = worker.balance;
        uint256 strangerBefore = stranger.balance;

        vm.warp(block.timestamp + 601);
        vm.prank(stranger);
        escrow.settle(JOB);

        assertEq(worker.balance - workerBefore, AMOUNT, "the worker is paid");
        assertEq(stranger.balance, strangerBefore, "the caller gains nothing");
    }

    function test_settle_revertsOnSecondCall() public {
        _fundAndCommit();
        vm.warp(block.timestamp + 601);
        escrow.settle(JOB);

        vm.warp(block.timestamp + 601);
        vm.expectRevert(DuskEscrow.NotCommitted.selector);
        escrow.settle(JOB);
    }

    function test_settle_revertsOnAFundedButUncommittedDeal() public {
        _fund(1 hours);
        vm.warp(block.timestamp + 601);
        vm.expectRevert(DuskEscrow.NotCommitted.selector);
        escrow.settle(JOB);
    }

    function test_fund_revertsOnDuplicateJobId() public {
        _fund(1 hours);

        vm.prank(buyer);
        vm.expectRevert(DuskEscrow.DealExists.selector);
        escrow.fund{value: AMOUNT}(JOB, uint64(block.timestamp) + 1 hours);
    }

    function test_fund_revertsOnZeroValue() public {
        vm.prank(buyer);
        vm.expectRevert(DuskEscrow.ZeroAmount.selector);
        escrow.fund{value: 0}(JOB, uint64(block.timestamp) + 1 hours);
    }

    function test_commit_revertsOnZeroOutputHash() public {
        _fund(1 hours);
        bytes memory auth = _auth(buyerKey, JOB, worker);
        vm.prank(worker);
        vm.expectRevert(DuskEscrow.EmptyOutputHash.selector);
        escrow.commit(JOB, bytes32(0), auth);
    }

    function test_commit_checksTheDealBeforeTheSignature() public {
        vm.prank(worker);
        vm.expectRevert(DuskEscrow.NotFunded.selector);
        escrow.commit(JOB, OUTPUT_HASH, hex"dead");
    }

    function test_fund_revertsOnDeadlineInThePast() public {
        vm.warp(1000);
        vm.prank(buyer);
        vm.expectRevert(DuskEscrow.DeadlineInPast.selector);
        escrow.fund{value: AMOUNT}(JOB, uint64(block.timestamp) - 1);
    }
}
