//go:build !contractbridge

// Package testbridge has no behavior in production binaries.
package testbridge

import "net/http"

func Wrap(handler http.Handler, _ func()) http.Handler { return handler }
