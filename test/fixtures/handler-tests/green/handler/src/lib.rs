//! The healthy half of the control for module-toolkit#146.
//!
//! Its twin in `../../../mutant/` is byte-identical except for ONE assertion. If this one is not
//! green and that one is not red, the gate is not measuring what it claims to measure.

/// Sum of the line amounts of a ticket, in cents.
pub fn total_cents(lines: &[i64]) -> i64 {
    lines.iter().sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_total_adds_the_lines() {
        assert_eq!(total_cents(&[125_050, 300]), 125_350);
    }

    /// The module root has to stay reachable from the crate: real handlers read their manifest and
    /// their JSON schemas this way, so any scheme that runs these tests somewhere else breaks them.
    #[test]
    fn the_manifest_travels_with_the_crate() {
        let manifest = include_str!("../../module.json");
        assert!(manifest.contains("handler_fixture_green"), "manifest not reachable: {manifest}");
    }
}
