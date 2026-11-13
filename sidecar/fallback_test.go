package main

import (
	"encoding/base64"
	"net"
	"testing"
)

func TestParseFallback(t *testing.T) {
	custom := base64.StdEncoding.EncodeToString([]byte{0, 1, 2, 3})
	tests := []struct {
		name    string
		value   string
		hasList bool
		builtin bool
		always  bool
		fails   bool
	}{
		{name: "off", value: "off"},
		{name: "empty", value: ""},
		{name: "built-in", value: "cloudflare", hasList: true, builtin: true},
		{name: "default", value: "default", hasList: true, builtin: true},
		{name: "always", value: "always", hasList: true, builtin: true, always: true},
		{name: "custom", value: custom, hasList: true},
		{name: "invalid", value: "not base64!", fails: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fallback, err := parseFallback(test.value)
			if test.fails {
				if err == nil {
					t.Fatal("the invalid config was accepted")
				}
				return
			}
			if err != nil {
				t.Fatalf("the config was refused: %v", err)
			}
			if (len(fallback.list) > 0) != test.hasList {
				t.Fatalf("the list is %d bytes, wanted a list: %v", len(fallback.list), test.hasList)
			}
			if fallback.builtin != test.builtin {
				t.Fatalf("builtin is %v, wanted %v", fallback.builtin, test.builtin)
			}
			if fallback.always != test.always {
				t.Fatalf("always is %v, wanted %v", fallback.always, test.always)
			}
			if fallback.builtin && coverName(fallback.list) != "cloudflare-ech.com" {
				t.Fatalf("the built-in config names %q", coverName(fallback.list))
			}
		})
	}
}

func TestFallbackOf(t *testing.T) {
	custom := base64.StdEncoding.EncodeToString([]byte{9, 9, 9, 9})
	t.Run("the environment is used when the flag was not given", func(t *testing.T) {
		t.Setenv(fallbackEnv, custom)
		fallback, err := fallbackOf("cloudflare", false)
		if err != nil {
			t.Fatal(err)
		}
		if fallback.builtin {
			t.Fatal("the environment config was read as the built-in one")
		}
		if string(fallback.list) != string([]byte{9, 9, 9, 9}) {
			t.Fatalf("the list is %v", fallback.list)
		}
	})

	t.Run("the flag wins over the environment", func(t *testing.T) {
		t.Setenv(fallbackEnv, "off")
		fallback, err := fallbackOf(custom, true)
		if err != nil {
			t.Fatal(err)
		}
		if len(fallback.list) == 0 || fallback.builtin {
			t.Fatal("the flag config was not used")
		}
	})
}

func TestFallbackForHost(t *testing.T) {
	custom, err := parseFallback(base64.StdEncoding.EncodeToString([]byte{1, 2, 3, 4}))
	if err != nil {
		t.Fatal(err)
	}
	if !custom.forHost("api.example.com") {
		t.Fatal("a config the user gave is not used for every host")
	}

	always, err := parseFallback("always")
	if err != nil {
		t.Fatal(err)
	}
	if !always.forHost("api.example.com") {
		t.Fatal("always is not used for every host")
	}
}

func TestCloudflareIP(t *testing.T) {
	tests := []struct {
		address string
		want    bool
	}{
		{address: "104.16.132.229", want: true},
		{address: "172.64.0.1", want: true},
		{address: "2606:4700:10::6816:84e5", want: true},
		{address: "1.1.1.1", want: false},
		{address: "8.8.8.8", want: false},
	}
	for _, test := range tests {
		if got := cloudflareIP(net.ParseIP(test.address)); got != test.want {
			t.Fatalf("%s is Cloudflare's: %v, wanted %v", test.address, got, test.want)
		}
	}
}
