// Package acs speaks the internal GenieACS API without holding database connections.
package acs

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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
	return strings.HasPrefix(URL(), "http://") || strings.HasPrefix(URL(), "https://")
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
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	defer transport.CloseIdleConnections()
	client := http.Client{Transport: transport, CheckRedirect: func(_ *http.Request, via []*http.Request) error {
		if len(via) > 20 {
			return fmt.Errorf("redirecionamentos demais")
		}
		return nil
	}}
	response, err := client.Do(req)
	if err != nil {
		return 0, nil, &apierr.Error{Status: 502, Message: "o servidor de gerência de roteadores não respondeu", Code: "acs_down"}
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		return 0, nil, err
	}
	var body any
	if len(raw) > 0 {
		if json.Unmarshal(raw, &body) != nil {
			body = string(raw)
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
	_, body, err := call(ctx, "/devices/?query="+escape(string(raw))+"&projection="+projection, "GET", nil)
	if err != nil {
		return nil, err
	}
	out := []map[string]any{}
	if list, ok := body.([]any); ok {
		for _, v := range list {
			if object, ok := v.(map[string]any); ok {
				out = append(out, object)
			}
		}
	}
	return out, nil
}
func Get(ctx context.Context, id, projection string) (map[string]any, error) {
	if projection == "" {
		projection = "_id,_lastInform,_deviceId,InternetGatewayDevice,Device"
	}
	devices, err := Find(ctx, map[string]any{"_id": id}, projection)
	if err != nil || len(devices) == 0 {
		return nil, err
	}
	return devices[0], nil
}
func Task(ctx context.Context, id string, payload any) (string, error) {
	status, body, err := call(ctx, "/devices/"+escape(id)+"/tasks?connection_request&timeout=20000", "POST", payload)
	if err != nil {
		return "", err
	}
	if status == 404 {
		return "", apierr.New(404, "roteador não encontrado no servidor de gerência")
	}
	if status != 200 && status != 202 {
		return "", apierr.New(502, fmt.Sprintf("o servidor de gerência recusou a tarefa (%d)", status))
	}
	if status == 200 {
		return "applied", nil
	}
	taskID := At(body, "_id")
	if jsonx.Truthy(taskID) {
		raw, _ := jsonx.Encode(map[string]any{"device": id, "channel": "task_" + jsonx.String(taskID)})
		_, faults, err := call(ctx, "/faults/?query="+escape(string(raw)), "GET", nil)
		if err != nil {
			return "", err
		}
		if list, ok := faults.([]any); ok && len(list) > 0 {
			fault := list[0]
			_, _, _ = call(ctx, "/tasks/"+escape(jsonx.String(taskID)), "DELETE", nil)
			_, _, _ = call(ctx, "/faults/"+escape(jsonx.String(At(fault, "_id"))), "DELETE", nil)
			message := At(fault, "message")
			if message == nil {
				message = At(fault, "code")
			}
			text := "undefined"
			if message != nil {
				text = jsonx.String(message)
			}
			if code := At(fault, "detail.faultCode"); jsonx.Truthy(code) {
				text += " (código " + jsonx.String(code) + ")"
			}
			return "", &apierr.Error{Status: 409, Message: "o roteador recusou: " + text, Code: "cpe_fault"}
		}
	}
	return "queued", nil
}
