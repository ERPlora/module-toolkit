//! The FARM half of the control for module-toolkit#146: a handler whose guest-sdk dependency is
//! declared by the production relative path, so its tests only compile when the symlink farm of
//! `run-cargo.mjs` really put the hub checkout where `../../../../hub/crates/guest-sdk` looks.
//!
//! The test CALLS the sdk on purpose: resolving the manifest is not enough — the crate has to
//! compile, link and answer through the farm, the same way the 22 production handlers do.

/// Prefixes a ticket label with the sdk's own marker.
pub fn label_through_sdk(name: &str) -> String {
    format!("{}:{name}", erplora_guest_sdk::sdk_marker())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sdk_answers_through_the_farm() {
        assert_eq!(
            label_through_sdk("mesa-4"),
            "erplora-guest-sdk-through-the-farm:mesa-4"
        );
    }

    /// Same property the green/mutant fixtures pin: the module root must stay reachable from the
    /// crate, because real handlers `include_str!` their manifest and schemas.
    #[test]
    fn the_manifest_travels_with_the_crate() {
        let manifest = include_str!("../../module.json");
        assert!(manifest.contains("handler_fixture_farmed"), "manifest not reachable: {manifest}");
    }
}
