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

	// healthPath answers the plugin's own check without touching the
	// upstream.
	healthPath = "/_ech/health"

	// configWait is how long the ECH config is looked up again after a
	// resolver refused to answer.
	configWait = 10 * time.Second

	// upstreamWait is how often the upstreams file is read again.
	upstreamWait = 2 * time.Second
)

// defaultDoH are the endpoints asked for the upstream's HTTPS record, in the
// order they are tried. Alidns answers from inside the network the plugin
// runs on, which is the network where the blocking happens.
const defaultDoH = "https://dns.alidns.com/resolve,https://cloudflare-dns.com/dns-query,https://dns.google/resolve"

// upstream is one address the sidecar serves: the name it is called by in
// the path, the address it forwards to, and the ECH config it connects
// with.
type upstream struct {
	name string
	url  *url.URL
	ech  string

	mu    sync.Mutex
	list  []byte
	cover string

	// ready is closed when the first config list arrives, and allowPlain
	// says the sidecar goes on without one when there is none.
	ready      chan struct{}
	once       sync.Once
	allowPlain bool

	transport *http.Transport
	proxy     *httputil.ReverseProxy
}

// sidecar is the upstreams it serves, by name.
type sidecar struct {
	mu         sync.RWMutex
	ups        map[string]*upstream
	allowPlain bool
	doh        string
}

func main() {
	listen := flag.String("listen", "127.0.0.1:8790", "address to listen on")
	upstreams := flag.String("upstreams-file", "", "file the upstreams are read from")
	doh := flag.String("doh", defaultDoH, "comma separated DoH endpoints asked for the HTTPS record")
	portFile := flag.String("port-file", "", "file the listening port is written to")
	allowPlain := flag.Bool("allow-plain", false, "go on without ECH when no config list is found")
	flag.Parse()

	if *upstreams == "" {
		fail("no upstream file given: -upstreams-file <file> is required")
	}

	sc := &sidecar{
		ups:        map[string]*upstream{},
		allowPlain: *allowPlain,
		doh:        *doh,
	}
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
		go u.resolve(sc.doh)
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
// that refuses must not keep the sidecar from serving. It gives up when
// the sidecar is told to go on without one.
func (u *upstream) resolve(doh string) {
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		list, err := echConfigList(ctx, u.url.Hostname(), u.ech, doh)
		cancel()
		if err == nil {
			u.setList(list)
			log.Printf("ECH for %s uses the cover name %q", u.url.Hostname(), u.coverName())
			return
		}
		log.Printf("no ECH config for %s: %v", u.url.Hostname(), err)
		if u.allowPlain {
			log.Printf("going on without ECH for %s", u.url.Hostname())
			return
		}
		time.Sleep(configWait)
	}
}

// dial connects to the upstream with Encrypted Client Hello. A server that
// refuses the config list we sent offers another one; the handshake is made
// again with it.
func (u *upstream) dial(ctx context.Context, network, addr string) (net.Conn, error) {
	list := u.echList(ctx)
	if len(list) == 0 && !u.allowPlain {
		return nil, fmt.Errorf("no ECH config for %s: the lookup did not finish in time", u.url.Hostname())
	}
	var err error
	// Each edge of a network may know a different config list, so a
	// rejection is answered with the list that edge offers and the
	// handshake is made again with it.
	for attempt := 0; attempt < 3; attempt++ {
		var conn net.Conn
		conn, err = u.handshake(ctx, network, addr, list)
		if err == nil {
			return conn, nil
		}
		var rejected *tls.ECHRejectionError
		if !errors.As(err, &rejected) || len(rejected.RetryConfigList) == 0 {
			return nil, err
		}
		u.setList(rejected.RetryConfigList)
		list = rejected.RetryConfigList
		log.Printf("the server rejected our ECH config; retrying with the one it offered, under the cover name %q", u.coverName())
	}
	return nil, err
}

// handshake makes the TLS connection to the upstream. The name in the
// config is the real one: with a config list, Go puts the cover name in
// the outer hello and this one inside the encrypted part, and checks the
// certificate against this one.
func (u *upstream) handshake(ctx context.Context, network, addr string, list []byte) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, handshakeTimeout)
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

// echList is the config list in use. When there is none yet, and the
// sidecar is to go on without one only when it is told to, it waits for
// the lookup to find one: a request must not go out in the clear because
// the DNS was slow.
func (u *upstream) echList(ctx context.Context) []byte {
	u.mu.Lock()
	list := u.list
	u.mu.Unlock()
	if len(list) > 0 || u.allowPlain {
		return list
	}
	timer := time.NewTimer(handshakeTimeout)
	defer timer.Stop()
	select {
	case <-u.ready:
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return nil
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.list
}

// setList keeps the config list in use and the cover name it names.
func (u *upstream) setList(list []byte) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.list = list
	u.cover = coverName(list)
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
