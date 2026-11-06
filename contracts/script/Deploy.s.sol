// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {DuskEscrow, IDuskAdmission} from "../src/DuskEscrow.sol";

contract Deploy is Script {
    function run() external returns (DuskEscrow escrow) {
        vm.startBroadcast();
        address verifier = vm.envOr("DUSK_VERIFIER_ADDRESS", address(0));
        escrow = new DuskEscrow(
            IDuskAdmission(vm.envOr("DUSK_ADMISSION_ADDRESS", address(0))),
            verifier == address(0) ? 0 : uint64(vm.envOr("DUSK_CHALLENGE_WINDOW_SEC", uint256(600))),
            verifier
        );
        vm.stopBroadcast();

        console.log("DuskEscrow deployed at:", address(escrow));
        console.log("chain id:", block.chainid);
    }
}
