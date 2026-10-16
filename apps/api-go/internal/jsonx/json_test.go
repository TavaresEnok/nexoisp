package jsonx

import (
	"encoding/json"
	"math/big"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

func TestFastifyGolden(t *testing.T) {
	raw, err := os.ReadFile("../../../../tests/contrato/corpus/jsonx.json")
	if err != nil {
		t.Fatal(err)
	}
	tm, _ := time.Parse(time.RFC3339Nano, "2026-01-02T03:04:05.123456Z")
	o := Object{{"uuid", UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")}, {"instant", Time{tm}}, {"date", Date("2026-01-02")}, {"bigint", Normalize(int64(9007199254740993), 20)}, {"numeric", Normalize(pgtype.Numeric{Int: big.NewInt(1250), Exp: -2, Valid: true}, 1700)}, {"nullable", nil}, {"html", "<>&"}, {"texts", []string{"a", "b"}}, {"object", json.RawMessage(`{"z":1,"aa":2}`)}, {"inet", "127.0.0.1"}, {"cidr", "10.0.0.0/8"}}
	o = append(o, Field{"smallint", int16(7)}, Field{"integer", int32(42)}, Field{"float", 1.25}, Field{"boolean", true}, Field{"stamp", Time{tm}}, Field{"ids", []string{"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}}, Field{"precision", JSON([]byte(`{"line":"x y","large":9007199254740993}`))})
	got, err := Encode(o)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != strings.TrimSpace(string(raw)) {
		t.Fatalf("JSON Fastify divergente\nesperado: %s\nobtido: %s", raw, got)
	}
}
