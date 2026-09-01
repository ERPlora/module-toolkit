//! The MUTANT half of the control for module-toolkit#146: `the_total_adds_the_lines` asserts a
//! total that is one cent wrong. Its only job is to prove that a broken handler test turns the
//! gate RED — a check that has never seen the positive is a check nobody has tested.
//!
//! Do NOT "fix" this file. The suite asserts that it fails.
/// Sum of the line amounts of a ticket, in cents.
pub fn total_cents(lines: &[i64]) -> i64 {
    lines.iter().sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_total_adds_the_lines() {
        assert_eq!(total_cents(&[125_050, 300]), 125_349); // 🔴 MUTANT: off by one cent, on purpose
    }

    /// The module root has to stay reachable from the crate: real handlers read their manifest and
    /// their JSON schemas this way, so any scheme that runs these tests somewhere else breaks them.
    #[test]
    fn the_manifest_travels_with_the_crate() {
        let manifest = include_str!("../../module.json");
        assert!(manifest.contains("handler_fixture_mutant"), "manifest not reachable: {manifest}");
    }
}
