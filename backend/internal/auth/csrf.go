package auth

import (
	"crypto/subtle"
	"net/http"
)

const CsrfCookieName = "csrf_token"

func ValidCSRF(r *http.Request) bool {
	c, err := r.Cookie(CsrfCookieName)
	if err != nil || c.Value == "" {
		return false
	}
	header := r.Header.Get("X-CSRF-Token")
	if header == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(c.Value), []byte(header)) == 1
}
