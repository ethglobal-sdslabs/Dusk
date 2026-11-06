// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {DuskEscrow, IDuskAdmission} from "../src/DuskEscrow.sol";

contract Rejecter {
    function commit(DuskEscrow e, bytes32 id, bytes32 h, bytes calldata a) external { e.commit(id, h, a); }
    function fund(DuskEscrow e, bytes32 id, uint64 d) external payable { e.fund{value: msg.value}(id, d); }
    function refund(DuskEscrow e, bytes32 id) external { e.refund(id); }
}

contract ReentrantWorker {
    DuskEscrow public immutable e;
    bytes32 public id;
    uint256 public reentryAttempts;
    uint256 public reentrySuccesses;

    constructor(DuskEscrow _e) { e = _e; }

    function commit(bytes32 _id, bytes32 h, bytes calldata a) external { id = _id; e.commit(_id, h, a); }

    receive() external payable {
        reentryAttempts++;
        try e.settle(id) { reentrySuccesses++; } catch {}
        try e.refund(id) { reentrySuccesses++; } catch {}
        try e.commit(id, keccak256("again"), "") { reentrySuccesses++; } catch {}
    }
}

contract ReentrantBuyer {
    DuskEscrow public immutable e;
    bytes32 public id;
    uint256 public reentrySuccesses;

    constructor(DuskEscrow _e) { e = _e; }

    function fund(bytes32 _id, uint64 d) external payable { id = _id; e.fund{value: msg.value}(_id, d); }
    function refund() external { e.refund(id); }

    receive() external payable {
        try e.refund(id) { reentrySuccesses++; } catch {}
        try e.settle(id) { reentrySuccesses++; } catch {}
    }
}

contract ForceFeeder {
    constructor(address payable to) payable { selfdestruct(to); }
}

contract DuskEscrowAdversarialTest is Test {
    DuskEscrow escrow;

    uint256 buyerKey = 0xB0;
    uint256 workerKey = 0xA1;
    uint256 worker2Key = 0xA2;
    uint256 thiefKey = 0xBAD;
    uint256 buyerSybilKey = 0xB1;

    address buyer;
    address worker;
    address worker2;
    address thief;
    address buyerSybil;

    bytes32 ds;
    bytes32 th;

    bytes32 constant JOB = keccak256("job-1");
    bytes32 constant OUT = keccak256("output");
    uint256 constant AMOUNT = 8000;
    uint256 constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    function setUp() public {
        vm.warp(1_700_000_000);
        buyer = vm.addr(buyerKey);
        worker = vm.addr(workerKey);
        worker2 = vm.addr(worker2Key);
        thief = vm.addr(thiefKey);
        buyerSybil = vm.addr(buyerSybilKey);

        escrow = new DuskEscrow(IDuskAdmission(address(0)), 600, address(0xBEEF));
        ds = escrow.DOMAIN_SEPARATOR();
        th = escrow.AUTH_TYPEHASH();
        vm.deal(buyer, 10 ether);
        vm.deal(thief, 1 ether);
    }

    function _digest(bytes32 domain, bytes32 jobId, address w) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(th, jobId, w))));
    }

    function _auth(uint256 key, bytes32 jobId, address w) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _digest(ds, jobId, w));
        return abi.encodePacked(r, s, v);
    }

    function _fund(uint64 secs) internal returns (uint64 deadline) {
        deadline = uint64(block.timestamp) + secs;
        vm.prank(buyer);
        escrow.fund{value: AMOUNT}(JOB, deadline);
    }

    function _commitAs(address who) internal {
        bytes memory a = _auth(buyerKey, JOB, who);
        vm.prank(who);
        escrow.commit(JOB, OUT, a);
    }

    function _state(bytes32 id) internal view returns (DuskEscrow.State s) {
        (,,,,,, s) = escrow.deals(id);
    }

    function test_boundary_fundDeadlineEqualNow_reverts() public {
        vm.prank(buyer);
        vm.expectRevert(DuskEscrow.DeadlineInPast.selector);
        escrow.fund{value: AMOUNT}(JOB, uint64(block.timestamp));
    }

    function test_boundary_fundDeadlineNowPlusOne_ok() public {
        vm.prank(buyer);
        escrow.fund{value: AMOUNT}(JOB, uint64(block.timestamp) + 1);
        assertEq(uint8(_state(JOB)), uint8(DuskEscrow.State.Funded));
    }

    function testFuzz_boundary_commitXorRefund(uint32 secs, uint32 dt) public {
        secs = uint32(bound(secs, 1, 30 days));
        uint64 deadline = _fund(secs);
        vm.warp(block.timestamp + dt);
        bytes memory a = _auth(buyerKey, JOB, worker);

        uint256 snap = vm.snapshot();
        vm.prank(worker);
        (bool cOk,) = address(escrow).call(abi.encodeCall(escrow.commit, (JOB, OUT, a)));
        vm.revertTo(snap);
        vm.prank(buyer);
        (bool rOk,) = address(escrow).call(abi.encodeCall(escrow.refund, (JOB)));

        assertTrue(cOk != rOk, "exactly one of commit/refund must be live");
        assertEq(rOk, block.timestamp > deadline);
    }

    function testFuzz_fund_anyAmountAnyFutureDeadline(uint96 amount, uint64 deadline) public {
        vm.assume(amount > 0 && deadline > block.timestamp);
        vm.deal(buyer, amount);
        vm.prank(buyer);
        escrow.fund{value: amount}(JOB, deadline);
        (address b,, uint256 a,,, uint64 d,) = escrow.deals(JOB);
        assertEq(b, buyer);
        assertEq(a, amount);
        assertEq(d, deadline);
    }

    function test_state_none() public {
        vm.expectRevert(DuskEscrow.NotFunded.selector);
        escrow.commit(JOB, OUT, "");
        vm.warp(block.timestamp + 601);
        vm.expectRevert(DuskEscrow.NotCommitted.selector);
        escrow.settle(JOB);
        vm.expectRevert(DuskEscrow.NotFunded.selector);
        escrow.refund(JOB);
    }

    function test_state_funded_settleReverts() public {
        _fund(1 hours);
        vm.warp(block.timestamp + 601);
        vm.expectRevert(DuskEscrow.NotCommitted.selector);
        escrow.settle(JOB);
    }

    function test_state_committed_buyerHasNoExit() public {
        uint64 d = _fund(1 hours);
        _commitAs(worker);
        vm.warp(d + 365 days);
        vm.prank(buyer);
        vm.expectRevert(DuskEscrow.NotFunded.selector);
        escrow.refund(JOB);
        bytes memory a2 = _auth(buyerKey, JOB, worker2);
        vm.prank(worker2);
        vm.expectRevert(DuskEscrow.NotFunded.selector);
        escrow.commit(JOB, OUT, a2);
    }

    function test_state_settled_everythingReverts() public {
        _fund(1 hours);
        _commitAs(worker);
        vm.warp(block.timestamp + 601);
        escrow.settle(JOB);

        vm.warp(block.timestamp + 601);
        vm.expectRevert(DuskEscrow.NotCommitted.selector);
        escrow.settle(JOB);
        vm.prank(buyer);
        vm.expectRevert(DuskEscrow.NotFunded.selector);
        escrow.refund(JOB);
        bytes memory a = _auth(buyerKey, JOB, worker);
        vm.prank(worker);
        vm.expectRevert(DuskEscrow.NotFunded.selector);
        escrow.commit(JOB, OUT, a);
        vm.prank(buyer);
        vm.expectRevert(DuskEscrow.DealExists.selector);
        escrow.fund{value: 1}(JOB, uint64(block.timestamp) + 1 hours);
    }

    function test_state_refunded_everythingReverts_andIdIsBurned() public {
        uint64 d = _fund(1 hours);
        vm.warp(d + 1);
        vm.prank(buyer);
        escrow.refund(JOB);

        vm.prank(buyer);
        vm.expectRevert(DuskEscrow.NotFunded.selector);
        escrow.refund(JOB);
        vm.warp(block.timestamp + 601);
        vm.expectRevert(DuskEscrow.NotCommitted.selector);
        escrow.settle(JOB);
        vm.prank(buyer);
        vm.expectRevert(DuskEscrow.DealExists.selector);
        escrow.fund{value: 1}(JOB, uint64(block.timestamp) + 1 hours);
    }

    function test_sig_compact64ByteIsRejected() public {
        _fund(1 hours);
        bytes memory good = _auth(buyerKey, JOB, worker);
        bytes memory compact = new bytes(64);
        for (uint256 i = 0; i < 64; i++) compact[i] = good[i];
        vm.prank(worker);
        vm.expectRevert(DuskEscrow.BadSignature.selector);
        escrow.commit(JOB, OUT, compact);
    }

    function test_sig_66BytesIsRejected() public {
        _fund(1 hours);
        bytes memory padded = abi.encodePacked(_auth(buyerKey, JOB, worker), uint8(0));
        vm.prank(worker);
        vm.expectRevert(DuskEscrow.BadSignature.selector);
        escrow.commit(JOB, OUT, padded);
    }

    function test_sig_sJustAboveHalfNIsRejected() public {
        _fund(1 hours);
        bytes memory bad = abi.encodePacked(bytes32(uint256(1)), bytes32(HALF_N + 1), uint8(27));
        vm.prank(worker);
        vm.expectRevert(DuskEscrow.BadSignature.selector);
        escrow.commit(JOB, OUT, bad);
    }

    function test_sig_otherDeploymentDomainIsRejected() public {
        _fund(1 hours);
        DuskEscrow other = new DuskEscrow(IDuskAdmission(address(0)), 600, address(0xBEEF));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerKey, _digest(other.DOMAIN_SEPARATOR(), JOB, worker));
        bytes memory a = abi.encodePacked(r, s, v);
        vm.prank(worker);
        vm.expectRevert(DuskEscrow.NotAuthorised.selector);
        escrow.commit(JOB, OUT, a);
    }

    function test_sig_personalSignOfSameFieldsIsRejected() public {
        _fund(1 hours);
        bytes32 h = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", keccak256(abi.encode(JOB, worker)))
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerKey, h);
        bytes memory a = abi.encodePacked(r, s, v);
        vm.prank(worker);
        vm.expectRevert(DuskEscrow.NotAuthorised.selector);
        escrow.commit(JOB, OUT, a);
    }

    function testFuzz_sig_randomBytesNeverAuthorise(bytes32 r, bytes32 s, uint8 v, address caller) public {
        vm.assume(caller != buyer && caller != address(0));
        _fund(1 hours);
        bytes memory a = abi.encodePacked(r, s, v);
        vm.prank(caller);
        (bool ok,) = address(escrow).call(abi.encodeCall(escrow.commit, (JOB, OUT, a)));
        assertFalse(ok);
    }

    function testFuzz_sig_nonBuyerSignerNeverAuthorises(uint256 key, address w) public {
        key = bound(key, 1, N - 1);
        vm.assume(key != buyerKey && w != buyer && w != address(0));
        _fund(1 hours);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _digest(ds, JOB, w));
        bytes memory a = abi.encodePacked(r, s, v);
        vm.prank(w);
        (bool ok,) = address(escrow).call(abi.encodeCall(escrow.commit, (JOB, OUT, a)));
        assertFalse(ok);
    }

    function testFuzz_sig_authOnlyWorksForNamedCaller(address other) public {
        vm.assume(other != worker && other != buyer);
        _fund(1 hours);
        bytes memory a = _auth(buyerKey, JOB, worker);
        vm.prank(other);
        vm.expectRevert(DuskEscrow.NotAuthorised.selector);
        escrow.commit(JOB, OUT, a);
    }

    function test_frontrun_copyingPendingCommitFails() public {
        _fund(1 hours);
        bytes memory a = _auth(buyerKey, JOB, worker);
        vm.prank(thief);
        vm.expectRevert(DuskEscrow.NotAuthorised.selector);
        escrow.commit(JOB, OUT, a);
        vm.prank(worker);
        escrow.commit(JOB, OUT, a);
        (, address w,,,,,) = escrow.deals(JOB);
        assertEq(w, worker);
    }

    function test_sig_preSignedAuthWorksAfterFunding() public {
        bytes memory a = _auth(buyerKey, JOB, worker);
        _fund(1 hours);
        vm.prank(worker);
        escrow.commit(JOB, OUT, a);
        assertEq(uint8(_state(JOB)), uint8(DuskEscrow.State.Committed));
    }

    function testFuzz_settle_anyCallerAlwaysPaysWorker(address caller) public {
        vm.assume(caller != worker && caller != address(escrow));
        _fund(1 hours);
        _commitAs(worker);
        uint256 cb = caller.balance;
        vm.warp(block.timestamp + 601);
        vm.prank(caller);
        escrow.settle(JOB);
        assertEq(worker.balance, AMOUNT);
        assertEq(caller.balance, cb);
    }

    function test_settle_sameBlockAsCommit() public {
        _fund(1 hours);
        _commitAs(worker);
        vm.warp(block.timestamp + 601);
        escrow.settle(JOB);
        assertEq(worker.balance, AMOUNT);
    }

    function test_reentrancy_workerCannotDrainViaReceive() public {
        vm.prank(buyer);
        escrow.fund{value: AMOUNT}(keccak256("other"), uint64(block.timestamp) + 1 hours);
        _fund(1 hours);

        ReentrantWorker rw = new ReentrantWorker(escrow);
        bytes memory a = _auth(buyerKey, JOB, address(rw));
        rw.commit(JOB, OUT, a);
        vm.warp(block.timestamp + 601);
        escrow.settle(JOB);

        assertEq(address(rw).balance, AMOUNT, "paid exactly once");
        assertEq(rw.reentryAttempts(), 1);
        assertEq(rw.reentrySuccesses(), 0);
        assertEq(address(escrow).balance, AMOUNT, "other deal untouched");
    }

    function test_reentrancy_buyerCannotDoubleRefund() public {
        ReentrantBuyer rb = new ReentrantBuyer(escrow);
        uint64 d = uint64(block.timestamp) + 1 hours;
        rb.fund{value: AMOUNT}(JOB, d);
        vm.prank(buyer);
        escrow.fund{value: AMOUNT}(keccak256("other"), d);

        vm.warp(d + 1);
        rb.refund();
        assertEq(address(rb).balance, AMOUNT);
        assertEq(rb.reentrySuccesses(), 0);
        assertEq(address(escrow).balance, AMOUNT);
    }

    function test_eth_plainTransferBounces() public {
        (bool ok,) = address(escrow).call{value: 1}("");
        assertFalse(ok);
    }

    function test_eth_unknownSelectorReverts() public {
        (bool ok,) = address(escrow).call(abi.encodeWithSignature("withdraw(bytes32)", JOB));
        assertFalse(ok);
        (ok,) = address(escrow).call(abi.encodeWithSignature("challenge(bytes32)", JOB));
        assertFalse(ok);
    }

    function test_eth_forceFedEthDoesNotChangePayouts() public {
        _fund(1 hours);
        new ForceFeeder{value: 5 ether}(payable(address(escrow)));
        _commitAs(worker);
        vm.warp(block.timestamp + 601);
        escrow.settle(JOB);
        assertEq(worker.balance, AMOUNT, "pays the deal amount, not the balance");
        assertEq(address(escrow).balance, 5 ether, "force-fed ETH is permanently stranded");
    }

    function test_isolation_dealsAreIndependent() public {
        bytes32 a = keccak256("a");
        bytes32 b = keccak256("b");
        uint64 d = uint64(block.timestamp) + 1 hours;
        vm.startPrank(buyer);
        escrow.fund{value: 100}(a, d);
        escrow.fund{value: 200}(b, d);
        vm.stopPrank();

        bytes memory auth = _auth(buyerKey, a, worker);
        vm.prank(worker);
        escrow.commit(a, OUT, auth);
        vm.warp(block.timestamp + 601);
        escrow.settle(a);

        assertEq(address(escrow).balance, 200);
        assertEq(uint8(_state(b)), uint8(DuskEscrow.State.Funded));
    }

    function test_LOOPHOLE_buyerSybilCancelsEarlyAndStiffsWorker() public {
        _fund(1 hours);
        bytes memory honest = _auth(buyerKey, JOB, worker);

        bytes memory sybil = _auth(buyerKey, JOB, buyerSybil);
        vm.prank(buyerSybil);
        escrow.commit(JOB, keccak256("cancel"), sybil);
        vm.warp(block.timestamp + 601);
        escrow.settle(JOB);

        vm.prank(worker);
        vm.expectRevert(DuskEscrow.NotFunded.selector);
        escrow.commit(JOB, OUT, honest);

        assertEq(buyerSybil.balance, AMOUNT, "buyer has its money back, pre-deadline");
        assertEq(worker.balance, 0);
    }

    function test_LOOPHOLE_authorisedWorkerPaidForJunkInstantly() public {
        _fund(1 hours);
        bytes memory a = _auth(buyerKey, JOB, worker);
        vm.prank(worker);
        escrow.commit(JOB, bytes32(uint256(1)), a);
        vm.warp(block.timestamp + 601);
        escrow.settle(JOB);
        assertEq(worker.balance, AMOUNT);
    }

    function test_LOOPHOLE_multipleAuthsOnlyOnePaid() public {
        _fund(1 hours);
        bytes memory a1 = _auth(buyerKey, JOB, worker);
        bytes memory a2 = _auth(buyerKey, JOB, worker2);
        vm.prank(worker2);
        escrow.commit(JOB, OUT, a2);
        vm.prank(worker);
        vm.expectRevert(DuskEscrow.NotFunded.selector);
        escrow.commit(JOB, OUT, a1);
    }

    function test_LOOPHOLE_badAuthOnlyDetectedAtCommit() public {
        _fund(1 hours);
        bytes memory wrongJob = _auth(buyerKey, keccak256("some other job"), worker);
        vm.prank(worker);
        vm.expectRevert(DuskEscrow.NotAuthorised.selector);
        escrow.commit(JOB, OUT, wrongJob);
    }

    function test_LOOPHOLE_jobIdSquatBlocksBuyer() public {
        uint64 d = uint64(block.timestamp) + 1 hours;
        vm.prank(thief);
        escrow.fund{value: 1}(JOB, d);
        vm.prank(buyer);
        vm.expectRevert(DuskEscrow.DealExists.selector);
        escrow.fund{value: AMOUNT}(JOB, d);
    }

    function test_LOOPHOLE_rejectingWorkerLocksFundsForever() public {
        _fund(1 hours);
        Rejecter r = new Rejecter();
        bytes memory a = _auth(buyerKey, JOB, address(r));
        r.commit(escrow, JOB, OUT, a);
        vm.warp(block.timestamp + 365 days);

        vm.warp(block.timestamp + 601);
        vm.expectRevert(DuskEscrow.TransferFailed.selector);
        escrow.settle(JOB);
        vm.prank(buyer);
        vm.expectRevert(DuskEscrow.NotFunded.selector);
        escrow.refund(JOB);
        assertEq(address(escrow).balance, AMOUNT, "stuck");
    }

    function test_LOOPHOLE_millisecondDeadlineLocksFunds() public {
        vm.prank(buyer);
        escrow.fund{value: AMOUNT}(JOB, uint64(block.timestamp) * 1000);
        vm.warp(block.timestamp + 10 * 365 days);
        vm.prank(buyer);
        vm.expectRevert(DuskEscrow.DeadlineNotReached.selector);
        escrow.refund(JOB);
    }

    function test_LOOPHOLE_contractBuyerCanNeverAuthorise() public {
        ReentrantBuyer cb = new ReentrantBuyer(escrow);
        cb.fund{value: AMOUNT}(JOB, uint64(block.timestamp) + 1 hours);
        bytes memory a = _auth(buyerKey, JOB, worker);
        vm.prank(worker);
        vm.expectRevert(DuskEscrow.NotAuthorised.selector);
        escrow.commit(JOB, OUT, a);
    }

    function test_LOOPHOLE_unnormalisedVIsRejected() public {
        _fund(1 hours);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerKey, _digest(ds, JOB, worker));
        bytes memory a = abi.encodePacked(r, s, v - 27);
        vm.prank(worker);
        vm.expectRevert(DuskEscrow.BadSignature.selector);
        escrow.commit(JOB, OUT, a);
    }

    function test_LOOPHOLE_cachedDomainSurvivesChainIdChange() public {
        _fund(1 hours);
        bytes memory a = _auth(buyerKey, JOB, worker);
        vm.chainId(block.chainid + 1);
        vm.prank(worker);
        escrow.commit(JOB, OUT, a);
        assertEq(uint8(_state(JOB)), uint8(DuskEscrow.State.Committed));
    }

    function test_LOOPHOLE_rejectingBuyerLocksOwnFunds() public {
        Rejecter r = new Rejecter();
        uint64 d = uint64(block.timestamp) + 1 hours;
        r.fund{value: AMOUNT}(escrow, JOB, d);
        vm.warp(d + 1);
        vm.expectRevert(DuskEscrow.TransferFailed.selector);
        r.refund(escrow, JOB);
        assertEq(address(escrow).balance, AMOUNT);
    }
}

contract Handler is Test {
    DuskEscrow public immutable escrow;
    bytes32 immutable ds;
    bytes32 immutable th;

    uint256[] keys;
    address[] public actors;
    bytes32[] public ids;

    uint256 public ghostIn;
    uint256 public ghostOut;
    uint256 public ghostTerminalMutations;
    uint256 public ghostUnauthorisedCommits;

    constructor(DuskEscrow _e) {
        escrow = _e;
        ds = _e.DOMAIN_SEPARATOR();
        th = _e.AUTH_TYPEHASH();
        for (uint256 i = 1; i <= 4; i++) {
            keys.push(0x1000 + i);
            address a = vm.addr(0x1000 + i);
            vm.deal(a, 1_000 ether);
            actors.push(a);
        }
        for (uint256 i = 0; i < 6; i++) ids.push(keccak256(abi.encodePacked("id", i)));
    }

    function idCount() external view returns (uint256) { return ids.length; }

    function _st(bytes32 id) internal view returns (DuskEscrow.State s) { (,,,,,, s) = escrow.deals(id); }

    function _terminal(DuskEscrow.State s) internal pure returns (bool) {
        return s == DuskEscrow.State.Settled || s == DuskEscrow.State.Refunded;
    }

    function fund(uint256 a, uint256 i, uint256 amt, uint32 dt) external {
        bytes32 id = ids[i % ids.length];
        amt = bound(amt, 1, 10 ether);
        uint64 d = uint64(block.timestamp) + uint64(bound(dt, 1, 2 hours));
        vm.prank(actors[a % actors.length]);
        try escrow.fund{value: amt}(id, d) { ghostIn += amt; } catch {}
    }

    function commit(uint256 w, uint256 s, uint256 named, uint256 i, bytes32 h) external {
        bytes32 id = ids[i % ids.length];
        address caller = actors[w % actors.length];
        address namedAddr = actors[named % actors.length];
        uint256 signerKey = keys[s % keys.length];
        (address buyer,,,,,,) = escrow.deals(id);
        DuskEscrow.State before = _st(id);

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ds, keccak256(abi.encode(th, id, namedAddr))));
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(signerKey, digest);
        bytes memory auth = abi.encodePacked(r, ss, v);

        vm.prank(caller);
        try escrow.commit(id, h, auth) {
            bool legit = vm.addr(signerKey) == buyer && namedAddr == caller && caller != buyer && h != 0;
            if (!legit) ghostUnauthorisedCommits++;
        } catch {}
        if (_terminal(before) && _st(id) != before) ghostTerminalMutations++;
    }

    function settle(uint256 a, uint256 i) external {
        bytes32 id = ids[i % ids.length];
        DuskEscrow.State before = _st(id);
        (,, uint256 amt,,,,) = escrow.deals(id);
        vm.prank(actors[a % actors.length]);
        try escrow.settle(id) { ghostOut += amt; } catch {}
        if (_terminal(before) && _st(id) != before) ghostTerminalMutations++;
    }

    function refund(uint256 a, uint256 i) external {
        bytes32 id = ids[i % ids.length];
        DuskEscrow.State before = _st(id);
        (,, uint256 amt,,,,) = escrow.deals(id);
        vm.prank(actors[a % actors.length]);
        try escrow.refund(id) { ghostOut += amt; } catch {}
        if (_terminal(before) && _st(id) != before) ghostTerminalMutations++;
    }

    function warp(uint32 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 2 hours));
    }
}

contract DuskEscrowInvariantTest is StdInvariant, Test {
    DuskEscrow escrow;
    Handler handler;

    function setUp() public {
        vm.warp(1_700_000_000);
        escrow = new DuskEscrow(IDuskAdmission(address(0)), 600, address(0xBEEF));
        handler = new Handler(escrow);
        targetContract(address(handler));
    }

    function invariant_solvency() public view {
        uint256 owed;
        for (uint256 i = 0; i < handler.idCount(); i++) {
            (,, uint256 amt,,,, DuskEscrow.State s) = escrow.deals(handler.ids(i));
            if (s == DuskEscrow.State.Funded || s == DuskEscrow.State.Committed) owed += amt;
            else assertEq(amt, 0, "terminal or empty deal holds an amount");
        }
        assertEq(address(escrow).balance, owed);
        assertEq(handler.ghostIn() - handler.ghostOut(), owed);
    }

    function invariant_terminalStatesAreFinal() public view {
        assertEq(handler.ghostTerminalMutations(), 0);
    }

    function invariant_onlyAuthorisedCommits() public view {
        assertEq(handler.ghostUnauthorisedCommits(), 0);
    }

    function invariant_dealShape() public view {
        for (uint256 i = 0; i < handler.idCount(); i++) {
            (address b, address w,, bytes32 h, uint64 c,, DuskEscrow.State s) = escrow.deals(handler.ids(i));
            if (s != DuskEscrow.State.None) assertTrue(b != address(0));
            if (s == DuskEscrow.State.Funded) assertEq(w, address(0));
            if (s == DuskEscrow.State.Committed || s == DuskEscrow.State.Settled) {
                assertTrue(w != address(0) && w != b, "worker set and never the buyer");
                assertTrue(h != bytes32(0));
                assertTrue(c != 0);
            }
        }
    }
}
