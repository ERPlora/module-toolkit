//! The control for module-toolkit#149: a handler that only compiles THROUGH the farm.
//!
//! Two things have to hold at once for these tests to run at all, and each one is a link that #147
//! broke or left unproven:
//!
//!   · the `hub` link — `erplora_guest_sdk` is reached by the same `../../../../hub/crates/guest-sdk`
//!     the 21 real handlers declare, and it resolves to nothing without the farm;
//!   · the `module` link — `include_str!("../../module.json")` only reads if the farmed module link
//!     leads to the real fixture directory. That is exactly the link that pointed at the scratch
//!     dir's own parent when the path arrived relative, and cargo said «manifest path … does not
//!     exist» on 21 module gates.

use erplora_guest_sdk::minor_units;

/// Total of a ticket in minor units, computed through the guest-sdk.
pub fn ticket_total(euros: i64, cents: i64) -> i64 {
    minor_units(euros, cents)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_guest_sdk_is_reachable_through_the_farm() {
        assert_eq!(ticket_total(1_250, 50), 125_050);
    }

    #[test]
    fn the_module_root_is_reachable_through_the_farm() {
        let manifest = include_str!("../../module.json");
        assert!(manifest.contains("handler_fixture_farmed"), "manifest not reachable: {manifest}");
    }
}
