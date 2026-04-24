package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	netmail "net/mail"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/rhythm-info/backend/internal/auth"
	"github.com/rhythm-info/backend/internal/mail"
	"github.com/rhythm-info/backend/internal/session"
	"github.com/rhythm-info/backend/internal/store"
)

type app struct {
	store           *store.Store
	sessions        *session.Store
	mailer          mail.Sender
	turnstileSecret string
	frontendBaseURL string
	appBaseURL      string
}

const (
	sessionCookieName  = "sid"
	rememberCookieName = "remember_token"
	sessionTTL         = 12 * time.Hour
	rememberTTL        = 30 * 24 * time.Hour
	resetTTL           = 10 * time.Minute
	emailVerifyTTL     = 15 * time.Minute
)

func (a *app) handleSignup() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Username       string `json:"username"`
			Email          string `json:"email"`
			Password       string `json:"password"`
			PasswordConfirm string `json:"password_confirm"`
			TurnstileToken string `json:"turnstile_token"`
			AgreePolicy    bool   `json:"agree_policy"`
			AgreeTerms     bool   `json:"agree_terms"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		ip := clientIP(r)
		if err := a.enforceRateLimit("signup_ip", ip, 15*time.Minute, 5); err != nil {
			http.Error(w, "too many requests", http.StatusTooManyRequests)
			return
		}
		if !body.AgreePolicy || !body.AgreeTerms {
			http.Error(w, "agreement required", http.StatusBadRequest)
			return
		}
		if !a.verifyTurnstile(r.Context(), body.TurnstileToken, ip) {
			http.Error(w, "captcha failed", http.StatusBadRequest)
			return
		}
		username := strings.TrimSpace(body.Username)
		email := strings.ToLower(strings.TrimSpace(body.Email))
		if !validUsername(username) || !validEmail(email) || !validPassword(body.Password) || body.Password != body.PasswordConfirm {
			http.Error(w, "invalid input", http.StatusBadRequest)
			return
		}
		hash, err := auth.HashPassword(body.Password)
		if err != nil {
			http.Error(w, "signup failed", http.StatusInternalServerError)
			return
		}
		u, err := a.store.CreateAuthUser(username, email, hash)
		if err != nil {
			// 회원가입 UX를 위해 ID/이메일 중복은 명확히 안내한다.
			errText := strings.ToLower(err.Error())
			if strings.Contains(errText, "users.username") || strings.Contains(errText, "idx_users_username_unique") {
				http.Error(w, "username already in use", http.StatusConflict)
				return
			}
			if strings.Contains(errText, "users.email") || strings.Contains(errText, "idx_users_email_unique") {
				http.Error(w, "email already in use", http.StatusConflict)
				return
			}
			http.Error(w, "signup failed", http.StatusInternalServerError)
			return
		}
		if err := a.sendVerificationEmail(u.ID, email); err != nil {
			log.Printf("signup verification mail failed: user_id=%s err=%v", u.ID, err)
			http.Error(w, "mail failed", http.StatusBadGateway)
			return
		}
		_ = a.store.RecordRateLimitEvent("signup_ip", ip)
		writeJSON(w, http.StatusCreated, map[string]any{"ok": true})
	}
}

func (a *app) handleLogin() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Email          string `json:"email"`
			Password       string `json:"password"`
			Remember       bool   `json:"remember"`
			TurnstileToken string `json:"turnstile_token"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		email := strings.ToLower(strings.TrimSpace(body.Email))
		ip := clientIP(r)
		failCnt, _ := a.store.CountLoginFailures(email, ip, time.Now().Add(-15*time.Minute))
		if failCnt >= 2 && !a.verifyTurnstile(r.Context(), body.TurnstileToken, ip) {
			http.Error(w, "captcha required", http.StatusBadRequest)
			return
		}
		u, err := a.store.UserByEmail(email)
		if err != nil || auth.ComparePassword(u.PasswordHash, body.Password) != nil {
			_ = a.store.RecordLoginFailure(email, ip)
			http.Error(w, "invalid credentials", http.StatusUnauthorized)
			return
		}
		if u.EmailVerifiedAt == nil {
			http.Error(w, "email not verified", http.StatusForbidden)
			return
		}
		_ = a.store.ClearLoginFailures(email, ip)
		if err := a.issueSession(w, r, u.ID, body.Remember); err != nil {
			http.Error(w, "login failed", http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func (a *app) handleLogout() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !auth.ValidCSRF(r) {
			http.Error(w, "csrf failed", http.StatusForbidden)
			return
		}
		if c, err := r.Cookie(sessionCookieName); err == nil {
			_ = a.sessions.Delete(r.Context(), c.Value)
		}
		clearCookie(w, sessionCookieName)
		clearCookie(w, rememberCookieName)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func (a *app) handleForgotPassword() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Email          string `json:"email"`
			TurnstileToken string `json:"turnstile_token"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		ip := clientIP(r)
		email := strings.ToLower(strings.TrimSpace(body.Email))
		if err := a.enforceRateLimit("forgot_ip", ip, 15*time.Minute, 5); err != nil {
			http.Error(w, "too many requests", http.StatusTooManyRequests)
			return
		}
		if err := a.enforceRateLimit("forgot_email", email, time.Hour, 5); err != nil {
			http.Error(w, "too many requests", http.StatusTooManyRequests)
			return
		}
		if !a.verifyTurnstile(r.Context(), body.TurnstileToken, ip) {
			http.Error(w, "captcha failed", http.StatusBadRequest)
			return
		}
		if u, err := a.store.UserByEmail(email); err == nil && u.DeletedAt == nil {
			if token, tokErr := auth.RandomToken(32); tokErr == nil {
				if err := a.store.CreatePasswordResetToken(u.ID, token, resetTTL); err != nil {
					log.Printf("forgot reset token save failed: user_id=%s err=%v", u.ID, err)
				}
				resetURL := fmt.Sprintf("%s/reset-password?token=%s", a.frontendBaseURL, url.QueryEscape(token))
				subject := "[Chinatsu Info] パスワード再設定のご案内"
				mailBody := fmt.Sprintf(
					"Chinatsu Info をご利用いただきありがとうございます。\n\nパスワード再設定のリクエストを受け付けました。\n以下のリンクにアクセスし、新しいパスワードを設定してください。\n\n%s\n\nこのリンクの有効期限は 10 分です。\n心当たりがない場合は、このメールを破棄してください。\n\n発行元: Chinatsu Info\nhttps://chinatsu.sappagetti.com/",
					resetURL,
				)
				if err := a.mailer.Send(email, subject, mailBody); err != nil {
					log.Printf("forgot reset mail send failed: user_id=%s err=%v", u.ID, err)
				}
			} else {
				log.Printf("forgot reset token create failed: user_id=%s err=%v", u.ID, tokErr)
			}
		}
		_ = a.store.RecordRateLimitEvent("forgot_ip", ip)
		_ = a.store.RecordRateLimitEvent("forgot_email", email)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func (a *app) handleResetPassword() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Token       string `json:"token"`
			NewPassword string `json:"new_password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		if len(body.NewPassword) < 10 {
			http.Error(w, "weak password", http.StatusBadRequest)
			return
		}
		userID, err := a.store.ConsumePasswordResetToken(strings.TrimSpace(body.Token))
		if err != nil {
			http.Error(w, "invalid token", http.StatusBadRequest)
			return
		}
		hash, err := auth.HashPassword(body.NewPassword)
		if err != nil {
			http.Error(w, "reset failed", http.StatusInternalServerError)
			return
		}
		if err := a.store.UpdatePassword(userID, hash); err != nil {
			http.Error(w, "reset failed", http.StatusInternalServerError)
			return
		}
		_ = a.store.RevokeAllPasswordResetTokens(userID)
		_ = a.store.RevokeRememberTokensByUser(userID)
		_ = a.sessions.DeleteUserSessions(r.Context(), userID)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func (a *app) handleAuthMe() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, ok := a.userFromSession(r)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		// 이미 유효한 CSRF 토큰이 요청 쿠키에 있다면 재사용한다. SPA 가 자주 /auth/me 를
		// 호출해도 매번 새 토큰으로 교체되지 않아 여러 탭/요청 간 경쟁을 줄일 수 있다.
		if existing, err := r.Cookie(auth.CsrfCookieName); err == nil && len(existing.Value) >= 16 {
			// 만료를 현재 기준으로 재설정(슬라이딩 세션)
			setCookie(w, auth.CsrfCookieName, existing.Value, 3600, false)
		} else {
			csrf, _ := auth.RandomToken(24)
			setCookie(w, auth.CsrfCookieName, csrf, 3600, false)
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"user_id":        u.ID,
			"public_id":      u.PublicID,
			"email":          u.Email,
			"display_name":   u.DisplayName,
			"email_verified": u.EmailVerifiedAt != nil,
			"ingest_token":   u.IngestToken,
		})
	}
}

func (a *app) handleDeleteAccount() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !auth.ValidCSRF(r) {
			http.Error(w, "csrf failed", http.StatusForbidden)
			return
		}
		u, ok := a.userFromSession(r)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if err := a.store.SoftDeleteUser(u.ID); err != nil {
			http.Error(w, "delete failed", http.StatusInternalServerError)
			return
		}
		_ = a.store.RevokeRememberTokensByUser(u.ID)
		_ = a.sessions.DeleteUserSessions(r.Context(), u.ID)
		clearCookie(w, sessionCookieName)
		clearCookie(w, rememberCookieName)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func (a *app) verifyEmailLinkURL(rawToken string) string {
	base := strings.TrimRight(a.appBaseURL, "/")
	return base + "/api/v1/auth/verify-email?token=" + url.QueryEscape(rawToken)
}

// sendVerificationEmail: 15分有効のワンタイムトークンを発行しメール送信する。
func (a *app) sendVerificationEmail(userID, toEmail string) error {
	rawToken, err := auth.RandomToken(32)
	if err != nil {
		return err
	}
	if err := a.store.CreateEmailVerificationToken(userID, rawToken, emailVerifyTTL); err != nil {
		return err
	}
	link := a.verifyEmailLinkURL(rawToken)
	subject := "[Chinatsu Info] メール認証のご案内"
	body := fmt.Sprintf(
		"Chinatsu Info への会員登録ありがとうございます。\n\nまだ会員登録は完了していません。\n以下のリンクにアクセスして、メール認証を完了してください。\n\n%s\n\nこのリンクの有効期限は 15 分です。\n認証が完了すると、自動的にログイン状態になります。\n\n心当たりがない場合は、このメールを破棄してください。\n\n発行元: Chinatsu Info\nhttps://chinatsu.sappagetti.com/",
		link,
	)
	return a.mailer.Send(toEmail, subject, body)
}

func (a *app) handleVerifyEmail() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw := strings.TrimSpace(r.URL.Query().Get("token"))
		redirBad := strings.TrimRight(a.frontendBaseURL, "/") + "/login?verify=invalid"
		if raw == "" {
			http.Redirect(w, r, redirBad, http.StatusFound)
			return
		}
		userID, err := a.store.CompleteEmailVerification(raw)
		if err != nil {
			log.Printf("verify email failed: %v", err)
			http.Redirect(w, r, redirBad, http.StatusFound)
			return
		}
		if err := a.issueSession(w, r, userID, false); err != nil {
			log.Printf("verify email session issue failed: user_id=%s err=%v", userID, err)
			http.Redirect(w, r, redirBad, http.StatusFound)
			return
		}
		ok := strings.TrimRight(a.frontendBaseURL, "/") + "/setup?verified=1"
		http.Redirect(w, r, ok, http.StatusFound)
	}
}

func (a *app) handleResendVerification() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Email          string `json:"email"`
			TurnstileToken string `json:"turnstile_token"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid request", http.StatusBadRequest)
			return
		}
		email := strings.ToLower(strings.TrimSpace(body.Email))
		ip := clientIP(r)
		if err := a.enforceRateLimit("verify_resend_email", email, 5*time.Minute, 1); err != nil {
			http.Error(w, "too many requests", http.StatusTooManyRequests)
			return
		}
		if err := a.enforceRateLimit("verify_resend_ip", ip, 5*time.Minute, 1); err != nil {
			http.Error(w, "too many requests", http.StatusTooManyRequests)
			return
		}
		if !a.verifyTurnstile(r.Context(), body.TurnstileToken, ip) {
			http.Error(w, "captcha failed", http.StatusBadRequest)
			return
		}
		if u, err := a.store.UserByEmail(email); err == nil && u.DeletedAt == nil && u.EmailVerifiedAt == nil {
			if err := a.sendVerificationEmail(u.ID, email); err != nil {
				log.Printf("resend verification mail failed: user_id=%s err=%v", u.ID, err)
			}
		}
		_ = a.store.RecordRateLimitEvent("verify_resend_email", email)
		_ = a.store.RecordRateLimitEvent("verify_resend_ip", ip)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func (a *app) issueSession(w http.ResponseWriter, r *http.Request, userID string, remember bool) error {
	sid, err := auth.RandomToken(32)
	if err != nil {
		return err
	}
	if err := a.sessions.Set(r.Context(), sid, session.Session{
		UserID:    userID,
		CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	}, sessionTTL); err != nil {
		return err
	}
	if remember {
		selector, err := auth.RandomToken(12)
		if err != nil {
			return err
		}
		validator, err := auth.RandomToken(24)
		if err != nil {
			return err
		}
		if err := a.store.CreateRememberToken(userID, selector, validator, rememberTTL); err != nil {
			return err
		}
		setCookie(w, rememberCookieName, selector+"."+validator, int(rememberTTL.Seconds()), true)
	}
	setCookie(w, sessionCookieName, sid, int(sessionTTL.Seconds()), remember)
	return nil
}

func (a *app) userFromSession(r *http.Request) (*store.User, bool) {
	c, err := r.Cookie(sessionCookieName)
	if err == nil && c.Value != "" {
		sess, err := a.sessions.Get(r.Context(), c.Value)
		if err == nil {
			u, err := a.store.UserByID(sess.UserID)
			return u, err == nil && u.DeletedAt == nil
		}
	}
	rc, err := r.Cookie(rememberCookieName)
	if err != nil || rc.Value == "" {
		return nil, false
	}
	parts := strings.SplitN(rc.Value, ".", 2)
	if len(parts) != 2 {
		return nil, false
	}
	userID, err := a.store.ConsumeRememberToken(parts[0], parts[1])
	if err != nil {
		return nil, false
	}
	u, err := a.store.UserByID(userID)
	return u, err == nil && u.DeletedAt == nil
}

func (a *app) enforceRateLimit(bucket, subject string, window time.Duration, max int) error {
	cnt, err := a.store.CountRateLimitEvents(bucket, subject, time.Now().Add(-window))
	if err != nil {
		return err
	}
	if cnt >= max {
		return errors.New("rate limited")
	}
	return nil
}

func (a *app) verifyTurnstile(ctx context.Context, token, ip string) bool {
	if a.turnstileSecret == "" {
		log.Printf("turnstile verify failed: missing TURNSTILE_SECRET_KEY")
		return false
	}
	if strings.TrimSpace(token) == "" {
		log.Printf("turnstile verify failed: empty token")
		return false
	}
	vals := url.Values{}
	vals.Set("secret", a.turnstileSecret)
	vals.Set("response", token)
	vals.Set("remoteip", ip)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "https://challenges.cloudflare.com/turnstile/v0/siteverify", strings.NewReader(vals.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		log.Printf("turnstile verify failed: request error: %v", err)
		return false
	}
	defer resp.Body.Close()
	var out struct {
		Success    bool     `json:"success"`
		Hostname   string   `json:"hostname"`
		ErrorCodes []string `json:"error-codes"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		log.Printf("turnstile verify failed: decode error: %v", err)
		return false
	}
	if !out.Success {
		log.Printf("turnstile verify failed: error_codes=%v hostname=%s remote_ip=%s", out.ErrorCodes, out.Hostname, ip)
	}
	return out.Success
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func setCookie(w http.ResponseWriter, name, value string, maxAge int, persistent bool) {
	c := &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   true,
	}
	if persistent {
		c.MaxAge = maxAge
		c.Expires = time.Now().Add(time.Duration(maxAge) * time.Second)
	}
	if name == auth.CsrfCookieName {
		c.HttpOnly = false
		c.Secure = true
	}
	http.SetCookie(w, c)
}

func clearCookie(w http.ResponseWriter, name string) {
	http.SetCookie(w, &http.Cookie{
		Name:     name,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   true,
	})
}

func mustEnv(name, fallback string) string {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return fallback
	}
	return v
}

func envInt(name string, fallback int) int {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}

var (
	usernameRE = regexp.MustCompile(`^[A-Za-z0-9]{4,15}$`)
	passwordRE = regexp.MustCompile(`^[A-Za-z0-9[:punct:]]{4,15}$`)
)

func validUsername(v string) bool {
	return usernameRE.MatchString(v)
}

func validEmail(v string) bool {
	if len(v) < 5 || len(v) > 254 {
		return false
	}
	// RFC 5322 주소 파싱으로 기본 형식을 검증한다.
	addr, err := netmail.ParseAddress(v)
	if err != nil {
		return false
	}
	// ParseAddress 는 "Name <user@host>" 도 허용하므로, 입력과 주소부가 일치하는지 다시 확인한다.
	if !strings.EqualFold(addr.Address, v) {
		return false
	}
	at := strings.LastIndex(v, "@")
	if at <= 0 {
		return false
	}
	domain := v[at+1:]
	// TLD 가 반드시 있어야 실제로 유효한 메일 주소다.
	if !strings.Contains(domain, ".") || strings.HasPrefix(domain, ".") || strings.HasSuffix(domain, ".") {
		return false
	}
	return true
}

func validPassword(v string) bool {
	return passwordRE.MatchString(v)
}
