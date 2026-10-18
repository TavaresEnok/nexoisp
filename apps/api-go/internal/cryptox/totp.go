package cryptox

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"fmt"
	"net/url"
	"strings"
	"time"
	"unicode"
)

func NewTOTP() (string, error) {
	data := make([]byte, 10)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(data), nil
}
func TOTPURI(email, secret string) string {
	return "otpauth://totp/NexoISP:" + strings.ReplaceAll(url.QueryEscape(email), "+", "%20") + "?secret=" + secret + "&period=30&digits=6&algorithm=SHA1&issuer=NexoISP"
}
func CheckTOTP(code, secret string) bool {
	code = strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) || r == '\ufeff' {
			return -1
		}
		return r
	}, code)
	if len(code) != 6 {
		return false
	}
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.TrimRight(strings.ToUpper(secret), "="))
	if err != nil {
		return false
	}
	counter := time.Now().Unix() / 30
	for _, delta := range []int64{0, -1, 1} {
		var data [8]byte
		binary.BigEndian.PutUint64(data[:], uint64(counter+delta))
		h := hmac.New(sha1.New, key)
		_, _ = h.Write(data[:])
		sum := h.Sum(nil)
		offset := sum[len(sum)-1] & 15
		number := (uint32(sum[offset])&127)<<24 | uint32(sum[offset+1])<<16 | uint32(sum[offset+2])<<8 | uint32(sum[offset+3])
		token := fmt.Sprintf("%06d", number%1000000)
		if subtle.ConstantTimeCompare([]byte(token), []byte(code)) == 1 {
			return true
		}
	}
	return false
}

func TOTPCode(secret string, at time.Time) (string, error) {
	key, e := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.TrimRight(strings.ToUpper(secret), "="))
	if e != nil {
		return "", e
	}
	var data [8]byte
	binary.BigEndian.PutUint64(data[:], uint64(at.Unix()/30))
	h := hmac.New(sha1.New, key)
	_, _ = h.Write(data[:])
	sum := h.Sum(nil)
	offset := sum[len(sum)-1] & 15
	number := (uint32(sum[offset])&127)<<24 | uint32(sum[offset+1])<<16 | uint32(sum[offset+2])<<8 | uint32(sum[offset+3])
	return fmt.Sprintf("%06d", number%1000000), nil
}
