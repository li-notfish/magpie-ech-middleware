// Command ech-sidecar is the transport behind the ech magpie plugin.
//
// A network that blocks a domain by its TLS SNI cannot read the name inside
// an Encrypted Client Hello, so a connection that carries one goes through.
// This program keeps such a connection to the upstreams it is given and
// forwards HTTP to them: it resolves each upstream's ECHConfigList over
// DoH, connects with Encrypted Client Hello, and serves the upstreams on
// 127.0.0.1 so that the plugin can point a provider's base URL at it.
//
// Usage:
//
//	ech-sidecar -upstreams-file upstreams.json [-listen 127.0.0.1:8790]
//	           [-ech-fallback cloudflare|always|off|<base64 ECHConfigList>]
//
// -ech-fallback defaults to cloudflare: the built-in ECH config of
// Cloudflare's edge, offered only to upstreams whose address is in
// Cloudflare's own networks. A zone behind Cloudflare need not enable ECH:
// when the edge rejects the built-in list without offering another one, the
// connection is retried with plain TLS, but a list from DoH or from the user
// is never silently downgraded. ECH_SIDECAR_ECH_FALLBACK overrides it when
// the flag is not given; always offers it to every upstream; "" or off
// turns the fallback off.
//
// The upstreams file is a JSON object: each name is an upstream the
// plugin serves, and each address is where that upstream is reached.
//
//	{"nvidia": "https://api.example.com/v1"}
//
// A request is served by the upstream its path names: a request for
// /nvidia/chat/completions goes to the upstream "nvidia", and what is
// left of the path is put under that upstream's own path.
//
// The listening port is written to stdout as one JSON line, and to
// -port-file when that is given.
//
// The sidecar listens before it looks the ECH config up: the plugin waits
// for the line above, and a DNS lookup must not hold it up. A request that
// comes while the config is still being looked up waits for it, so no
// request goes out in the clear because the lookup was slow.
package main

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	// dialTimeout bounds the TCP connect to the upstream.
	dialTimeout = 15 * time.Second

	// handshakeTimeout bounds the TLS handshake, the ECH part included.
	handshakeTimeout = 20 * time.Second

	// dohWait bounds one resolver's answer. Every endpoint is asked at
	// once, and the first config list wins; a resolver that has not
	// answered by then must not hold the first model list up.
	dohWait = 5 * time.Second

	// fallbackHandshakeTimeout bounds a handshake made with the built-in
	// Cloudflare fallback. That list is only a guess, and an edge that
	// offers another one may still not complete here: neither attempt may
	// spend the whole request's time.
	fallbackHandshakeTimeout = 4 * time.Second

	// healthPath answers the plugin's own check without touching the
	// upstream.
	healthPath = "/_ech/health"

	// configWait is how long the ECH config is looked up again after a
	// resolver refused to answer.
	configWait = 10 * time.Second

	// upstreamWait is how often the upstreams file is read again.
	upstreamWait = 2 * time.Second
)

// defaultDoH are the endpoints asked for the upstream's HTTPS record, all
// at once, first answer with a config list winning. Alidns and its plain-IP
// form answer from inside the network the plugin runs on, which is the
// network where the blocking happens; the others may not be reached at all
// from it.
const defaultDoH = "https://dns.alidns.com/resolve,https://223.5.5.5/resolve,https://dns.google/resolve,https://cloudflare-dns.com/dns-query"

// fallbackECH is the ECH config list of Cloudflare's edge, kept for the
// upstreams behind it (a Cloudflare-proxied site, which is most of them)
// when every DoH endpoint answers without one: from a network that blocks
// the public resolvers, or one whose resolvers strip the record, the lookup
// finds nothing, and without this the sidecar could never connect. The
// cover name it carries is cloudflare-ech.com. The built-in fallback is
// offered only to a host whose address is in Cloudflare's own networks:
// another server would answer under the cover name, and the handshake
// would fail. "always" offers it to every host. -ech-fallback and
// ECH_SIDECAR_ECH_FALLBACK change it; "" or "off" turns it off, and an
// ECH config given by hand for an upstream always wins over all of them.
// It is the config cloudflare-ech.com published when this was written; the
// edge may offer a newer one in a rejection, and that is retried.
const fallbackECH = "AEX+DQBB0gAgACDFD85iIN6Pl/peBoQUS6kYYD6wzOeSYr/0XJMStAQwcgAEAAEAAQASY2xvdWRmbGFyZS1lY2guY29tAAA="

// fallbackEnv is the environment variable that overrides -ech-fallback.
const fallbackEnv = "ECH_SIDECAR_ECH_FALLBACK"

// upstream is one address the sidecar serves: the name it is called by in
// the path, the address it forwards to, and the ECH config it connects
// with.
type upstream struct {
	name string
	url  *url.URL
	ech  string

	mu       sync.Mutex
	list     []byte
	cover    string
	fallback bool
	plain    bool

	// ready is closed when the first config list arrives, and allowPlain
	// says the sidecar goes on without one when there is none. plain is
	// whether that is what this upstream does now: the user allowed it, or
	// the server rejected the speculative built-in config and the request
	// was retried without ECH.
	ready      chan struct{}
	once       sync.Once
	allowPlain bool

	transport *http.Transport
	proxy     *httputil.ReverseProxy
}

// sidecar is the upstreams it serves, by name.
type sidecar struct {
	mu          sync.RWMutex
	ups         map[string]*upstream
	allowPlain  bool
	doh         string
	echFallback echFallback
}

// echFallback is the config list used when no resolver gives one. A list
// the user gave is used for every upstream; the built-in Cloudflare list
// is only for hosts behind Cloudflare.
type echFallback struct {
	list    []byte
	builtin bool
	always  bool
}

func main() {
	listen := flag.String("listen", "127.0.0.1:8790", "address to listen on")
	upstreams := flag.String("upstreams-file", "", "file the upstreams are read from")
	doh := flag.String("doh", defaultDoH, "comma separated DoH endpoints asked for the HTTPS record")
	fallbackFlag := flag.String("ech-fallback", "cloudflare", "ECH config list used when DoH gives none: cloudflare (built-in, Cloudflare hosts only), a base64 ECHConfigList (every host), or \"\" to turn it off")
	portFile := flag.String("port-file", "", "file the listening port is written to")
	allowPlain := flag.Bool("allow-plain", false, "go on without ECH when no config list is found")
	flag.Parse()

	if *upstreams == "" {
		fail("no upstream file given: -upstreams-file <file> is required")
	}

	fallback, err := fallbackOf(*fallbackFlag, flagWasSet("ech-fallback"))
	if err != nil {
		fail("%v", err)
	}

	sc := &sidecar{
		ups:         map[string]*upstream{},
		allowPlain:  *allowPlain,
		doh:         *doh,
		echFallback: fallback,
	}
	log.Printf("the ECH fallback is %s", fallback.describe())
	if err := sc.read(*upstreams); err != nil {
		fail("the upstreams cannot be read: %v", err)
	}
	go sc.watch(*upstreams)

	mux := http.NewServeMux()
	mux.HandleFunc(healthPath, sc.health)
	mux.HandleFunc("/", sc.serve)

	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		fail("cannot listen on %s: %v", *listen, err)
	}
	port := ln.Addr().(*net.TCPAddr).Port

	status := sc.status()
	status["port"] = port
	out, err := json.Marshal(status)
	if err != nil {
		fail("cannot write the status: %v", err)
	}
	fmt.Println(string(out))
	if err := os.Stdout.Sync(); err != nil {
		// A pipe cannot be synced; the line is written either way.
		_ = err
	}
	if *portFile != "" {
		if err := os.WriteFile(*portFile, []byte(fmt.Sprintf("%d", port)), 0o644); err != nil {
			fail("cannot write the port file %s: %v", *portFile, err)
		}
	}

	server := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 30 * time.Second,
	}

	stopped := make(chan struct{})
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-signals
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
		close(stopped)
	}()

	if err := server.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fail("the server stopped: %v", err)
	}
	<-stopped
}

// read reads the upstreams file: the names the sidecar serves and the
// addresses they are reached at. What the file says more than that is
// kept: an ECH config given by hand for a provider that publishes none.
func (sc *sidecar) read(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	var parsed map[string]json.RawMessage
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return err
	}
	seen := map[string]bool{}
	for name, value := range parsed {
		address, ech, err := upstreamOf(value)
		if err != nil {
			log.Printf("the upstream %q is not an address: %v", name, err)
			continue
		}
		seen[name] = true
		sc.mu.Lock()
		old, had := sc.ups[name]
		sc.mu.Unlock()
		if had && old.url.String() == address && old.ech == ech {
			continue
		}
		u, err := newUpstream(name, address, ech, sc.allowPlain)
		if err != nil {
			log.Printf("the upstream %q is not an address: %v", name, err)
			continue
		}
		sc.mu.Lock()
		sc.ups[name] = u
		sc.mu.Unlock()
		if had {
			log.Printf("the upstream %q now points at %s", name, address)
		}
		go u.resolve(sc.doh, sc.echFallback)
	}
	sc.mu.Lock()
	for name := range sc.ups {
		if !seen[name] {
			delete(sc.ups, name)
			log.Printf("the upstream %q is gone", name)
		}
	}
	sc.mu.Unlock()
	return nil
}

// watch reads the upstreams file again when it changes: a provider added
// later is served without the sidecar being started again.
func (sc *sidecar) watch(path string) {
	last := stamp(path)
	for {
		time.Sleep(upstreamWait)
		now := stamp(path)
		if now == last {
			continue
		}
		last = now
		if err := sc.read(path); err != nil {
			log.Printf("the upstreams could not be read: %v", err)
		}
	}
}

// stamp is the file's size and when it was written: what says that it
// changed.
func stamp(path string) string {
	fi, err := os.Stat(path)
	if err != nil {
		return ""
	}
	return fmt.Sprintf("%d:%d", fi.Size(), fi.ModTime().UnixNano())
}

// upstreamOf is the address an upstream is reached at, and the ECH
// config given by hand for it: the file holds either the address alone
// or an object of the address and the config.
func upstreamOf(raw json.RawMessage) (string, string, error) {
	var address string
	if err := json.Unmarshal(raw, &address); err == nil {
		return address, "", nil
	}
	var obj struct {
		URL string `json:"url"`
		ECH string `json:"ech"`
	}
	if err := json.Unmarshal(raw, &obj); err != nil {
		return "", "", err
	}
	if obj.URL == "" {
		return "", "", errors.New("it names no address")
	}
	return obj.URL, obj.ECH, nil
}

// newUpstream is the upstream the name is called by, reached at the
// address, with the ECH config given by hand (empty when there is none).
func newUpstream(name, address, ech string, allowPlain bool) (*upstream, error) {
	target, err := url.Parse(address)
	if err != nil || target.Host == "" {
		return nil, fmt.Errorf("the address %q is not a URL", address)
	}
	if target.Scheme != "https" {
		return nil, fmt.Errorf("the address %q is not https", address)
	}
	target.Path = strings.TrimSuffix(target.Path, "/")

	u := &upstream{
		name:       name,
		url:        target,
		ech:        ech,
		ready:      make(chan struct{}),
		allowPlain: allowPlain,
		plain:      allowPlain,
	}
	u.transport = &http.Transport{
		DialContext:         (&net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}).DialContext,
		DialTLSContext:      u.dial,
		ForceAttemptHTTP2:   true,
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: handshakeTimeout,
	}
	u.proxy = &httputil.ReverseProxy{
		Director:  u.direct,
		Transport: u.transport,
		// A reply that streams is written as it arrives: a flush per
		// write is what an SSE answer needs to reach the agent while it
		// is still being made.
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("the request to %s failed: %v", target.Host, err)
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			fmt.Fprintf(w, `{"error":{"message":%q,"type":"ech_upstream_unreachable"}}`, err.Error())
		},
	}
	return u, nil
}

// serve hands the request to the upstream its path names.
func (sc *sidecar) serve(w http.ResponseWriter, r *http.Request) {
	name, rest := split(r.URL.Path)
	sc.mu.RLock()
	u := sc.ups[name]
	sc.mu.RUnlock()
	if u == nil {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		fmt.Fprintf(w, `{"error":{"message":%q,"type":"ech_no_upstream"}}`, "no upstream is called "+name)
		return
	}
	r.URL.Path = rest
	r.URL.RawPath = ""
	u.proxy.ServeHTTP(w, r)
}

// split is the name an upstream is called by, and what is left of the
// path: the name is what is before the first slash.
func split(path string) (string, string) {
	p := strings.TrimPrefix(path, "/")
	at := strings.Index(p, "/")
	if at < 0 {
		return p, "/"
	}
	return p[:at], p[at:]
}

// health answers the plugin's check: it says that the sidecar is up and
// what it connects with, without making any upstream answer.
func (sc *sidecar) health(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(sc.status())
}

// status is what the sidecar serves now: each upstream, its address, and
// whether it is connected with an ECH config.
func (sc *sidecar) status() map[string]any {
	out := map[string]any{"ok": true, "upstreams": map[string]any{}}
	sc.mu.RLock()
	defer sc.mu.RUnlock()
	for name, u := range sc.ups {
		out["upstreams"].(map[string]any)[name] = map[string]any{
			"url":   u.url.String(),
			"ech":   u.hasECH(),
			"cover": u.coverName(),
		}
	}
	return out
}

// direct sends the request to the upstream, under the upstream's own name:
// the Host header and the TLS SNI are the upstream's, not the sidecar's.
func (u *upstream) direct(req *http.Request) {
	req.URL.Scheme = u.url.Scheme
	req.URL.Host = u.url.Host
	req.URL.Path = joinPath(u.url.Path, req.URL.Path)
	if req.URL.RawPath != "" {
		req.URL.RawPath = joinPath(u.url.Path, req.URL.RawPath)
	}
	req.Host = u.url.Host
}

// resolve looks the upstream's ECH config up over DoH and keeps looking
// until it finds one: the record may carry it only later, and a resolver
// that refuses must not keep the sidecar from serving. When no resolver
// gives one and a fallback config is set, the fallback is used: from a
// network whose resolvers strip the HTTPS record, that is the only way to
// connect with ECH at all. It gives up when the sidecar is told to go on
// without one.
func (u *upstream) resolve(doh string, fallback echFallback) {
	host := u.url.Hostname()
	declined := false
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		list, err := echConfigList(ctx, host, u.ech, doh)
		cancel()
		if err == nil {
			u.setList(list)
			log.Printf("ECH for %s uses the cover name %q", host, u.coverName())
			return
		}
		log.Printf("no ECH config for %s: %v", host, err)
		if u.ech == "" && fallback.forHost(host) {
			if fallback.builtin {
				u.setFallback(fallback.list)
			} else {
				u.setList(fallback.list)
			}
			log.Printf("ECH for %s uses %s, cover name %q", host, fallback.source(), u.coverName())
			return
		}
		if u.ech == "" && fallback.builtin && len(fallback.list) > 0 && !declined {
			log.Printf("the built-in ECH fallback is not used for %s: its address is not Cloudflare's", host)
			declined = true
		}
		if u.allowPlain {
			log.Printf("going on without ECH for %s", host)
			return
		}
		time.Sleep(configWait)
	}
}

// fallbackOf is the fallback the flag, the environment or the built-in
// default names. The flag wins when it was given, then the environment,
// then the built-in Cloudflare config.
func fallbackOf(flagValue string, flagGiven bool) (echFallback, error) {
	value := flagValue
	source := "-ech-fallback"
	if !flagGiven {
		if env, ok := os.LookupEnv(fallbackEnv); ok {
			value = env
			source = fallbackEnv
		}
	}
	fallback, err := parseFallback(value)
	if err != nil {
		return echFallback{}, fmt.Errorf("%s: %w", source, err)
	}
	return fallback, nil
}

// parseFallback reads what the flag or the environment says: off, the
// built-in Cloudflare config, or a base64 config of the user's own.
func parseFallback(value string) (echFallback, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "0", "false", "no", "off", "none", "disable", "disabled":
		return echFallback{}, nil
	case "1", "true", "yes", "on", "cloudflare", "builtin", "built-in", "default", "auto":
		list, err := decodeECHList(fallbackECH)
		if err != nil {
			return echFallback{}, fmt.Errorf("the built-in ECH config is not base64: %w", err)
		}
		return echFallback{list: list, builtin: true}, nil
	case "always", "force", "any":
		list, err := decodeECHList(fallbackECH)
		if err != nil {
			return echFallback{}, fmt.Errorf("the built-in ECH config is not base64: %w", err)
		}
		return echFallback{list: list, builtin: true, always: true}, nil
	default:
		list, err := decodeECHList(strings.TrimSpace(value))
		if err != nil {
			return echFallback{}, fmt.Errorf("the ECH config is not base64: %w", err)
		}
		return echFallback{list: list}, nil
	}
}

// decodeECHList reads an ECHConfigList as base64, with or without the
// padding.
func decodeECHList(value string) ([]byte, error) {
	list, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		list, err = base64.RawStdEncoding.DecodeString(value)
	}
	if err != nil {
		return nil, err
	}
	if len(list) == 0 {
		return nil, errors.New("it is empty")
	}
	return list, nil
}

// flagWasSet says whether the user gave the flag, so that the environment
// does not override it.
func flagWasSet(name string) bool {
	given := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == name {
			given = true
		}
	})
	return given
}

// forHost says whether the fallback is for this upstream. A config the
// user gave is theirs to apply everywhere; the built-in Cloudflare one is
// only for a host whose address is Cloudflare's, because another server
// would answer under the cover name and fail the handshake.
func (f echFallback) forHost(host string) bool {
	if len(f.list) == 0 {
		return false
	}
	if !f.builtin || f.always {
		return true
	}
	return cloudflareHost(host)
}

// describe is what the log says about the fallback, without the config
// itself.
func (f echFallback) describe() string {
	switch {
	case len(f.list) == 0:
		return "off"
	case f.always:
		return "the built-in Cloudflare config, for every upstream"
	case f.builtin:
		return "the built-in Cloudflare config, for hosts behind Cloudflare"
	default:
		return "the config given, for every upstream"
	}
}

// source is what the log says when the fallback is used.
func (f echFallback) source() string {
	if f.builtin {
		return "the built-in Cloudflare fallback"
	}
	return "the configured fallback"
}

// dial connects to the upstream with Encrypted Client Hello. A server that
// refuses the config list we sent offers another one; the handshake is made
// again with it. The built-in fallback is only a guess, though: when the edge
// rejects it, offers a config that does not complete, or does not answer at
// all, the connection is made with plain TLS. A config from DoH or from the
// user is authoritative, and is not silently downgraded.
func (u *upstream) dial(ctx context.Context, network, addr string) (net.Conn, error) {
	list, fallback, plain := u.echList(ctx)
	if len(list) == 0 && !plain {
		return nil, fmt.Errorf("no ECH config for %s: the lookup did not finish in time", u.url.Hostname())
	}
	timeout := handshakeTimeout
	attempts := 3
	if fallback {
		timeout = fallbackHandshakeTimeout
		// The built-in list and the one retry the edge may offer are
		// enough: a guess that has not connected by then is not going
		// to make the first listing in time.
		attempts = 2
	}
	var err error
	var retry []byte
	// Each edge of a network may know a different config list, so a
	// rejection is answered with the list that edge offers and the
	// handshake is made again with it.
	for attempt := 0; attempt < attempts; attempt++ {
		var conn net.Conn
		conn, err = u.handshake(ctx, network, addr, list, timeout)
		if err == nil {
			// A config the edge offered and then accepted is the
			// authoritative one for the connections that follow.
			if len(retry) > 0 {
				u.setList(retry)
			}
			return conn, nil
		}
		var rejected *tls.ECHRejectionError
		if !errors.As(err, &rejected) {
			// A built-in list that timed out or could not be
			// connected with is no more final than a rejection:
			// plain TLS may still serve the upstream.
			if fallback {
				break
			}
			return nil, err
		}
		if len(rejected.RetryConfigList) == 0 {
			// A published config is strict: there is nothing more
			// to try. The built-in one was only a guess, so the
			// request goes on without ECH.
			if !fallback {
				return nil, err
			}
			break
		}
		retry = rejected.RetryConfigList
		list = rejected.RetryConfigList
		log.Printf("the server rejected our ECH config; retrying with the one it offered, under the cover name %q", coverName(list))
	}
	if !fallback {
		return nil, err
	}
	u.setPlain()
	log.Printf("the built-in ECH config of %s was rejected or did not complete; retrying with plain TLS", u.url.Hostname())
	conn, plainErr := u.handshake(ctx, network, addr, nil, handshakeTimeout)
	if plainErr != nil {
		return nil, fmt.Errorf("the built-in ECH config did not connect, and plain TLS failed: %w", plainErr)
	}
	return conn, nil
}

// handshake makes the TLS connection to the upstream. The name in the
// config is the real one: with a config list, Go puts the cover name in
// the outer hello and this one inside the encrypted part, and checks the
// certificate against this one.
func (u *upstream) handshake(ctx context.Context, network, addr string, list []byte, timeout time.Duration) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	raw, err := (&net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}).DialContext(ctx, network, addr)
	if err != nil {
		return nil, err
	}

	config := &tls.Config{
		ServerName: u.url.Hostname(),
		MinVersion: tls.VersionTLS12,
		NextProtos: []string{"h2", "http/1.1"},
	}
	if len(list) > 0 {
		// A config list is only offered with TLS 1.3.
		config.MinVersion = tls.VersionTLS13
		config.MaxVersion = tls.VersionTLS13
		config.EncryptedClientHelloConfigList = list
	}

	conn := tls.Client(raw, config)
	if err := conn.HandshakeContext(ctx); err != nil {
		raw.Close()
		return nil, err
	}
	return conn, nil
}

// echList is the config list in use, whether it is the speculative built-in
// one, and whether plain TLS is allowed. When there is none yet, and plain TLS
// is not allowed, it waits for the lookup to finish: a request must not go out
// in the clear because the DNS was slow.
func (u *upstream) echList(ctx context.Context) ([]byte, bool, bool) {
	u.mu.Lock()
	list, fallback, plain := u.list, u.fallback, u.plain
	u.mu.Unlock()
	if len(list) > 0 || plain {
		return list, fallback, plain
	}
	timer := time.NewTimer(handshakeTimeout)
	defer timer.Stop()
	select {
	case <-u.ready:
	case <-timer.C:
		return nil, false, false
	case <-ctx.Done():
		return nil, false, false
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.list, u.fallback, u.plain
}

// setList keeps an authoritative config list and the cover name it names.
func (u *upstream) setList(list []byte) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.list = list
	u.cover = coverName(list)
	u.fallback = false
	u.once.Do(func() { close(u.ready) })
}

// setFallback keeps a config list that was guessed rather than published:
// the built-in Cloudflare one. A server is free to reject that guess, and
// dialing it again would not make the rejection any different.
func (u *upstream) setFallback(list []byte) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.list = list
	u.cover = coverName(list)
	u.fallback = true
	u.once.Do(func() { close(u.ready) })
}

// setPlain gives up ECH for this upstream, and lets a request that is waiting
// for a config list go on without one. It is called when the server rejects
// the speculative built-in config, not when a published one is rejected.
func (u *upstream) setPlain() {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.list = nil
	u.cover = ""
	u.fallback = false
	u.plain = true
	u.once.Do(func() { close(u.ready) })
}

// hasECH says whether the sidecar connects with a config list.
func (u *upstream) hasECH() bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	return len(u.list) > 0
}

// coverName is the name the outer hello carries.
func (u *upstream) coverName() string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.cover
}

// joinPath puts a request path under the upstream's own path.
func joinPath(prefix, path string) string {
	prefix = strings.TrimSuffix(prefix, "/")
	if prefix == "" {
		return path
	}
	if path == "" {
		return prefix
	}
	return prefix + "/" + strings.TrimPrefix(path, "/")
}

// fail writes what went wrong and stops: the sidecar is no use to the
// plugin without its upstreams.
func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "ech-sidecar: "+format+"\n", args...)
	os.Exit(1)
}
