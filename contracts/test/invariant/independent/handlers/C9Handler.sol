// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.35;

import {Vm} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IEscrow, IEscrowEvents, Quote, Cutoff, Booking, BookingState} from "../../../../src/interfaces/IEscrow.sol";
import {C9Base, IEscrowViews, IFactoryAdmin} from "../C9Base.sol";

/// @notice C9 handler. Drives the real factory + escrow through random sequences of guest, owner,
/// guardian, arbitrator, rebalancer, factoryAdmin and attacker actions, and keeps a ghost ledger
/// computed only from the spec's formulas (4.3, 4.4, 6.1, 6.3, 6.4, 7 and ADRs 0007, 0009, 0010,
/// 0011) and from external facts (token and vault balances). The ghost never reads escrow
/// accounting state.
///
/// Every escrow call is predicted before it is made: MUST_OK, MUST_REVERT or EITHER (EITHER is used
/// only where the spec leaves the outcome open; each use is listed in docs/handoffs/C9.md). A call
/// that succeeds when the spec says it must revert, or reverts when the spec says it must succeed,
/// is recorded as a violation under a property key. Handlers never revert, so invariant functions
/// and `afterInvariant` read the violation counters.
contract C9Handler is C9Base {
    uint8 internal constant MUST_OK = 1;
    uint8 internal constant MUST_REVERT = 2;
    uint8 internal constant EITHER = 3;

    uint8 internal constant S_ESCROWED = 1;
    uint8 internal constant S_DELIVERED = 2;
    uint8 internal constant S_FROZEN = 3;
    uint8 internal constant S_DISPUTED = 4;
    uint8 internal constant S_SETTLED = 5;

    uint8 internal constant O_COMPLETED = 0;
    uint8 internal constant O_CANCEL_GUEST = 1;
    uint8 internal constant O_CANCEL_PROPERTY = 2;

    // violation keys (property numbers from briefs/C9-independent-invariants.md)
    bytes32 public constant K_P2 = "P2_settlementEqualities";
    bytes32 public constant K_P3 = "P3_credits";
    bytes32 public constant K_P4 = "P4_yield";
    bytes32 public constant K_P5 = "P5_terms";
    bytes32 public constant K_P6 = "P6_recipients";
    bytes32 public constant K_P7 = "P7_lossGate";
    bytes32 public constant K_P8 = "P8_quoteTerms";
    bytes32 public constant K_P9 = "P9_arbitrator";
    bytes32 public constant K_P10 = "P10_rebalancer";
    bytes32 public constant K_P11 = "P11_liveness";
    bytes32 public constant K_AUTH = "SM_unexpectedSuccess";
    bytes32 public constant K_LIVE = "LIVE_unexpectedRevert";
    bytes32 public constant K_CLAIM = "CLAIM_amount";
    bytes32 public constant K_AMBIG = "AMBIGUITY_observed"; // informational only
    bytes32 public constant K_RULE4 = "RULE4_accrueFirst";

    struct Ledger {
        uint256 lastAssets;
        uint256 lossDebt;
        uint256 acc;
        uint256 reserve;
        uint256 unalloc;
        uint256 open;
        uint256 disputed;
        uint256 pendDisp; // yield crystallised by open disputes
        uint256 ownerCl;
        uint256 pendO;
        uint256 since; // shortfall observation start (0 = none)
        uint256 gainDist; // cumulative gain distributed by accrue (acc + reserve)
    }

    struct GB {
        bytes32 id;
        address guest;
        bytes32 resourceId;
        uint40 checkIn;
        uint40 checkOut;
        uint256 principal;
        uint16 feeBps;
        uint16 gyBps;
        uint16 finalBps;
        address arb;
        uint256 accAtDep;
        uint8 st;
        uint8 frozenFrom;
        uint40 frozenSince;
        uint32 frozenTotal;
        uint256 contested;
        uint256 dispY;
        uint40 openedAt;
        uint32 frozenAtOpen;
    }

    struct QS {
        bytes32 resourceId;
        uint40 ci;
        uint40 co;
        uint256 price;
        uint16 fee;
        uint16 gy;
        bytes32 policy;
        uint16 finalBps;
        address guest;
        uint40 exp;
        bytes32 salt;
    }

    /// Settlement figures (spec 4.4), laid out to decode the tail of BookingSettled/DisputeResolved.
    struct Fig {
        uint256 refund;
        uint256 ownerPrin;
        uint256 fee;
        uint256 y;
        uint256 gY;
        uint256 oY;
        address feeRecipient;
    }

    Ledger internal L;
    GB[] internal gb;
    mapping(uint256 => Cutoff[]) internal gCut;
    mapping(bytes32 => bool) internal gExists;
    QS[] internal stash;
    mapping(uint256 => Cutoff[]) internal stashCut;
    uint256 internal nonce;

    // ghost configuration
    uint16 internal gFee = ESCROW_FEE;
    uint16 internal gPendFee;
    uint64 internal gPendFeeAt;
    address internal gArb;
    address internal gPendArb;
    uint64 internal gPendArbAt;
    address internal gRecip;
    address internal gPendRecip;
    uint64 internal gPendRecipAt;
    uint16 internal gGy = 5_000; // spec 13 default
    uint16 internal gMaxDeploy = 9_000; // spec 13 default
    address internal gPayout;
    bool internal gPaused;
    bool internal gResSet;
    uint256 internal gResAmt;
    uint8 internal gResReason;

    // ghost buckets
    mapping(address => uint256) internal gCl;
    mapping(address => uint256) internal pendG;
    mapping(address => uint256) internal feeCl;
    mapping(address => uint256) public cumG; // cumulative credited to guest claim bucket
    mapping(address => uint256) public cumFee;
    uint256 public cumOwnerPaid;
    uint256 public cumReservePaid;

    // external facts and event sums
    uint256 public extGain; // measured increases of escrow assets from injected gains and donations
    uint256 public evGain; // sum of YieldAccrued.gain
    bool public lossInjected;

    // bookkeeping
    mapping(bytes32 => uint256) public viol;
    mapping(bytes32 => string) public firstMsg;
    mapping(bytes32 => uint256) public okCount;
    uint256 public calls;

    constructor() {
        _deployAll();
        gArb = arbA1;
        gRecip = feeR1;
        gPayout = payout1;
        L.lastAssets = _assets();
        usdc.setAdmin(address(this), true);
    }

    // =====================================================================================
    // public getters for the invariant contract
    // =====================================================================================

    function escrowAddr() external view returns (address) {
        return escAddr;
    }

    function tokenAddr() external view returns (address) {
        return address(usdc);
    }

    function vaultAddr() external view returns (address) {
        return address(vault);
    }

    function factoryAddr() external view returns (address) {
        return address(factory);
    }

    function bookingCount() external view returns (uint256) {
        return gb.length;
    }

    function ledger() external view returns (Ledger memory) {
        return L;
    }

    function guestAt(uint256 i) external view returns (address) {
        return guests[i];
    }

    function roles() external view returns (address, address, address, address, address, address) {
        return (payout1, payout2, feeR1, feeR2, rebalancer, attacker);
    }

    function ghostBuckets(address a) external view returns (uint256 cl, uint256 pend, uint256 fee) {
        return (gCl[a], pendG[a], feeCl[a]);
    }

    function effFee() public view returns (uint16) {
        return (gPendFeeAt != 0 && block.timestamp >= gPendFeeAt) ? gPendFee : gFee;
    }

    function effArb() public view returns (address) {
        return (gPendArbAt != 0 && block.timestamp >= gPendArbAt) ? gPendArb : gArb;
    }

    function effRecip() public view returns (address) {
        return (gPendRecipAt != 0 && block.timestamp >= gPendRecipAt) ? gPendRecip : gRecip;
    }

    function ghostConfig() external view returns (uint16 gy, uint16 maxDeploy, address payout, bool paused_) {
        return (gGy, gMaxDeploy, gPayout, gPaused);
    }

    function totalsModel()
        public
        view
        returns (uint256 claimable, uint256 pending, uint256 guestPrincipalSide)
    {
        for (uint256 i; i < 4; i++) {
            claimable += gCl[guests[i]];
            pending += pendG[guests[i]];
        }
        guestPrincipalSide = claimable;
        claimable += L.ownerCl + feeCl[feeR1] + feeCl[feeR2];
        pending += L.pendO + L.pendDisp;
    }

    /// @dev Compares every stored term of booking `i` with the ghost copy taken at deposit (spec 4.2, 5).
    function termsMismatch(uint256 i) external view returns (string memory) {
        GB storage b = gb[i];
        Booking memory k = esc.getBooking(b.id);
        if (k.guest != b.guest) return "guest";
        if (k.checkInUtc != b.checkIn || k.checkOutUtc != b.checkOut) return "dates";
        if (k.feeBps != b.feeBps) return "feeBps";
        if (k.guestYieldBps != b.gyBps) return "guestYieldBps";
        if (k.finalBps != b.finalBps) return "finalBps";
        if (k.arbitrator != b.arb) return "arbitrator";
        if (k.resourceId != b.resourceId) return "resourceId";
        if (k.principalAtomic != b.principal) return "principal";
        if (k.accAtDeposit != b.accAtDep) return "accAtDeposit";
        Cutoff[] memory cs = esc.getCutoffs(b.id);
        if (cs.length != gCut[i].length) return "cutoffs.length";
        for (uint256 j; j < cs.length; j++) {
            if (cs[j].cutoffUtc != gCut[i][j].cutoffUtc || cs[j].refundBps != gCut[i][j].refundBps) {
                return "cutoffs";
            }
        }
        return "";
    }

    /// @dev Ghost state as the spec's derived state (DELIVERED from time), for comparison with bookingState().
    function ghostState(uint256 i) external view returns (bytes32 id, uint8 st) {
        GB storage b = gb[i];
        st = b.st;
        if (st == S_ESCROWED && block.timestamp >= b.checkOut) st = S_DELIVERED;
        return (b.id, st);
    }

    function ghostDeadline(uint256 i) public view returns (uint256) {
        GB storage b = gb[i];
        return uint256(b.openedAt) + DISPUTE_WINDOW + (b.frozenTotal - b.frozenAtOpen);
    }

    function ghostDisputed(uint256 i) external view returns (bool) {
        return gb[i].st == S_DISPUTED || (gb[i].st == S_FROZEN && gb[i].frozenFrom == S_DISPUTED);
    }

    function ghostRefundBps(uint256 i) external view returns (bool live, uint16 bps) {
        GB storage b = gb[i];
        if (b.st != S_ESCROWED || block.timestamp >= b.checkOut) return (false, 0);
        return (true, _refundBps(i));
    }

    // =====================================================================================
    // model primitives
    // =====================================================================================

    function _assets() internal view returns (uint256) {
        return _assetsOf(escAddr);
    }

    /// Spec 6.1 accrue() with ADR 0009 (high-water mark) and ADR 0010 section 4 (1 USDC threshold).
    function _accrue(uint256 a) internal {
        if (a > L.lastAssets) {
            uint256 d = a - L.lastAssets;
            uint256 r = d < L.lossDebt ? d : L.lossDebt;
            L.lossDebt -= r;
            d -= r;
            if (d > 0) {
                if (L.open == 0) {
                    L.reserve += d;
                } else {
                    L.acc += d * 1e18 / L.open;
                    L.unalloc += d;
                }
                L.gainDist += d;
            }
            L.lastAssets = a;
        }
        uint256 sf = L.lastAssets > a ? L.lastAssets - a : 0;
        if (sf >= MIN_LOSS) {
            if (L.since == 0) L.since = block.timestamp;
        } else {
            L.since = 0;
        }
    }

    function _gate(uint256 a) internal view returns (bool) {
        return L.lossDebt > 0 || (L.lastAssets > a && L.lastAssets - a >= MIN_LOSS);
    }

    function _refundBps(uint256 i) internal view returns (uint16) {
        GB storage b = gb[i];
        if (block.timestamp >= b.checkIn) return b.finalBps;
        Cutoff[] storage cs = gCut[i];
        for (uint256 j; j < cs.length; j++) {
            if (block.timestamp < cs[j].cutoffUtc) return cs[j].refundBps;
        }
        return b.finalBps;
    }

    function _flag(bytes32 k, string memory m) internal {
        if (viol[k] == 0) firstMsg[k] = string.concat(m, " @t=", vm.toString(block.timestamp));
        viol[k]++;
    }

    function _judge(bytes32 kSucc, string memory tag, uint8 pred, bool ok, bytes memory ret) internal {
        calls++;
        if (ok) okCount[keccak256(bytes(tag))]++;
        if (ok && pred == MUST_REVERT) _flag(kSucc, string.concat(tag, ": succeeded, spec says revert"));
        if (!ok && pred == MUST_OK) {
            _flag(K_LIVE, string.concat(tag, ": reverted, spec says succeed; data=", vm.toString(ret)));
        }
    }

    function _count(string memory tag) internal {
        okCount[keccak256(bytes(tag))]++;
    }

    function okCountOf(string memory tag) external view returns (uint256) {
        return okCount[keccak256(bytes(tag))];
    }

    /// Calls the escrow as `caller`, recording logs; folds YieldAccrued gains into `evGain`.
    function _call(address caller, bytes memory data)
        internal
        returns (bool ok, bytes memory ret, Vm.Log[] memory logs)
    {
        vm.recordLogs();
        vm.prank(caller);
        (ok, ret) = escAddr.call(data);
        logs = vm.getRecordedLogs();
        if (!ok) return (ok, ret, logs);
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter == escAddr && logs[i].topics[0] == IEscrowEvents.YieldAccrued.selector) {
                (uint256 g,,) = abi.decode(logs[i].data, (uint256, uint256, uint256));
                evGain += g;
            }
        }
    }

    function _creditGuest(address g, uint256 amt) internal {
        gCl[g] += amt;
        cumG[g] += amt;
    }

    function _creditFee(address r, uint256 amt) internal {
        feeCl[r] += amt;
        cumFee[r] += amt;
    }

    function _pick(uint256 idx) internal view returns (uint256) {
        return idx % gb.length;
    }

    // =====================================================================================
    // quotes
    // =====================================================================================

    function _h(uint256 seed, uint256 salt) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(seed, salt)));
    }

    function _makeQuote(uint256 gi, uint256 seed) internal returns (Quote memory q) {
        uint256 lead = _bound(_h(seed, 1), 1 hours, 40 days);
        uint256 nights = 1 + _h(seed, 2) % 14;
        if (_h(seed, 2) % 25 == 0) nights = 15 + _h(seed, 3) % 46; // up to MAX_NIGHTS
        q.checkInUtc = uint40(block.timestamp + lead);
        uint256 trim = _h(seed, 4) % 2 == 0 ? 0 : _h(seed, 4) % 12 hours; // partial last day, same nights
        q.checkOutUtc = uint40(uint256(q.checkInUtc) + nights * 1 days - trim);
        q.priceAtomic = MIN_NIGHTLY * nights + _h(seed, 5) % (2_000e6 * nights);
        q.feeBps = effFee();
        q.guestYieldBps = gGy;
        q.policyHash = keccak256(abi.encode("policy", seed % 5));
        q.resourceId = keccak256("villa-crete");
        q.guest = guests[gi];
        q.expiresAt = uint40(block.timestamp + 25 minutes + _h(seed, 6) % 1 days);
        q.salt = keccak256(abi.encode(seed, ++nonce));
        uint256 n = 1 + _h(seed, 7) % 3;
        q.cutoffs = new Cutoff[](n);
        uint256 span = lead / (n + 1);
        uint256 r = 10_000 - (_h(seed, 8) % 3) * 2_500;
        for (uint256 k; k < n; k++) {
            q.cutoffs[k] = Cutoff(uint40(block.timestamp + span * (k + 1)), uint16(r));
            r = r * (_h(seed, 9 + k) % 101) / 100;
        }
        q.finalBps = uint16(uint256(q.cutoffs[n - 1].refundBps) * (_h(seed, 20) % 101) / 100);
    }

    /// Corruption kinds 8..15; each makes a spec 4.2 guard fail.
    function _corrupt(Quote memory q, uint8 kind) internal view {
        if (kind == 8) q.feeBps = q.feeBps + 1; // guard 9
        if (kind == 9) q.guestYieldBps = q.guestYieldBps == 10_000 ? 9_999 : q.guestYieldBps + 1; // guard 10
        if (kind == 10) {
            uint256 nights = Math.ceilDiv(uint256(q.checkOutUtc - q.checkInUtc), 1 days);
            q.priceAtomic = MIN_NIGHTLY * nights - 1; // guard 8
        }
        if (kind == 13) q.expiresAt = uint40(block.timestamp - 1); // guard 3
        if (kind == 14) q.cutoffs[q.cutoffs.length - 1].cutoffUtc = q.checkInUtc; // guard 11
        if (kind == 15) {
            q.checkOutUtc = q.checkInUtc + uint40(MAX_NIGHTS * 1 days + 1); // guard 7
            q.priceAtomic = MIN_NIGHTLY * (MAX_NIGHTS + 1);
        }
    }

    function _predictDeposit(Quote memory q, address sender, uint256 preDebt) internal view returns (uint8) {
        if (sender != q.guest) return MUST_REVERT;
        if (block.timestamp > q.expiresAt) return MUST_REVERT;
        if (gExists[_hashStruct(q)]) return MUST_REVERT;
        if (gPaused) return MUST_REVERT;
        if (block.timestamp >= q.checkInUtc || q.checkInUtc >= q.checkOutUtc) return MUST_REVERT;
        uint256 nights = Math.ceilDiv(uint256(q.checkOutUtc - q.checkInUtc), 1 days);
        if (nights == 0 || nights > MAX_NIGHTS) return MUST_REVERT;
        if (q.priceAtomic < MIN_NIGHTLY * nights) return MUST_REVERT;
        if (q.feeBps != effFee()) return MUST_REVERT;
        if (q.guestYieldBps != gGy) return MUST_REVERT;
        if (L.open + q.priceAtomic > CAP) return MUST_REVERT;
        if (usdc.blacklisted(q.guest)) return MUST_REVERT;
        // guard 5 precedes accrue() in spec 4.2's order; accrue may repay the debt first (rule 4)
        if (preDebt > 0) return L.lossDebt > 0 ? MUST_REVERT : EITHER;
        return MUST_OK;
    }

    // =====================================================================================
    // guest actions
    // =====================================================================================

    /// mode % 16: 0-4 allowance path, 5-6 permit path, 7 permit path front-run by the attacker,
    /// 8-15 a corrupted quote or caller (must revert).
    function guestDeposit(uint256 seed, uint8 mode) external {
        uint256 gi = seed % 4;
        Quote memory q = _makeQuote(gi, seed);
        uint8 kind = mode % 16;
        if (kind >= 8) _corrupt(q, kind);
        uint256 pk = kind == 11 ? attackerPk : signerPk; // guard 1
        bytes memory sig = _signQuote(pk, escAddr, q);
        address sender = kind == 12 ? attacker : q.guest; // guard 2
        _submit(q, sig, sender, kind, gi);
    }

    /// Aliases so the uniform selector choice books more often than it warps.
    function guestDepositB(uint256 seed, uint8 mode) external {
        this.guestDeposit(seed, mode % 8);
    }

    function guestDepositC(uint256 seed) external {
        this.guestDeposit(seed, 0);
    }

    function stashQuote(uint256 seed) external {
        if (stash.length >= 12) return;
        Quote memory q = _makeQuote(seed % 4, seed);
        stash.push(
            QS(
                q.resourceId,
                q.checkInUtc,
                q.checkOutUtc,
                q.priceAtomic,
                q.feeBps,
                q.guestYieldBps,
                q.policyHash,
                q.finalBps,
                q.guest,
                q.expiresAt,
                q.salt
            )
        );
        for (uint256 k; k < q.cutoffs.length; k++) {
            stashCut[stash.length - 1].push(q.cutoffs[k]);
        }
    }

    /// Deposits a quote signed in an earlier step: exercises stale fee / split / expiry / replay (4.2).
    function depositStashed(uint256 idx) external {
        if (stash.length == 0) return;
        uint256 i = idx % stash.length;
        QS storage s = stash[i];
        Quote memory q;
        q.resourceId = s.resourceId;
        q.checkInUtc = s.ci;
        q.checkOutUtc = s.co;
        q.priceAtomic = s.price;
        q.feeBps = s.fee;
        q.guestYieldBps = s.gy;
        q.policyHash = s.policy;
        q.finalBps = s.finalBps;
        q.guest = s.guest;
        q.expiresAt = s.exp;
        q.salt = s.salt;
        q.cutoffs = stashCut[i];
        uint256 gi;
        for (uint256 k; k < 4; k++) {
            if (guests[k] == q.guest) gi = k;
        }
        _submit(q, _signQuote(signerPk, escAddr, q), q.guest, 0, gi);
    }

    function _submit(Quote memory q, bytes memory sig, address sender, uint8 kind, uint256 gi) internal {
        Ledger memory saved = L;
        uint256 preDebt = L.lossDebt;
        _accrue(_assets());
        uint8 pred = kind >= 8 ? MUST_REVERT : _predictDeposit(q, sender, preDebt);
        bytes memory data;
        if (kind >= 5 && kind <= 7) {
            data = _permitData(q, sig, gi, kind == 7);
        } else {
            vm.prank(sender);
            usdc.approve(escAddr, q.priceAtomic);
            data = abi.encodeCall(IEscrow.deposit, (q, sig));
        }
        (bool ok, bytes memory ret,) = _call(sender, data);
        _judge(K_AUTH, kind >= 5 && kind <= 7 ? "depositWithPermit" : "deposit", pred, ok, ret);
        if (!ok) {
            if (q.feeBps != effFee() || q.guestYieldBps != gGy) _count("rejected:feeOrSplitMismatch");
            if (L.lossDebt > 0) _count("rejected:depositDuringLossDebt");
            L = saved;
            return;
        }
        if (kind == 7) _count("ok:permitFrontRunDeposit");
        if (L.since != 0) _count("ok:depositDuringShortfall");
        if (q.feeBps != effFee() || q.guestYieldBps != gGy) _flag(K_P8, "deposit with non-live fee/split");
        if (preDebt > 0 && L.lossDebt > 0) _flag(K_P7, "deposit while lossDebt > 0");
        _recordBooking(q, abi.decode(ret, (bytes32)));
    }

    function _permitData(Quote memory q, bytes memory sig, uint256 gi, bool frontRun)
        internal
        returns (bytes memory)
    {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                q.guest,
                escAddr,
                q.priceAtomic,
                usdc.nonces(q.guest),
                deadline
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(guestPks[gi], keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
        if (frontRun) {
            // the attacker lands the guest's permit first (spec 4.2: must not grief the deposit)
            vm.prank(attacker);
            try usdc.permit(q.guest, escAddr, q.priceAtomic, deadline, v, r, s) {} catch {}
        }
        return abi.encodeCall(IEscrow.depositWithPermit, (q, sig, deadline, v, r, s));
    }

    function _recordBooking(Quote memory q, bytes32 id) internal {
        if (id != _hashStruct(q)) _flag(K_P5, "bookingId != EIP-712 hashStruct(quote)");
        gExists[id] = true;
        L.open += q.priceAtomic;
        L.lastAssets += q.priceAtomic;
        gb.push();
        uint256 i = gb.length - 1;
        GB storage b = gb[i];
        b.id = id;
        b.guest = q.guest;
        b.resourceId = q.resourceId;
        b.checkIn = q.checkInUtc;
        b.checkOut = q.checkOutUtc;
        b.principal = q.priceAtomic;
        b.feeBps = q.feeBps;
        b.gyBps = q.guestYieldBps;
        b.finalBps = q.finalBps;
        b.arb = effArb();
        b.accAtDep = L.acc;
        b.st = S_ESCROWED;
        for (uint256 k; k < q.cutoffs.length; k++) {
            gCut[i].push(q.cutoffs[k]);
        }
        if (esc.getBooking(id).accAtDeposit != L.acc) _flag(K_P4, "accAtDeposit != accumulator at deposit");
    }

    /// Prefers a booking in state s1 or s2 (3 times in 4), so state-dependent paths are reached; the
    /// fourth pick is uniform so calls on bookings in the wrong state are fuzzed too.
    function _pickState(uint256 idx, uint8 s1, uint8 s2) internal view returns (uint256) {
        uint256 n = gb.length;
        if (idx % 4 == 0) return idx % n;
        for (uint256 k; k < n; k++) {
            uint256 j = (idx % n + k) % n;
            if (gb[j].st == s1 || gb[j].st == s2) return j;
        }
        return idx % n;
    }

    function guestCancel(uint256 idx, bool asAttacker) external {
        if (gb.length == 0) return;
        uint256 i = _pickState(idx, S_ESCROWED, S_ESCROWED);
        GB storage b = gb[i];
        address caller = asAttacker ? attacker : b.guest;
        uint8 pred = MUST_OK;
        if (caller != b.guest || b.st != S_ESCROWED || block.timestamp >= b.checkOut) pred = MUST_REVERT;
        _settleAction(i, caller, abi.encodeCall(IEscrow.cancelByGuest, (b.id)), pred, O_CANCEL_GUEST, "cancelByGuest");
    }

    function openDispute(uint256 idx, uint256 contestedSeed, bool asAttacker) external {
        if (gb.length == 0) return;
        uint256 i = _pickState(idx, S_ESCROWED, S_ESCROWED);
        GB storage b = gb[i];
        if (b.st == S_ESCROWED && block.timestamp < b.checkOut && (contestedSeed >> 128) % 2 == 0) {
            vm.warp(uint256(b.checkOut) + (contestedSeed >> 64) % GRACE); // into the dispute window
        }
        uint256 c = _bound(contestedSeed, 0, b.principal + 1);
        if (contestedSeed % 4 == 0) c = b.principal;
        address caller = asAttacker ? attacker : b.guest;
        uint8 pred = MUST_OK;
        if (caller != b.guest || b.st != S_ESCROWED) pred = MUST_REVERT;
        if (block.timestamp < b.checkOut || block.timestamp >= uint256(b.checkOut) + GRACE) pred = MUST_REVERT;
        if (c == 0 || c > b.principal) pred = MUST_REVERT;
        Ledger memory saved = L;
        _accrue(_assets());
        (bool ok, bytes memory ret, Vm.Log[] memory logs) =
            _call(caller, abi.encodeCall(IEscrow.openDispute, (b.id, c, keccak256("evidence"))));
        _judge(K_AUTH, "openDispute", pred, ok, ret);
        if (!ok) {
            L = saved;
            return;
        }
        _openDisputeModel(i, c, logs);
    }

    function _openDisputeModel(uint256 i, uint256 c, Vm.Log[] memory logs) internal {
        GB storage b = gb[i];
        L.open -= b.principal;
        uint256 y = b.principal * (L.acc - b.accAtDep) / 1e18;
        L.unalloc -= y;
        L.pendDisp += y;
        L.disputed += c;
        uint256 u = b.principal - c;
        uint256 feeU = u * b.feeBps / 10_000;
        L.ownerCl += u - feeU;
        address r = effRecip();
        _creditFee(r, feeU);
        b.st = S_DISPUTED;
        b.contested = c;
        b.dispY = y;
        b.openedAt = uint40(block.timestamp);
        b.frozenAtOpen = b.frozenTotal;
        for (uint256 k; k < logs.length; k++) {
            if (logs[k].emitter != escAddr || logs[k].topics[0] != IEscrowEvents.DisputeOpened.selector) continue;
            (uint256 ec,, uint256 eop, uint256 ef, uint256 ey, address er) =
                abi.decode(logs[k].data, (uint256, bytes32, uint256, uint256, uint256, address));
            if (ec != c || eop != u - feeU || ef != feeU || ey != y || er != r) {
                _flag(K_P2, "DisputeOpened figures differ from spec 7 partial settlement");
            }
            return;
        }
        _flag(K_P2, "no DisputeOpened event");
    }

    function claim(uint256 who) external {
        address c = _claimant(who);
        _claim(c);
    }

    function _claimant(uint256 who) internal view returns (address) {
        uint256 w = who % 10;
        if (w < 4) return guests[w];
        if (w == 4) return payout1;
        if (w == 5) return payout2;
        if (w == 6) return feeR1;
        if (w == 7) return feeR2;
        if (w == 8) return attacker;
        return escOwner;
    }

    struct ClaimPlan {
        bool gate;
        uint256 relG;
        uint256 relO;
        uint256 gOwed;
        uint256 oOwed;
        uint256 fOwed;
        uint256 expectPaid;
        uint8 pred;
    }

    function _planClaim(address c) internal view returns (ClaimPlan memory p) {
        uint256 a = _assets();
        p.gate = _gate(a);
        p.relG = p.gate ? 0 : pendG[c];
        p.relO = (!p.gate && c == gPayout) ? L.pendO : 0;
        p.gOwed = gCl[c] + p.relG;
        p.oOwed = c == gPayout ? L.ownerCl + p.relO : 0;
        p.fOwed = feeCl[c];
        if (p.gate && p.gOwed == 0 && (p.oOwed > 0 || p.fOwed > 0)) {
            p.pred = MUST_REVERT; // spec 4.5, 6.4, ADR 0007/0009
            return p;
        }
        uint256 owed = p.gate ? p.gOwed : p.gOwed + p.oOwed + p.fOwed;
        uint256 liquid = usdc.balanceOf(escAddr) + vault.maxWithdraw(escAddr);
        p.expectPaid = owed < liquid ? owed : liquid;
        if (usdc.blacklisted(c)) p.pred = p.expectPaid > 0 ? MUST_REVERT : EITHER;
        else p.pred = MUST_OK;
    }

    function _claim(address c) internal returns (uint256 paid, bool ok) {
        Ledger memory saved = L;
        _accrue(_assets());
        ClaimPlan memory p = _planClaim(c);
        bytes memory ret;
        (ok, ret,) = _call(c, abi.encodeCall(IEscrow.claim, ()));
        _judge(p.gate ? K_P7 : K_AUTH, "claim", p.pred, ok, ret);
        if (!ok) {
            if (p.gate && p.pred == MUST_REVERT) _count("rejected:ownerOrFeeClaimDuringLoss");
            if (usdc.blacklisted(c)) _count("rejected:blacklistedClaim");
            L = saved;
            return (0, false);
        }
        paid = abi.decode(ret, (uint256));
        if (p.gate && paid > 0) _count("ok:guestClaimDuringLoss");
        if (paid > 0 && paid < (p.gate ? p.gOwed : p.gOwed + p.oOwed + p.fOwed)) _count("ok:partialClaim");
        if (p.relG + p.relO > 0) _count("ok:pendingYieldReleased");
        if (paid != p.expectPaid) {
            _flag(K_CLAIM, string.concat("claim paid ", vm.toString(paid), " expected ", vm.toString(p.expectPaid)));
        }
        _applyClaim(c, p, paid);
    }

    function _applyClaim(address c, ClaimPlan memory p, uint256 paid) internal {
        if (p.relG > 0) {
            pendG[c] -= p.relG;
            _creditGuest(c, p.relG);
        }
        if (p.relO > 0) {
            L.pendO -= p.relO;
            L.ownerCl += p.relO;
        }
        uint256 rest = paid;
        uint256 x = rest < gCl[c] ? rest : gCl[c];
        gCl[c] -= x;
        rest -= x;
        if (!p.gate && c == gPayout) {
            x = rest < L.ownerCl ? rest : L.ownerCl;
            L.ownerCl -= x;
            cumOwnerPaid += x;
            rest -= x;
        }
        if (!p.gate) {
            x = rest < feeCl[c] ? rest : feeCl[c];
            feeCl[c] -= x;
            rest -= x;
        }
        if (rest != 0) _flag(K_CLAIM, "claim paid more than the caller's buckets");
        L.lastAssets -= paid;
    }

    // =====================================================================================
    // settlement paths (spec 4.3, 4.4)
    // =====================================================================================

    function propertyCancel(uint256 idx, bool asAttacker) external {
        if (gb.length == 0) return;
        uint256 i = _pick(idx);
        GB storage b = gb[i];
        address caller = asAttacker ? attacker : escOwner;
        uint8 pred = MUST_OK;
        if (caller != escOwner || b.st != S_ESCROWED || block.timestamp >= b.checkIn) pred = MUST_REVERT;
        _settleAction(
            i, caller, abi.encodeCall(IEscrow.cancelByProperty, (b.id)), pred, O_CANCEL_PROPERTY, "cancelByProperty"
        );
    }

    function settle(uint256 idx, uint256 who) external {
        if (gb.length == 0) return;
        uint256 i = _pick(idx);
        GB storage b = gb[i];
        uint8 pred = MUST_OK;
        if (b.st != S_ESCROWED || block.timestamp < uint256(b.checkOut) + GRACE) pred = MUST_REVERT;
        _settleAction(i, _claimant(who), abi.encodeCall(IEscrow.settle, (b.id)), pred, O_COMPLETED, "settle");
    }

    function _settleAction(uint256 i, address caller, bytes memory data, uint8 pred, uint8 outcome, string memory tag)
        internal
    {
        Ledger memory saved = L;
        _accrue(_assets());
        uint16 rb = outcome == O_COMPLETED ? 0 : (outcome == O_CANCEL_PROPERTY ? 10_000 : _refundBps(i));
        (bool ok, bytes memory ret, Vm.Log[] memory logs) = _call(caller, data);
        _judge(K_AUTH, tag, pred, ok, ret);
        if (!ok) {
            L = saved;
            return;
        }
        Fig memory f = _settleModel(i, rb, outcome == O_COMPLETED);
        _checkSettledEvent(gb[i].id, outcome, gb[i].principal, f, logs);
    }

    function _figures(uint256 p, uint16 rb, uint16 feeBps, uint256 y, bool vested, uint16 gy)
        internal
        pure
        returns (Fig memory f)
    {
        f.refund = Math.ceilDiv(p * rb, 10_000); // guest rounds up
        uint256 retained = p - f.refund;
        f.fee = retained * feeBps / 10_000; // rounds down
        f.ownerPrin = retained - f.fee;
        f.y = y;
        f.gY = vested ? y * gy / 10_000 : 0; // D3: non-vested guest share goes to the owner
        f.oY = y - f.gY;
    }

    function _credit(address guest, Fig memory f) internal {
        _creditGuest(guest, f.refund);
        L.ownerCl += f.ownerPrin;
        _creditFee(f.feeRecipient, f.fee);
        if (f.y > 0) _count("ok:settlementWithYield");
        if (f.gY > 0) _count("ok:guestYieldVested");
        if (L.lossDebt > 0) {
            if (f.y > 0) _count("ok:yieldDeferred");
            pendG[guest] += f.gY; // spec 6.4, ADR 0010 section 3
            L.pendO += f.oY;
        } else {
            _creditGuest(guest, f.gY);
            L.ownerCl += f.oY;
        }
    }

    function _settleModel(uint256 i, uint16 rb, bool vested) internal returns (Fig memory f) {
        GB storage b = gb[i];
        uint256 y = b.principal * (L.acc - b.accAtDep) / 1e18;
        L.open -= b.principal;
        L.unalloc -= y;
        f = _figures(b.principal, rb, b.feeBps, y, vested, b.gyBps);
        f.feeRecipient = effRecip();
        _credit(b.guest, f);
        b.st = S_SETTLED;
    }

    function _checkSettledEvent(bytes32 id, uint8 outcome, uint256 p, Fig memory f, Vm.Log[] memory logs)
        internal
    {
        for (uint256 k; k < logs.length; k++) {
            if (logs[k].emitter != escAddr || logs[k].topics[0] != IEscrowEvents.BookingSettled.selector) continue;
            if (logs[k].topics[1] != id) continue;
            (uint8 eo, uint256 ep, Fig memory e) = abi.decode(logs[k].data, (uint8, uint256, Fig));
            if (e.refund + e.ownerPrin + e.fee != ep || e.gY + e.oY != e.y || e.fee > ep - e.refund) {
                _flag(K_P2, "BookingSettled figures break spec 4.4 equalities");
            }
            if (eo != outcome || ep != p || !_sameFig(e, f)) {
                _flag(K_P2, string.concat("BookingSettled figures differ from spec 4.4 ghost; outcome ", vm.toString(outcome)));
            }
            return;
        }
        _flag(K_P2, "no BookingSettled event");
    }

    function _sameFig(Fig memory a, Fig memory b) internal pure returns (bool) {
        return a.refund == b.refund && a.ownerPrin == b.ownerPrin && a.fee == b.fee && a.y == b.y && a.gY == b.gY
            && a.oY == b.oY && a.feeRecipient == b.feeRecipient;
    }

    // =====================================================================================
    // disputes (spec 7, ADR 0011): the arbitrator actor is treated as compromised (property 9)
    // =====================================================================================

    function arbitratorResolve(uint256 idx, uint256 bpsSeed, uint8 reason, uint8 who) external {
        if (gb.length == 0) return;
        uint256 i = _pickState(idx, S_DISPUTED, S_DISPUTED);
        GB storage b = gb[i];
        address caller = who % 4 == 0 ? arbA1 : who % 4 == 1 ? arbA2 : who % 4 == 2 ? attacker : escOwner;
        if (who % 8 >= 4) caller = b.arb; // the booking's own (compromised) arbitrator, fuzzed guestBps
        uint256 m = bpsSeed % 4;
        uint16 g = m == 0 ? 0 : m == 1 ? 10_000 : uint16(_bound(bpsSeed, 0, 10_500));
        uint8 rc = reason % 9;
        uint8 pred = MUST_OK;
        if (b.st != S_DISPUTED || caller != b.arb || g > 10_000 || rc >= 7) pred = MUST_REVERT;
        else if (block.timestamp >= ghostDeadline(i)) pred = EITHER; // spec 7 does not bar a late resolve
        _resolveAction(i, caller, abi.encodeCall(IEscrow.resolve, (b.id, g, rc)), pred, g, "resolve");
    }

    function resolveByDefault(uint256 idx, uint256 who) external {
        if (gb.length == 0) return;
        uint256 i = _pickState(idx, S_DISPUTED, S_DISPUTED);
        GB storage b = gb[i];
        uint8 pred = MUST_OK;
        if (b.st != S_DISPUTED || block.timestamp < ghostDeadline(i)) pred = MUST_REVERT;
        _resolveAction(i, _claimant(who), abi.encodeCall(IEscrow.resolveByDefault, (b.id)), pred, 0, "resolveByDefault");
    }

    function _resolveAction(uint256 i, address caller, bytes memory data, uint8 pred, uint16 g, string memory tag)
        internal
    {
        Ledger memory saved = L;
        _accrue(_assets());
        (bool ok, bytes memory ret, Vm.Log[] memory logs) = _call(caller, data);
        bytes32 k = keccak256(bytes(tag)) == keccak256("resolve") ? K_P9 : K_AUTH;
        _judge(k, tag, pred, ok, ret);
        if (!ok) {
            L = saved;
            return;
        }
        GB storage b = gb[i];
        L.pendDisp -= b.dispY;
        L.disputed -= b.contested;
        Fig memory f = _figures(b.contested, g, b.feeBps, b.dispY, g == 0, b.gyBps);
        f.feeRecipient = effRecip();
        _credit(b.guest, f);
        b.st = S_SETTLED;
        _checkResolvedEvent(b.id, g, b.contested, f, logs);
    }

    function _checkResolvedEvent(bytes32 id, uint16 g, uint256 c, Fig memory f, Vm.Log[] memory logs) internal {
        for (uint256 k; k < logs.length; k++) {
            if (logs[k].emitter != escAddr || logs[k].topics[0] != IEscrowEvents.DisputeResolved.selector) continue;
            if (logs[k].topics[1] != id) continue;
            (uint16 eg,, Fig memory e) = abi.decode(logs[k].data, (uint16, uint8, Fig));
            if (e.refund + e.ownerPrin + e.fee != c || e.gY + e.oY != e.y || e.fee > c - e.refund) {
                _flag(K_P2, "DisputeResolved figures break spec 4.4 equalities");
            }
            if (eg != g || !_sameFig(e, f)) _flag(K_P2, "DisputeResolved figures differ from spec 7 ghost");
            return;
        }
        _flag(K_P2, "no DisputeResolved event");
    }

    // =====================================================================================
    // guardian (spec 3.3, 3.5, ADR 0007)
    // =====================================================================================

    function guardianFreeze(uint256 idx, bool asAttacker) external {
        if (gb.length == 0) return;
        uint256 i = _pickState(idx, S_ESCROWED, S_DISPUTED);
        GB storage b = gb[i];
        address caller = asAttacker ? attacker : guardian;
        uint8 pred = MUST_OK;
        if (caller != guardian || (b.st != S_ESCROWED && b.st != S_DISPUTED) || b.frozenTotal >= MAX_FREEZE) {
            pred = MUST_REVERT;
        }
        Ledger memory saved = L;
        _accrue(_assets());
        (bool ok, bytes memory ret,) = _call(caller, abi.encodeCall(IEscrow.freezeBooking, (b.id)));
        _judge(K_AUTH, "freezeBooking", pred, ok, ret);
        if (!ok) {
            L = saved;
            return;
        }
        b.frozenFrom = b.st;
        b.st = S_FROZEN;
        b.frozenSince = uint40(block.timestamp);
    }

    function unfreeze(uint256 idx, bool asAttacker) external {
        if (gb.length == 0) return;
        _unfreeze(_pickState(idx, S_FROZEN, S_FROZEN), asAttacker ? attacker : guardian);
    }

    function _unfreeze(uint256 i, address caller) internal returns (bool ok) {
        GB storage b = gb[i];
        uint256 total = uint256(b.frozenTotal) + (block.timestamp - b.frozenSince);
        uint8 pred = MUST_OK;
        if (b.st != S_FROZEN) pred = MUST_REVERT;
        else if (caller != guardian && total < MAX_FREEZE) pred = MUST_REVERT;
        else if (caller != guardian && total == MAX_FREEZE) pred = EITHER; // "once the budget is used"
        Ledger memory saved = L;
        _accrue(_assets());
        bytes memory ret;
        (ok, ret,) = _call(caller, abi.encodeCall(IEscrow.unfreezeBooking, (b.id)));
        _judge(K_AUTH, "unfreezeBooking", pred, ok, ret);
        if (!ok) {
            L = saved;
            return false;
        }
        b.st = b.frozenFrom;
        uint32 onChain = esc.getBooking(b.id).frozenTotal;
        uint256 capped = total > MAX_FREEZE ? MAX_FREEZE : total;
        if (onChain != total && onChain != capped) _flag(K_P5, "frozenTotal is neither elapsed nor capped elapsed");
        if (onChain != total) _flag(K_AMBIG, "frozenTotal capped at MAX_FREEZE_DURATION");
        b.frozenTotal = onChain; // documented ambiguity: the ghost adopts whichever the escrow chose
    }

    /// Amended by docs/adr/0013 §2 (C9 finding F1): pause and unpause are pure flags. They must not
    /// run accrue() (so a broken vault cannot stop the guardian) and must leave the books untouched.
    function guardianPause(bool pause, bool asAttacker) external {
        address caller = asAttacker ? attacker : guardian;
        uint8 pred = (caller != guardian || pause == gPaused) ? MUST_REVERT : MUST_OK;
        uint256 laBefore = escV.lastAssets();
        uint40 sinceBefore = escV.shortfallSince();
        bytes memory data = pause ? abi.encodeCall(IEscrow.pauseDeposits, ()) : abi.encodeCall(IEscrow.unpauseDeposits, ());
        (bool ok, bytes memory ret,) = _call(caller, data);
        _judge(K_AUTH, pause ? "pauseDeposits" : "unpauseDeposits", pred, ok, ret);
        if (!ok) return;
        gPaused = pause;
        if (escV.lastAssets() != laBefore || escV.shortfallSince() != sinceBefore) {
            _flag(K_RULE4, pause ? "pauseDeposits changed the books" : "unpauseDeposits changed the books");
        }
    }

    /// Spec 6.1 / CLAUDE.md rule 4: accrue() is the first line of every state-changing function. If the
    /// model's accrue would have changed state but the escrow's baseline did not move, the function
    /// skipped accrue(): flag it under its own key and keep the ghost in step with the escrow.
    function _detectSkippedAccrue(Ledger memory saved, uint256 laBefore, uint40 sinceBefore, string memory tag)
        internal
    {
        bool modelMoved = L.lastAssets != saved.lastAssets || (saved.since == 0 && L.since != 0);
        bool escMoved = escV.lastAssets() != laBefore || escV.shortfallSince() != sinceBefore;
        if (modelMoved && !escMoved) {
            _flag(K_RULE4, string.concat(tag, " succeeded without running accrue()"));
            L = saved;
        }
    }

    // =====================================================================================
    // owner (spec 3.3, 6.4, 6.5)
    // =====================================================================================

    function ownerConfig(uint8 what, uint256 v, bool asAttacker) external {
        address caller = asAttacker ? attacker : escOwner;
        uint8 w = what % 3;
        uint8 pred = caller == escOwner ? MUST_OK : MUST_REVERT;
        bytes memory data;
        if (w == 0) {
            v = _bound(v, 0, 10_500);
            if (v > 10_000) pred = MUST_REVERT;
            data = abi.encodeCall(IEscrow.setGuestYieldBps, (uint16(v)));
        } else if (w == 1) {
            data = abi.encodeCall(IEscrow.setPayoutAddress, (gPayout == payout1 ? payout2 : payout1));
        } else {
            v = _bound(v, 0, 9_500);
            if (v > 10_000 - MIN_BUFFER_BPS) pred = MUST_REVERT;
            data = abi.encodeCall(IEscrow.setMaxDeployBps, (uint16(v)));
        }
        Ledger memory saved = L;
        _accrue(_assets());
        (bool ok, bytes memory ret,) = _call(caller, data);
        _judge(K_AUTH, "ownerConfig", pred, ok, ret);
        if (!ok) {
            L = saved;
            return;
        }
        if (w == 0) gGy = uint16(v);
        else if (w == 1) gPayout = gPayout == payout1 ? payout2 : payout1;
        else gMaxDeploy = uint16(v);
    }

    function ownerFundReserve(uint256 amount) external {
        amount = _bound(amount, 0, 500e6);
        uint8 pred = amount == 0 ? EITHER : MUST_OK;
        vm.prank(escOwner);
        usdc.approve(escAddr, amount);
        Ledger memory saved = L;
        _accrue(_assets());
        (bool ok, bytes memory ret,) = _call(escOwner, abi.encodeCall(IEscrow.fundReserve, (amount)));
        _judge(K_AUTH, "fundReserve", pred, ok, ret);
        if (!ok) {
            L = saved;
            return;
        }
        L.reserve += amount;
        L.lastAssets += amount;
    }

    function ownerTopUp(uint256 amount) external {
        _topUp(_bound(amount, 0, 20_000e6));
    }

    function _topUp(uint256 amount) internal {
        vm.prank(escOwner);
        usdc.approve(escAddr, amount);
        Ledger memory saved = L;
        _accrue(_assets());
        uint8 pred = L.lossDebt == 0 ? MUST_REVERT : (amount == 0 ? EITHER : MUST_OK);
        (bool ok, bytes memory ret,) = _call(escOwner, abi.encodeCall(IEscrow.topUpLoss, (amount)));
        _judge(K_AUTH, "topUpLoss", pred, ok, ret);
        if (!ok) {
            L = saved;
            return;
        }
        uint256 x = amount < L.lossDebt ? amount : L.lossDebt;
        L.lossDebt -= x;
        L.lastAssets += x;
    }

    function ownerProposeReserveWithdrawal(uint256 amount, uint8 reason) external {
        amount = _bound(amount, 0, L.reserve + 10e6);
        reason = reason % 3;
        Ledger memory saved = L;
        _accrue(_assets());
        (bool ok, bytes memory ret,) =
            _call(escOwner, abi.encodeCall(IEscrow.proposeReserveWithdrawal, (amount, reason)));
        _judge(K_AUTH, "proposeReserveWithdrawal", EITHER, ok, ret);
        if (!ok) {
            L = saved;
            return;
        }
        gResSet = amount != 0;
        gResAmt = amount;
        gResReason = reason;
    }

    function guardianConfirmReserve(bool asAttacker, bool mismatch) external {
        address caller = asAttacker ? attacker : guardian;
        uint256 amount = gResAmt + (mismatch ? 1 : 0);
        Ledger memory saved = L;
        uint256 a = _assets();
        _accrue(a);
        uint8 pred = MUST_OK;
        if (caller != guardian || !gResSet || mismatch || _gate(a) || amount > L.reserve) pred = MUST_REVERT;
        else if (L.reserve - amount < MIN_LOSS && _liabilities() != 0) pred = MUST_REVERT; // ADR 0013 §5
        else if (amount > usdc.balanceOf(escAddr) + vault.maxWithdraw(escAddr)) pred = MUST_REVERT;
        (bool ok, bytes memory ret,) =
            _call(caller, abi.encodeCall(IEscrow.confirmReserveWithdrawal, (amount, gResReason)));
        _judge(K_P7, "confirmReserveWithdrawal", pred, ok, ret);
        if (!ok) {
            L = saved;
            return;
        }
        L.reserve -= amount;
        L.lastAssets -= amount;
        cumReservePaid += amount;
        gResSet = false;
        gResAmt = 0;
    }

    // =====================================================================================
    // factory admin (spec 3.4 timelocks, ADR 0007 section 5)
    // =====================================================================================

    function adminProposeFee(uint256 v, bool asAttacker) external {
        address caller = asAttacker ? attacker : admin;
        v = _bound(v, 0, MAX_FEE_BPS + 100);
        uint8 pred = (caller != admin || v > ESCROW_MAX_FEE) ? MUST_REVERT : MUST_OK;
        Ledger memory saved = L;
        _accrue(_assets());
        (bool ok, bytes memory ret,) = _call(caller, abi.encodeCall(IEscrow.proposeFeeBps, (uint16(v))));
        _judge(K_AUTH, "proposeFeeBps", pred, ok, ret);
        if (!ok) {
            L = saved;
            return;
        }
        if (gPendFeeAt != 0 && block.timestamp >= gPendFeeAt) gFee = gPendFee;
        gPendFee = uint16(v);
        gPendFeeAt = uint64(block.timestamp + FEE_DELAY);
    }

    function adminProposeArbitrator(bool second, bool asAttacker) external {
        address caller = asAttacker ? attacker : admin;
        address a = second ? arbA2 : arbA1;
        uint8 pred = caller != admin ? MUST_REVERT : MUST_OK;
        Ledger memory saved = L;
        _accrue(_assets());
        (bool ok, bytes memory ret,) = _call(caller, abi.encodeCall(IEscrow.proposeArbitrator, (a)));
        _judge(K_AUTH, "proposeArbitrator", pred, ok, ret);
        if (!ok) {
            L = saved;
            return;
        }
        if (gPendArbAt != 0 && block.timestamp >= gPendArbAt) gArb = gPendArb;
        gPendArb = a;
        gPendArbAt = uint64(block.timestamp + ARB_DELAY);
    }

    function adminProposeFeeRecipient(bool second, bool asAttacker) external {
        address caller = asAttacker ? attacker : admin;
        address r = second ? feeR2 : feeR1;
        vm.prank(caller);
        (bool ok, bytes memory ret) =
            address(factory).call(abi.encodeCall(IFactoryAdmin.proposeFeeRecipient, (r)));
        _judge(K_AUTH, "proposeFeeRecipient", caller != admin ? MUST_REVERT : MUST_OK, ok, ret);
        if (!ok) return;
        if (gPendRecipAt != 0 && block.timestamp >= gPendRecipAt) gRecip = gPendRecip;
        gPendRecip = r;
        gPendRecipAt = uint64(block.timestamp + FEE_RECIPIENT_DELAY);
    }

    // =====================================================================================
    // rebalancer (spec 6.3), fuzzed as compromised (property 10)
    // =====================================================================================

    function _liabilities() internal view returns (uint256) {
        (uint256 cl, uint256 pend,) = totalsModel();
        return L.open + L.disputed + pend + cl;
    }

    function rebalancerDeploy(uint256 amount, bool asAttacker) external {
        address caller = asAttacker ? attacker : rebalancer;
        uint256 idle = usdc.balanceOf(escAddr);
        uint256 m = amount % 4;
        if (m == 0) amount = amount % (idle + 1);
        else if (m == 1) amount = _bound(amount, 0, idle + idle / 10 + 1);
        else amount = _maxDeployable(idle); // the largest move the spec 6.3 caps allow
        Ledger memory saved = L;
        uint256 a = _assets();
        _accrue(a);
        uint8 pred = _predictDeploy(caller, amount, idle, _gate(a));
        (bool ok, bytes memory ret,) = _call(caller, abi.encodeCall(IEscrow.deploy, (amount)));
        _judge(K_P10, "deploy", pred, ok, ret);
        if (!ok) {
            L = saved;
            return;
        }
        if (_gate(a)) _flag(K_P7, "deploy while lossDebt > 0 or shortfall observed");
        uint256 lb = _liabilities();
        uint256 idleAfter = usdc.balanceOf(escAddr);
        uint256 dep = vault.previewRedeem(vault.balanceOf(escAddr));
        if (idleAfter < lb * MIN_BUFFER_BPS / 10_000) _flag(K_P10, "deploy left idle below MIN_BUFFER_BPS");
        if (dep > lb * gMaxDeploy / 10_000) _flag(K_P10, "deploy exceeded maxDeployBps");
    }

    function _maxDeployable(uint256 idle) internal view returns (uint256) {
        uint256 lb = _liabilities();
        uint256 buf = lb * MIN_BUFFER_BPS / 10_000;
        uint256 cap = lb * gMaxDeploy / 10_000;
        uint256 dep = vault.previewRedeem(vault.balanceOf(escAddr));
        if (idle <= buf || dep >= cap) return 0;
        uint256 x = idle - buf;
        return x < cap - dep ? x : cap - dep;
    }

    function _predictDeploy(address caller, uint256 amount, uint256 idle, bool gate) internal view returns (uint8) {
        if (caller != rebalancer || amount == 0 || amount > idle || gate) return MUST_REVERT;
        // docs/adr/0013 §1 and §5: the vault must be seeded and the owner-funded reserve floor held.
        if (vault.totalSupply() < 1e6 || L.reserve < MIN_LOSS) return MUST_REVERT;
        uint256 lb = _liabilities();
        uint256 dep = vault.previewRedeem(vault.balanceOf(escAddr));
        if (idle - amount < lb * MIN_BUFFER_BPS / 10_000) return MUST_REVERT;
        uint256 cap = lb * gMaxDeploy / 10_000;
        if (dep + amount > cap + 2) return MUST_REVERT;
        if (dep + amount > cap) return EITHER; // "deployed" measured before or after vault rounding
        if (vault.previewDeposit(amount) == 0) return MUST_REVERT; // ADR 0010 VaultMintedNoShares
        return MUST_OK;
    }

    function rebalancerRedeem(uint256 amount, bool asAttacker) external {
        address caller = asAttacker ? attacker : rebalancer;
        uint256 mw = vault.maxWithdraw(escAddr);
        amount = _bound(amount, 0, mw + mw / 10 + 1);
        uint8 pred = caller != rebalancer || amount == 0 ? MUST_REVERT : (amount > mw ? EITHER : MUST_OK);
        Ledger memory saved = L;
        _accrue(_assets());
        (bool ok, bytes memory ret,) = _call(caller, abi.encodeCall(IEscrow.redeem, (amount)));
        _judge(K_P10, "redeem", pred, ok, ret);
        if (!ok) L = saved;
    }

    // =====================================================================================
    // loss handling (spec 6.4, ADR 0009, ADR 0010)
    // =====================================================================================

    function observeShortfall(uint256 who) external {
        Ledger memory saved = L;
        _accrue(_assets());
        (bool ok, bytes memory ret,) = _call(_claimant(who), abi.encodeCall(IEscrow.observeShortfall, ()));
        _judge(K_AUTH, "observeShortfall", MUST_OK, ok, ret);
        if (!ok) L = saved;
    }

    function recogniseLoss(uint256 who) external {
        _recognise(_claimant(who));
    }

    function _recognise(address caller) internal returns (bool ok) {
        Ledger memory saved = L;
        uint256 a = _assets();
        _accrue(a);
        uint256 sf = L.lastAssets > a ? L.lastAssets - a : 0;
        uint8 pred = MUST_OK;
        if (sf < MIN_LOSS || block.timestamp < L.since + LOSS_WINDOW) pred = MUST_REVERT;
        else if (block.timestamp == L.since + LOSS_WINDOW) pred = EITHER; // boundary: see targeted test
        bytes memory ret;
        Vm.Log[] memory logs;
        (ok, ret, logs) = _call(caller, abi.encodeCall(IEscrow.recogniseLoss, ()));
        _judge(K_AUTH, "recogniseLoss", pred, ok, ret);
        if (!ok) {
            L = saved;
            return false;
        }
        _absorb(sf, a, logs);
    }

    function _absorb(uint256 loss, uint256 a, Vm.Log[] memory logs) internal {
        uint256 total = loss;
        uint256 fr = loss < L.reserve ? loss : L.reserve;
        L.reserve -= fr;
        loss -= fr;
        uint256 fo = loss < L.ownerCl ? loss : L.ownerCl;
        L.ownerCl -= fo;
        loss -= fo;
        uint256 fp = loss < L.pendO ? loss : L.pendO;
        L.pendO -= fp;
        loss -= fp;
        if (fr > 0) _count("ok:lossFromReserve");
        if (fo + fp > 0) _count("ok:lossFromOwner");
        if (loss > 0) _count("ok:lossToDebt");
        L.lossDebt += loss;
        L.lastAssets = a;
        L.since = 0;
        for (uint256 k; k < logs.length; k++) {
            if (logs[k].emitter != escAddr || logs[k].topics[0] != IEscrowEvents.LossRecognised.selector) continue;
            (uint256 el, uint256 er, uint256 eo, uint256 ed) =
                abi.decode(logs[k].data, (uint256, uint256, uint256, uint256));
            if (el != total || er != fr || eo != fo + fp || ed != loss) {
                _flag(K_P3, "LossRecognised figures differ from spec 6.4 absorption order");
            }
            return;
        }
        _flag(K_P3, "no LossRecognised event");
    }

    // =====================================================================================
    // world: time, vault, token
    // =====================================================================================

    function warp(uint256 seed) external {
        uint256 m = seed % 8;
        uint256 t = block.timestamp;
        if (m == 0) t += 1 + seed % 1 hours;
        else if (m == 1) t += _bound(seed, 1 hours, 2 days);
        else if (m == 2) t += _bound(seed, 2 days, 10 days);
        else if (m == 3 || m == 4) t = _boundaryTarget(seed, t);
        else if (m == 5) t = L.since != 0 ? L.since + LOSS_WINDOW - 1 + (seed >> 8) % 3 : t + 1;
        else if (m == 6) t = gPendFeeAt > t ? uint256(gPendFeeAt) - 1 + (seed >> 8) % 3 : t + 1;
        else t += 1;
        if (t <= block.timestamp) t = block.timestamp + 1;
        vm.warp(t);
    }

    /// Jumps to a boundary of a booking (cutoff, checkIn, checkOut, checkOut+GRACE, dispute deadline), -1/0/+1.
    function _boundaryTarget(uint256 seed, uint256 t) internal view returns (uint256) {
        if (gb.length == 0) return t + 1;
        uint256 i = (seed >> 8) % gb.length;
        GB storage b = gb[i];
        uint256 k = (seed >> 16) % 5;
        uint256 target;
        if (k == 0) target = gCut[i][(seed >> 24) % gCut[i].length].cutoffUtc;
        else if (k == 1) target = b.checkIn;
        else if (k == 2) target = b.checkOut;
        else if (k == 3) target = uint256(b.checkOut) + GRACE;
        else target = b.openedAt != 0 ? ghostDeadline(i) : uint256(b.checkOut);
        target = target + ((seed >> 32) % 3) - 1;
        return target > t ? target : t + 1;
    }

    function vaultGain(uint256 amount) external {
        uint256 before = _assets();
        amount = _bound(amount, 0, vault.totalAssets() / 50 + 200e6);
        usdc.mint(address(vault), amount);
        uint256 afterA = _assets();
        if (afterA > before) extGain += afterA - before;
    }

    function vaultLoss(uint256 amount) external {
        uint256 bal = usdc.balanceOf(address(vault));
        if (bal == 0) return;
        if (amount % 5 == 0 || bal / 3 + 1 <= MIN_LOSS) amount = amount % MIN_LOSS;
        else if (amount % 5 == 1) amount = bal * 9 / 10; // severe: well beyond reserve + owner credits
        else amount = _bound(amount, MIN_LOSS, bal / 3 + 1);
        if (amount > bal) amount = bal;
        if (amount > 0) lossInjected = true;
        usdc.adminBurn(address(vault), amount);
    }

    function vaultLimit(uint256 v) external {
        uint256 m = v % 4;
        uint256 lim = m == 0 ? type(uint256).max : m == 1 ? 0 : _bound(v, 0, vault.totalAssets());
        vault.setWithdrawLimit(lim);
    }

    /// The attacker donates USDC to the escrow: realised as yield by accrue (spec 6.1).
    function attackerDonate(uint256 amount) external {
        amount = _bound(amount, 0, 500e6);
        uint256 before = _assets();
        vm.prank(attacker);
        usdc.transfer(escAddr, amount);
        extGain += _assets() - before;
    }

    /// Blacklists guest 3 in the token; when switched on, guest 3 immediately tries to claim (spec 4.5:
    /// the claim stays pending, nothing is redirected).
    function toggleBlacklist(bool on) external {
        usdc.setBlacklisted(guests[3], on);
        if (on) _claim(guests[3]);
    }

    /// Unauthorised calls by the attacker: every one must revert (spec 3.3).
    function attackerProbe(uint256 idx, uint8 what) external {
        bytes32 id = gb.length == 0 ? bytes32(uint256(1)) : gb[_pick(idx)].id;
        uint8 w = what % 8;
        bytes memory data;
        if (w == 0) data = abi.encodeCall(IEscrow.setRebalancer, (attacker));
        else if (w == 1) data = abi.encodeCall(IEscrow.setQuoteSigner, (attacker));
        else if (w == 2) data = abi.encodeCall(IEscrow.setMinNightlyAtomic, (1));
        else if (w == 3) data = abi.encodeCall(IEscrow.setMaxOpenPrincipal, (type(uint256).max));
        else if (w == 4) data = abi.encodeCall(IEscrow.proposeReserveWithdrawal, (1, 0));
        else if (w == 5) data = abi.encodeCall(IEscrow.fundReserve, (0));
        else if (w == 6) data = abi.encodeCall(IEscrow.topUpLoss, (1));
        else data = abi.encodeCall(IEscrow.resolve, (id, 10_000, 0));
        Ledger memory saved = L;
        _accrue(_assets());
        (bool ok, bytes memory ret,) = _call(attacker, data);
        _judge(K_AUTH, "attackerProbe", MUST_REVERT, ok, ret);
        if (!ok) L = saved;
    }

    // =====================================================================================
    // liveness drain (property 11): called from afterInvariant, never fuzzed
    // =====================================================================================

    function drain() external {
        usdc.setBlacklisted(guests[3], false);
        vault.setWithdrawLimit(type(uint256).max);
        uint256 far = block.timestamp;
        for (uint256 i; i < gb.length; i++) {
            if (gb[i].st == S_FROZEN && !_unfreeze(i, guardian)) _flag(K_P11, "guardian cannot unfreeze");
            uint256 t = uint256(gb[i].checkOut) + GRACE + 1;
            if (t > far) far = t;
            if (gb[i].st == S_DISPUTED && ghostDeadline(i) + 1 > far) far = ghostDeadline(i) + 1;
        }
        vm.warp(far + 1);
        _drainLoss();
        for (uint256 i; i < gb.length; i++) {
            if (gb[i].st == S_ESCROWED) this.settle(i, 8);
            else if (gb[i].st == S_DISPUTED) this.resolveByDefault(i, 8);
            if (gb[i].st != S_SETTLED) _flag(K_P11, string.concat("booking not settleable: ", vm.toString(i)));
            if (uint8(esc.bookingState(gb[i].id)) != S_SETTLED) _flag(K_P11, "bookingState != SETTLED after drain");
        }
        _drainLoss();
        for (uint256 i; i < 4; i++) {
            _claim(guests[i]);
        }
        _claim(feeR1);
        _claim(feeR2);
        _claim(gPayout);
    }

    function _drainLoss() internal {
        this.observeShortfall(0);
        if (L.since != 0) {
            vm.warp(block.timestamp + LOSS_WINDOW + 1);
            if (!_recognise(escOwner)) _flag(K_P11, "loss not recognisable after the window");
        }
        if (L.lossDebt > 0) _topUp(L.lossDebt);
    }
}
