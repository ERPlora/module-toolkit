//! Stand-in for the hub's `erplora-guest-sdk`, for the farm control of module-toolkit#146/#147.
//!
//! The fixture handler in `../../../farmed/` calls this function from its test: if the farm did
//! not really put this crate where `../../../../hub/crates/guest-sdk` looks, the handler does not
//! even compile — which is exactly the loud failure the control exists to observe the absence of.

/// The marker the farmed handler's test asserts on.
pub fn sdk_marker() -> &'static str {
    "erplora-guest-sdk-through-the-farm"
}
