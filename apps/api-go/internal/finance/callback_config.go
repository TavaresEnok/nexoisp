package finance

import (
	"errors"
	"net"
	"net/url"
	"os"
	"strings"
)

// A server-owned HTTPS origin, never a tenant-supplied arbitrary callback URL.
// No resolver/fetch is used, and no production listener is configured by code.
func ChargesCallbackURL(connection string) (string, error) {
	return callbackURL(os.Getenv("NEXO_GO_EFI_CHARGES_CALLBACK_ORIGIN"), "/api/callbacks/efi/charges/"+connection)
}
func PixCallbackURL(connection string) (string, error) {
	return callbackURL(os.Getenv("NEXO_GO_EFI_PIX_CALLBACK_ORIGIN"), "/callbacks/efi/"+connection)
}
func callbackURL(origin, path string) (string, error) {
	if origin == "" {
		return "", nil
	}
	u, err := url.Parse(origin)
	if err != nil || u.Scheme != "https" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || u.Port() != "" || net.ParseIP(u.Hostname()) != nil || !strings.Contains(u.Hostname(), ".") || strings.HasSuffix(u.Hostname(), ".localhost") {
		return "", errors.New("invalid server-owned charges callback origin")
	}
	u.Path = path
	return u.String(), nil
}
