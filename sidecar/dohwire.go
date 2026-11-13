package main

import (
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
)

// svcParamECH is the SvcParamKey of the ech parameter in an HTTPS record
// (RFC 9460, RFC 9849).
const svcParamECH = 5

// dnsQuery is one DNS message asking for the host's HTTPS record, and the
// id the answer must carry.
func dnsQuery(host string) ([]byte, uint16, error) {
	name, err := dnsName(host)
	if err != nil {
		return nil, 0, err
	}
	var idBytes [2]byte
	if _, err := rand.Read(idBytes[:]); err != nil {
		return nil, 0, fmt.Errorf("the DNS query id cannot be made: %w", err)
	}
	id := binary.BigEndian.Uint16(idBytes[:])

	message := make([]byte, 12, 12+len(name)+4)
	binary.BigEndian.PutUint16(message[0:2], id)
	binary.BigEndian.PutUint16(message[2:4], 0x0100) // recursion desired
	binary.BigEndian.PutUint16(message[4:6], 1)      // one question
	message = append(message, name...)
	message = binary.BigEndian.AppendUint16(message, httpsRecord)
	message = binary.BigEndian.AppendUint16(message, 1) // class IN
	return message, id, nil
}

// dnsName is the wire form of a host name: each label, and the root label.
func dnsName(host string) ([]byte, error) {
	host = strings.TrimSuffix(strings.TrimSpace(host), ".")
	if host == "" {
		return nil, errors.New("the DoH query names no host")
	}
	if len(host) > 253 {
		return nil, fmt.Errorf("the host %q is too long for a DNS name", host)
	}
	name := make([]byte, 0, len(host)+2)
	for _, label := range strings.Split(host, ".") {
		if label == "" {
			return nil, fmt.Errorf("the host %q has an empty label", host)
		}
		if len(label) > 63 {
			return nil, fmt.Errorf("the host %q has a label longer than 63 bytes", host)
		}
		for i := 0; i < len(label); i++ {
			if label[i] == 0 || label[i] >= 0x80 {
				return nil, fmt.Errorf("the host %q is not an ASCII DNS name", host)
			}
		}
		name = append(name, byte(len(label)))
		name = append(name, label...)
	}
	name = append(name, 0)
	if len(name) > 255 {
		return nil, fmt.Errorf("the host %q is too long for a DNS name", host)
	}
	return name, nil
}

// echFromDNSMessage takes the ECH config list out of a wire-format DNS
// answer. It reads the answer section only: the HTTPS record is there.
func echFromDNSMessage(message []byte, id uint16) ([]byte, error) {
	if len(message) < 12 {
		return nil, errors.New("the DNS answer is shorter than its header")
	}
	if got := binary.BigEndian.Uint16(message[0:2]); got != id {
		return nil, fmt.Errorf("the DNS answer has id %d, not %d", got, id)
	}
	flags := binary.BigEndian.Uint16(message[2:4])
	if flags&0x8000 == 0 {
		return nil, errors.New("the DNS message is a query, not an answer")
	}
	if flags&0x0200 != 0 {
		return nil, errors.New("the DNS answer is truncated")
	}
	if code := flags & 0x000f; code != 0 {
		return nil, fmt.Errorf("the resolver answered with DNS status %d", code)
	}

	questions := int(binary.BigEndian.Uint16(message[4:6]))
	answers := int(binary.BigEndian.Uint16(message[6:8]))
	offset := 12
	for i := 0; i < questions; i++ {
		next, err := skipDNSName(message, offset)
		if err != nil {
			return nil, err
		}
		offset = next
		if offset+4 > len(message) {
			return nil, errors.New("the DNS question is cut short")
		}
		offset += 4
	}

	foundHTTPS := false
	for i := 0; i < answers; i++ {
		next, err := skipDNSName(message, offset)
		if err != nil {
			return nil, err
		}
		offset = next
		if offset+10 > len(message) {
			return nil, errors.New("the DNS answer is cut short")
		}
		recordType := binary.BigEndian.Uint16(message[offset : offset+2])
		class := binary.BigEndian.Uint16(message[offset+2 : offset+4])
		size := int(binary.BigEndian.Uint16(message[offset+8 : offset+10]))
		offset += 10
		end := offset + size
		if end > len(message) {
			return nil, errors.New("the DNS record is cut short")
		}
		if recordType == httpsRecord && class == 1 {
			foundHTTPS = true
			if list, ok := echFromSVCBRData(message, offset, end); ok {
				return append([]byte(nil), list...), nil
			}
		}
		offset = end
	}
	if foundHTTPS {
		return nil, errors.New("the HTTPS record carries no ech parameter")
	}
	return nil, errors.New("the DNS answer carries no HTTPS record")
}

// skipDNSName is the offset after a possibly compressed DNS name.
func skipDNSName(message []byte, offset int) (int, error) {
	for {
		if offset >= len(message) {
			return 0, errors.New("the DNS name is cut short")
		}
		length := message[offset]
		switch {
		case length == 0:
			return offset + 1, nil
		case length&0xc0 == 0xc0:
			if offset+1 >= len(message) {
				return 0, errors.New("the compressed DNS name is cut short")
			}
			return offset + 2, nil
		case length&0xc0 != 0:
			return 0, errors.New("the DNS name has an unknown label type")
		}
		offset += 1 + int(length)
		if offset > len(message) {
			return 0, errors.New("the DNS name is cut short")
		}
	}
}

// echFromSVCBRData takes the ech SvcParam out of the RDATA of an HTTPS
// record: the priority, the target name, and the parameters.
func echFromSVCBRData(message []byte, start, end int) ([]byte, bool) {
	if start+2 > end {
		return nil, false
	}
	offset, err := skipDNSName(message, start+2)
	if err != nil || offset > end {
		return nil, false
	}
	for offset < end {
		if offset+4 > end {
			return nil, false
		}
		key := binary.BigEndian.Uint16(message[offset : offset+2])
		size := int(binary.BigEndian.Uint16(message[offset+2 : offset+4]))
		offset += 4
		if offset+size > end {
			return nil, false
		}
		if key == svcParamECH && size > 0 {
			return message[offset : offset+size], true
		}
		offset += size
	}
	return nil, false
}
