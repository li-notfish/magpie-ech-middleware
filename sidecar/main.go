// Command ech-sidecar is the transport behind the ech magpie plugin.
//
// A network that blocks a domain by its TLS SNI cannot read the name inside
// an Encrypted Client Hello, so a connection that carries one goes through.
// This program keeps such a connection to one upstream and forwards HTTP to
// it: it resolves the upstream's ECHConfigList over DoH, connects with
// Encrypted Client Hello, and serves the upstream on 127.0.0.1 so that the
// plugin can point a provider's base URL at it.
//
// Usage:
//
//	ech-sidecar -upstream https://api.example.com [-listen 127.0.0.1:8790]
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
)

// defaultDoH are the endpoints asked for the upstream's HTTPS record, in the
// order they are tried. Alidns answers from inside the network the plugin
// runs on, which is the network where the blocking happens.
const defaultDoH = "https://dns.alidns.com/resolve,https://cloudflare-dns.com/dns-query,https://dns.google/resolve"

// sidecar is the upstream, the ECH config list in use, and the transport
// that connects with it.
type sidecar struct {
	upstream *url.URL

	mu    sync.Mutex
	list  []byte
	cover string

	// ready is closed when the first config list arrives, and allowPlain
	// says the sidecar goes on without one when there is none.
	ready      chan struct{}
	once       sync.Once
	allowPlain bool

	transport *http.Transport
}

func main() {
	listen := flag.String("listen", "127.0.0.1:8790", "address to listen on")
	upstream := flag.String("upstream", "", "upstream origin URL (https://host)")
	echConfig := flag.String("ech-config", "", "base64 ECHConfigList; looked up over DoH when empty")
	doh := flag.String("doh", defaultDoH, "comma separated DoH endpoints asked for the HTTPS record")
	portFile := flag.String("port-file", "", "file the listening port is written to")
	allowPlain := flag.Bool("allow-plain", false, "go on without ECH when no config list is found")
	flag.Parse()

	if *upstream == "" {
		fail("no upstream given: -upstream https://host is required")
	}
	target, err := url.Parse(*upstream)
	if err != nil || target.Host == "" {
		fail("the upstream %q is not a URL", *upstream)
	}
	if target.Scheme != "https" {
		fail("the upstream %q is not https", *upstream)
	}
	target.Path = strings.TrimSuffix(target.Path, "/")

	sc := &sidecar{upstream: target, ready: make(chan struct{}), allowPlain: *allowPlain}

	sc.transport = &http.Transport{
		DialContext:         (&net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}).DialContext,
		DialTLSContext:      sc.dial,
		ForceAttemptHTTP2:   true,
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     90 * time.Second,
		TLSHandshakeTimeout: handshakeTimeout,
	}

	proxy := &httputil.ReverseProxy{
		Director:  sc.direct,
		Transport: sc.transport,
		// A reply that streams is written as it arrives: a flush per
		// write is what an SSE answer needs to reach the agent while it
		// is still being made.
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("the upstream request failed: %v", err)
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			fmt.Fprintf(w, `{"error":{"message":%q,"type":"ech_upstream_unreachable"}}`, err.Error())
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc(healthPath, sc.health)
	mux.Handle("/", proxy)

	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		fail("cannot listen on %s: %v", *listen, err)
	}
	port := ln.Addr().(*net.TCPAddr).Port

	status, err := json.Marshal(map[string]any{
		"port":     port,
		"upstream": target.String(),
		"ech":      sc.hasECH(),
		"cover":    sc.coverName(),
	})
	if err != nil {
		fail("cannot write the status: %v", err)
	}
	fmt.Println(string(status))
	if err := os.Stdout.Sync(); err != nil {
		// A pipe cannot be synced; the line is written either way.
		_ = err
	}
	if *portFile != "" {
		if err := os.WriteFile(*portFile, []byte(fmt.Sprintf("%d", port)), 0o644); err != nil {
			fail("cannot write the port file %s: %v", *portFile, err)
		}

	// The ECH config is looked up after the sidecar listens: the plugin
	// waits for the line above, and a resolver that is slow must not hold
	// it up. A request that comes before the config is there waits for it.
	go sc.resolve(*echConfig, *doh)
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

// direct sends the request to the upstream, under the upstream's own name:
// the Host header and the TLS SNI are the upstream's, not the sidecar's.
func (sc *sidecar) direct(req *http.Request) {
	req.URL.Scheme = sc.upstream.Scheme
	req.URL.Host = sc.upstream.Host
	req.URL.Path = joinPath(sc.upstream.Path, req.URL.Path)
	if req.URL.RawPath != "" {
		req.URL.RawPath = joinPath(sc.upstream.Path, req.URL.RawPath)
	}
	req.Host = sc.upstream.Host
}

// health answers the plugin's check: it says that the sidecar is up and
// what it connects with, without making the upstream answer.
func (sc *sidecar) health(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":       true,
		"upstream": sc.upstream.String(),
		"ech":      sc.hasECH(),
		"cover":    sc.coverName(),
	})
}

// resolve looks the upstream's ECH config up over DoH and keeps looking
// until it finds one: the record may carry it only later, and a resolver
// that refuses must not keep the sidecar from serving. It gives up when
// the sidecar is told to go on without one.
func (sc *sidecar) resolve(given, doh string) {
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		list, err := echConfigList(ctx, sc.upstream.Hostname(), given, doh)
		cancel()
		if err == nil {
			sc.setList(list)
			log.Printf("ECH for %s uses the cover name %q", sc.upstream.Hostname(), sc.coverName())
			return
		}
		log.Printf("no ECH config for %s: %v", sc.upstream.Hostname(), err)
		if sc.allowPlain {
			log.Printf("going on without ECH for %s", sc.upstream.Hostname())
			return
		}
		time.Sleep(configWait)
	}
}

// dial connects to the upstream with Encrypted Client Hello. A server that
// refuses the config list we sent offers another one; the handshake is made
// again with it.
func (sc *sidecar) dial(ctx context.Context, network, addr string) (net.Conn, error) {
	list := sc.echList(ctx)
	if len(list) == 0 && !sc.allowPlain {
		return nil, fmt.Errorf("no ECH config for %s: the lookup did not finish in time", sc.upstream.Hostname())
	}
	var err error
	// Each edge of a network may know a different config list, so a
	// rejection is answered with the list that edge offers and the
	// handshake is made again with it.
	for attempt := 0; attempt < 3; attempt++ {
		var conn net.Conn
		conn, err = sc.handshake(ctx, network, addr, list)
		if err == nil {
			return conn, nil
		}
		var rejected *tls.ECHRejectionError
		if !errors.As(err, &rejected) || len(rejected.RetryConfigList) == 0 {
			return nil, err
		}
		sc.setList(rejected.RetryConfigList)
		list = rejected.RetryConfigList
		log.Printf("the server rejected our ECH config; retrying with the one it offered, under the cover name %q", sc.coverName())
	}
	return nil, err
}

// handshake makes the TLS connection to the upstream. The name in the
// config is the real one: with a config list, Go puts the cover name in the
// outer hello and this one inside the encrypted part, and checks the
// certificate against this one.
func (sc *sidecar) handshake(ctx context.Context, network, addr string, list []byte) (net.Conn, error) {
	ctx, cancel := context.WithTimeout(ctx, handshakeTimeout)
	defer cancel()

	raw, err := (&net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}).DialContext(ctx, network, addr)
	if err != nil {
		return nil, err
	}

	config := &tls.Config{
		ServerName: sc.upstream.Hostname(),
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
func (sc *sidecar) echList(ctx context.Context) []byte {
	sc.mu.Lock()
	list := sc.list
	sc.mu.Unlock()
	if len(list) > 0 || sc.allowPlain {
		return list
	}
	timer := time.NewTimer(handshakeTimeout)
	defer timer.Stop()
	select {
	case <-sc.ready:
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return nil
	}
	sc.mu.Lock()
	defer sc.mu.Unlock()
	return sc.list
}

// setList keeps the config list in use and the cover name it names.
func (sc *sidecar) setList(list []byte) {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	sc.list = list
	sc.cover = coverName(list)
	sc.once.Do(func() { close(sc.ready) })
}

// hasECH says whether the sidecar connects with a config list.
func (sc *sidecar) hasECH() bool {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	return len(sc.list) > 0
}

// coverName is the name the outer hello carries.
func (sc *sidecar) coverName() string {
	sc.mu.Lock()
	defer sc.mu.Unlock()
	return sc.cover
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
// plugin without its upstream.
func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "ech-sidecar: "+format+"\n", args...)
	os.Exit(1)
}
