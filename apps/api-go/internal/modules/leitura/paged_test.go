package leitura

import (
	"net/http/httptest"
	"testing"
)

func TestWorkOrderAssigneeFilter(t *testing.T) {
	const user = "00000000-0000-4000-8000-000000000001"
	const other = "00000000-0000-4000-8000-000000000002"
	for _, tc := range []struct {
		name, query string
		want        any
		invalid     bool
	}{
		{name: "unfiltered"},
		{name: "technician", query: "assignee_id=" + other, want: other},
		{name: "current user", query: "mine=1", want: user},
		{name: "mine takes precedence", query: "mine=1&assignee_id=" + other, want: user},
		{name: "invalid UUID", query: "assignee_id=invalid", invalid: true},
		{name: "invalid even when mine", query: "mine=1&assignee_id=invalid", invalid: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/api/work-orders?"+tc.query, nil)
			input, err := parsePaged("/api/work-orders", r, user)
			if (err != nil) != tc.invalid {
				t.Fatalf("invalid=%v, got error %v", tc.invalid, err)
			}
			if !tc.invalid && input.Args[2] != tc.want {
				t.Fatalf("assignee=%v, want %v", input.Args[2], tc.want)
			}
		})
	}
}
