// Package acs speaks the internal GenieACS API without holding database connections.
package acs

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"github.com/google/uuid"
	"io"
	"net/http"
	"net/url"
	"nexoisp/api-go/internal/apierr"
	"nexoisp/api-go/internal/jsonx"
	"os"
	"strings"
	"time"
)

func URL() string { return strings.TrimSuffix(os.Getenv("NEXO_ACS_URL"), "/") }
func Configured() bool {
	u, e := url.Parse(URL())
	return e == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" && u.User == nil && u.RawQuery == "" && u.Fragment == ""
}
func escape(s string) string {
	return strings.NewReplacer("+", "%20", "%21", "!", "%27", "'", "%28", "(", "%29", ")", "%2A", "*").Replace(url.QueryEscape(s))
}
func call(ctx context.Context, path, method string, payload any) (int, any, error) {
	if !Configured() {
		return 0, nil, &apierr.Error{Status: 503, Message: "o gerenciamento de roteadores (TR-069) não está habilitado nesta instalação", Code: "acs_unavailable"}
	}
	var data []byte
	var err error
	if payload != nil {
		data, err = jsonx.Encode(payload)
		if err != nil {
			return 0, nil, err
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, URL()+path, bytes.NewReader(data))
	if err != nil {
		return 0, nil, err
	}
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if user := os.Getenv("NEXO_ACS_USERNAME"); user != "" {
		req.SetBasicAuth(user, os.Getenv("NEXO_ACS_PASSWORD"))
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	defer transport.CloseIdleConnections()
	client := http.Client{Transport: transport, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return fmt.Errorf("ACS redirects are disabled") }}
	response, err := client.Do(req)
	if err != nil {
		return 0, nil, &apierr.Error{Status: 502, Message: "o servidor de gerência de roteadores não respondeu", Code: "acs_down"}
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
	if err != nil {
		return 0, nil, err
	}
	if len(raw) > 2<<20 {
		return 0, nil, apierr.New(502, "resposta ACS excede o limite")
	}
	var body any
	if len(raw) > 0 {
		if json.Unmarshal(raw, &body) != nil {
			return 0, nil, apierr.New(502, "resposta ACS inválida")
		}
	}
	if response.StatusCode >= 500 {
		return 0, nil, &apierr.Error{Status: 502, Message: "o servidor de gerência de roteadores falhou", Code: "acs_error"}
	}
	return response.StatusCode, body, nil
}
func Find(ctx context.Context, filter any, projection string) ([]map[string]any, error) {
	if projection == "" {
		projection = "_id,_lastInform,_deviceId"
	}
	raw, err := jsonx.Encode(filter)
	if err != nil {
		return nil, err
	}
	status, body, err := call(ctx, "/devices/?query="+escape(string(raw))+"&projection="+escape(projection), "GET", nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, apierr.New(502, "consulta ACS recusada")
	}
	out := []map[string]any{}
	if _, ok := body.([]any); !ok {
		return nil, apierr.New(502, "lista ACS inválida")
	}
	if list, ok := body.([]any); ok {
		for _, v := range list {
			if object, ok := v.(map[string]any); ok {
				out = append(out, object)
			}
		}
	}
	return out, nil
}

const ownerPrefix = "nexoisp-tenant:"

func TenantTag(tenant string) string {
	if id, e := uuid.Parse(tenant); e == nil {
		return ownerPrefix + id.String()
	}
	return ownerPrefix + tenant
}
func OwnedBy(device map[string]any, tenant string) bool {
	if uuid.Validate(tenant) != nil {
		return false
	}
	tags, _ := device["_tags"].([]any)
	owner := ""
	count := 0
	for _, raw := range tags {
		if tag, ok := raw.(string); ok && strings.HasPrefix(tag, ownerPrefix) {
			owner = tag
			count++
		}
	}
	return count == 1 && owner == TenantTag(tenant)
}

// Ownership is assigned only by the platform operator in the authoritative ACS
// inventory. Knowing a serial or PPP username never grants ownership of a CPE.
func FindOwned(ctx context.Context, tenant string, filter any, projection string) ([]map[string]any, error) {
	if uuid.Validate(tenant) != nil {
		return nil, apierr.New(403, "tenant ACS inválido")
	}
	if projection == "" {
		projection = "_id,_lastInform,_deviceId,InternetGatewayDevice,Device"
	}
	projection += ",_tags"
	devices, err := Find(ctx, map[string]any{"$and": []any{filter, map[string]any{"_tags": TenantTag(tenant)}}}, projection)
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	for _, d := range devices {
		if OwnedBy(d, tenant) {
			out = append(out, d)
		}
	}
	return out, nil
}
func GetOwned(ctx context.Context, tenant, id, projection string) (map[string]any, error) {
	devices, err := FindOwned(ctx, tenant, map[string]any{"_id": id}, projection)
	if err != nil || len(devices) == 0 {
		return nil, err
	}
	if len(devices) != 1 || devices[0]["_id"] != id {
		return nil, apierr.New(409, "identidade ACS divergente")
	}
	return devices[0], nil
}
func Get(ctx context.Context, id, projection string) (map[string]any, error) {
	if projection == "" {
		projection = "_id,_lastInform,_deviceId,InternetGatewayDevice,Device"
	}
	devices, err := Find(ctx, map[string]any{"_id": id}, projection)
	if err != nil || len(devices) == 0 {
		return nil, err
	}
	if len(devices) != 1 || devices[0]["_id"] != id {
		return nil, apierr.New(409, "identidade ACS divergente")
	}
	return devices[0], nil
}

// TaskReceipt acknowledges the ACS queue, never physical application.
type TaskReceipt struct {
	ID       string
	Accepted bool
}

func SubmitTask(ctx context.Context, id string, payload map[string]any) (TaskReceipt, error) {
	if key, ok := payload["uniqueKey"].(string); !ok || !strings.HasPrefix(key, "nexo:") {
		return TaskReceipt{}, apierr.New(400, "tarefa exige intenção durável")
	}
	status, body, err := call(ctx, "/devices/"+escape(id)+"/tasks", http.MethodPost, payload)
	if err != nil {
		return TaskReceipt{}, err
	}
	if status != 200 && status != 202 {
		return TaskReceipt{}, apierr.New(502, "ACS não confirmou aceite da tarefa; consultar antes de repetir")
	}
	taskID, _ := At(body, "_id").(string)
	if taskID == "" || len(taskID) > 200 || At(body, "device") != id || At(body, "uniqueKey") != payload["uniqueKey"] {
		return TaskReceipt{}, apierr.New(502, "tarefa aceita sem identificador; resultado desconhecido")
	}
	return TaskReceipt{ID: taskID, Accepted: true}, nil
}

// Legacy caller cannot bypass the durable-intent requirement or claim applied.
func Task(ctx context.Context, id string, payload any) (string, error) {
	values, ok := payload.(map[string]any)
	if !ok {
		return "", apierr.New(400, "tarefa inválida")
	}
	_, err := SubmitTask(ctx, id, values)
	return "queued", err
}
func TaskEvidence(ctx context.Context, device, key, remote string) (string, bool, error) {
	raw, _ := json.Marshal(map[string]any{"device": device, "uniqueKey": key})
	status, body, err := call(ctx, "/tasks/?query="+escape(string(raw))+"&projection=_id,device,uniqueKey", http.MethodGet, nil)
	if err != nil {
		return "", false, err
	}
	if status != 200 {
		return "", false, apierr.New(502, "consulta de tarefa ACS recusada")
	}
	list, ok := body.([]any)
	if !ok || len(list) > 1 {
		return "", false, apierr.New(409, "tarefa ACS ambígua")
	}
	found := remote
	if len(list) == 1 {
		obj, ok := list[0].(map[string]any)
		if !ok || obj["device"] != device || obj["uniqueKey"] != key {
			return "", false, apierr.New(409, "identidade da tarefa ACS divergente")
		}
		id, _ := obj["_id"].(string)
		if id == "" || (remote != "" && remote != id) {
			return "", false, apierr.New(409, "identificador de tarefa ACS divergente")
		}
		found = id
	}
	if found != "" {
		raw, _ = json.Marshal(map[string]any{"device": device, "channel": "task_" + found})
		status, faults, e := call(ctx, "/faults/?query="+escape(string(raw))+"&projection=_id,device,channel,code", http.MethodGet, nil)
		if e != nil {
			return "", false, e
		}
		if status != 200 {
			return "", false, apierr.New(502, "consulta de falha ACS recusada")
		}
		rows, ok := faults.([]any)
		if !ok {
			return "", false, apierr.New(502, "resposta de falhas ACS inválida")
		}
		if len(rows) > 0 {
			return found, true, nil
		}
	}
	if len(list) == 0 {
		return "", false, nil
	}
	return found, false, nil
}
func AssignTenant(ctx context.Context, id, tenant, serial string) error {
	if uuid.Validate(tenant) != nil || serial == "" {
		return apierr.New(400, "atribuição ACS inválida")
	}
	device, err := Get(ctx, id, "_id,_deviceId,_tags")
	if err != nil {
		return err
	}
	if device == nil {
		return apierr.New(404, "CPE não encontrado")
	}
	if At(device, "_deviceId._SerialNumber") != serial {
		return apierr.New(409, "serial ACS diverge da atribuição")
	}
	if OwnedBy(device, tenant) {
		return nil
	}
	tags, _ := device["_tags"].([]any)
	for _, tag := range tags {
		if value, ok := tag.(string); ok && strings.HasPrefix(value, ownerPrefix) {
			return apierr.New(409, "CPE já possui propriedade ou atribuição ambígua")
		}
	}
	status, _, err := call(ctx, "/devices/"+escape(id)+"/tags/"+escape(TenantTag(tenant)), http.MethodPost, nil)
	if err != nil {
		return err
	}
	if status != 200 && status != 204 {
		return apierr.New(502, "atribuição ACS não confirmada")
	}
	confirmed, err := GetOwned(ctx, tenant, id, "_id,_tags")
	if err != nil {
		return err
	}
	if confirmed == nil {
		return apierr.New(409, "atribuição ACS não confirmada por leitura")
	}
	return nil
}
