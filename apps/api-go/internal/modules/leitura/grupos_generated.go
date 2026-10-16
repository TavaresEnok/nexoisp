// Generated route metadata. DO NOT EDIT.
package leitura

import gen "nexoisp/api-go/internal/modules/leitura/gen"

var grupos = []grupo{
	{Path: "/api/acceptances/{id}/evidence", Permission: "contracts:read", SQL: []string{gen.Group29ec64410}},
	{Path: "/api/audit", Permission: "audit:read", SQL: []string{gen.Group3221ef100}},
	{Path: "/api/contracts/{id}/equipment", Permission: "stock:read", SQL: []string{gen.Group3ea49f940, gen.Group3ea49f941}},
	{Path: "/api/contracts/{id}/finance", Permission: "finance:read", SQL: []string{gen.Groupc47037ac0}},
	{Path: "/api/contracts/{id}/radius-log", Permission: "network:read", SQL: []string{gen.Group35c412840, gen.Group35c412841}},
	{Path: "/api/contracts/{id}/states", Permission: "contracts:read", SQL: []string{gen.Groupf9e93af20}},
	{Path: "/api/finance/monthly", Permission: "finance:read", SQL: []string{gen.Group3a79e37d0}},
	{Path: "/api/finance/reconciliation", Permission: "finance:read", SQL: []string{gen.Group152f5ccd0, gen.Group152f5ccd1}},
	{Path: "/api/ftth/boxes/{id}", Permission: "network:read", SQL: []string{gen.Group022be0fb0, gen.Group022be0fb1}},
	{Path: "/api/invoices/{id}", Permission: "finance:read", SQL: []string{gen.Group91a4cc440, gen.Group91a4cc441, gen.Group91a4cc442, gen.Group91a4cc443}},
	{Path: "/api/leads", Permission: "crm:read", SQL: []string{gen.Groupcfbe52020}},
	{Path: "/api/leads/{id}", Permission: "crm:read", SQL: []string{gen.Group775251e10, gen.Group775251e11}},
	{Path: "/api/map/coverage", Permission: "contracts:read", SQL: []string{gen.Group7cd376610, gen.Group7cd376611, gen.Group7cd376612}},
	{Path: "/api/notice-page", Permission: "settings:manage", SQL: []string{gen.Group84bb53020}},
	{Path: "/api/notice-templates", Permission: "settings:manage", SQL: []string{gen.Groupf9f53cac0}},
	{Path: "/api/notifications", Permission: "settings:manage", SQL: []string{gen.Groupcc96ccc10, gen.Groupcc96ccc11}},
	{Path: "/api/radius/allowed-sources", Permission: "network:read", SQL: []string{gen.Groupb8b3464c0}},
	{Path: "/api/settings/retention", Permission: "settings:manage", SQL: []string{gen.Groupb01b24910}},
	{Path: "/api/surveys", Permission: "os:read", SQL: []string{gen.Group9fb1f09c0, gen.Group9fb1f09c1}},
	{Path: "/api/tenants", Permission: "tenants:manage", SQL: []string{"select t.*, (select count(*) from users u where u.tenant_id = t.id and u.role <> 'subscriber') as users,\n                h.agents, h.agents_offline, h.uncertain, h.failed_recent\n         from tenants t left join platform_health() h on h.tenant_id = t.id order by t.name"}},
	{Path: "/api/tickets", Permission: "crm:read", SQL: []string{gen.Group729a22910}},
	{Path: "/api/tickets/{id}", Permission: "crm:read", SQL: []string{gen.Group8a6c68280, gen.Group8a6c68281, gen.Group8a6c68282}},
	{Path: "/api/work-orders", Permission: "os:read", SQL: []string{gen.Groupd4b13e4f0}},
	{Path: "/api/work-orders/{id}", Permission: "os:read", SQL: []string{gen.Group432d4bfb0, gen.Group432d4bfb1, gen.Group432d4bfb2, gen.Group432d4bfb3, gen.Group432d4bfb4}},
}
