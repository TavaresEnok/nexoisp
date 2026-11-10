package network

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"regexp"
	"strings"

	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/cryptox"
	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
)

// Backup de configuração dos equipamentos que o NexoISP gerencia (OLTs e concentradores com agente).
// A nuvem decide quando: 7 dias depois do último backup, ou na hora quando pedido pelo painel. Depois de uma
// falha, nova tentativa em 6 horas. Ficam só as ConfigBackupKeep cópias mais recentes de cada equipamento.
const ConfigBackupKeep = 4

// Drivers que sabem exportar a configuração (o RADIUS integrado não tem equipamento a consultar).
var ConfigBackupDrivers = []string{"olt_huawei", "olt_zte", "olt_datacom", "mikrotik_radius", "olt_demo", "demo"}

const configBackupDue = `case when d.config_backup_requested_at is not null then d.config_backup_requested_at
	else greatest(coalesce((select max(b.taken_at) from config_backups b where b.tenant_id = d.tenant_id and b.device_id = d.id) + interval '7 days', now()),
		coalesce(d.config_backup_error_at + interval '6 hours', '-infinity'::timestamptz)) end`

// ConfigBackupSchedule é a agenda entregue ao agente: equipamentos dele com backup ligado e a data em que cada um vence.
func ConfigBackupSchedule(ctx context.Context, tx *db.Tx, agent any) ([]jsonx.Object, error) {
	return tx.Objects(ctx, `select d.id as device_id, `+configBackupDue+` as due_at, d.config_backup_requested_at is not null as manual
		from devices d where d.agent_id = $1 and d.config_backup and d.driver = any($2) order by d.id`, agent, ConfigBackupDrivers)
}

// ConfigBackupNextDue é a próxima data de backup de um equipamento (nula com o backup desligado ou sem suporte).
func ConfigBackupNextDue(ctx context.Context, tx *db.Tx, device any) (any, error) {
	rows, err := tx.Objects(ctx, `select case when d.config_backup and d.driver = any($2) and d.agent_id is not null then `+configBackupDue+` end as due_at
		from devices d where d.id = $1`, device, ConfigBackupDrivers)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0].Get("due_at"), nil
}

// Linha de data do cabeçalho do /export do RouterOS: muda a cada exportação sem mudar a configuração.
var volatileConfigLine = regexp.MustCompile(`(?m)^# .* by RouterOS .*\n?`)

// NormalizeConfig deixa o texto comparável entre duas coletas: quebras de linha uniformes, sem espaço no fim da
// linha e sem a linha de data do cabeçalho.
func NormalizeConfig(text string) string {
	lines := strings.Split(strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n"), "\n")
	for i, l := range lines {
		lines[i] = strings.TrimRight(l, " \t")
	}
	return volatileConfigLine.ReplaceAllString(strings.TrimRight(strings.Join(lines, "\n"), "\n")+"\n", "")
}

func ConfigHash(text string) string {
	sum := sha256.Sum256([]byte(NormalizeConfig(text)))
	return hex.EncodeToString(sum[:])
}

// SealConfig comprime e cifra o texto com a chave de segredos (a rotação de chaves recifra a coluna).
func SealConfig(text string) (string, error) {
	var buf bytes.Buffer
	w := gzip.NewWriter(&buf)
	if _, err := w.Write([]byte(text)); err != nil {
		return "", err
	}
	if err := w.Close(); err != nil {
		return "", err
	}
	return cryptox.EncryptSecret(buf.String())
}

func OpenConfig(sealed string) (string, error) {
	plain, err := cryptox.DecryptSecret(sealed)
	if err != nil {
		return "", err
	}
	r, err := gzip.NewReader(strings.NewReader(plain))
	if err != nil {
		return "", err
	}
	defer r.Close()
	out, err := io.ReadAll(io.LimitReader(r, 64<<20))
	return string(out), err
}

// SaveConfigBackup registra o resultado de um backup enviado pelo agente dono do equipamento.
func SaveConfigBackup(ctx context.Context, tx *db.Tx, tenant any, device string, b map[string]any) (map[string]any, error) {
	rows, err := tx.Objects(ctx, `select config_backup, config_backup_requested_at is not null as manual from devices where id = $1 for update`, device)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, apierr.New(404, "equipamento não encontrado")
	}
	if rows[0].Get("config_backup") != true {
		return map[string]any{"ok": true, "ignored": true, "next_due_at": nil}, nil
	}
	trigger := "scheduled"
	if rows[0].Get("manual") == true {
		trigger = "manual"
	}
	out := map[string]any{"ok": true}
	if b["ok"] == true {
		content, _ := b["content"].(string)
		if strings.TrimSpace(content) == "" {
			return nil, apierr.New(400, "backup sem conteúdo")
		}
		hash := ConfigHash(content)
		var changed any
		prev, err := tx.Objects(ctx, `select sha256 from config_backups where device_id = $1 order by taken_at desc, id desc limit 1`, device)
		if err != nil {
			return nil, err
		}
		if len(prev) > 0 {
			changed = prev[0].Get("sha256") != hash
		}
		sealed, err := SealConfig(content)
		if err != nil {
			return nil, err
		}
		saved, err := tx.Objects(ctx, `insert into config_backups (tenant_id, device_id, trigger, size_bytes, lines, sha256, changed, content_enc)
			values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`, tenant, device, trigger, len(content), strings.Count(NormalizeConfig(content), "\n"), hash, changed, sealed)
		if err != nil {
			return nil, err
		}
		if err = tx.Exec(ctx, `delete from config_backups where device_id = $1 and id not in
			(select id from config_backups where device_id = $1 order by taken_at desc, id desc limit $2)`, device, ConfigBackupKeep); err != nil {
			return nil, err
		}
		if err = tx.Exec(ctx, `update devices set config_backup_requested_at = null, config_backup_error = null, config_backup_error_at = null where id = $1`, device); err != nil {
			return nil, err
		}
		out["id"], out["changed"] = saved[0].Get("id"), changed
	} else {
		msg, _ := b["error"].(string)
		if msg == "" {
			msg = "falha sem detalhe"
		}
		if err = tx.Exec(ctx, `update devices set config_backup_requested_at = null, config_backup_error = left($2, 500), config_backup_error_at = now() where id = $1`, device, msg); err != nil {
			return nil, err
		}
	}
	due, err := ConfigBackupNextDue(ctx, tx, device)
	out["next_due_at"] = due
	return out, err
}

// ConfigDiff compara duas cópias linha a linha (Myers) e devolve só os trechos alterados, com contexto.
type DiffLine struct {
	Op   string `json:"op"` // " ", "-", "+"; "@" abre um trecho
	Old  int    `json:"old,omitempty"`
	New  int    `json:"new,omitempty"`
	Text string `json:"text"`
}

const diffMaxEdits, diffContext, diffMaxLines = 2000, 3, 6000

func ConfigDiff(before, after string) (lines []DiffLine, added, removed int, truncated bool) {
	a := strings.Split(strings.TrimRight(NormalizeConfig(before), "\n"), "\n")
	b := strings.Split(strings.TrimRight(NormalizeConfig(after), "\n"), "\n")
	ops, ok := myers(a, b)
	if !ok {
		return nil, 0, 0, true
	}
	// ops: sequência de ' ', '-', '+' sobre a e b
	type step struct {
		op       byte
		old, new int
	}
	steps := make([]step, 0, len(ops))
	i, j := 0, 0
	for _, op := range ops {
		switch op {
		case ' ':
			steps = append(steps, step{' ', i, j})
			i, j = i+1, j+1
		case '-':
			steps = append(steps, step{'-', i, -1})
			removed++
			i++
		case '+':
			steps = append(steps, step{'+', -1, j})
			added++
			j++
		}
	}
	keep := make([]bool, len(steps))
	for k, s := range steps {
		if s.op != ' ' {
			for c := max(0, k-diffContext); c <= min(len(steps)-1, k+diffContext); c++ {
				keep[c] = true
			}
		}
	}
	prev := -2
	for k, s := range steps {
		if !keep[k] {
			continue
		}
		if k != prev+1 {
			lines = append(lines, DiffLine{Op: "@", Old: max(s.old, 0) + 1, New: max(s.new, 0) + 1})
		}
		prev = k
		line := DiffLine{Op: string(s.op)}
		if s.old >= 0 {
			line.Old, line.Text = s.old+1, a[s.old]
		}
		if s.new >= 0 {
			line.New, line.Text = s.new+1, b[s.new]
		}
		lines = append(lines, line)
		if len(lines) >= diffMaxLines {
			return lines, added, removed, true
		}
	}
	return lines, added, removed, false
}

// myers devolve o script de edição mínimo; desiste (ok=false) acima de diffMaxEdits diferenças.
func myers(a, b []string) ([]byte, bool) {
	n, m := len(a), len(b)
	limit := min(n+m, diffMaxEdits)
	off := limit + 1
	v := make([]int, 2*limit+3)
	trace := make([][]int, 0, 64)
	for d := 0; d <= limit; d++ {
		// guarda só a faixa que o recuo vai consultar (k-1..k+1 para k em -d..d)
		snap := make([]int, 2*d+3)
		copy(snap, v[off-d-1:off+d+2])
		trace = append(trace, snap)
		for k := -d; k <= d; k += 2 {
			var x int
			if k == -d || (k != d && v[off+k-1] < v[off+k+1]) {
				x = v[off+k+1]
			} else {
				x = v[off+k-1] + 1
			}
			y := x - k
			for x < n && y < m && a[x] == b[y] {
				x, y = x+1, y+1
			}
			v[off+k] = x
			if x >= n && y >= m {
				return backtrack(trace, a, b, d), true
			}
		}
	}
	return nil, false
}

func backtrack(trace [][]int, a, b []string, d int) []byte {
	x, y := len(a), len(b)
	out := make([]byte, 0, x+y)
	for ; d > 0; d-- {
		v, lo := trace[d], d+1
		k := x - y
		var pk int
		if k == -d || (k != d && v[lo+k-1] < v[lo+k+1]) {
			pk = k + 1
		} else {
			pk = k - 1
		}
		px := v[lo+pk]
		py := px - pk
		for x > px && y > py {
			out = append(out, ' ')
			x, y = x-1, y-1
		}
		if x == px {
			out = append(out, '+')
		} else {
			out = append(out, '-')
		}
		x, y = px, py
	}
	for x > 0 && y > 0 {
		out = append(out, ' ')
		x, y = x-1, y-1
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return out
}
