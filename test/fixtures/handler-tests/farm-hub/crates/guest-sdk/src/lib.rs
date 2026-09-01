//! The one symbol the farmed fixture handler imports, so the dependency has to RESOLVE and COMPILE
//! and not merely be declared (module-toolkit#149).

/// Minor units of a money amount, the way the real guest-sdk hands them to a handler.
pub fn minor_units(euros: i64, cents: i64) -> i64 {
    euros * 100 + cents
}
