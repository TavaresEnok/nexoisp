package escrita

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/netip"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/auth"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/modules/leitura"
	"nexoisp/api-go/internal/radius"
	"nexoisp/api-go/internal/validate"
	"os"
	"regexp"

	"github.com/jackc/pgx/v5/pgconn"
)

func (s Service) radiusOperations(ops map[string]operation) {
	f, o, str, n, e := validate.F, validate.Object, validate.String, validate.Number, validate.Enum
	vendor := e("mikrotik", "huawei", "cisco", "generic")
	ip := str().Trimmed().Refine(func(v any) bool { a, err := netip.ParseAddr(v.(string)); return err == nil && a.Zone() == "" }, "endereço IP inválido")
	create := []validate.Field{f("name", str().Trimmed().Min(2).Max(80)), f("vendor", vendor), f("connection", e("vpn", "l2tp", "direct").Def("direct")), f("nas_ip", ip.Opt()), f("coa_host", text(200).Nullish().Then(nilEmpty, true)), f("coa_port", n().Int().Min(1).Max(65535).Def(float64(3799)))}
	ops["POST /api/radius/devices"] = operation{s.createRadius, obj(o(create...))}
	ops["POST /api/devices/:id/convert-to-integrated"] = operation{s.convertRadius, obj(o(create[1:]...))}
	ops["PATCH /api/radius/devices/:id"] = operation{s.updateRadius, obj(o(f("vendor", vendor.Opt()), f("nas_ip", ip.Opt()), f("coa_host", text(200).Nullish()), f("coa_port", n().Int().Min(1).Max(65535).Opt())))}
	ops["POST /api/radius/devices/:id/secret"] = operation{s.radiusSecret, nil}
	ops["POST /api/radius/devices/:id/tunnel"] = operation{s.radiusTunnel, obj(o(f("kind", e("vpn", "l2tp").Def("vpn"))))}
}
func ipTaken(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "23505" && regexp.MustCompile(`nas_ip`).MatchString(pg.ConstraintName) {
		return apierr.New(409, "este endereço já está cadastrado como concentrador; cada concentrador precisa de um endereço de origem próprio")
	}
	return err
}
func nas(ctx context.Context, tx *db.Tx, id string) (jsonx.Object, error) {
	return mustRow(ctx, tx, "helper:nasOf", 0, "concentrador do RADIUS integrado não encontrado", id)
}
func makeTunnel(ctx context.Context, tx *db.Tx, tenant, device, vendor, kind string) (map[string]any, error) {
	host, port := leitura.RadiusEndpoint()
	if kind == "l2tp" {
		const key = "helper:newL2tp"
		psk := os.Getenv("NEXO_L2TP_PSK")
		if !regexp.MustCompile(`^[A-Za-z0-9_-]{16,}$`).MatchString(psk) {
			return nil, &apierr.Error{Status: 503, Message: "o túnel L2TP/IPsec não está habilitado nesta instalação", Code: "l2tp_unavailable"}
		}
		ip, err := one(ctx, tx, key, 0)
		if err != nil {
			return nil, err
		}
		if ip.Get("ip") == nil {
			return nil, apierr.New(503, "sem endereços livres no túnel L2TP")
		}
		random := make([]byte, 6)
		if _, err = rand.Read(random); err != nil {
			return nil, err
		}
		username := "nx-" + hex.EncodeToString(random)
		password, err := cryptox.RandomToken(15)
		if err != nil {
			return nil, err
		}
		radiusKey, err := radius.Key()
		if err != nil {
			return nil, err
		}
		if err = tx.Exec(ctx, query(key, 1), device); err != nil {
			return nil, err
		}
		if err = tx.Exec(ctx, query(key, 2), device); err != nil {
			return nil, err
		}
		if err = tx.Exec(ctx, query(key, 3), device, tenant, username, password, radiusKey, ip.Get("ip")); err != nil {
			return nil, err
		}
		return map[string]any{"kind": "l2tp", "privateKey": "", "serverPublicKey": "", "endpointHost": host, "endpointPort": 1701, "tunnelIp": ip.Get("ip"), "serverIp": "10.251.0.1", "l2tp": map[string]any{"username": username, "password": password, "psk": psk}}, nil
	}
	const key = "helper:newTunnel"
	if vendor != "mikrotik" && vendor != "generic" {
		return nil, apierr.New(400, "o túnel pelo painel está disponível para MikroTik (RouterOS 7) e equipamentos com WireGuard; para este fabricante use o acesso direto")
	}
	server, err := one(ctx, tx, key, 0)
	if err != nil {
		return nil, err
	}
	if server == nil {
		return nil, &apierr.Error{Status: 503, Message: "o serviço do túnel não está no ar nesta instalação", Code: "vpn_unavailable"}
	}
	raw := make([]byte, 32)
	if _, err = rand.Read(raw); err != nil {
		return nil, err
	}
	raw[0] &= 248
	raw[31] &= 127
	raw[31] |= 64
	private, err := ecdh.X25519().NewPrivateKey(raw)
	if err != nil {
		return nil, err
	}
	ip, err := one(ctx, tx, key, 1)
	if err != nil {
		return nil, err
	}
	if ip.Get("ip") == nil {
		return nil, apierr.New(503, "sem endereços livres no túnel")
	}
	if err = tx.Exec(ctx, query(key, 2), device); err != nil {
		return nil, err
	}
	if err = tx.Exec(ctx, query(key, 3), device); err != nil {
		return nil, err
	}
	if err = tx.Exec(ctx, query(key, 4), device, tenant, ip.Get("ip"), base64.StdEncoding.EncodeToString(private.PublicKey().Bytes())); err != nil {
		return nil, err
	}
	return map[string]any{"privateKey": base64.StdEncoding.EncodeToString(private.Bytes()), "serverPublicKey": server.Get("public_key"), "endpointHost": host, "endpointPort": port, "tunnelIp": ip.Get("ip"), "serverIp": "10.250.0.1"}, nil
}
func (s Service) createRadius(ctx context.Context, tx *db.Tx, _ string, b map[string]any) (any, error) {
	const key = "POST /api/radius/devices"
	if b["connection"] == "direct" && b["nas_ip"] == nil {
		return nil, apierr.New(400, "informe o endereço de origem do concentrador (ou use o túnel)")
	}
	if _, err := radius.Key(); err != nil {
		return nil, err
	}
	secret, err := cryptox.RandomToken(18)
	if err != nil {
		return nil, err
	}
	c := auth.From(ctx)
	agent, err := radius.EnsureAgent(ctx, tx, c.TenantID)
	if err != nil {
		return nil, err
	}
	d, err := one(ctx, tx, key, 0, c.TenantID, b["name"], b["vendor"], b["nas_ip"], agent)
	if err != nil {
		return nil, ipTaken(err)
	}
	var tunnel map[string]any
	if b["connection"] != "direct" {
		tunnel, err = makeTunnel(ctx, tx, c.TenantID, d.Get("id").(string), b["vendor"].(string), b["connection"].(string))
		if err != nil {
			return nil, ipTaken(err)
		}
	}
	nasIP := b["nas_ip"]
	coa := b["coa_host"]
	if tunnel != nil {
		nasIP = tunnel["tunnelIp"]
		coa = nil
	}
	if err = tx.Exec(ctx, query(key, 1), d.Get("id"), nasIP); err != nil {
		return nil, ipTaken(err)
	}
	if err = tx.Exec(ctx, query(key, 2), d.Get("id"), c.TenantID, nasIP, secret, coa, b["coa_port"]); err != nil {
		return nil, ipTaken(err)
	}
	if err = record(ctx, tx, "radius.device_create", "device", d.Get("id"), map[string]any{"vendor": b["vendor"], "connection": b["connection"], "nas_ip": nasIP}); err != nil {
		return nil, err
	}
	setup, err := leitura.RadiusSetupData(b["vendor"].(string), b["coa_port"], secret, tunnel)
	if err != nil {
		return nil, err
	}
	d.Set("nas_ip", nasIP)
	d.Set("secret", secret)
	d.Set("setup", setup)
	return d, nil
}
func (s Service) updateRadius(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "PATCH /api/radius/devices/:id"
	current, err := nas(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	if b["vendor"] != nil {
		if err = tx.Exec(ctx, query(key, 0), id, b["vendor"]); err != nil {
			return nil, ipTaken(err)
		}
	}
	if err = tx.Exec(ctx, query(key, 1), id, b["nas_ip"], has(b, "coa_host"), nilEmpty(b["coa_host"]), b["coa_port"]); err != nil {
		return nil, ipTaken(err)
	}
	if b["nas_ip"] != nil {
		if err = tx.Exec(ctx, query(key, 2), id, b["nas_ip"]); err != nil {
			return nil, ipTaken(err)
		}
	}
	if err = record(ctx, tx, "radius.device_update", "device", id, b); err != nil {
		return nil, err
	}
	row, err := nas(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	row.Set("reapply_needed", b["vendor"] != nil && b["vendor"] != current.Get("vendor"))
	return row, nil
}
func (s Service) radiusSecret(ctx context.Context, tx *db.Tx, id string, _ map[string]any) (any, error) {
	current, err := nas(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	secret, err := cryptox.RandomToken(18)
	if err != nil {
		return nil, err
	}
	if err = tx.Exec(ctx, query("POST /api/radius/devices/:id/secret", 0), id, secret); err != nil {
		return nil, err
	}
	if err = record(ctx, tx, "radius.secret_rotate", "device", id, nil); err != nil {
		return nil, err
	}
	tunnel, err := leitura.RadiusTunnel(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	setup, err := leitura.RadiusSetupData(current.Get("vendor").(string), current.Get("coa_port"), secret, tunnel)
	if err != nil {
		return nil, err
	}
	return map[string]any{"secret": secret, "setup": setup, "note": "O servidor passa a aceitar o segredo novo em até 2 minutos. Troque no concentrador em seguida: enquanto diferirem, ninguém autentica."}, nil
}
func (s Service) radiusTunnel(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/radius/devices/:id/tunnel"
	current, err := nas(ctx, tx, id)
	if err != nil {
		return nil, err
	}
	tunnel, err := makeTunnel(ctx, tx, auth.From(ctx).TenantID, id, current.Get("vendor").(string), b["kind"].(string))
	if err != nil {
		return nil, err
	}
	if err = tx.Exec(ctx, query(key, 0), id, tunnel["tunnelIp"]); err != nil {
		return nil, err
	}
	if err = tx.Exec(ctx, query(key, 1), id, tunnel["tunnelIp"]); err != nil {
		return nil, err
	}
	if err = record(ctx, tx, "radius.device_tunnel", "device", id, map[string]any{"tunnel_ip": tunnel["tunnelIp"], "kind": b["kind"]}); err != nil {
		return nil, err
	}
	setup, err := leitura.RadiusSetupData(current.Get("vendor").(string), 3799, "<SEGREDO>", tunnel)
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "nas_ip": tunnel["tunnelIp"], "setup": setup, "note": "O segredo do RADIUS não mudou. Aplique os comandos do túnel e aponte o RADIUS do concentrador para o endereço interno."}, nil
}
func (s Service) convertRadius(ctx context.Context, tx *db.Tx, id string, b map[string]any) (any, error) {
	const key = "POST /api/devices/:id/convert-to-integrated"
	if b["connection"] == "direct" && b["nas_ip"] == nil {
		return nil, apierr.New(400, "informe o endereço de origem do concentrador (ou use o túnel)")
	}
	if _, err := radius.Key(); err != nil {
		return nil, err
	}
	secret, err := cryptox.RandomToken(18)
	if err != nil {
		return nil, err
	}
	device, err := mustRow(ctx, tx, key, 0, "equipamento não encontrado", id)
	if err != nil {
		return nil, err
	}
	if device.Get("driver") != "mikrotik_radius" && device.Get("driver") != "demo" {
		return nil, apierr.New(400, "só concentradores PPPoE podem passar ao RADIUS integrado")
	}
	busy, err := one(ctx, tx, key, 1, id)
	if err != nil {
		return nil, err
	}
	if busy != nil {
		return nil, apierr.New(409, "há operações em aberto no equipamento; aguarde concluírem")
	}
	c := auth.From(ctx)
	agent, err := radius.EnsureAgent(ctx, tx, c.TenantID)
	if err != nil {
		return nil, err
	}
	var tunnel map[string]any
	if b["connection"] != "direct" {
		tunnel, err = makeTunnel(ctx, tx, c.TenantID, id, b["vendor"].(string), b["connection"].(string))
		if err != nil {
			return nil, ipTaken(err)
		}
	}
	nasIP, coa := b["nas_ip"], b["coa_host"]
	if tunnel != nil {
		nasIP, coa = tunnel["tunnelIp"], nil
	}
	if err = tx.Exec(ctx, query(key, 2), id, b["vendor"], agent, nasIP); err != nil {
		return nil, ipTaken(err)
	}
	if err = tx.Exec(ctx, query(key, 3), id, c.TenantID, nasIP, secret, coa, b["coa_port"]); err != nil {
		return nil, ipTaken(err)
	}
	resources, err := rows(ctx, tx, key, 4, id)
	if err != nil {
		return nil, err
	}
	for _, r := range resources {
		if _, err = requestNetwork(ctx, tx, r.Get("id").(string), "subscriber.provision", "passagem para o RADIUS integrado", ""); err != nil {
			return nil, err
		}
	}
	missing, err := one(ctx, tx, key, 5, id)
	if err != nil {
		return nil, err
	}
	if err = record(ctx, tx, "radius.device_convert", "device", id, map[string]any{"vendor": b["vendor"], "connection": b["connection"], "nas_ip": nasIP, "accounts": len(resources)}); err != nil {
		return nil, err
	}
	setup, err := leitura.RadiusSetupData(b["vendor"].(string), b["coa_port"], secret, tunnel)
	if err != nil {
		return nil, err
	}
	return map[string]any{"id": id, "accounts_requested": len(resources), "accounts_without_secret": missing.Get("n"), "secret": secret, "setup": setup}, nil
}
