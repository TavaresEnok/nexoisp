package providers

import (
	"bytes"
	"encoding/base64"
	"encoding/xml"
	"image/png"
	"io"
	"net/url"
	"regexp"
	"strings"
)

// Presentation received from the authenticated provider, never derived from a
// charge ID or a webhook body. Invalid presentation must not invent/lose cash.
type PaymentArtifacts struct {
	PixCopyPaste  string `json:"pix_copy_paste,omitempty"`
	PixQRCode     string `json:"pix_qr_code,omitempty"`
	BoletoURL     string `json:"boleto_url,omitempty"`
	BoletoBarcode string `json:"boleto_barcode,omitempty"`
}

var barcodeShape = regexp.MustCompile(`^[0-9 .-]{44,80}$`)

func SafeBoletoURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && len(raw) <= 2048 && u.Scheme == "https" && u.User == nil && u.Port() == "" && u.Fragment == "" &&
		(u.Host == "visualizacao.gerencianet.com.br" || u.Host == "visualizacao.efipay.com.br")
}

// SVG QR responses are limited to inert geometry; scripts, style, references,
// foreignObject, entities and external resources are rejected rather than used.
func SafeQRCode(raw string) bool {
	if len(raw) > 350000 {
		return false
	}
	var data []byte
	var err error
	if strings.HasPrefix(raw, "data:image/png;base64,") {
		data, err = base64.StdEncoding.DecodeString(strings.TrimPrefix(raw, "data:image/png;base64,"))
		if err != nil {
			return false
		}
		cfg, e := png.DecodeConfig(bytes.NewReader(data))
		return e == nil && cfg.Width > 0 && cfg.Height > 0 && cfg.Width <= 2048 && cfg.Height <= 2048
	}
	if !strings.HasPrefix(raw, "data:image/svg+xml;base64,") {
		return false
	}
	data, err = base64.StdEncoding.DecodeString(strings.TrimPrefix(raw, "data:image/svg+xml;base64,"))
	if err != nil || len(data) > 250000 {
		return false
	}
	d := xml.NewDecoder(bytes.NewReader(data))
	depth := 0
	root := false
	elements := map[string]bool{"svg": true, "g": true, "path": true, "rect": true}
	attrs := map[string]bool{"xmlns": true, "viewBox": true, "width": true, "height": true, "shape-rendering": true, "d": true, "fill": true, "stroke": true, "stroke-width": true, "x": true, "y": true, "transform": true}
	for {
		token, e := d.Token()
		if e == io.EOF {
			return root && depth == 0
		}
		if e != nil {
			return false
		}
		switch t := token.(type) {
		case xml.StartElement:
			if !elements[t.Name.Local] || (t.Name.Space != "" && t.Name.Space != "http://www.w3.org/2000/svg") || (depth == 0 && (root || t.Name.Local != "svg")) {
				return false
			}
			root = true
			depth++
			for _, a := range t.Attr {
				if a.Name.Space != "" || !attrs[a.Name.Local] || strings.ContainsAny(a.Value, "&<>\"'\\") || strings.Contains(strings.ToLower(a.Value), "url(") {
					return false
				}
			}
		case xml.EndElement:
			depth--
		case xml.CharData:
			if strings.TrimSpace(string(t)) != "" {
				return false
			}
		default:
			return false
		}
	}
}

// Clean drops only unusable presentation. Financial identity/status validation
// runs independently, so a QR failure cannot suppress an authoritative receipt.
func (a PaymentArtifacts) Clean() *PaymentArtifacts {
	if len(a.PixCopyPaste) > 8192 || strings.ContainsAny(a.PixCopyPaste, "\r\n\x00") {
		a.PixCopyPaste = ""
	}
	if !SafeQRCode(a.PixQRCode) || a.PixCopyPaste == "" {
		a.PixQRCode = ""
	}
	if !SafeBoletoURL(a.BoletoURL) {
		a.BoletoURL = ""
	}
	if !barcodeShape.MatchString(a.BoletoBarcode) {
		a.BoletoBarcode = ""
	}
	if a == (PaymentArtifacts{}) {
		return nil
	}
	return &a
}
