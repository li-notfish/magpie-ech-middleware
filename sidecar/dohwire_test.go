package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestDoHEndpoints(t *testing.T) {
	got, err := dohEndpoints(" https://doh.pub/dns-query,\nhttps://dns.alidns.com/dns-query ")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"https://doh.pub/dns-query", "https://dns.alidns.com/dns-query"}
	if len(got) != len(want) {
		t.Fatalf("the endpoints are %v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("the endpoints are %v", got)
		}
	}
	upper, err := dohEndpoints("HTTPS://doh.pub/dns-query")
	if err != nil || len(upper) != 1 || upper[0] != "https://doh.pub/dns-query" {
		t.Fatalf("an uppercase scheme is %v, %v", upper, err)
	}
	if _, err := dohEndpoints(""); err == nil {
		t.Fatal("an empty list was accepted")
	}
	if _, err := dohEndpoints("doh.pub/dns-query"); err == nil {
		t.Fatal("an endpoint without a scheme was accepted")
	}
	if _, err := dohEndpoints("ftp://doh.pub/dns-query"); err == nil {
		t.Fatal("an endpoint that is not HTTP was accepted")
	}
}

func TestECHFromDNSMessage(t *testing.T) {
	query, id, err := dnsQuery("api.example.com")
	if err != nil {
		t.Fatal(err)
	}
	list := []byte{0, 1, 2, 3, 4, 5}
	got, err := echFromDNSMessage(dnsResponseWithECH(query, list), id)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(list) {
		t.Fatalf("the config is %v, wanted %v", got, list)
	}
	if _, err := echFromDNSMessage(dnsResponseWithECH(query, list), id+1); err == nil {
		t.Fatal("an answer with another id was accepted")
	}
}

func TestECHFromJSONDoH(t *testing.T) {
	list := []byte{6, 7, 8, 9}
	encoded := base64.StdEncoding.EncodeToString(list)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "GET is wanted", http.StatusMethodNotAllowed)
			return
		}
		if r.URL.Query().Get("name") != "api.example.com" || r.URL.Query().Get("type") != "65" {
			http.Error(w, "the HTTPS question is wanted", http.StatusBadRequest)
			return
		}
		w.Header().Set("content-type", "application/dns-json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"Status": 0,
			"Answer": []map[string]any{{
				"name": "api.example.com",
				"type": 65,
				"data": fmt.Sprintf(`65 . ech="%s"`, encoded),
			}},
		})
	}))
	defer server.Close()

	got, err := echFromDoH(context.Background(), server.URL, "api.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(list) {
		t.Fatalf("the config is %v, wanted %v", got, list)
	}
}

func TestECHFromWireDoHWhenJSONIsRefused(t *testing.T) {
	list := []byte{10, 11, 12, 13}
	var askedJSON atomic.Bool
	var askedWire atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			askedJSON.Store(true)
			http.Error(w, "the wire form is wanted", http.StatusMethodNotAllowed)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "POST is wanted", http.StatusMethodNotAllowed)
			return
		}
		askedWire.Store(true)
		if r.Header.Get("content-type") != "application/dns-message" {
			t.Errorf("the query has content-type %q", r.Header.Get("content-type"))
		}
		query, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("the query cannot be read: %v", err)
			return
		}
		w.Header().Set("content-type", "application/dns-message")
		_, _ = w.Write(dnsResponseWithECH(query, list))
	}))
	defer server.Close()

	got, err := echFromDoH(context.Background(), server.URL, "api.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if !askedJSON.Load() || !askedWire.Load() {
		t.Fatalf("the JSON form was asked %v, the wire form %v", askedJSON.Load(), askedWire.Load())
	}
	if string(got) != string(list) {
		t.Fatalf("the config is %v, wanted %v", got, list)
	}
}

// dnsResponseWithECH builds an answer to the query with one HTTPS record
// carrying the config.
func dnsResponseWithECH(query, list []byte) []byte {
	if len(query) < 12 {
		return nil
	}
	rdata := []byte{0, 1, 0} // priority 1, root target
	rdata = binary.BigEndian.AppendUint16(rdata, svcParamECH)
	rdata = binary.BigEndian.AppendUint16(rdata, uint16(len(list)))
	rdata = append(rdata, list...)

	answer := []byte{0xc0, 0x0c} // the question's name
	answer = binary.BigEndian.AppendUint16(answer, httpsRecord)
	answer = binary.BigEndian.AppendUint16(answer, 1)
	answer = binary.BigEndian.AppendUint32(answer, 60)
	answer = binary.BigEndian.AppendUint16(answer, uint16(len(rdata)))
	answer = append(answer, rdata...)

	message := make([]byte, 12, len(query)+len(answer))
	copy(message[0:2], query[0:2])
	binary.BigEndian.PutUint16(message[2:4], 0x8180)
	binary.BigEndian.PutUint16(message[4:6], 1)
	binary.BigEndian.PutUint16(message[6:8], 1)
	message = append(message, query[12:]...)
	message = append(message, answer...)
	return message
}
