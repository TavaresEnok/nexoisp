package providers

import (
	"encoding/base64"
	"testing"
)

func TestArtifactsRejectActiveContentAndUnsafeDestinations(t *testing.T) {
	for _, svg := range []string{`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`, `<svg><path fill="url(https://evil.invalid)"/></svg>`, `<svg onload="alert(1)"/>`, `<!DOCTYPE svg SYSTEM "file:///etc/passwd"><svg/>`} {
		if SafeQRCode("data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(svg))) {
			t.Fatal("unsafe SVG accepted")
		}
	}
	for _, url := range []string{"javascript:alert(1)", "http://visualizacao.gerencianet.com.br/x", "https://evil.invalid/x", "https://visualizacao.gerencianet.com.br.evil.invalid/x", "https://secret@visualizacao.gerencianet.com.br/x", "https://visualizacao.gerencianet.com.br:8443/x"} {
		if SafeBoletoURL(url) {
			t.Fatal("unsafe URL accepted")
		}
	}
	if (PaymentArtifacts{PixCopyPaste: "synthetic", BoletoURL: "javascript:x", PixQRCode: "<svg/>"}).Clean().BoletoURL != "" {
		t.Fatal("unsafe artifact retained")
	}
}
