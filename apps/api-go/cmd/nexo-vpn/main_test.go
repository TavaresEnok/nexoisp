package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestWaitForInsisteAteOBancoResponder(t *testing.T) {
	calls := 0
	got, e := waitFor(context.Background(), time.Millisecond, 2*time.Millisecond, func(context.Context) (string, error) {
		if calls++; calls < 4 {
			return "", errors.New("banco fora")
		}
		return "ok", nil
	})
	if e != nil || got != "ok" || calls != 4 {
		t.Fatalf("got=%q e=%v calls=%d", got, e, calls)
	}
}

func TestWaitForParaAoCancelar(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	_, e := waitFor(ctx, time.Hour, time.Hour, func(context.Context) (string, error) {
		calls++
		cancel()
		return "", errors.New("banco fora")
	})
	if !errors.Is(e, context.Canceled) || calls != 1 {
		t.Fatalf("e=%v calls=%d", e, calls)
	}
}
