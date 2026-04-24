package store

import (
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
)

func hashToken(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

func (s *Store) CreateAuthUser(username, email, passwordHash string) (*User, error) {
	id := uuid.NewString()
	token := uuid.NewString()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	username = strings.TrimSpace(username)
	email = strings.ToLower(strings.TrimSpace(email))
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	publicID, err := nextPublicIDTx(tx)
	if err != nil {
		return nil, err
	}
	_, err = tx.Exec(`
INSERT INTO users (id, public_id, username, display_name, ingest_token, email, password_hash, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`, id, publicID, username, username, token, email, passwordHash, now, now)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.UserByID(id)
}

func (s *Store) UserByEmail(email string) (*User, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	row := s.db.QueryRow(`
SELECT id, public_id, username, display_name, ingest_token, email, password_hash, email_verified_at, deleted_at, created_at
FROM users WHERE email = ? AND deleted_at IS NULL
`, email)
	var u User
	var created string
	var verifiedAt sql.NullString
	var deletedAt sql.NullString
	var publicID sql.NullInt64
	if err := row.Scan(&u.ID, &publicID, &u.Username, &u.DisplayName, &u.IngestToken, &u.Email, &u.PasswordHash, &verifiedAt, &deletedAt, &created); err != nil {
		return nil, err
	}
	if publicID.Valid {
		u.PublicID = publicID.Int64
	}
	u.CreatedAt, _ = time.Parse(time.RFC3339Nano, created)
	if verifiedAt.Valid {
		t, _ := time.Parse(time.RFC3339Nano, verifiedAt.String)
		u.EmailVerifiedAt = &t
	}
	if deletedAt.Valid {
		t, _ := time.Parse(time.RFC3339Nano, deletedAt.String)
		u.DeletedAt = &t
	}
	return &u, nil
}

func (s *Store) UserByID(userID string) (*User, error) {
	row := s.db.QueryRow(`
SELECT id, public_id, username, display_name, ingest_token, email, password_hash, email_verified_at, deleted_at, created_at
FROM users WHERE id = ?
`, userID)
	var u User
	var created string
	var verifiedAt sql.NullString
	var deletedAt sql.NullString
	var publicID sql.NullInt64
	if err := row.Scan(&u.ID, &publicID, &u.Username, &u.DisplayName, &u.IngestToken, &u.Email, &u.PasswordHash, &verifiedAt, &deletedAt, &created); err != nil {
		return nil, err
	}
	if publicID.Valid {
		u.PublicID = publicID.Int64
	}
	u.CreatedAt, _ = time.Parse(time.RFC3339Nano, created)
	if verifiedAt.Valid {
		t, _ := time.Parse(time.RFC3339Nano, verifiedAt.String)
		u.EmailVerifiedAt = &t
	}
	if deletedAt.Valid {
		t, _ := time.Parse(time.RFC3339Nano, deletedAt.String)
		u.DeletedAt = &t
	}
	return &u, nil
}

// CreateEmailVerificationToken: 기존 미사용 토큰을 무효화한 뒤 새 토큰을 저장한다(평문은 호출자만 보관).
func (s *Store) CreateEmailVerificationToken(userID, rawToken string, ttl time.Duration) error {
	now := time.Now().UTC()
	expires := now.Add(ttl).Format(time.RFC3339Nano)
	nnow := now.Format(time.RFC3339Nano)
	if _, err := s.db.Exec(
		`UPDATE email_verification_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL`,
		nnow, userID,
	); err != nil {
		return err
	}
	_, err := s.db.Exec(`
INSERT INTO email_verification_tokens (user_id, token_hash, expires_at, created_at)
VALUES (?, ?, ?, ?)
`, userID, hashToken(rawToken), expires, nnow)
	return err
}

// CompleteEmailVerification: 토큰 1회 검증 + 사용자 메일 인증 완료를 한 트랜잭션으로 처리한다.
func (s *Store) CompleteEmailVerification(rawToken string) (string, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()

	row := tx.QueryRow(`
SELECT id, user_id, expires_at, used_at FROM email_verification_tokens WHERE token_hash = ?
`, hashToken(rawToken))
	var id int64
	var userID, expiresAt string
	var usedAt sql.NullString
	if err := row.Scan(&id, &userID, &expiresAt, &usedAt); err != nil {
		return "", err
	}
	if usedAt.Valid {
		return "", errors.New("token already used")
	}
	exp, _ := time.Parse(time.RFC3339Nano, expiresAt)
	if time.Now().UTC().After(exp) {
		return "", errors.New("token expired")
	}
	if _, err := tx.Exec(`UPDATE email_verification_tokens SET used_at = ? WHERE id = ?`, now, id); err != nil {
		return "", err
	}
	if _, err := tx.Exec(`UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`, now, now, userID); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return userID, nil
}

func (s *Store) UpdatePassword(userID, passwordHash string) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.Exec(`UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`, passwordHash, now, userID)
	return err
}

func (s *Store) SoftDeleteUser(userID string) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.Exec(`UPDATE users SET deleted_at = ?, updated_at = ? WHERE id = ?`, now, now, userID)
	return err
}

// CreatePasswordResetToken: 기존 미사용 리셋 토큰을 모두 사용 처리한 뒤 새 토큰을 저장한다.
// 같은 사용자의 과거 토큰이 우연히 유효한 상태로 남아 있는 경우를 막기 위함.
func (s *Store) CreatePasswordResetToken(userID, rawToken string, ttl time.Duration) error {
	now := time.Now().UTC()
	expires := now.Add(ttl).Format(time.RFC3339Nano)
	nnow := now.Format(time.RFC3339Nano)
	if _, err := s.db.Exec(
		`UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL`,
		nnow, userID,
	); err != nil {
		return err
	}
	_, err := s.db.Exec(`
INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, created_at)
VALUES (?, ?, ?, ?)
`, userID, hashToken(rawToken), expires, nnow)
	return err
}

func (s *Store) ConsumePasswordResetToken(rawToken string) (string, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()

	row := tx.QueryRow(`
SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?
`, hashToken(rawToken))
	var id int64
	var userID, expiresAt string
	var usedAt sql.NullString
	if err := row.Scan(&id, &userID, &expiresAt, &usedAt); err != nil {
		return "", err
	}
	if usedAt.Valid {
		return "", errors.New("token already used")
	}
	exp, _ := time.Parse(time.RFC3339Nano, expiresAt)
	if time.Now().UTC().After(exp) {
		return "", errors.New("token expired")
	}
	if _, err := tx.Exec(`UPDATE password_reset_tokens SET used_at = ? WHERE id = ?`, now, id); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return userID, nil
}

func (s *Store) RevokeAllPasswordResetTokens(userID string) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.Exec(`UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL`, now, userID)
	return err
}

func (s *Store) RecordRateLimitEvent(bucket, subject string) error {
	_, err := s.db.Exec(
		`INSERT INTO rate_limit_events (bucket, subject, created_at) VALUES (?, ?, ?)`,
		bucket, subject, time.Now().UTC().Format(time.RFC3339Nano),
	)
	return err
}

func (s *Store) CountRateLimitEvents(bucket, subject string, since time.Time) (int, error) {
	row := s.db.QueryRow(`
SELECT COUNT(*) FROM rate_limit_events WHERE bucket = ? AND subject = ? AND created_at >= ?
`, bucket, subject, since.UTC().Format(time.RFC3339Nano))
	var cnt int
	if err := row.Scan(&cnt); err != nil {
		return 0, err
	}
	return cnt, nil
}

func (s *Store) RecordLoginFailure(email, ip string) error {
	email = strings.ToLower(strings.TrimSpace(email))
	_, err := s.db.Exec(
		`INSERT INTO login_failures (email, ip, created_at) VALUES (?, ?, ?)`,
		email, ip, time.Now().UTC().Format(time.RFC3339Nano),
	)
	return err
}

func (s *Store) ClearLoginFailures(email, ip string) error {
	email = strings.ToLower(strings.TrimSpace(email))
	_, err := s.db.Exec(`DELETE FROM login_failures WHERE email = ? AND ip = ?`, email, ip)
	return err
}

func (s *Store) CountLoginFailures(email, ip string, since time.Time) (int, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	row := s.db.QueryRow(`
SELECT COUNT(*) FROM login_failures WHERE email = ? AND ip = ? AND created_at >= ?
`, email, ip, since.UTC().Format(time.RFC3339Nano))
	var cnt int
	if err := row.Scan(&cnt); err != nil {
		return 0, err
	}
	return cnt, nil
}

func (s *Store) CreateRememberToken(userID, selector, validator string, ttl time.Duration) error {
	now := time.Now().UTC()
	_, err := s.db.Exec(`
INSERT INTO remember_tokens (user_id, selector, validator_hash, expires_at, created_at)
VALUES (?, ?, ?, ?, ?)
`, userID, selector, hashToken(validator), now.Add(ttl).Format(time.RFC3339Nano), now.Format(time.RFC3339Nano))
	return err
}

func (s *Store) ConsumeRememberToken(selector, validator string) (string, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := s.db.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()

	row := tx.QueryRow(`
SELECT id, user_id, validator_hash, expires_at, used_at, revoked_at
FROM remember_tokens WHERE selector = ?
`, selector)
	var id int64
	var userID, validatorHash, expiresAt string
	var usedAt, revokedAt sql.NullString
	if err := row.Scan(&id, &userID, &validatorHash, &expiresAt, &usedAt, &revokedAt); err != nil {
		return "", err
	}
	if usedAt.Valid || revokedAt.Valid {
		return "", errors.New("invalid remember token")
	}
	expectedHash := hashToken(validator)
	if subtle.ConstantTimeCompare([]byte(validatorHash), []byte(expectedHash)) != 1 {
		return "", errors.New("invalid remember token")
	}
	exp, _ := time.Parse(time.RFC3339Nano, expiresAt)
	if time.Now().UTC().After(exp) {
		return "", errors.New("remember token expired")
	}
	if _, err := tx.Exec(`UPDATE remember_tokens SET used_at = ? WHERE id = ?`, now, id); err != nil {
		return "", err
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return userID, nil
}

func (s *Store) RevokeRememberTokensByUser(userID string) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err := s.db.Exec(`UPDATE remember_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`, now, userID)
	return err
}
