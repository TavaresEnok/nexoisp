package escrita

import (
	"nexoisp/api-go/internal/validate"
	"regexp"
	"strings"
)

func (s Service) operations() map[string]operation {
	str := validate.String
	number := validate.Number
	boolean := validate.Boolean
	f := validate.F
	object := validate.Object
	enum := validate.Enum
	name := func(min, max float64) validate.Rule { return str().Trimmed().Min(min).Max(max) }
	uuid := str().UUID()
	version := []validate.Field{f("price_cents", number().Int().Min(0).Max(10000000)), f("down_kbps", number().Int().Positive()), f("up_kbps", number().Int().Positive()), f("profile_name", str().Trimmed().Pattern(`^[A-Za-z0-9_.-]{1,60}$`, "perfil: letras, números, _ . -"))}
	duration := number().Int().Min(0).Max(365).Null()
	cnpj := str().Trimmed().Apply(func(v any) any { return digits(v.(string)) }).Refine(func(v any) bool { return v == "" || len(v.(string)) == 14 }, "CNPJ deve ter 14 dígitos").Then(nilEmpty, false).Opt()
	subscriber := subscriberSchema()
	operations := map[string]operation{
		"POST /api/subscribers":                     {s.createSubscriber, obj(subscriber)},
		"PATCH /api/subscribers/:id":                {s.updateSubscriber, obj(subscriber)},
		"POST /api/plans":                           {s.createPlan, obj(object(append(append([]validate.Field{}, version...), f("name", name(2, 100)))...))},
		"POST /api/plans/:id/versions":              {s.createVersion, obj(object(version...))},
		"PATCH /api/plans/:id":                      {s.updatePlan, obj(object(f("name", name(2, 100).Opt()), f("active", boolean().Opt())))},
		"PUT /api/plans/:id/dunning":                {s.planDunning, obj(object(f("warn_after_days", duration), f("reduce_after_days", duration), f("block_after_days", duration), f("reduced_profile", str().Trimmed().Pattern(`^[A-Za-z0-9_.-]{1,60}$`, "perfil: letras, números, _ . - (até 60)").Null())))},
		"POST /api/contracts":                       {s.createContract, obj(object(f("subscriber_id", uuid), f("plan_id", uuid), f("due_day", number().Int().Min(1).Max(28)), f("start_date", str().Pattern(`^\d{4}-\d{2}-\d{2}$`, "data inválida").Opt()), f("notes", text(2000).Nullish())))},
		"POST /api/tags":                            {s.createTag, obj(object(f("name", name(2, 40))))},
		"DELETE /api/tags/:id":                      {s.deleteTag, nil},
		"PUT /api/contracts/:id/tags":               {s.contractTags, obj(object(f("tag_ids", validate.Array(uuid).Max(30))))},
		"POST /api/companies":                       {s.createCompany, obj(object(f("name", name(2, 120)), f("document", cnpj), f("is_default", boolean().Def(false))))},
		"PATCH /api/companies/:id":                  {s.updateCompany, obj(object(f("name", name(2, 120).Opt()), f("document", cnpj), f("is_default", validate.Literal(true).Opt()), f("active", boolean().Opt())))},
		"PUT /api/contracts/:id/company":            {s.contractCompany, obj(object(f("company_id", uuid.Null())))},
		"PUT /api/anatel/municipalities":            {s.municipality, obj(object(f("name", name(2, 80)), f("state", str().Trimmed().Upper().Pattern(`^[A-Z]{2}$`, "UF com 2 letras")), f("ibge_code", str().Trimmed().Pattern(`^[0-9]{7}$`, "código IBGE com 7 dígitos"))))},
		"PUT /api/plans/:id/technology":             {s.planTechnology, obj(object(f("access_technology", enum("FTTH", "FTTB", "HFC", "XDSL", "ETHERNET", "RADIO", "LTE", "SATELITE", "OUTRA").Null())))},
		"PUT /api/contracts/:id/service-area":       {s.serviceArea, obj(object(f("service_area", enum("urban", "rural"))))},
		"PUT /api/contracts/:id/credit-restriction": {s.creditRestriction, obj(object(f("restricted", boolean()), f("note", name(3, 300))))},
		"POST /api/subscribers/:id/notes":           {s.subscriberNote, obj(object(f("body", name(1, 2000)), f("alert", boolean().Def(false)), f("contract_id", uuid.Nullish()), f("type_id", uuid.Nullish())))},
		"PATCH /api/notes/:id":                      {s.updateNote, obj(object(f("archived", boolean().Opt()), f("alert", boolean().Opt())))},
		"POST /api/maintenance-notices/:id/cancel":  {s.cancelMaintenance, nil},
		"POST /api/maintenance-notices":             {s.createMaintenance, obj(object(f("title", name(3, 120)), f("message", name(3, 1000)), f("severity", enum("info", "degraded", "outage").Def("info")), f("device_id", uuid.Nullish()), f("starts_at", str().Refine(validDateTime, "Invalid datetime")), f("ends_at", str().Refine(validDateTime, "Invalid datetime"))))},
	}
	s.importOperations(operations)
	s.routineOperations(operations)
	s.contractOperations(operations)
	s.financeOperations(operations)
	s.remainingNetworkOperations(operations)
	s.nocOperations(operations)
	s.conditionOperations(operations)
	s.configOperations(operations)
	s.documentOperations(operations)
	s.stockOperations(operations)
	s.infrastructureOperations(operations)
	s.accessOperations(operations)
	s.noticeOperations(operations)
	s.crmOperations(operations)
	s.workOperations(operations)
	s.networkOperations(operations)
	s.cpeOperations(operations)
	s.oltOperations(operations)
	s.radiusOperations(operations)
	s.reportOperations(operations)
	s.ipOperations(operations)
	s.integrationOperations(operations)
	return operations
}

func digits(s string) string { return regexp.MustCompile(`[^0-9]`).ReplaceAllString(s, "") }
func validEmail(s string) bool {
	return !strings.HasPrefix(s, ".") && !strings.Contains(s, "..") && regexp.MustCompile(`(?i)^([A-Z0-9_'+.\-]*)[A-Z0-9_+\-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$`).MatchString(s)
}
func validDocument(d string) bool {
	if len(d) != 11 && len(d) != 14 {
		return false
	}
	if strings.Repeat(d[:1], len(d)) == d {
		return false
	}
	digit := func(index int) int { return int(d[index] - '0') }
	if len(d) == 11 {
		for _, n := range []int{9, 10} {
			sum := 0
			for i := 0; i < n; i++ {
				sum += digit(i) * (n + 1 - i)
			}
			rest := sum * 10 % 11
			if rest == 10 {
				rest = 0
			}
			if rest != digit(n) {
				return false
			}
		}
	} else {
		for _, n := range []int{12, 13} {
			sum := 0
			weight := n - 7
			for i := 0; i < n; i++ {
				sum += digit(i) * weight
				weight--
				if weight == 1 {
					weight = 9
				}
			}
			rest := sum % 11
			if rest < 2 {
				rest = 0
			} else {
				rest = 11 - rest
			}
			if rest != digit(n) {
				return false
			}
		}
	}
	return true
}

func subscriberSchema() validate.Rule {
	f, str, enum := validate.F, validate.String, validate.Enum
	subscriber := []validate.Field{f("name", str().Trimmed().Min(2, "nome obrigatório").Max(200)),
		f("document", str().Nullish().Apply(func(v any) any {
			if v == "" {
				return nil
			}
			return digits(v.(string))
		}).Refine(func(v any) bool { return v == nil || validDocument(v.(string)) }, "CPF/CNPJ inválido").Then(nilEmpty, true)),
		f("email", str().Trimmed().Refine(func(v any) bool { return validEmail(v.(string)) }, "e-mail inválido").Max(200).Nullish().OrEmpty().Then(nilEmpty, true)),
	}
	for _, field := range []struct {
		name string
		max  float64
	}{{"phone", 40}, {"address_street", 200}, {"address_number", 20}, {"address_district", 200}, {"address_city", 200}, {"address_state", 2}, {"address_zip", 12}, {"notes", 2000}} {
		subscriber = append(subscriber, f(field.name, text(field.max).Nullish().Then(nilEmpty, true)))
	}
	subscriber = append(subscriber,
		f("status", enum("active", "inactive").Def("active")), f("birth_date", str().Pattern(`^\d{4}-\d{2}-\d{2}$`, "data de nascimento inválida").Nullish().OrEmpty().Then(nilEmpty, true)),
		f("rg", str().Trimmed().Pattern(`^[0-9A-Za-z.\- /]{3,20}$`, "RG inválido").Nullish().OrEmpty().Then(nilEmpty, true)),
		f("rg_issuer", text(20).Nullish().Then(nilEmpty, true)), f("mother_name", text(200).Nullish().Then(nilEmpty, true)), f("trade_name", text(200).Nullish().Then(nilEmpty, true)))
	return validate.Object(subscriber...)
}
