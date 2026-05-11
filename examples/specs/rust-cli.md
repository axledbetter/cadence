# greet — Rust 2021 binary crate

## Goal

A small Rust binary crate that prints a greeting. Demonstrates the
default `cargo init` layout: `Cargo.toml` + `src/main.rs` for the
binary target + `tests/integration_test.rs` for the integration
smoke test. No external crate dependencies — uses only `std`.

This is the v7.7.0 binary-only path. For a library, list ONLY
`src/lib.rs` (no `main.rs`) and the scaffolder switches to library
mode and excludes `Cargo.lock` from `.gitignore` per Cargo's
documented convention.

## Files

* `Cargo.toml` — `[package]` name = "greet", edition = "2021", no `[dependencies]` block (stdlib only)
* `.gitignore` — `target/` (Cargo.lock NOT excluded — binary crate commits it)
* `src/main.rs` — `fn main()` plus a pure `fn greet(name: &str) -> String`
* `tests/integration_test.rs` — Integration smoke test that invokes the binary via `assert_cmd` (or `std::process::Command` for stdlib-only)
* `README.md` — Usage example: `cargo run -- --name=World`

## How to use

```bash
claude-autopilot scaffold --from-spec examples/specs/rust-cli.md
cargo test
cargo run -- --name=World
```

The scaffolder writes a working "hello, name" binary skeleton with an
integration test stub you can extend. Rename the `[package].name` in
`Cargo.toml` before publishing to crates.io.
