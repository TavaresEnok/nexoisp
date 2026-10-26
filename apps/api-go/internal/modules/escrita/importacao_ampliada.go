package escrita

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/validate"
)

type importOnlyKey struct{}

// Closed catalog: imports never execute remote commands or accept arbitrary SQL/routes.
var networkImports = map[string]string{
	"pop": "POST /api/pops", "agent": "POST /api/agents", "device": "POST /api/devices",
	"radius_device": "POST /api/radius/devices", "pool": "POST /api/ipam/pools",
	"box": "POST /api/ftth/boxes", "drop": "POST /api/ftth/boxes/:id/drops",
	"allocation": "POST /api/ipam/pools/:id/allocations", "delegation": "POST /api/ipam/pools/:id/delegations",
	"cgnat": "POST /api/cgnat/plans", "onu": "POST /api/contracts/:id/onu",
}

func importReference(ctx context.Context, tx *db.Tx, source, kind, external string) (string, error) {
	var sql string
	switch kind {
	case "subscriber":
		sql = "select id from subscribers where external_source=$1 and external_id=$2"
	case "contract":
		sql = "select id from contracts where external_source=$1 and external_id=$2"
	default:
		row, err := importOne(ctx, tx, "select entity_id as id from import_entities where source=$1 and kind=$2 and external_id=$3", source, kind, external)
		if err != nil {
			return "", err
		}
		if row == nil {
			return "", rowError("referência não importada: @" + kind + ":" + external)
		}
		return row.Get("id").(string), nil
	}
	row, err := importOne(ctx, tx, sql, source, external)
	if err != nil {
		return "", err
	}
	if row == nil {
		return "", rowError("referência não importada: @" + kind + ":" + external)
	}
	return row.Get("id").(string), nil
}
func resolveImportReferences(ctx context.Context, tx *db.Tx, source string, value any) (any, error) {
	switch v := value.(type) {
	case string:
		if strings.HasPrefix(v, "@") {
			kind, ext, ok := strings.Cut(v[1:], ":")
			if !ok || ext == "" {
				return nil, rowError("referência no formato @tipo:id_externo")
			}
			return importReference(ctx, tx, source, kind, ext)
		}
	case map[string]any:
		for k, item := range v {
			resolved, e := resolveImportReferences(ctx, tx, source, item)
			if e != nil {
				return nil, e
			}
			v[k] = resolved
		}
	case []any:
		for i, item := range v {
			resolved, e := resolveImportReferences(ctx, tx, source, item)
			if e != nil {
				return nil, e
			}
			v[i] = resolved
		}
	}
	return value, nil
}
func importedEntityID(value any) string {
	switch v := value.(type) {
	case jsonx.Object:
		id, _ := v.Get("id").(string)
		return id
	case map[string]any:
		id, _ := v["id"].(string)
		return id
	}
	return ""
}
func (s Service) importExtended(ctx context.Context, tx *db.Tx, b map[string]any, r map[string]string, plans []jsonx.Object, totals map[string]any, mapped map[string]bool) (map[string]any, error) {
	c := auth.From(ctx)
	if len(c.PopIDs) > 0 {
		return nil, rowError("a importação estrutural exige administrador sem restrição de POP")
	}
	kind, source, ext := b["kind"].(string), b["source"].(string), r["id_externo"]
	if ext == "" || len(ext) > 200 {
		return nil, rowError("id_externo obrigatório, até 200 caracteres")
	}
	entityKind := kind
	if kind == "network" {
		entityKind = r["tipo"]
		if _, ok := networkImports[entityKind]; !ok {
			return nil, rowError("tipo de inventário desconhecido")
		}
	}
	encoded, _ := json.Marshal(r)
	sum := sha256.Sum256(encoded)
	fingerprint := hex.EncodeToString(sum[:])
	// Serialize reimports across API replicas; a successful preview releases the lock on rollback.
	if err := tx.Exec(ctx, "select pg_advisory_xact_lock(hashtextextended($1,7411003))", c.TenantID+":"+source+":"+entityKind+":"+ext); err != nil {
		return nil, err
	}
	prior, err := importOne(ctx, tx, "select entity_id,fingerprint from import_entities where source=$1 and kind=$2 and external_id=$3", source, entityKind, ext)
	if err != nil {
		return nil, err
	}
	if prior != nil {
		if prior.Get("fingerprint") != fingerprint {
			return nil, rowError("registro já importado com conteúdo diferente; ajuste pelo cadastro para preservar decisões posteriores")
		}
		return importResult(ext, "unchanged", prior.Get("entity_id"), []string{}), nil
	}
	var id string
	switch kind {
	case "contracts":
		id, err = importContract(ctx, tx, b, r, plans, totals, mapped)
	case "network":
		var raw map[string]any
		if json.Unmarshal([]byte(r["dados"]), &raw) != nil || raw == nil {
			return nil, rowError("dados deve ser um objeto JSON válido")
		}
		// Resolve only foreign-key fields, so names, passwords and notes beginning with @ remain literal.
		for key, value := range raw {
			if strings.HasSuffix(key, "_id") || strings.HasSuffix(key, "_ids") {
				raw[key], err = resolveImportReferences(ctx, tx, source, value)
				if err != nil {
					return nil, err
				}
			}
		}
		path := networkImports[entityKind]
		if !slices.Contains(c.Permissions, specs[path].Permission) {
			return nil, rowError("permissão insuficiente para este tipo de inventário")
		}
		for _, module := range auth.Modules(strings.TrimPrefix(path, "POST ")) {
			if !slices.Contains(c.Modules, module) {
				return nil, rowError("módulo não habilitado: " + module)
			}
		}
		parent := ""
		if strings.Contains(path, ":id") {
			parent = r["pai"]
			if strings.HasPrefix(parent, "@") {
				v, e := resolveImportReferences(ctx, tx, source, parent)
				if e != nil {
					return nil, e
				}
				parent = v.(string)
			}
			if validate.UUID(parent) != nil {
				return nil, rowError("pai deve referenciar um contrato, pool ou caixa importado")
			}
		}
		op := s.operations()[path]
		if op.handle == nil || op.schema == nil {
			return nil, fmt.Errorf("operação de inventário indisponível: %s", entityKind)
		}
		var body map[string]any
		body, err = op.schema.Parse(raw, true)
		if err == nil {
			var value any
			value, err = op.handle(context.WithValue(ctx, importOnlyKey{}, true), tx, parent, body)
			id = importedEntityID(value)
		}
	case "documents":
		var sub, contract string
		sub, err = importReference(ctx, tx, source, "subscriber", r["id_externo_assinante"])
		if err != nil {
			return nil, err
		}
		var contractValue any
		if r["id_externo_contrato"] != "" {
			contract, err = importReference(ctx, tx, source, "contract", r["id_externo_contrato"])
			if err != nil {
				return nil, err
			}
			contractValue = contract
		}
		op := s.operations()["POST /api/subscribers/:id/documents"]
		var body map[string]any
		body, err = op.schema.Parse(map[string]any{"name": r["nome"], "kind": r["tipo"], "contract_id": contractValue, "content_base64": r["conteudo_base64"]}, true)
		if err == nil {
			var value any
			value, err = s.uploadDocument(ctx, tx, sub, body)
			id = importedEntityID(value)
		}
	case "users":
		id, err = importUser(ctx, tx, source, r)
	}
	if err != nil {
		if e, ok := err.(*apierr.Error); ok && e.Status < 500 {
			return nil, rowError(e.Message)
		}
		return nil, err
	}
	if id == "" {
		return nil, fmt.Errorf("importação não retornou identificador para %s", entityKind)
	}
	err = tx.Exec(ctx, "insert into import_entities (tenant_id,source,kind,external_id,entity_id,fingerprint) values ($1,$2,$3,$4,$5,$6)", c.TenantID, source, entityKind, ext, id, fingerprint)
	return importResult(ext, "created", id, []string{}), err
}

func importContract(ctx context.Context, tx *db.Tx, b map[string]any, r map[string]string, plans []jsonx.Object, totals map[string]any, mapped map[string]bool) (string, error) {
	source := b["source"].(string)
	c := auth.From(ctx)
	sub, err := importReference(ctx, tx, source, "subscriber", r["id_externo_assinante"])
	if err != nil {
		return "", err
	}
	var plan jsonx.Object
	for _, p := range plans {
		if p.Get("id") == bodyRecord(b, "plan_map", r["plano"]) || strings.EqualFold(jsonx.String(p.Get("name")), r["plano"]) {
			plan = p
			break
		}
	}
	if plan == nil {
		return "", rowError("plano não encontrado; cadastre ou mapeie o plano antes de importar")
	}
	due, err := strconv.Atoi(r["vencimento_dia"])
	if err != nil || due < 1 || due > 28 {
		return "", rowError("vencimento_dia deve estar entre 1 e 28")
	}
	var start any
	if r["inicio_contrato"] != "" {
		start = importDate(r["inicio_contrato"])
		if start == nil {
			return "", rowError("inicio_contrato inválido")
		}
	}
	existing, err := importOne(ctx, tx, "select id from contracts where external_source=$1 and external_id=$2", source, r["id_externo"])
	if err != nil {
		return "", err
	}
	if existing != nil {
		return "", rowError("identificador de contrato já utilizado nesta origem")
	}
	row, err := importOne(ctx, tx, "insert into contracts (tenant_id,subscriber_id,plan_version_id,due_day,start_date,external_source,external_id) values ($1,$2,$3,$4,coalesce($5::date,current_date),$6,$7) returning id", c.TenantID, sub, plan.Get("version_id"), due, start, source, r["id_externo"])
	if err != nil {
		return "", err
	}
	id := row.Get("id").(string)
	if r["pppoe_usuario"] != "" {
		if !regexp.MustCompile(`^[A-Za-z0-9_.@-]{3,64}$`).MatchString(r["pppoe_usuario"]) {
			return "", rowError("usuário PPPoE inválido")
		}
		device := b["device_id"]
		if r["equipamento"] != "" {
			device, err = resolveImportReferences(ctx, tx, source, r["equipamento"])
			if err != nil {
				return "", err
			}
		}
		if device == nil || validate.UUID(fmt.Sprint(device)) != nil {
			return "", rowError("informe equipamento de destino")
		}
		dev, e := importOne(ctx, tx, "select id from devices where id=$1 and driver not like 'olt%'", device)
		if e != nil {
			return "", e
		}
		if dev == nil {
			return "", rowError("NAS de destino não encontrado")
		}
		var secret any
		if r["pppoe_senha"] != "" {
			if len(r["pppoe_senha"]) < 6 || len(r["pppoe_senha"]) > 64 {
				return "", rowError("senha PPPoE deve ter 6 a 64 caracteres")
			}
			secret, err = cryptox.EncryptSecret(r["pppoe_senha"])
			if err != nil {
				return "", err
			}
		}
		err = tx.Exec(ctx, "insert into service_resources (tenant_id,contract_id,device_id,pppoe_username,secret_enc,desired_profile,external_source,external_id) values ($1,$2,$3,$4,$5,$6,$7,$8)", c.TenantID, id, device, r["pppoe_usuario"], secret, plan.Get("profile_name"), source, r["id_externo"])
		if err != nil {
			return "", err
		}
		inc(totals, "accounts_created", 1)
		if secret == nil {
			inc(totals, "accounts_without_secret", 1)
		}
	}
	if _, err = importExtras(ctx, tx, b, id, r, mapped, totals, new([]string)); err != nil {
		return "", err
	}
	if err = record(ctx, tx, "contract.import", "contract", id, map[string]any{"source": source, "external_id": r["id_externo"]}); err != nil {
		return "", err
	}
	inc(totals, "contracts_created", 1)
	return id, nil
}

func importUser(ctx context.Context, tx *db.Tx, source string, r map[string]string) (string, error) {
	c := auth.From(ctx)
	if !slices.Contains(c.Permissions, "users:manage") {
		return "", rowError("sem permissão de gestão da equipe")
	}
	if !slices.Contains([]string{"admin", "attendant", "finance", "noc"}, r["perfil"]) {
		return "", rowError("perfil deve ser admin, attendant, finance ou noc; operador SaaS não pode ser importado")
	}
	f := validate.F
	schema := validate.Object(f("email", validate.String().Pattern(`^[^@\s]+@[^@\s]+\.[^@\s]+$`, "e-mail inválido")), f("name", validate.String().Trimmed().Min(2).Max(120)), f("password", validate.String().Min(12).Max(200)))
	password := r["senha"]
	if password == "" {
		var e error
		password, e = cryptox.RandomToken(32)
		if e != nil {
			return "", e
		}
	}
	_, err := schema.Parse(map[string]any{"email": r["email"], "name": r["nome"], "password": password}, true)
	if err != nil {
		return "", rowError("nome, e-mail ou senha inválidos (senha: mínimo 12 caracteres)")
	}
	active := false
	if r["ativo"] != "" {
		switch unaccent(r["ativo"]) {
		case "sim":
			active = true
		case "nao":
		default:
			return "", rowError("ativo deve ser sim ou não")
		}
	}
	if active && r["senha"] == "" {
		return "", rowError("ativação exige senha nova explícita; hashes de senha da origem não são aceitos")
	}
	hash, err := cryptox.HashPassword(password)
	if err != nil {
		return "", err
	}
	row, err := importOne(ctx, tx, "insert into users (tenant_id,email,name,password_hash,role,active) values ($1,lower($2),$3,$4,$5,$6) returning id", c.TenantID, r["email"], r["nome"], hash, r["perfil"], active)
	if err != nil {
		return "", err
	}
	id := row.Get("id").(string)
	for _, external := range strings.Split(r["pops"], "|") {
		if external == "" {
			continue
		}
		pop, e := importReference(ctx, tx, source, "pop", external)
		if e != nil {
			return "", e
		}
		if err = tx.Exec(ctx, "insert into user_pops (tenant_id,user_id,pop_id) values ($1,$2,$3)", c.TenantID, id, pop); err != nil {
			return "", err
		}
	}
	return id, record(ctx, tx, "user.import", "user", id, map[string]any{"role": r["perfil"], "active": active, "source": source})
}
