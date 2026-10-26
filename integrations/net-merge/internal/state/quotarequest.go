package state

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type QuotaRequest struct {
	ID      string `json:"id"`
	Adapter string `json:"adapter"`
	Bytes   int64  `json:"bytes"`
	Daily   bool   `json:"daily"`
	Reset   bool   `json:"reset"`
}

func TakeQuota(dir string) (QuotaRequest, bool) {
	path := filepath.Join(dir, "ctl", "quota")
	taken := path + ".taken"
	os.Remove(taken)
	if os.Rename(path, taken) != nil {
		return QuotaRequest{}, false
	}
	defer os.Remove(taken)
	data, ok := readLimitRequest(taken)
	var request QuotaRequest
	if !ok || json.Unmarshal(data, &request) != nil || request.Adapter == "" || request.Bytes < 0 || request.Bytes > 1e15 {
		return QuotaRequest{}, false
	}
	return request, true
}

func QuotaResult(dir, id string, result error) {
	message := ""
	if result != nil {
		message = result.Error()
	}
	data, err := json.Marshal(struct {
		ID    string `json:"id"`
		Error string `json:"error"`
	}{id, message})
	if err != nil {
		return
	}
	path := filepath.Join(dir, "quota-result.json")
	if os.WriteFile(path+".tmp", data, 0600) == nil {
		os.Rename(path+".tmp", path)
	}
}
