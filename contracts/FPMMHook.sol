// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "./BaseHook.sol";
import {CTHelpers} from "./CTHelpers.sol";
import {CurrencySettler} from "./CurrencySettler.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SafeCast} from "v4-core/src/libraries/SafeCast.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {Owned} from "solmate/src/auth/Owned.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title FPMMHook
/// @notice Uniswap v4 hook implementing FPMM prediction markets.
///         All outcome tokens and LP shares are ERC-6909 tokens on this contract.
///         Pool key: (collateral ↔ address(this)), fee slot = outcome linear index.
contract FPMMHook is BaseHook, Owned {
    using PoolIdLibrary for PoolKey;
    using CurrencySettler for Currency;
    using SafeCast for uint256;

    // ── Errors ────────────────────────────────────────────────────────────────
    error LiquidityOnlyViaHook();
    error OSAlreadyExists();
    error OSNotFound();
    error ConditionNotPrepared();
    error ConditionAlreadyPrepared();
    error ConditionAlreadyResolved();
    error InvalidPayoutVector();
    error BuyForbidden();
    error OperatorRequired();
    error TooManyConditions();
    error SubOSNotFound();
    error NoLiquidity();
    error FeeTooHigh();
    error WeightsMismatch();

    // ── Events ────────────────────────────────────────────────────────────────
    event OSCreated(bytes32 indexed osIndex, address indexed collateral, bytes32[] conditions);
    event LiquidityAdded(bytes32 indexed osIndex, address indexed sender, uint256 lpMinted, uint256 collateralIn);
    event LiquidityRemoved(bytes32 indexed osIndex, address indexed sender, uint256 lpBurned, uint256[] tokensReturned);
    event SwapExecuted(bytes32 indexed osIndex, address indexed user, uint32 posIdx, uint256 specified, uint256 outcome, uint256 fee, bool isBuy);
    event ConditionPreparation(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint256 slotCount);
    event ConditionResolution(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint256 slotCount, uint256[] numerators);
    event Redeemed(address indexed user, bytes32 indexed osIndex, uint256 payout);
    event FeesWithdrawn(bytes32 indexed osIndex, address indexed account, uint256 amount);

    // ── ERC-6909 ──────────────────────────────────────────────────────────────
    event Transfer(address caller, address indexed from, address indexed to, uint256 indexed id, uint256 amount);
    event OperatorSet(address indexed owner, address indexed operator, bool approved);
    event Approval(address indexed owner, address indexed spender, uint256 indexed id, uint256 amount);

    mapping(address => mapping(uint256 => uint256)) private _balanceOf;
    mapping(address => mapping(address => bool)) public isOperator;
    mapping(address => mapping(address => mapping(uint256 => uint256))) public allowance;

    // ERC-6909 getter
    function balanceOf(address owner, uint256 id) external view returns (uint256) { return _balanceOf[owner][id]; }
    // ERC-20 shim: PoolSwapTest calls IERC20(hookAddr).balanceOf(account) on the hook-address
    // currency. That side is always zero-netted via BeforeSwapDelta, so 0 is correct.
    function balanceOf(address) external pure returns (uint256) { return 0; }
    function totalSupply() external pure returns (uint256) { return 0; }

    function transfer(address to, uint256 id, uint256 amount) external returns (bool) {
        _balanceOf[msg.sender][id] -= amount;
        unchecked { _balanceOf[to][id] += amount; }
        emit Transfer(msg.sender, msg.sender, to, id, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 id, uint256 amount) external returns (bool) {
        if (from != msg.sender && !isOperator[from][msg.sender]) {
            uint256 allowed = allowance[from][msg.sender][id];
            if (allowed != type(uint256).max) {
                require(allowed >= amount, "ERC6909: allowance");
                allowance[from][msg.sender][id] = allowed - amount;
            }
        }
        _balanceOf[from][id] -= amount;
        unchecked { _balanceOf[to][id] += amount; }
        emit Transfer(msg.sender, from, to, id, amount);
        return true;
    }

    function approve(address spender, uint256 id, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender][id] = amount;
        emit Approval(msg.sender, spender, id, amount);
        return true;
    }

    function setOperator(address operator, bool approved) external returns (bool) {
        isOperator[msg.sender][operator] = approved;
        emit OperatorSet(msg.sender, operator, approved);
        return true;
    }

    function _mint(address to, uint256 id, uint256 amount) internal {
        unchecked { _balanceOf[to][id] += amount; }
        emit Transfer(address(0), address(0), to, id, amount);
    }

    function _burn(address from, uint256 id, uint256 amount) internal {
        _balanceOf[from][id] -= amount;
        emit Transfer(address(0), from, address(0), id, amount);
    }

    // ── Token ID encoding ─────────────────────────────────────────────────────
    uint256 private constant LP_FLAG = 1 << 255;
    uint256 private constant OUTCOME_SHIFT = 224;
    uint256 private constant MARKET_MASK = (1 << 224) - 1;

    function outcomeTokenId(bytes32 osIndex, uint32 linearIdx) public pure returns (uint256) {
        return (uint256(linearIdx) << OUTCOME_SHIFT) | (uint256(osIndex) & MARKET_MASK);
    }

    function lpTokenId(bytes32 osIndex) public pure returns (uint256) {
        return LP_FLAG | (uint256(osIndex) & MARKET_MASK);
    }

    // ── Condition management ──────────────────────────────────────────────────
    mapping(bytes32 => uint256[]) public payoutNumerators;
    mapping(bytes32 => uint256) public payoutDenominator;

    function prepareCondition(address oracle, bytes32 questionId, uint256 outcomeSlotCount) external {
        require(outcomeSlotCount >= 2 && outcomeSlotCount <= 256, "FPMM: bad slot count");
        bytes32 cId = CTHelpers.getConditionId(oracle, questionId, outcomeSlotCount);
        if (payoutNumerators[cId].length != 0) revert ConditionAlreadyPrepared();
        payoutNumerators[cId] = new uint256[](outcomeSlotCount);
        emit ConditionPreparation(cId, oracle, questionId, outcomeSlotCount);
    }

    /// @dev Oracle = msg.sender, enforced by hash.
    function reportPayouts(bytes32 questionId, uint256[] calldata payouts) external {
        uint256 slots = payouts.length;
        require(slots >= 2, "FPMM: need >= 2");
        bytes32 cId = CTHelpers.getConditionId(msg.sender, questionId, slots);
        if (payoutNumerators[cId].length != slots) revert ConditionNotPrepared();
        if (payoutDenominator[cId] != 0) revert ConditionAlreadyResolved();
        uint256 den;
        for (uint256 i; i < slots;) {
            payoutNumerators[cId][i] = payouts[i];
            den += payouts[i];
            unchecked { ++i; }
        }
        if (den == 0) revert InvalidPayoutVector();
        payoutDenominator[cId] = den;
        emit ConditionResolution(cId, msg.sender, questionId, slots, payouts);
    }

    function getOutcomeSlotCount(bytes32 conditionId) public view returns (uint256) {
        return payoutNumerators[conditionId].length;
    }

    // ── OS struct ─────────────────────────────────────────────────────────────
    struct OS {
        address collateral;
        bytes32[] conditions;
        uint256[] positions;            // keccak positionIds in linear-index order
        uint256[] initialWeights;       // used only on first fund (totalSupply == 0)
        uint256 lpTotalSupply;
        uint256 feePoolWeight;          // cumulative fee credits (in collateral units)
        uint256 totalWithdrawnFees;
        mapping(address => uint256) withdrawnFees;
        mapping(uint256 => uint32) posLinearIdx; // positionId → linear index
    }

    mapping(bytes32 => OS) private _os;
    mapping(PoolId => bytes32) public poolOsIndex;
    mapping(PoolId => uint32) public poolOutcomeIdx;
    // osIndex → linear outcome index → pool fee slot (used to reconstruct PoolKey)
    mapping(bytes32 => mapping(uint32 => uint24)) public outcomeFeeSlot;

    // Global counter ensuring every pool has a unique fee slot (avoids PoolId collision
    // when multiple outcome spaces share the same collateral + hook address pair)
    uint24 private _nextFeeSlot;

    // ── Fee parameters ────────────────────────────────────────────────────────
    uint256 public baseFee;    // 1e6 basis, e.g. 3000 = 0.3%
    uint256 public minFee;
    uint256 public maxFee;
    uint256 public alpha;      // directional weight (1e6 = 1.0x)
    uint256 public beta;       // volatility weight  (1e6 = 1.0x)
    uint256 public volNeutral; // vol level that gives zero vol bonus (1e6 basis)

    // ── Cross-hook swap state (set in beforeSwap, read in afterSwap) ──────────
    bytes32 private _sOsIndex;
    uint32  private _sPosIdx;
    uint256 private _sNetAmt;      // collateral into pool (buy) OR returnAmountPlusFees (sell)
    uint256 private _sOutcomeAmt;  // outcome tokens going to/from user
    uint256 private _sFeeAmt;
    address private _sUser;
    bool    private _sIsBuy;

    // ── Reentrancy ────────────────────────────────────────────────────────────
    bool private _locked;
    modifier nonReentrant() {
        require(!_locked, "reentrancy");
        _locked = true;
        _;
        _locked = false;
    }

    // ── Constants ─────────────────────────────────────────────────────────────
    uint160 private constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    uint256 private constant MAX_CONDITIONS = 4;
    uint256 private constant ONE = 1e18;

    constructor(IPoolManager _pm, address _owner) BaseHook(_pm) Owned(_owner) {
        baseFee    = 3000;    // 0.3%
        minFee     = 100;     // 0.01%
        maxFee     = 100000;  // 10%
        alpha      = 500000;  // 0.5x directional
        beta       = 200000;  // 0.2x volatility
        volNeutral = 0;
    }

    // ── Hook permissions ──────────────────────────────────────────────────────
    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: true,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: true,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function _beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        internal pure override returns (bytes4)
    { revert LiquidityOnlyViaHook(); }

    function _beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        internal pure override returns (bytes4)
    { revert LiquidityOnlyViaHook(); }

    // ── OS creation ───────────────────────────────────────────────────────────
    function createOutcomeSpace(
        address collateral,
        bytes32[] calldata conditions,
        uint256[] calldata initialWeights
    ) external returns (bytes32 osIndex) {
        uint256 len = conditions.length;
        require(len >= 1 && len <= MAX_CONDITIONS, "FPMM: bad conditions length");

        bytes32[] memory ordered = _sortBytes32Calldata(conditions);
        osIndex = keccak256(abi.encode(collateral, ordered));
        OS storage data = _os[osIndex];
        if (data.collateral != address(0)) revert OSAlreadyExists();

        data.collateral = collateral;
        data.conditions = ordered;
        if (initialWeights.length != 0) {
            data.initialWeights = initialWeights;
        }

        uint8[] memory indexes = new uint8[](len);
        _recordPositions(osIndex, collateral, bytes32(0), len, indexes);

        emit OSCreated(osIndex, collateral, ordered);
    }

    function _recordPositions(
        bytes32 osIndex,
        address collateral,
        bytes32 parentCollectionId,
        uint256 conditionsLeft,
        uint8[] memory indexes
    ) private {
        OS storage data = _os[osIndex];
        if (conditionsLeft == 0) {
            uint32 linIdx = uint32(data.positions.length);
            uint256 posId = uint256(keccak256(abi.encodePacked(collateral, parentCollectionId)));
            data.positions.push(posId);
            data.posLinearIdx[posId] = linIdx;

            // Pool: (collateral, hookAddr) or (hookAddr, collateral) by address order
            // fee = globally unique slot (avoids PoolId collision across outcome spaces)
            (Currency c0, Currency c1) = address(collateral) < address(this)
                ? (Currency.wrap(collateral), Currency.wrap(address(this)))
                : (Currency.wrap(address(this)), Currency.wrap(collateral));
            uint24 feeSlot = _nextFeeSlot++;
            PoolKey memory key = PoolKey(c0, c1, feeSlot, int24(60), IHooks(address(this)));
            PoolId pid = key.toId();
            poolOsIndex[pid] = osIndex;
            poolOutcomeIdx[pid] = linIdx;
            outcomeFeeSlot[osIndex][linIdx] = feeSlot;
            poolManager.initialize(key, SQRT_PRICE_1_1);
            return;
        }
        conditionsLeft--;
        uint256 slotCount = getOutcomeSlotCount(data.conditions[conditionsLeft]);
        require(slotCount >= 2, "FPMM: condition not prepared");
        for (uint256 i; i < slotCount;) {
            indexes[conditionsLeft] = uint8(i);
            bytes32 childColl = CTHelpers.getCollectionId(
                parentCollectionId,
                data.conditions[conditionsLeft],
                1 << i
            );
            _recordPositions(osIndex, collateral, childColl, conditionsLeft, indexes);
            unchecked { ++i; }
        }
    }

    // ── LP management ─────────────────────────────────────────────────────────
    enum CallbackOp { ADD_LIQ, REMOVE_LIQ, WITHDRAW_FEES }

    struct CallbackData {
        CallbackOp op;
        bytes32 osIndex;
        uint256 amount;
        address sender;
    }

    function addLiquidity(bytes32 osIndex, uint256 collateralAmount) external nonReentrant {
        if (_os[osIndex].collateral == address(0)) revert OSNotFound();
        poolManager.unlock(abi.encode(CallbackData(CallbackOp.ADD_LIQ, osIndex, collateralAmount, msg.sender)));
    }

    function removeLiquidity(bytes32 osIndex, uint256 lpAmount) external nonReentrant {
        if (_os[osIndex].collateral == address(0)) revert OSNotFound();
        poolManager.unlock(abi.encode(CallbackData(CallbackOp.REMOVE_LIQ, osIndex, lpAmount, msg.sender)));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "FPMM: not PM");
        CallbackData memory cd = abi.decode(data, (CallbackData));
        if (cd.op == CallbackOp.ADD_LIQ) {
            _addLiq(cd.osIndex, cd.amount, cd.sender);
        } else if (cd.op == CallbackOp.REMOVE_LIQ) {
            _removeLiq(cd.osIndex, cd.amount, cd.sender);
        } else {
            _withdrawFeesCallback(cd.osIndex, cd.amount, cd.sender);
        }
        return "";
    }

    function _addLiq(bytes32 osIndex, uint256 amount, address sender) internal {
        OS storage data = _os[osIndex];
        Currency coll = Currency.wrap(data.collateral);

        // Transfer collateral from sender into PM as hook's ERC-6909 claim
        coll.settle(poolManager, sender, amount, false);      // transferFrom sender → PM
        coll.take(poolManager, address(this), amount, true);  // hook mints ERC-6909 claim

        uint256[] memory bals = _getPoolBalances(osIndex);
        uint256 len = bals.length;
        uint256 totalLp = data.lpTotalSupply;
        uint256 lpMinted;

        if (totalLp == 0) {
            if (data.initialWeights.length == len) {
                // Weighted first fund: distribute proportionally by weight
                uint256 wTotal;
                for (uint256 i; i < len;) { wTotal += data.initialWeights[i]; unchecked { ++i; } }
                for (uint256 i; i < len;) {
                    _mint(address(this), outcomeTokenId(osIndex, uint32(i)), amount * data.initialWeights[i] / wTotal);
                    unchecked { ++i; }
                }
            } else {
                // Standard FPMM first fund: each outcome gets the full amount
                // (pool balance[i] = amount for all i → equal implied probabilities)
                for (uint256 i; i < len;) {
                    _mint(address(this), outcomeTokenId(osIndex, uint32(i)), amount);
                    unchecked { ++i; }
                }
            }
            lpMinted = amount;
        } else {
            // Proportional to existing pool balances; excess returned to LP
            uint256 maxBal;
            for (uint256 i; i < len;) {
                if (bals[i] > maxBal) maxBal = bals[i];
                unchecked { ++i; }
            }
            lpMinted = amount * totalLp / maxBal;
            for (uint256 i; i < len;) {
                uint256 amtForPos = amount * bals[i] / maxBal;
                _mint(address(this), outcomeTokenId(osIndex, uint32(i)), amtForPos);
                uint256 excess = amount - amtForPos;
                if (excess > 0) {
                    // Return excess outcome tokens to LP provider
                    _mint(sender, outcomeTokenId(osIndex, uint32(i)), excess);
                }
                unchecked { ++i; }
            }
        }

        _mint(sender, lpTokenId(osIndex), lpMinted);
        data.lpTotalSupply += lpMinted;
        emit LiquidityAdded(osIndex, sender, lpMinted, amount);
    }

    function _removeLiq(bytes32 osIndex, uint256 lpAmount, address sender) internal {
        OS storage data = _os[osIndex];
        uint256 totalLp = data.lpTotalSupply;
        require(totalLp > 0, "FPMM: no liquidity");
        require(_balanceOf[sender][lpTokenId(osIndex)] >= lpAmount, "FPMM: insufficient LP");

        uint256[] memory bals = _getPoolBalances(osIndex);
        uint256 len = bals.length;
        uint256[] memory returned = new uint256[](len);

        for (uint256 i; i < len;) {
            returned[i] = bals[i] * lpAmount / totalLp;
            if (returned[i] > 0) {
                _burn(address(this), outcomeTokenId(osIndex, uint32(i)), returned[i]);
                _mint(sender, outcomeTokenId(osIndex, uint32(i)), returned[i]);
            }
            unchecked { ++i; }
        }

        _burn(sender, lpTokenId(osIndex), lpAmount);
        data.lpTotalSupply -= lpAmount;
        emit LiquidityRemoved(osIndex, sender, lpAmount, returned);
    }

    // ── Swap hooks ────────────────────────────────────────────────────────────
    // hookData: abi.encode(address user)
    // Buy  = exactInput collateral (amountSpecified < 0)
    // Sell = exactOutput collateral (amountSpecified > 0)
    function _beforeSwap(
        address /*sender*/,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata hookData
    ) internal override returns (bytes4, BeforeSwapDelta, uint24) {
        PoolId pid = key.toId();
        bytes32 osIndex = poolOsIndex[pid];
        require(osIndex != bytes32(0), "FPMM: unknown pool");

        (address user) = abi.decode(hookData, (address));
        uint32 posIdx = poolOutcomeIdx[pid];
        bool isBuy = params.amountSpecified < 0;

        if (!isBuy && _isResolved(osIndex)) revert BuyForbidden();
        if (isBuy && _isResolved(osIndex)) revert BuyForbidden();

        uint256 specifiedAmount = isBuy
            ? uint256(-params.amountSpecified)
            : uint256(params.amountSpecified);

        // Determine whether collateral is currency0
        bool collIsC0 = Currency.unwrap(key.currency0) != address(this);
        Currency coll = collIsC0 ? key.currency0 : key.currency1;

        uint256 fee = _calcFee(osIndex, posIdx, isBuy);
        uint256 feeAmount;
        BeforeSwapDelta returnDelta;

        if (isBuy) {
            feeAmount = specifiedAmount * fee / 1e6;
            uint256 netAmount = specifiedAmount - feeAmount;

            uint256 outcomeAmt = _calcBuyAmount(osIndex, posIdx, netAmount);

            // Take all collateral as ERC-6909 claim
            coll.take(poolManager, address(this), specifiedAmount, true);

            _sIsBuy     = true;
            _sOsIndex   = osIndex;
            _sPosIdx    = posIdx;
            _sNetAmt    = netAmount;
            _sOutcomeAmt = outcomeAmt;
            _sFeeAmt    = feeAmount;
            _sUser      = user;

            // Absorb full collateral side; hookAddr side stays zero
            returnDelta = toBeforeSwapDelta(specifiedAmount.toInt128(), 0);
        } else {
            // Sell: user wants specifiedAmount collateral out
            feeAmount = specifiedAmount * fee / 1e6;
            uint256 returnAmtPlusFees = specifiedAmount + feeAmount;

            uint256 outcomeAmt = _calcSellAmount(osIndex, posIdx, specifiedAmount, fee);

            // Burn user's outcome tokens (requires operator approval)
            if (!isOperator[user][address(this)]) revert OperatorRequired();
            _burn(user, outcomeTokenId(osIndex, posIdx), outcomeAmt);

            // Provide specifiedAmount collateral to PM (burn hook's ERC-6909 claim)
            coll.settle(poolManager, address(this), specifiedAmount, true);

            _sIsBuy      = false;
            _sOsIndex    = osIndex;
            _sPosIdx     = posIdx;
            _sNetAmt     = returnAmtPlusFees;
            _sOutcomeAmt = outcomeAmt;
            _sFeeAmt     = feeAmount;
            _sUser       = user;

            // Hook provides specifiedAmount to PM → PM pays user
            returnDelta = toBeforeSwapDelta(-specifiedAmount.toInt128(), 0);
        }

        OS storage data = _os[osIndex];
        data.feePoolWeight += feeAmount;

        emit SwapExecuted(osIndex, user, posIdx, specifiedAmount, feeAmount > 0 ? specifiedAmount - feeAmount : 0, feeAmount, isBuy);
        return (IHooks.beforeSwap.selector, returnDelta, 0);
    }

    function _afterSwap(
        address,
        PoolKey calldata,
        SwapParams calldata,
        BalanceDelta,
        bytes calldata
    ) internal override returns (bytes4, int128) {
        if (_sIsBuy) {
            // Add netAmount of each outcome to pool (split collateral into outcomes)
            _splitFunds(_sOsIndex, _sNetAmt);
            // Transfer outcomeAmt of the bought outcome from pool to user
            // (pool's inventory decreases; user's balance increases)
            uint256 tid = outcomeTokenId(_sOsIndex, _sPosIdx);
            _balanceOf[address(this)][tid] -= _sOutcomeAmt;
            _balanceOf[_sUser][tid] += _sOutcomeAmt;
        } else {
            // Add user's sold tokens to pool inventory for the sold outcome
            uint256 tid = outcomeTokenId(_sOsIndex, _sPosIdx);
            _balanceOf[address(this)][tid] += _sOutcomeAmt;
            // Merge returnAmountPlusFees of each outcome out of pool (releases collateral)
            _mergeFromPool(_sOsIndex, _sNetAmt);
        }
        return (IHooks.afterSwap.selector, 0);
    }

    // ── Pool rebalancing ──────────────────────────────────────────────────────
    // Adds `amount` of every outcome token to pool inventory (simulating a split of collateral into outcomes)
    function _splitFunds(bytes32 osIndex, uint256 amount) internal {
        OS storage data = _os[osIndex];
        uint256 len = data.positions.length;
        for (uint256 i; i < len;) {
            _mint(address(this), outcomeTokenId(osIndex, uint32(i)), amount);
            unchecked { ++i; }
        }
    }

    // Burns `amount` of every outcome token from pool inventory (simulating a merge back to collateral)
    function _mergeFromPool(bytes32 osIndex, uint256 amount) internal {
        OS storage data = _os[osIndex];
        uint256 len = data.positions.length;
        for (uint256 i; i < len;) {
            _burn(address(this), outcomeTokenId(osIndex, uint32(i)), amount);
            unchecked { ++i; }
        }
    }

    // ── FPMM pricing ──────────────────────────────────────────────────────────
    // Returns outcome tokens received when paying `netAmount` collateral for outcome `posIdx`
    function _calcBuyAmount(bytes32 osIndex, uint32 posIdx, uint256 netAmount)
        internal view returns (uint256)
    {
        uint256[] memory bals = _getPoolBalances(osIndex);
        uint256 len = bals.length;
        if (len == 0) revert NoLiquidity();
        uint256 buyBal = bals[posIdx];
        if (buyBal == 0) revert NoLiquidity();
        uint256 endBal = buyBal * ONE;
        for (uint256 i; i < len;) {
            if (i != posIdx) {
                uint256 b = bals[i];
                if (b == 0) revert NoLiquidity();
                endBal = _ceildiv(endBal * b, b + netAmount);
            }
            unchecked { ++i; }
        }
        return buyBal + netAmount - _ceildiv(endBal, ONE);
    }

    /// @notice Public view for UI. Deducts fee internally.
    function calcBuyAmount(bytes32 osIndex, uint32 posIdx, uint256 investmentAmount)
        external view returns (uint256)
    {
        if (_isResolved(osIndex)) revert BuyForbidden();
        uint256 fee = _calcFee(osIndex, posIdx, true);
        uint256 netAmount = investmentAmount - investmentAmount * fee / 1e6;
        return _calcBuyAmount(osIndex, posIdx, netAmount);
    }

    // Returns outcome tokens user must pay to receive `returnAmount` collateral (sell exact-out)
    function _calcSellAmount(bytes32 osIndex, uint32 posIdx, uint256 returnAmount, uint256 fee)
        internal view returns (uint256)
    {
        uint256[] memory bals = _getPoolBalances(osIndex);
        uint256 len = bals.length;
        if (len == 0) revert NoLiquidity();
        // Gross amount extracted from pool (including fee retained by pool)
        uint256 gross = returnAmount * (1_000_000 + fee) / 1_000_000;
        uint256 sellBal = bals[posIdx];
        uint256 endBal = sellBal * ONE;
        for (uint256 i; i < len;) {
            if (i != posIdx) {
                uint256 b = bals[i];
                endBal = _ceildiv(endBal * b, b - gross);
            }
            unchecked { ++i; }
        }
        return gross + _ceildiv(endBal, ONE) - sellBal;
    }

    /// @notice Public view for UI.
    function calcSellAmount(bytes32 osIndex, uint32 posIdx, uint256 returnAmount)
        external view returns (uint256)
    {
        if (_isResolved(osIndex)) revert BuyForbidden();
        uint256 fee = _calcFee(osIndex, posIdx, false);
        return _calcSellAmount(osIndex, posIdx, returnAmount, fee);
    }

    // ── Dynamic fee ───────────────────────────────────────────────────────────
    function _calcFee(bytes32 osIndex, uint32 posIdx, bool isBuy) internal view returns (uint256) {
        uint256[] memory bals = _getPoolBalances(osIndex);
        uint256 len = bals.length;
        if (len == 0) return baseFee;

        uint256 total;
        uint256 bMin = type(uint256).max;
        uint256 bMax;
        uint256 bI = bals[posIdx];
        for (uint256 i; i < len;) {
            total += bals[i];
            if (bals[i] < bMin) bMin = bals[i];
            if (bals[i] > bMax) bMax = bals[i];
            unchecked { ++i; }
        }
        if (total == 0) return baseFee;
        uint256 bMean = total / len;
        if (bMean == 0) return baseFee;

        // Directional component D in 1e6 (signed via int256):
        // Buy dominant (bI < bMean) → D > 0 → higher fee
        // Buy underdog (bI > bMean) → D < 0 → lower fee
        // Sell flips sign
        int256 D = isBuy
            ? (int256(bMean) - int256(bI)) * int256(1e6) / int256(bMean)
            : (int256(bI) - int256(bMean)) * int256(1e6) / int256(bMean);

        // Volatility component V: spread relative to mean, minus neutral level
        int256 V = int256((bMax - bMin) * 1e6 / bMean) - int256(volNeutral);

        int256 feeS = int256(baseFee) * (int256(1e6) + int256(alpha) * D / int256(1e6) + int256(beta) * V / int256(1e6)) / int256(1e6);

        if (feeS < int256(minFee)) return minFee;
        if (feeS > int256(maxFee)) return maxFee;
        return uint256(feeS);
    }

    function setFeeParams(
        uint256 _baseFee,
        uint256 _minFee,
        uint256 _maxFee,
        uint256 _alpha,
        uint256 _beta,
        uint256 _volNeutral
    ) external onlyOwner {
        require(_minFee <= _baseFee && _baseFee <= _maxFee, "FPMM: fee ordering");
        require(_maxFee <= 100_000, "FPMM: maxFee > 10%");
        baseFee    = _baseFee;
        minFee     = _minFee;
        maxFee     = _maxFee;
        alpha      = _alpha;
        beta       = _beta;
        volNeutral = _volNeutral;
    }

    // ── Split / merge personal positions ────────────────────────────────────
    /// @notice Burns `amount` of a composite-OS outcome and mints `amount` of each
    ///         sub-OS outcome (the OS formed by removing one condition).
    ///         The sub-OS must already exist (createOutcomeSpace was called for it).
    function splitPosition(
        bytes32 osIndex,
        uint32 parentLinearIdx,
        bytes32 condition,
        uint256 amount
    ) external {
        OS storage data = _os[osIndex];
        require(data.collateral != address(0), "FPMM: OS not found");

        // Derive sub-OS: conditions without `condition`
        bytes32[] storage conds = data.conditions;
        uint256 cLen = conds.length;
        bytes32[] memory subConds = new bytes32[](cLen - 1);
        uint256 k;
        for (uint256 i; i < cLen;) {
            if (conds[i] != condition) {
                subConds[k++] = conds[i];
            }
            unchecked { ++i; }
        }
        require(k == cLen - 1, "FPMM: condition not in OS");
        bytes32 subOsIndex = keccak256(abi.encode(data.collateral, _sortBytes32(subConds)));
        if (_os[subOsIndex].collateral == address(0)) revert SubOSNotFound();

        uint256 slotCount = getOutcomeSlotCount(condition);
        require(slotCount >= 2, "FPMM: condition not prepared");

        // Burn parent outcome token
        _burn(msg.sender, outcomeTokenId(osIndex, parentLinearIdx), amount);

        // Mint one sub-outcome token per slot of the split condition
        for (uint256 i; i < slotCount;) {
            _mint(msg.sender, outcomeTokenId(subOsIndex, uint32(i)), amount);
            unchecked { ++i; }
        }
    }

    /// @notice Inverse of splitPosition: burns sub-OS outcome tokens and mints parent.
    function mergePosition(
        bytes32 osIndex,
        uint32 parentLinearIdx,
        bytes32 condition,
        uint256 amount
    ) external {
        OS storage data = _os[osIndex];
        require(data.collateral != address(0), "FPMM: OS not found");

        bytes32[] storage conds = data.conditions;
        uint256 cLen = conds.length;
        bytes32[] memory subConds = new bytes32[](cLen - 1);
        uint256 k;
        for (uint256 i; i < cLen;) {
            if (conds[i] != condition) {
                subConds[k++] = conds[i];
            }
            unchecked { ++i; }
        }
        require(k == cLen - 1, "FPMM: condition not in OS");
        bytes32 subOsIndex = keccak256(abi.encode(data.collateral, _sortBytes32(subConds)));
        if (_os[subOsIndex].collateral == address(0)) revert SubOSNotFound();

        uint256 slotCount = getOutcomeSlotCount(condition);

        // Burn one sub-outcome token per slot
        for (uint256 i; i < slotCount;) {
            _burn(msg.sender, outcomeTokenId(subOsIndex, uint32(i)), amount);
            unchecked { ++i; }
        }
        // Mint parent outcome token
        _mint(msg.sender, outcomeTokenId(osIndex, parentLinearIdx), amount);
    }

    /// @notice Split collateral into equal amounts of each outcome position.
    function splitCollateral(bytes32 osIndex, uint256 amount) external nonReentrant {
        OS storage data = _os[osIndex];
        require(data.collateral != address(0), "FPMM: OS not found");
        // Transfer collateral from user
        IERC20(data.collateral).transferFrom(msg.sender, address(this), amount);
        uint256 len = data.positions.length;
        for (uint256 i; i < len;) {
            _mint(msg.sender, outcomeTokenId(osIndex, uint32(i)), amount);
            unchecked { ++i; }
        }
    }

    /// @notice Merge equal amounts of all outcomes back to collateral.
    function mergeCollateral(bytes32 osIndex, uint256 amount) external {
        OS storage data = _os[osIndex];
        require(data.collateral != address(0), "FPMM: OS not found");
        uint256 len = data.positions.length;
        for (uint256 i; i < len;) {
            _burn(msg.sender, outcomeTokenId(osIndex, uint32(i)), amount);
            unchecked { ++i; }
        }
        IERC20(data.collateral).transfer(msg.sender, amount);
    }

    // ── Redemption ────────────────────────────────────────────────────────────
    function redeem(bytes32 osIndex) external nonReentrant {
        require(_isResolved(osIndex), "FPMM: not resolved");
        OS storage data = _os[osIndex];
        uint256[] storage positions = data.positions;
        bytes32[] storage conditions = data.conditions;
        uint256 len = positions.length;
        uint256 cLen = conditions.length;
        uint256 totalPayout;

        for (uint256 i; i < len;) {
            uint256 posId = positions[i];
            uint32 linIdx = data.posLinearIdx[posId];
            uint256 tokenId = outcomeTokenId(osIndex, linIdx);
            uint256 userBal = _balanceOf[msg.sender][tokenId];
            if (userBal > 0) {
                // Derive per-condition outcome indexes from positionId path
                // We stored positions in order of _recordPositions traversal,
                // which encodes the condition outcome indexes in the collection hash chain.
                // Instead, use the fact that linIdx encodes the outcome combination:
                // for n conditions with 2 outcomes each, linIdx = i0 + 2*i1 + 4*i2...
                uint256 payout = userBal;
                uint256 tmpIdx = linIdx;
                for (uint256 j; j < cLen;) {
                    uint256 slots = getOutcomeSlotCount(conditions[j]);
                    uint256 outcomeIdx = tmpIdx % slots;
                    tmpIdx /= slots;
                    uint256 num = payoutNumerators[conditions[j]][outcomeIdx];
                    uint256 den = payoutDenominator[conditions[j]];
                    payout = payout * num / den;
                    unchecked { ++j; }
                }
                if (payout > 0) {
                    _burn(msg.sender, tokenId, userBal);
                    totalPayout += payout;
                }
            }
            unchecked { ++i; }
        }
        if (totalPayout > 0) {
            // Collateral lives in PM as hook's ERC-6909 claims — withdraw via unlock
            address redeemer = msg.sender;
            address collateral = data.collateral;
            poolManager.unlock(abi.encode(CallbackData(CallbackOp.WITHDRAW_FEES, osIndex, totalPayout, redeemer)));
        }
        emit Redeemed(msg.sender, osIndex, totalPayout);
    }

    // ── Fee withdrawal ────────────────────────────────────────────────────────
    function feesWithdrawableBy(bytes32 osIndex, address account) public view returns (uint256) {
        OS storage data = _os[osIndex];
        uint256 totalLp = data.lpTotalSupply;
        if (totalLp == 0) return 0;
        uint256 lpBal = _balanceOf[account][lpTokenId(osIndex)];
        uint256 raw = data.feePoolWeight * lpBal / totalLp;
        uint256 already = data.withdrawnFees[account];
        return raw > already ? raw - already : 0;
    }

    function withdrawFees(bytes32 osIndex) external nonReentrant {
        uint256 amount = feesWithdrawableBy(osIndex, msg.sender);
        require(amount > 0, "FPMM: no fees");
        OS storage data = _os[osIndex];
        data.withdrawnFees[msg.sender] += amount;
        data.totalWithdrawnFees += amount;
        poolManager.unlock(abi.encode(CallbackData(CallbackOp.WITHDRAW_FEES, osIndex, amount, msg.sender)));
        emit FeesWithdrawn(osIndex, msg.sender, amount);
    }

    function _withdrawFeesCallback(bytes32 osIndex, uint256 amount, address recipient) internal {
        Currency coll = Currency.wrap(_os[osIndex].collateral);
        coll.settle(poolManager, address(this), amount, true); // burn hook's ERC-6909 claim
        coll.take(poolManager, recipient, amount, false);       // send ERC-20 to recipient
    }

    // ── View helpers ──────────────────────────────────────────────────────────
    function getPoolBalances(bytes32 osIndex) external view returns (uint256[] memory) {
        return _getPoolBalances(osIndex);
    }

    function _getPoolBalances(bytes32 osIndex) internal view returns (uint256[] memory bals) {
        OS storage data = _os[osIndex];
        uint256 len = data.positions.length;
        bals = new uint256[](len);
        for (uint256 i; i < len;) {
            bals[i] = _balanceOf[address(this)][outcomeTokenId(osIndex, uint32(i))];
            unchecked { ++i; }
        }
    }

    function getOSInfo(bytes32 osIndex)
        external view
        returns (address collateral, bytes32[] memory conditions, uint256[] memory positions, uint256 lpTotalSupply)
    {
        OS storage data = _os[osIndex];
        return (data.collateral, data.conditions, data.positions, data.lpTotalSupply);
    }

    function getOSIndex(address collateral, bytes32[] calldata conditions) external pure returns (bytes32) {
        return keccak256(abi.encode(collateral, _sortBytes32Calldata(conditions)));
    }

    function isResolved(bytes32 _osIndex) external view returns (bool) {
        return _isResolved(_osIndex);
    }

    function _isResolved(bytes32 _osIndex) internal view returns (bool) {
        bytes32[] storage conds = _os[_osIndex].conditions;
        uint256 len = conds.length;
        for (uint256 i; i < len;) {
            if (payoutDenominator[conds[i]] == 0) return false;
            unchecked { ++i; }
        }
        return len > 0;
    }

    // ── Utility ───────────────────────────────────────────────────────────────
    function _ceildiv(uint256 x, uint256 y) private pure returns (uint256) {
        if (x == 0) return 0;
        return (x - 1) / y + 1;
    }

    function _equalWeights(uint256 len) private pure returns (uint256[] memory w) {
        w = new uint256[](len);
        for (uint256 i; i < len;) { w[i] = 1; unchecked { ++i; } }
    }

    function _sortBytes32(bytes32[] memory data) internal pure returns (bytes32[] memory) {
        uint256 n = data.length;
        for (uint256 i; i < n;) {
            for (uint256 j; j < n - 1;) {
                if (data[j] > data[j + 1]) {
                    bytes32 tmp = data[j];
                    data[j] = data[j + 1];
                    data[j + 1] = tmp;
                }
                unchecked { ++j; }
            }
            unchecked { ++i; }
        }
        return data;
    }

    function _sortBytes32Calldata(bytes32[] calldata data) internal pure returns (bytes32[] memory sorted) {
        sorted = new bytes32[](data.length);
        for (uint256 i; i < data.length;) { sorted[i] = data[i]; unchecked { ++i; } }
        return _sortBytes32(sorted);
    }
}
