# greet — Go 1.22 CLI

## Goal

A small Go CLI that prints a greeting. Demonstrates the standard Go
module layout: `go.mod` at the repo root, `main.go` with a `main()`
function, and table-driven tests in `main_test.go`. No external
dependencies — uses only `fmt`, `os`, `flag` from the standard library.

This is the simplest Go scaffold target. For a multi-binary repo,
add `cmd/<name>/main.go` paths to the spec instead of root `main.go`.

## Files

* `go.mod` — `module greet`, `go 1.22`, no `require` block (stdlib only)
* `.gitignore` — `vendor/`, `*.test`, `*.out`, binary output names
* `main.go` — `package main`, defines `main()` and a pure `greet(name string) string`
* `main_test.go` — Table-driven tests for `greet()` plus a smoke test for `main()`
* `README.md` — Usage example: `go run . --name=World`

## How to use

```bash
claude-autopilot scaffold --from-spec examples/specs/go-cli.md
go test ./...
go run . --name=World
```

The scaffolder writes a working "hello, name" skeleton with a
table-driven test you can extend. Edit `go.mod`'s module path before
publishing (e.g. `module github.com/you/greet`).
