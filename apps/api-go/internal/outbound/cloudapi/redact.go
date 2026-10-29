package cloudapi

import (
	"regexp"
	"strings"
	"unicode/utf16"
)

const textLimitUTF16 = 300

var (
	reBearer = regexp.MustCompile(`(?i)bearer\s+\S+`)
	reEAA    = regexp.MustCompile(`EAA[A-Za-z0-9]{20,}`)
)

// Redact removes generic bearer prefixes and long page tokens that start with EAA.
// Send strips the known bearer and the known recipient before calling Redact.
func Redact(s string) string {
	s = reBearer.ReplaceAllString(s, "")
	s = reEAA.ReplaceAllString(s, "")
	return s
}

func redactKnown(s, bearer, to string) string {
	if bearer != "" {
		s = strings.ReplaceAll(s, "Bearer "+bearer, "")
		s = strings.ReplaceAll(s, bearer, "")
	}
	if to != "" {
		s = strings.ReplaceAll(s, to, "")
	}
	return Redact(s)
}

func capUTF16(s string, max int) string {
	units := utf16.Encode([]rune(s))
	if len(units) > max {
		units = units[:max]
	}
	return string(utf16.Decode(units))
}

func boundSecret(s, bearer, to string) string {
	out := strings.TrimSpace(capUTF16(redactKnown(s, bearer, to), textLimitUTF16))
	if out == "" {
		return "falha cloud api"
	}
	return out
}
