package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// httpsRecord is the RR type of the HTTPS record (RFC 9460).
const httpsRecord = 65

// echQuoted finds the ech parameter in the presentation form of an HTTPS
// record: ech="<base64>". The quotes are part of the format, because the
// value is not an alphanumeric token.
var echQuoted = regexp.MustCompile(`ech="([^"]*)"`)

// echBare is the same without the quotes, for a resolver that prints the
// value bare.
var echBare = regexp.MustCompile(`ech=([A-Za-z0-9+/=]+)`)

// dohAnswer is the part of a DoH answer in JSON form that is read here.
type dohAnswer struct {
	Status int `json:"Status"`
	Answer []struct {
		Name string `json:"name"`
		Type int    `json:"type"`
		Data string `json:"data"`
	} `json:"Answer"`
}

// echConfigList is the config list for the host: the one given on the
// command line, or the one the host's HTTPS record carries.
func echConfigList(ctx context.Context, host, given, doh string) ([]byte, error) {
	if given != "" {
		list, err := base64.StdEncoding.DecodeString(given)
		if err != nil {
			return nil, fmt.Errorf("the ECH config given is not base64: %w", err)
		}
		if len(list) == 0 {
			return nil, fmt.Errorf("the ECH config given is empty")
		}
		return list, nil
	}

	endpoints := []string{}
	for _, endpoint := range strings.Split(doh, ",") {
		if endpoint = strings.TrimSpace(endpoint); endpoint != "" {
			endpoints = append(endpoints, endpoint)
		}
	}
	if len(endpoints) == 0 {
		return nil, fmt.Errorf("no DoH endpoint given")
	}

	var last error
	for _, endpoint := range endpoints {
		list, err := echFromDoH(ctx, endpoint, host)
		if err == nil {
			return list, nil
		}
		last = err
		log.Printf("%s could not give the ECH config of %s: %v", endpoint, host, err)
	}
	return nil, last
}

// echFromDoH asks one resolver for the host's HTTPS record and takes the ECH
// config list out of it.
func echFromDoH(ctx context.Context, endpoint, host string) ([]byte, error) {
	query := url.Values{}
	query.Set("name", host)
	query.Set("type", fmt.Sprintf("%d", httpsRecord))

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"?"+query.Encode(), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("accept", "application/dns-json")

	client := &http.Client{Timeout: 10 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("answered HTTP %d", response.StatusCode)
	}

	var answer dohAnswer
	if err := json.NewDecoder(response.Body).Decode(&answer); err != nil {
		return nil, err
	}
	for _, record := range answer.Answer {
		if record.Type != httpsRecord {
			continue
		}
		encoded := echValue(record.Data)
		if encoded == "" {
			continue
		}
		list, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return nil, fmt.Errorf("the ech parameter is not base64: %w", err)
		}
		if len(list) == 0 {
			continue
		}
		return list, nil
	}
	return nil, fmt.Errorf("the HTTPS record of %s carries no ech parameter", host)
}

// echValue is the base64 config list in the presentation form of an HTTPS
// record.
func echValue(data string) string {
	if match := echQuoted.FindStringSubmatch(data); match != nil {
		return match[1]
	}
	if match := echBare.FindStringSubmatch(data); match != nil {
		return match[1]
	}
	return ""
}

// coverName is the public name the first config of the list names: the name
// the outer hello carries, the one a network sees.
func coverName(list []byte) string {
	if len(list) < 2 {
		return ""
	}
	// The list is a length and the configs. Each config is a version, a
	// length and the payload the version names.
	body := list[2:]
	for len(body) >= 4 {
		size := int(body[2])<<8 | int(body[3])
		if size < 4 || 4+size > len(body) {
			return ""
		}
		payload := body[4 : 4+size]
		body = body[4+size:]
		if name, ok := publicName(payload); ok {
			return name
		}
	}
	return ""
}

// publicName is the name the payload of a config carries.
func publicName(payload []byte) (string, bool) {
	// The payload is a config id, a key exchange method, the public key,
	// the cipher suites, the longest name the server takes, the public
	// name itself and the extensions.
	if len(payload) < 4 {
		return "", false
	}
	offset := 3
	if offset+2 > len(payload) {
		return "", false
	}
	keyLength := int(payload[offset])<<8 | int(payload[offset+1])
	offset += 2 + keyLength
	if offset+2 > len(payload) {
		return "", false
	}
	suiteLength := int(payload[offset])<<8 | int(payload[offset+1])
	offset += 2 + suiteLength
	if offset+1 > len(payload) {
		return "", false
	}
	offset++ // the longest name the server takes
	if offset+1 > len(payload) {
		return "", false
	}
	nameLength := int(payload[offset])
	offset++
	if offset+nameLength > len(payload) {
		return "", false
	}
	return string(payload[offset : offset+nameLength]), true
}
