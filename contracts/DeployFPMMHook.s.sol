// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {FPMMHook} from "src/FPMMHook.sol";
import {CTHelpers} from "src/CTHelpers.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";

/// @notice Deploys FPMMHook via CREATE2 with the correct hook flag bits.
///
/// Required env vars:
///   PRIVATE_KEY    — deployer private key
///   POOL_MANAGER   — Uniswap v4 PoolManager address
///   OWNER          — address set as Owned.owner on the hook
///
/// Optional env vars:
///   ORACLE         — if set, prepares a demo condition and creates an OS
///   COLLATERAL     — collateral ERC-20 (required when ORACLE is set)
///   QUESTION_ID    — bytes32 question ID (default: keccak256("demo"))
///   OUTCOME_SLOTS  — outcome count for the demo condition (default: 2)
///
/// Usage:
///   forge script script/DeployFPMMHook.s.sol \
///     --rpc-url $RPC_URL --private-key $PRIVATE_KEY --broadcast --verify
contract DeployFPMMHook is Script {
    uint160 constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_ADD_LIQUIDITY_FLAG
            | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG
            | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
            | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );

    function run() external {
        uint256 privateKey      = vm.envUint("PRIVATE_KEY");
        address poolManagerAddr = vm.envAddress("POOL_MANAGER");
        address owner           = vm.envAddress("OWNER");

        bytes memory creationCode = abi.encodePacked(
            type(FPMMHook).creationCode,
            abi.encode(IPoolManager(poolManagerAddr), owner)
        );
        bytes32 codeHash = keccak256(creationCode);

        uint256 salt;
        address hookAddr;
        while (true) {
            hookAddr = _create2Addr(CREATE2_FACTORY, bytes32(salt), codeHash);
            if (uint160(hookAddr) & 0x3FFF == HOOK_FLAGS) break;
            unchecked { ++salt; }
        }
        console2.log("Mined salt:  ", salt);
        console2.log("Hook address:", hookAddr);

        vm.startBroadcast(privateKey);

        (bool ok,) = CREATE2_FACTORY.call(abi.encodePacked(bytes32(salt), creationCode));
        require(ok && hookAddr.code.length > 0, "hook deploy failed");
        FPMMHook hook = FPMMHook(hookAddr);

        // Optional: prepare a demo condition and create an outcome space
        address oracle = vm.envOr("ORACLE", address(0));
        if (oracle != address(0)) {
            address collateral    = vm.envAddress("COLLATERAL");
            bytes32 questionId    = vm.envOr("QUESTION_ID", bytes32(keccak256("demo")));
            uint256 slots         = vm.envOr("OUTCOME_SLOTS", uint256(2));

            hook.prepareCondition(oracle, questionId, slots);

            bytes32 cId = CTHelpers.getConditionId(oracle, questionId, slots);
            bytes32[] memory conditions = new bytes32[](1);
            conditions[0] = cId;

            hook.createOutcomeSpace(collateral, conditions, new uint256[](0));

            console2.log("Condition ID:");
            console2.logBytes32(cId);
        }

        vm.stopBroadcast();

        console2.log("=== Deployment summary ===");
        console2.log("FPMMHook:    ", address(hook));
        console2.log("Owner:       ", owner);
        console2.log("PoolManager: ", poolManagerAddr);
    }

    function _create2Addr(address factory, bytes32 salt, bytes32 codeHash)
        internal
        pure
        returns (address)
    {
        return address(uint160(uint256(keccak256(
            abi.encodePacked(bytes1(0xff), factory, salt, codeHash)
        ))));
    }
}
