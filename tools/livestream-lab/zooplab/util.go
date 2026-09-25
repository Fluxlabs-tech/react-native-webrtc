package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

// flexString accepts a JSON string, number or bool (and null as "").
type flexString string

func (f *flexString) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) == 0 || string(b) == "null" {
		*f = ""
		return nil
	}
	if b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*f = flexString(s)
		return nil
	}
	*f = flexString(b)
	return nil
}

// rawInt parses a JSON number or numeric string.
func rawInt(raw json.RawMessage) (int, bool) {
	s := strings.Trim(strings.TrimSpace(string(raw)), `"`)
	if s == "" || s == "null" {
		return 0, false
	}
	if v, err := strconv.Atoi(s); err == nil {
		return v, true
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		return int(f), true
	}
	return 0, false
}

// rawBool parses a JSON bool, "true"/"false" string, or 0/1.
func rawBool(raw json.RawMessage) (bool, bool) {
	switch strings.ToLower(strings.Trim(strings.TrimSpace(string(raw)), `"`)) {
	case "true", "1":
		return true, true
	case "false", "0":
		return false, true
	}
	return false, false
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

func fmtBps(bps float64) string {
	switch {
	case bps >= 1e6:
		return fmt.Sprintf("%.2f Mbps", bps/1e6)
	case bps >= 1e3:
		return fmt.Sprintf("%.0f kbps", bps/1e3)
	default:
		return fmt.Sprintf("%.0f bps", bps)
	}
}

func onOff(b bool) string {
	if b {
		return "on"
	}
	return "off"
}
