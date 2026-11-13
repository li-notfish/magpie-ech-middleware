package main

import (
	"context"
	"log"
	"net"
	"net/netip"
	"time"
)

// cloudflareNetworks are the networks Cloudflare publishes for its edge.
// A host behind Cloudflare resolves to one of them, and only such a host
// can use the built-in Cloudflare ECH config: another server would answer
// under the cover name and fail the handshake. The list is
// https://www.cloudflare.com/ips-v4/ and https://www.cloudflare.com/ips-v6/.
var cloudflareNetworks = []netip.Prefix{
	netip.MustParsePrefix("173.245.48.0/20"),
	netip.MustParsePrefix("103.21.244.0/22"),
	netip.MustParsePrefix("103.22.200.0/22"),
	netip.MustParsePrefix("103.31.4.0/22"),
	netip.MustParsePrefix("141.101.64.0/18"),
	netip.MustParsePrefix("108.162.192.0/18"),
	netip.MustParsePrefix("190.93.240.0/20"),
	netip.MustParsePrefix("188.114.96.0/20"),
	netip.MustParsePrefix("197.234.240.0/22"),
	netip.MustParsePrefix("198.41.128.0/17"),
	netip.MustParsePrefix("162.158.0.0/15"),
	netip.MustParsePrefix("104.16.0.0/13"),
	netip.MustParsePrefix("104.24.0.0/14"),
	netip.MustParsePrefix("172.64.0.0/13"),
	netip.MustParsePrefix("131.0.72.0/22"),
	netip.MustParsePrefix("2400:cb00::/32"),
	netip.MustParsePrefix("2606:4700::/32"),
	netip.MustParsePrefix("2803:f800::/32"),
	netip.MustParsePrefix("2405:b500::/32"),
	netip.MustParsePrefix("2405:8100::/32"),
	netip.MustParsePrefix("2a06:98c0::/29"),
	netip.MustParsePrefix("2c0f:f248::/32"),
}

// cloudflareHost says whether the host resolves to an address in
// Cloudflare's own networks. It asks the system resolver, the one the
// dial itself uses, so that it sees the address the connection will use.
func cloudflareHost(host string) bool {
	// The lookup only tells whether the built-in fallback is for this
	// host; the dial makes the connection of its own.
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
	if err != nil {
		log.Printf("the address of %s could not be looked up to tell whether the built-in ECH fallback is for it: %v", host, err)
		return false
	}
	for _, ip := range ips {
		if cloudflareIP(ip) {
			return true
		}
	}
	return false
}

// cloudflareIP says whether the address is in Cloudflare's own networks.
func cloudflareIP(ip net.IP) bool {
	addr, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	addr = addr.Unmap()
	for _, network := range cloudflareNetworks {
		if network.Contains(addr) {
			return true
		}
	}
	return false
}
