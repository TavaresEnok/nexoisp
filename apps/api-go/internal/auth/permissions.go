// Permissões e módulos autorizados pelo backend.
package auth

import "regexp"

var Permissions = map[string][]string{
	"saas_operator": {"tenants:manage"},
	"admin":         {"users:manage", "subscribers:read", "subscribers:write", "plans:read", "plans:write", "contracts:read", "contracts:write", "network:read", "network:write", "network:operate", "finance:read", "finance:write", "audit:read", "import:run", "settings:manage", "os:read", "os:write", "stock:read", "stock:write", "crm:read", "crm:write", "trust:grant", "legal:query"},
	"attendant":     {"subscribers:read", "subscribers:write", "plans:read", "contracts:read", "contracts:write", "network:read", "network:operate", "finance:read", "os:read", "os:write", "stock:read", "crm:read", "crm:write", "trust:grant"},
	"finance":       {"subscribers:read", "plans:read", "contracts:read", "finance:read", "finance:write", "crm:read", "crm:write", "trust:grant"},
	"noc":           {"subscribers:read", "plans:read", "contracts:read", "network:read", "network:write", "network:operate", "os:read", "os:write", "stock:read", "stock:write", "crm:read", "crm:write", "legal:query"},
	"subscriber":    {"portal:self"},
}
var moduleRoutes = []struct {
	modules []string
	re      *regexp.Regexp
}{
	{[]string{"olt"}, regexp.MustCompile(`^/api/(olt/|onus(/|$)|contracts/[^/]+/onu$)`)},
	{[]string{"ipam"}, regexp.MustCompile(`^/api/(ipam/|cgnat/|contracts/[^/]+/(ips|ipv6)$)`)},
	{[]string{"field"}, regexp.MustCompile(`^/api/(work-orders(/|$)|stock/|contracts/[^/]+/equipment$|agenda(/|$)|surveys(/|$)|portal/surveys(/|$)|install-kits(/|$))`)},
	{[]string{"crm", "field"}, regexp.MustCompile(`^/api/(sla-policies(/|$)|reports/sla$)`)},
	{[]string{"ftth"}, regexp.MustCompile(`^/api/(ftth/|contracts/[^/]+/ftth$)`)},
	{[]string{"crm"}, regexp.MustCompile(`^/api/(leads(/|$)|tickets(/|$)|crm/|portal/tickets(/|$))`)},
	{[]string{"noc"}, regexp.MustCompile(`^/api/(noc/|contracts/[^/]+/diagnosis$)`)},
	{[]string{"notices"}, regexp.MustCompile(`^/api/notifications(/|$)`)},
	{[]string{"messages"}, regexp.MustCompile(`^/api/(notice-(channels|templates|rules|log)(/|$))`)},
	{[]string{"api"}, regexp.MustCompile(`^/api/(api-tokens|webhook-endpoints|webhook-deliveries|integrations)(/|$)`)},
}

func Modules(path string) []string {
	for _, row := range moduleRoutes {
		if row.re.MatchString(path) {
			return row.modules
		}
	}
	return nil
}
