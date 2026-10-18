// Package cryptox preserves the persisted cryptographic formats.
package cryptox

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"

	"golang.org/x/crypto/scrypt"
)

func RandomToken(size int) (string, error) {
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}
func SHA256(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}
func HashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	hash, err := scrypt.Key([]byte(password), salt, 16384, 8, 1, 32)
	if err != nil {
		return "", err
	}
	return "scrypt$" + hex.EncodeToString(salt) + "$" + hex.EncodeToString(hash), nil
}
func VerifyPassword(password, stored string) bool {
	p := strings.Split(stored, "$")
	if len(p) != 3 || p[0] != "scrypt" {
		return false
	}
	salt, e := hex.DecodeString(p[1])
	if e != nil {
		return false
	}
	expected, e := hex.DecodeString(p[2])
	if e != nil || len(expected) != 32 {
		return false
	}
	actual, e := scrypt.Key([]byte(password), salt, 16384, 8, 1, 32)
	return e == nil && subtle.ConstantTimeCompare(actual, expected) == 1
}

var secretState struct {
	once sync.Once
	keys [][]byte
	err  error
}

func envKey(name string) ([]byte, error) {
	raw := os.Getenv(name)
	if raw == "" {
		if os.Getenv("NODE_ENV") == "production" && os.Getenv("NEXO_DEMO_MODE") != "1" {
			return nil, fmt.Errorf("%s é obrigatória em produção", name)
		}
		return nil, nil
	}
	return base64.StdEncoding.DecodeString(raw)
}
func secretKeys() ([][]byte, error) {
	secretState.once.Do(func() {
		current, err := envKey("NEXO_SECRET_KEY")
		if err != nil {
			secretState.err = err
			return
		}
		if current == nil {
			current = make([]byte, 32)
			if _, err = rand.Read(current); err != nil {
				secretState.err = err
				return
			}
		}
		secretState.keys = [][]byte{current}
		for _, old := range strings.Split(os.Getenv("NEXO_SECRET_KEY_PREVIOUS"), ",") {
			if old = strings.TrimSpace(old); old != "" {
				key, err := base64.StdEncoding.DecodeString(old)
				if err != nil {
					secretState.err = err
					return
				}
				secretState.keys = append(secretState.keys, key)
			}
		}
		for _, key := range secretState.keys {
			if len(key) != 32 {
				secretState.err = errors.New("NEXO_SECRET_KEY(_PREVIOUS) deve ter 32 bytes (base64)")
				return
			}
		}
	})
	return secretState.keys, secretState.err
}
func EncryptSecret(plain string) (string, error) {
	keys, err := secretKeys()
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(keys[0])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	iv := make([]byte, 12)
	if _, err = rand.Read(iv); err != nil {
		return "", err
	}
	encrypted := gcm.Seal(nil, iv, []byte(plain), nil)
	cut := len(encrypted) - gcm.Overhead()
	encode := base64.StdEncoding.EncodeToString
	return "v1." + encode(iv) + "." + encode(encrypted[cut:]) + "." + encode(encrypted[:cut]), nil
}
func DecryptSecret(stored string) (string, error) {
	p := strings.Split(stored, ".")
	if len(p) != 4 || p[0] != "v1" {
		return "", errors.New("formato de segredo desconhecido")
	}
	keys, err := secretKeys()
	if err != nil {
		return "", err
	}
	iv, e1 := base64.StdEncoding.DecodeString(p[1])
	tag, e2 := base64.StdEncoding.DecodeString(p[2])
	encrypted, e3 := base64.StdEncoding.DecodeString(p[3])
	if e1 == nil && e2 == nil && e3 == nil && len(iv) == 12 {
		for _, key := range keys {
			block, _ := aes.NewCipher(key)
			gcm, _ := cipher.NewGCM(block)
			if len(tag) != gcm.Overhead() {
				continue
			}
			plain, err := gcm.Open(nil, iv, append(append([]byte{}, encrypted...), tag...), nil)
			if err == nil {
				return string(plain), nil
			}
		}
	}
	return "", errors.New("segredo não pôde ser decifrado com as chaves configuradas")
}

// UsesCurrentKey checks authentication with only the active encryption key.
func UsesCurrentKey(stored string) (bool, error) {
	p := strings.Split(stored, ".")
	if len(p) != 4 || p[0] != "v1" {
		return false, errors.New("formato de segredo desconhecido")
	}
	keys, e := secretKeys()
	if e != nil {
		return false, e
	}
	iv, e := base64.StdEncoding.DecodeString(p[1])
	if e != nil || len(iv) != 12 {
		return false, errors.New("IV inválido")
	}
	tag, e := base64.StdEncoding.DecodeString(p[2])
	if e != nil || len(tag) != 16 {
		return false, errors.New("tag inválida")
	}
	data, e := base64.StdEncoding.DecodeString(p[3])
	if e != nil {
		return false, e
	}
	block, e := aes.NewCipher(keys[0])
	if e != nil {
		return false, e
	}
	gcm, e := cipher.NewGCM(block)
	if e != nil {
		return false, e
	}
	_, e = gcm.Open(nil, iv, append(data, tag...), nil)
	return e == nil, nil
}

var signingState struct {
	once sync.Once
	key  ed25519.PrivateKey
	err  error
}

func signingKey() (ed25519.PrivateKey, error) {
	signingState.once.Do(func() {
		raw, err := envKey("NEXO_OP_SIGNING_KEY")
		if err != nil {
			signingState.err = err
			return
		}
		if raw == nil {
			_, signingState.key, signingState.err = ed25519.GenerateKey(rand.Reader)
			return
		}
		key, err := x509.ParsePKCS8PrivateKey(raw)
		if err != nil {
			signingState.err = err
			return
		}
		var ok bool
		signingState.key, ok = key.(ed25519.PrivateKey)
		if !ok {
			signingState.err = errors.New("chave de assinatura não é Ed25519")
		}
	})
	return signingState.key, signingState.err
}
func SignEnvelope(envelope string) (string, error) {
	key, err := signingKey()
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(ed25519.Sign(key, []byte(envelope))), nil
}
func SigningPublicKey() (string, error) {
	key, err := signingKey()
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(key.Public().(ed25519.PublicKey)), nil
}
