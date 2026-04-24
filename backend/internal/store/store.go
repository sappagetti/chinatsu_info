// store 패키지: SQLite에 사용자(users)와 수집 스냅샷(snapshots)을 저장한다.
// ORM 없이 database/sql만 사용한다.
package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite" // 드라이버 등록(import 시 부수효과로 "sqlite" 이름 사용 가능)
)

// public_id 발급 범위: 6자리 (100000 ~ 999999).
const (
	publicIDMin   int64 = 100000
	publicIDMax   int64 = 999999
	publicIDRange int64 = publicIDMax - publicIDMin + 1
)

// User: 인포 사이트에 등록된 한 명. IngestToken으로 북마크릿 요청을 인증한다.
type User struct {
	ID          string
	PublicID    int64
	Username    string
	DisplayName string
	IngestToken string
	Email       string
	PasswordHash string
	EmailVerifiedAt *time.Time
	DeletedAt   *time.Time
	CreatedAt   time.Time
}

// Snapshot: 특정 시점에 북마크릿이 보낸 JSON 한 번 분량. Payload는 게임마다 다른 형태를 허용한다.
type Snapshot struct {
	ID        int64
	UserID    string
	Payload   map[string]any
	CreatedAt time.Time
}

// Store: DB 연결 래퍼.
type Store struct {
	db *sql.DB
}

// Open: SQLite 파일을 열고, 테이블이 없으면 migrate로 만든다.
// WAL + busy_timeout + foreign_keys 를 활성화한다. WAL 은 DB 파일 단위로 영속되고
// 나머지는 연결 단위이므로 커넥션 수를 1 로 고정해 초기 PRAGMA 가 항상 적용되도록 한다.
func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	// MaxOpenConns = 1 로 두면 내부적으로 같은 연결이 재사용되므로, 아래 PRAGMA 는
	// 애플리케이션이 살아 있는 동안 유지된다.
	db.SetMaxOpenConns(1)
	for _, pragma := range []string{
		"PRAGMA journal_mode = WAL;",
		"PRAGMA synchronous = NORMAL;",
		"PRAGMA foreign_keys = ON;",
		"PRAGMA busy_timeout = 5000;",
	} {
		if _, err := db.Exec(pragma); err != nil {
			_ = db.Close()
			return nil, fmt.Errorf("pragma %q: %w", pragma, err)
		}
	}
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

// migrate: 최초 실행 시 users / snapshots 테이블과 인덱스를 생성한다.
// IF NOT EXISTS 이므로 이미 있으면 그대로 둔다.
func (s *Store) migrate() error {
	_, err := s.db.Exec(`
CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	display_name TEXT NOT NULL DEFAULT '',
	ingest_token TEXT NOT NULL UNIQUE,
	created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT NOT NULL REFERENCES users(id),
	payload TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_user ON snapshots(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS email_verification_tokens (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT NOT NULL REFERENCES users(id),
	token_hash TEXT NOT NULL UNIQUE,
	expires_at TEXT NOT NULL,
	used_at TEXT,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verify_tokens_user ON email_verification_tokens(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS password_reset_tokens (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT NOT NULL REFERENCES users(id),
	token_hash TEXT NOT NULL UNIQUE,
	expires_at TEXT NOT NULL,
	used_at TEXT,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reset_tokens_user ON password_reset_tokens(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS remember_tokens (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT NOT NULL REFERENCES users(id),
	selector TEXT NOT NULL UNIQUE,
	validator_hash TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	used_at TEXT,
	revoked_at TEXT,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_remember_user ON remember_tokens(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS rate_limit_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	bucket TEXT NOT NULL,
	subject TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_lookup ON rate_limit_events(bucket, subject, created_at DESC);
CREATE TABLE IF NOT EXISTS login_failures (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	email TEXT NOT NULL,
	ip TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_fail_email_ip ON login_failures(email, ip, created_at DESC);
`)
	if err != nil {
		return err
	}
	if err := s.ensureUserColumn("email", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	if err := s.ensureUserColumn("password_hash", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	if err := s.ensureUserColumn("email_verified_at", "TEXT"); err != nil {
		return err
	}
	if err := s.ensureUserColumn("deleted_at", "TEXT"); err != nil {
		return err
	}
	if err := s.ensureUserColumn("updated_at", "TEXT"); err != nil {
		return err
	}
	if err := s.ensureUserColumn("public_id", "INTEGER"); err != nil {
		return err
	}
	if err := s.ensureUserColumn("username", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	_, err = s.db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email) WHERE email <> ''`)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_unique ON users(username) WHERE username <> ''`)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_public_id_unique ON users(public_id) WHERE public_id IS NOT NULL`)
	if err != nil {
		return err
	}
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY)`); err != nil {
		return err
	}
	var migCount int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM app_migrations WHERE name = 'email_verify_backfill_v1'`).Scan(&migCount); err != nil {
		return err
	}
	if migCount == 0 {
		// 메일 인증 도입 시점 이전の既存アカウントのみ一回限り: 認証済みとみなす。
		if _, err := s.db.Exec(`
UPDATE users SET email_verified_at = created_at
WHERE email_verified_at IS NULL AND password_hash <> '' AND deleted_at IS NULL
`); err != nil {
			return err
		}
		if _, err := s.db.Exec(`INSERT INTO app_migrations (name) VALUES ('email_verify_backfill_v1')`); err != nil {
			return err
		}
	}
	// public_id 난수화 마이그레이션: 순차 번호(1,2,3,...)로 발급된 기존 public_id를
	// 한 번에 6자리 난수로 재할당한다. 이미 사용 중인 곳은 없다는 전제.
	var pidMig int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM app_migrations WHERE name = 'public_id_randomize_v1'`).Scan(&pidMig); err != nil {
		return err
	}
	if pidMig == 0 {
		if err := s.randomizeExistingPublicIDs(); err != nil {
			return err
		}
		if _, err := s.db.Exec(`INSERT INTO app_migrations (name) VALUES ('public_id_randomize_v1')`); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) ensureUserColumn(name string, columnDef string) error {
	rows, err := s.db.Query(`PRAGMA table_info(users)`)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var colName, colType string
		var notNull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &colName, &colType, &notNull, &dflt, &pk); err != nil {
			return err
		}
		if strings.EqualFold(colName, name) {
			return nil
		}
	}
	_, err = s.db.Exec(fmt.Sprintf("ALTER TABLE users ADD COLUMN %s %s", name, columnDef))
	return err
}

// CreateUser: UUID로 user id와 ingest_token을 새로 만들어 한 행 삽입한다.
func (s *Store) CreateUser(displayName string) (*User, error) {
	id := uuid.NewString()
	token := uuid.NewString()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	publicID, err := nextPublicIDTx(tx)
	if err != nil {
		return nil, err
	}
	_, err = tx.Exec(
		`INSERT INTO users (id, public_id, display_name, ingest_token, created_at) VALUES (?, ?, ?, ?, ?)`,
		id, publicID, displayName, token, now,
	)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &User{ID: id, PublicID: publicID, DisplayName: displayName, IngestToken: token, CreatedAt: time.Now().UTC()}, nil
}

// UserByIngestToken: 북마크릿이 보낸 토큰으로 사용자 한 명을 찾는다. 없으면 sql.ErrNoRows.
func (s *Store) UserByIngestToken(token string) (*User, error) {
	row := s.db.QueryRow(
		`SELECT id, public_id, username, display_name, ingest_token, email, password_hash, email_verified_at, deleted_at, created_at FROM users WHERE ingest_token = ?`,
		token,
	)
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

// randomPublicID: 100000~999999 범위의 균일 난수를 반환한다.
// crypto/rand가 실패하면 에러로 올린다(시간 기반 폴백을 쓰지 않는 이유:
// 마이그레이션·신규가입 둘 다 충돌을 피해야 하므로 엔트로피가 약한 소스는 피한다).
func randomPublicID() (int64, error) {
	n, err := rand.Int(rand.Reader, big.NewInt(publicIDRange))
	if err != nil {
		return 0, err
	}
	return publicIDMin + n.Int64(), nil
}

// nextPublicIDTx: 사용자 INSERT용 public_id를 난수로 뽑아 현재 users 테이블과 중복이 없는 값을 반환한다.
// 동일 트랜잭션 내 미커밋 행은 SELECT로 보이지 않을 수 있어, 최종 신뢰는 users(public_id) 유니크 인덱스에 맡긴다.
func nextPublicIDTx(tx *sql.Tx) (int64, error) {
	const maxAttempts = 200
	for i := 0; i < maxAttempts; i++ {
		id, err := randomPublicID()
		if err != nil {
			return 0, err
		}
		var cnt int
		if err := tx.QueryRow(`SELECT COUNT(1) FROM users WHERE public_id = ?`, id).Scan(&cnt); err != nil {
			return 0, err
		}
		if cnt == 0 {
			return id, nil
		}
	}
	return 0, errors.New("could not allocate unique public_id after retries")
}

// randomizeExistingPublicIDs: 기존 사용자의 public_id를 모두 6자리 난수로 재할당한다.
// 유니크 인덱스 충돌을 피하기 위해 먼저 전부 NULL로 비우고, 한 사용자씩 새 값으로 채운다.
func (s *Store) randomizeExistingPublicIDs() error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	rows, err := tx.Query(`SELECT id FROM users WHERE public_id IS NOT NULL ORDER BY public_id`)
	if err != nil {
		return err
	}
	var userIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		userIDs = append(userIDs, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	if len(userIDs) == 0 {
		return tx.Commit()
	}

	if _, err := tx.Exec(`UPDATE users SET public_id = NULL`); err != nil {
		return err
	}

	used := make(map[int64]struct{}, len(userIDs))
	const maxAttempts = 1000
	for _, uid := range userIDs {
		var assigned int64
		for attempt := 0; attempt < maxAttempts; attempt++ {
			id, err := randomPublicID()
			if err != nil {
				return err
			}
			if _, dup := used[id]; dup {
				continue
			}
			assigned = id
			break
		}
		if assigned == 0 {
			return errors.New("could not allocate unique public_id during migration")
		}
		if _, err := tx.Exec(`UPDATE users SET public_id = ? WHERE id = ?`, assigned, uid); err != nil {
			return err
		}
		used[assigned] = struct{}{}
	}
	return tx.Commit()
}

// SaveSnapshot: payload 맵을 JSON 문자열로 만든 뒤 snapshots에 append한다. 이력 전부 보존.
func (s *Store) SaveSnapshot(userID string, payload map[string]any) error {
	if shouldMergePartial(payload) {
		prev, err := s.LatestSnapshot(userID)
		if err == nil && prev != nil {
			payload = mergeSnapshotPayload(prev.Payload, payload)
		}
	}
	b, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	_, err = s.db.Exec(
		`INSERT INTO snapshots (user_id, payload, created_at) VALUES (?, ?, ?)`,
		userID, string(b), now,
	)
	return err
}

func shouldMergePartial(payload map[string]any) bool {
	v, ok := payload["full_snapshot"]
	if !ok {
		return false
	}
	b, ok := v.(bool)
	return ok && !b
}

func rowKey(row map[string]any) string {
	if mid, ok := row["music_ex_id"].(string); ok {
		mid = strings.TrimSpace(mid)
		if mid != "" {
			dif, _ := row["difficulty"].(string)
			return "id::" + mid + "::" + dif
		}
	}
	name, _ := row["name"].(string)
	dif, _ := row["difficulty"].(string)
	level, _ := row["level"].(string)
	return name + "::" + dif + "::" + level
}

func toRowSlice(v any) []map[string]any {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(arr))
	for _, e := range arr {
		m, ok := e.(map[string]any)
		if ok {
			out = append(out, m)
		}
	}
	return out
}

func mergeSnapshotPayload(prev map[string]any, incoming map[string]any) map[string]any {
	merged := make(map[string]any, len(prev)+len(incoming))
	for k, v := range prev {
		merged[k] = v
	}
	for k, v := range incoming {
		merged[k] = v
	}

	prevRows := toRowSlice(prev["scores"])
	incRows := toRowSlice(incoming["scores"])
	if len(prevRows) == 0 || len(incRows) == 0 {
		return merged
	}

	prevMap := make(map[string]map[string]any, len(prevRows))
	order := make([]string, 0, len(prevRows)+len(incRows))
	for _, r := range prevRows {
		k := rowKey(r)
		if _, seen := prevMap[k]; !seen {
			order = append(order, k)
		}
		prevMap[k] = r
	}
	for _, r := range incRows {
		k := rowKey(r)
		if _, seen := prevMap[k]; !seen {
			order = append(order, k)
		}
		prevMap[k] = r
	}

	finalRows := make([]any, 0, len(prevMap))
	for _, k := range order {
		if r, ok := prevMap[k]; ok {
			finalRows = append(finalRows, r)
		}
	}
	merged["scores"] = finalRows
	merged["row_count"] = len(finalRows)
	if v, ok := incoming["total_row_count"]; ok {
		merged["row_count"] = v
	}
	merged["full_snapshot"] = true
	return merged
}

// LatestSnapshot: 해당 사용자의 가장 최근 스냅샷 한 건. 없으면 sql.ErrNoRows.
func (s *Store) LatestSnapshot(userID string) (*Snapshot, error) {
	row := s.db.QueryRow(
		`SELECT id, user_id, payload, created_at FROM snapshots WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
		userID,
	)
	var snap Snapshot
	var payloadJSON, created string
	if err := row.Scan(&snap.ID, &snap.UserID, &payloadJSON, &created); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		return nil, err
	}
	if err := json.Unmarshal([]byte(payloadJSON), &snap.Payload); err != nil {
		return nil, err
	}
	snap.CreatedAt, _ = time.Parse(time.RFC3339Nano, created)
	return &snap, nil
}
