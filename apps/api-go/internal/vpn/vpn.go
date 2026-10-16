// Package vpn supervises the shared WireGuard/L2TP network and CoA relay.
package vpn

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"nexoisp/api-go/internal/db"
	"nexoisp/api-go/internal/jsonx"
	"nexoisp/api-go/internal/tenancy"
)

type service struct {
	db                        *db.DB
	state, lastConf, lastChap string
	mu                        sync.Mutex
	children                  map[string]bool
	wg                        sync.WaitGroup
}

func command(ctx context.Context, input, name string, args ...string) (string, error) {
	c := exec.CommandContext(ctx, name, args...)
	if input != "" {
		c.Stdin = strings.NewReader(input)
	}
	b, e := c.Output()
	if e != nil {
		return "", fmt.Errorf("comando %s falhou", name)
	}
	return strings.TrimSpace(string(b)), nil
}
func (s *service) objects(ctx context.Context, q string, args ...any) (out []jsonx.Object, e error) {
	e = s.db.WithScope(ctx, tenancy.Scope{}, func(tx *db.Tx) error { var err error; out, err = tx.Objects(ctx, q, args...); return err })
	return
}
func write(path, content string) error { return os.WriteFile(path, []byte(content), 0600) }

func (s *service) setup(ctx context.Context) error {
	if e := os.MkdirAll(s.state, 0700); e != nil {
		return e
	}
	key := filepath.Join(s.state, "server.key")
	if _, e := os.Stat(key); os.IsNotExist(e) {
		private, e := command(ctx, "", "wg", "genkey")
		if e != nil {
			return e
		}
		if e = write(key, private+"\n"); e != nil {
			return e
		}
	}
	if e := os.Chmod(key, 0600); e != nil {
		return e
	}
	if _, e := command(ctx, "", "ip", "link", "show", "dev", "wg0"); e != nil {
		if _, e = command(ctx, "", "ip", "link", "add", "wg0", "type", "wireguard"); e != nil {
			return e
		}
	}
	for _, args := range [][]string{{"addr", "replace", "10.250.0.1/16", "dev", "wg0"}, {"link", "set", "wg0", "mtu", "1420", "up"}} {
		if _, e := command(ctx, "", "ip", args...); e != nil {
			return e
		}
	}
	if _, e := command(ctx, "", "wg", "set", "wg0", "listen-port", "51820", "private-key", key); e != nil {
		return e
	}
	private, e := os.ReadFile(key)
	if e != nil {
		return e
	}
	public, e := command(ctx, string(private), "wg", "pubkey")
	if e != nil {
		return e
	}
	_, e = s.objects(ctx, "select vpn_set_server_key($1)", public)
	return e
}

func RenderServer(private string, peers []jsonx.Object) string {
	lines := []string{"[Interface]", "PrivateKey = " + strings.TrimSpace(private), "ListenPort = 51820", ""}
	for _, p := range peers {
		lines = append(lines, "[Peer]", "PublicKey = "+jsonx.String(p.Get("public_key")), "AllowedIPs = "+jsonx.String(p.Get("tunnel_ip"))+"/32", "")
	}
	return strings.Join(lines, "\n")
}
func RenderChap(peers []jsonx.Object) string {
	lines := []string{"# gerado pelo NexoISP — não editar"}
	for _, p := range peers {
		lines = append(lines, fmt.Sprintf("\"%s\" nexoisp \"%s\" %s", strings.ReplaceAll(jsonx.String(p.Get("username")), "\"", ""), strings.ReplaceAll(jsonx.String(p.Get("secret")), "\"", ""), jsonx.String(p.Get("tunnel_ip"))))
	}
	return strings.Join(append(lines, ""), "\n")
}

func (s *service) sync(ctx context.Context, l2tp bool, tick int) error {
	peers, e := s.objects(ctx, "select public_key,tunnel_ip from vpn_peers_all() order by tunnel_ip")
	if e != nil {
		return e
	}
	private, e := os.ReadFile(filepath.Join(s.state, "server.key"))
	if e != nil {
		return e
	}
	conf := RenderServer(string(private), peers)
	if conf != s.lastConf {
		path := filepath.Join(s.state, "wg0.conf")
		if e = write(path, conf+"\n"); e != nil {
			return e
		}
		if _, e = command(ctx, "", "wg", "syncconf", "wg0", path); e != nil {
			return e
		}
		s.lastConf = conf
	}
	if tick%3 == 0 {
		dump, e := command(ctx, "", "wg", "show", "wg0", "dump")
		if e != nil {
			return e
		}
		for _, line := range strings.Split(dump, "\n")[1:] {
			f := strings.Split(line, "\t")
			if len(f) < 8 {
				continue
			}
			var handshake, endpoint any
			n, _ := strconv.ParseInt(f[4], 10, 64)
			if n > 0 {
				handshake = time.Unix(n, 0)
			}
			if f[2] != "(none)" && f[2] != "" {
				endpoint = f[2]
			}
			rx, _ := strconv.ParseInt(f[5], 10, 64)
			tx, _ := strconv.ParseInt(f[6], 10, 64)
			if _, e = s.objects(ctx, "select vpn_report($1,$2,$3,$4,$5)", f[0], handshake, endpoint, rx, tx); e != nil {
				return e
			}
		}
	}
	if l2tp {
		s.keep(ctx, "/usr/sbin/ipsec", "start", "--nofork")
		s.keep(ctx, "/usr/sbin/xl2tpd", "-D", "-c", "/etc/xl2tpd/xl2tpd.conf")
		peers, e = s.objects(ctx, "select username,secret,tunnel_ip from l2tp_peers_all($1) order by tunnel_ip", os.Getenv("NEXO_RADIUS_KEY"))
		if e != nil {
			return e
		}
		chap := RenderChap(peers)
		if chap != s.lastChap {
			if e = write("/etc/ppp/chap-secrets", chap); e != nil {
				return e
			}
			s.lastChap = chap
		}
		if tick%3 == 0 {
			out, e := command(ctx, "", "ip", "-o", "-4", "addr", "show")
			if e != nil {
				return e
			}
			up := []string{}
			rx := regexp.MustCompile(`^\d+: ppp\d+.* peer (10\.251\.\d+\.\d+)/`)
			for _, line := range strings.Split(out, "\n") {
				m := rx.FindStringSubmatch(line)
				if len(m) > 1 {
					up = append(up, m[1])
				}
			}
			if _, e = s.objects(ctx, "select l2tp_report($1)", up); e != nil {
				return e
			}
		}
	}
	return nil
}
func (s *service) keep(ctx context.Context, name string, args ...string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.children[name] {
		return
	}
	s.children[name] = true
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		c := exec.CommandContext(ctx, name, args...)
		e := c.Run()
		s.mu.Lock()
		s.children[name] = false
		s.mu.Unlock()
		if ctx.Err() == nil {
			slog.Warn("processo VPN encerrou; nova tentativa no próximo ciclo", "process", name, "failed", e != nil)
		}
	}()
}

func (s *service) l2tp(ctx context.Context) (bool, error) {
	psk := os.Getenv("NEXO_L2TP_PSK")
	if psk == "" {
		return false, nil
	}
	if !regexp.MustCompile(`^[A-Za-z0-9_-]{16,}$`).MatchString(psk) {
		return false, fmt.Errorf("NEXO_L2TP_PSK inválida")
	}
	if os.Getenv("NEXO_RADIUS_KEY") == "" {
		return false, fmt.Errorf("NEXO_RADIUS_KEY obrigatória para L2TP")
	}
	for _, name := range []string{"/usr/sbin/ipsec", "/usr/sbin/xl2tpd", "/usr/sbin/pppd"} {
		if _, e := os.Stat(name); e != nil {
			return false, e
		}
	}
	for _, dir := range []string{"/etc/xl2tpd", "/etc/ppp", "/var/run/xl2tpd", "/etc/strongswan.d"} {
		if e := os.MkdirAll(dir, 0755); e != nil {
			return false, e
		}
	}
	if _, e := os.Stat("/dev/ppp"); os.IsNotExist(e) {
		if _, e = command(ctx, "", "mknod", "/dev/ppp", "c", "108", "0"); e != nil {
			return false, e
		}
	}
	for path, content := range map[string]string{
		"/etc/strongswan.d/nexoisp.conf": "charon {\n  plugins {\n    bypass-lan {\n      load = no\n    }\n  }\n}\n",
		"/etc/ipsec.conf":                ipsecConf,
		"/etc/ipsec.secrets":             "%any %any : PSK \"" + psk + "\"\n",
		"/etc/xl2tpd/xl2tpd.conf":        "[global]\nport = 1701\nipsec saref = no\nforce userspace = yes\n\n[lns default]\nlocal ip = 10.251.0.1\nassign ip = no\nrequire authentication = yes\nrefuse pap = yes\nrequire chap = yes\nname = nexoisp\npppoptfile = /etc/ppp/options.xl2tpd\nlength bit = yes\n",
		"/etc/ppp/options.xl2tpd":        "name nexoisp\nauth\nrefuse-pap\nnodefaultroute\nnoproxyarp\nnoccp\nnovj\nnovjccomp\nnobsdcomp\nnodeflate\nmtu 1400\nmru 1400\nlcp-echo-interval 30\nlcp-echo-failure 4\nnoipdefault\n",
	} {
		if e := write(path, content); e != nil {
			return false, e
		}
	}
	if _, e := os.Stat("/etc/ppp/chap-secrets"); os.IsNotExist(e) {
		if e = write("/etc/ppp/chap-secrets", RenderChap(nil)); e != nil {
			return false, e
		}
	}
	return true, nil
}

const ipsecConf = `config setup
  uniqueids=no

conn nexoisp-l2tp
  keyexchange=ikev1
  authby=secret
  type=transport
  left=%any
  leftprotoport=17/1701
  right=%any
  rightprotoport=17/%any
  auto=add
  ike=aes256-sha256-modp2048,aes256-sha1-modp2048,aes128-sha1-modp2048,aes256-sha1-modp1024,aes128-sha1-modp1024,3des-sha1-modp1024!
  esp=aes256-sha256-modp2048,aes256-sha1-modp2048,aes256-sha1-modp1024,aes192-sha1-modp1024,aes128-sha1-modp1024,aes256-sha256,aes256-sha1,aes128-sha1,3des-sha1!
  dpddelay=30s
  dpdtimeout=120s
  dpdaction=clear
  rekey=no
  ikelifetime=8h
  lifetime=1h
`

// Relay implements the existing 4-byte IPv4 + 2-byte port + RADIUS envelope.
func Relay(ctx context.Context, addr string) error {
	listen, e := net.ResolveUDPAddr("udp4", addr)
	if e != nil {
		return e
	}
	srv, e := net.ListenUDP("udp4", listen)
	if e != nil {
		return e
	}
	defer srv.Close()
	go func() { <-ctx.Done(); _ = srv.Close() }()
	limit := make(chan struct{}, 256)
	var wg sync.WaitGroup
	defer wg.Wait()
	for {
		buf := make([]byte, 65535)
		n, from, e := srv.ReadFromUDP(buf)
		if e != nil {
			if ctx.Err() != nil {
				return nil
			}
			return e
		}
		if n < 26 {
			continue
		}
		select {
		case limit <- struct{}{}:
		default:
			continue
		}
		packet := buf[:n]
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-limit }()
			to := &net.UDPAddr{IP: net.IPv4(packet[0], packet[1], packet[2], packet[3]), Port: int(packet[4])<<8 | int(packet[5])}
			out, e := net.DialUDP("udp4", nil, to)
			if e != nil {
				return
			}
			defer out.Close()
			_ = out.SetDeadline(time.Now().Add(4 * time.Second))
			if _, e = out.Write(packet[6:]); e != nil {
				return
			}
			reply := make([]byte, 65535)
			n, e := out.Read(reply)
			if e == nil {
				_, _ = srv.WriteToUDP(reply[:n], from)
			}
		}()
	}
}

func Run(ctx context.Context, database *db.DB) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	state := os.Getenv("NEXO_VPN_STATE")
	if state == "" {
		state = "/state"
	}
	s := &service{db: database, state: state, children: map[string]bool{}}
	if e := s.setup(ctx); e != nil {
		return e
	}
	l2tp, e := s.l2tp(ctx)
	if e != nil {
		return e
	}
	port := os.Getenv("NEXO_COA_RELAY_PORT")
	if port == "" {
		port = "3798"
	}
	fail := make(chan error, 1)
	go func() { fail <- Relay(ctx, ":"+port) }()
	defer s.wg.Wait()
	defer cancel()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for tick := 0; ; tick++ {
		if e = s.sync(ctx, l2tp, tick); e != nil && ctx.Err() == nil {
			slog.Error("sincronização VPN falhou", "error", e)
		}
		select {
		case <-ctx.Done():
			return nil
		case e = <-fail:
			return e
		case <-ticker.C:
		}
	}
}
