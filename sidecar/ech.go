package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"unicode"
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

// errJSONDoH says the endpoint did not answer the JSON form of DoH, so
// the RFC 8484 wire form is worth asking for.
var errJSONDoH = errors.New("the endpoint does not answer the JSON form of DoH")

// maxDoHBody bounds one DoH answer.
const maxDoHBody = 1 << 20

// echConfigList is the config list for the host: the one given on the
// command line, or the one the host's HTTPS record carries.
func echConfigList(ctx context.Context, host, given string, endpoints []string) ([]byte, error) {
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

	if len(endpoints) == 0 {
		return nil, fmt.Errorf("no DoH endpoint given")
	}

	// The endpoints are asked at once, and the first answer with a config
	// list wins: from a network that blocks some of them, waiting for each
	// in turn can take longer than the whole lookup is given.
	type answer struct {
		list []byte
		err  error
	}
	answers := make(chan answer, len(endpoints))
	var wg sync.WaitGroup
	for _, endpoint := range endpoints {
		wg.Add(1)
		go func(endpoint string) {
			defer wg.Done()
			list, err := echFromDoH(ctx, endpoint, host)
			if err != nil {
				log.Printf("%s could not give the ECH config of %s: %v", endpoint, host, err)
			}
			answers <- answer{list: list, err: err}
		}(endpoint)
	}
	go func() {
		wg.Wait()
		close(answers)
	}()
	var last error
	for a := range answers {
		if a.err == nil {
			return a.list, nil
		}
		last = a.err
	}
	if last == nil {
		last = fmt.Errorf("no resolver answered")
	}
	return nil, last
}

// dohEndpoints reads what the option says: one or more HTTP endpoints,
// separated by commas or whitespace.
func dohEndpoints(value string) ([]string, error) {
	fields := strings.FieldsFunc(value, func(r rune) bool {
		return r == ',' || unicode.IsSpace(r)
	})
	if len(fields) == 0 {
		return nil, errors.New("no DoH endpoint given")
	}
	endpoints := make([]string, 0, len(fields))
	seen := map[string]bool{}
	for _, endpoint := range fields {
		parsed, err := url.Parse(endpoint)
		if err != nil {
			return nil, fmt.Errorf("the DoH endpoint %q is not an HTTP URL", endpoint)
		}
		scheme := strings.ToLower(parsed.Scheme)
		if parsed.Host == "" || (scheme != "http" && scheme != "https") {
			return nil, fmt.Errorf("the DoH endpoint %q is not an HTTP URL", endpoint)
		}
		parsed.Scheme = scheme
		endpoint = parsed.String()
		if seen[endpoint] {
			continue
		}
		seen[endpoint] = true
		endpoints = append(endpoints, endpoint)
	}
	return endpoints, nil
}

// echFromDoH asks one resolver for the host's HTTPS record and takes the ECH
// config list out of it. JSON DoH comes first; when the endpoint does not
// speak it, the same URL is asked again in the RFC 8484 wire form.
func echFromDoH(ctx context.Context, endpoint, host string) ([]byte, error) {
	list, err := echFromJSONDoH(ctx, endpoint, host)
	if err == nil {
		return list, nil
	}
	if !errors.Is(err, errJSONDoH) {
		return nil, err
	}
	list, wireErr := echFromWireDoH(ctx, endpoint, host)
	if wireErr == nil {
		return list, nil
	}
	return nil, fmt.Errorf("the JSON form failed: %v; the RFC 8484 form failed: %w", err, wireErr)
}

// dohJSONURL puts the HTTPS question into an endpoint's query string.
func dohJSONURL(endpoint, host string) (string, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return "", err
	}
	query := parsed.Query()
	query.Set("name", host)
	query.Set("type", strconv.Itoa(httpsRecord))
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

// echFromJSONDoH asks one resolver for the JSON form of the host's HTTPS
// record and takes the ECH config list out of it.
func echFromJSONDoH(ctx context.Context, endpoint, host string) ([]byte, error) {
	target, err := dohJSONURL(endpoint, host)
	if err != nil {
		return nil, err
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("accept", "application/dns-json")

	// A resolver has the same short budget as the lookup: one that has
	// not answered by then is not going to make the first listing in time.
	client := &http.Client{Timeout: dohWait}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		if jsonDoHUnsupported(response.StatusCode) {
			return nil, fmt.Errorf("%w: it answered HTTP %d", errJSONDoH, response.StatusCode)
		}
		return nil, fmt.Errorf("answered HTTP %d", response.StatusCode)
	}

	body, err := readDoHBody(response.Body)
	if err != nil {
		return nil, err
	}
	var answer dohAnswer
	if err := json.Unmarshal(body, &answer); err != nil {
		return nil, fmt.Errorf("%w: the answer is not JSON: %v", errJSONDoH, err)
	}
	if answer.Status != 0 {
		return nil, fmt.Errorf("the resolver answered with DNS status %d", answer.Status)
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

// jsonDoHUnsupported says whether an HTTP status is one an endpoint that
// speaks only the wire form may give to the JSON question.
func jsonDoHUnsupported(status int) bool {
	switch status {
	case http.StatusBadRequest, http.StatusNotFound, http.StatusMethodNotAllowed,
		http.StatusNotAcceptable, http.StatusUnsupportedMediaType, http.StatusNotImplemented:
		return true
	}
	return false
}

// echFromWireDoH asks one resolver with an RFC 8484 DNS message and takes
// the ECH config list out of the wire answer.
func echFromWireDoH(ctx context.Context, endpoint, host string) ([]byte, error) {
	query, id, err := dnsQuery(host)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(query))
	if err != nil {
		return nil, err
	}
	request.Header.Set("content-type", "application/dns-message")
	request.Header.Set("accept", "application/dns-message")

	client := &http.Client{Timeout: dohWait}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("answered HTTP %d", response.StatusCode)
	}
	body, err := readDoHBody(response.Body)
	if err != nil {
		return nil, err
	}
	return echFromDNSMessage(body, id)
}

// readDoHBody reads one answer, and refuses one that is too large.
func readDoHBody(body io.Reader) ([]byte, error) {
	value, err := io.ReadAll(io.LimitReader(body, maxDoHBody+1))
	if err != nil {
		return nil, err
	}
	if len(value) > maxDoHBody {
		return nil, fmt.Errorf("the DoH answer is larger than %d bytes", maxDoHBody)
	}
	return value, nil
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
