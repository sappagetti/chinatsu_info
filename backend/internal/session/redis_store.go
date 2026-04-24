package session

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

type Session struct {
	UserID    string `json:"user_id"`
	CreatedAt string `json:"created_at"`
}

type Store struct {
	rdb *redis.Client
}

func New(addr, password string, db int) *Store {
	rdb := redis.NewClient(&redis.Options{
		Addr:     addr,
		Password: password,
		DB:       db,
	})
	return &Store{rdb: rdb}
}

func (s *Store) Ping(ctx context.Context) error {
	return s.rdb.Ping(ctx).Err()
}

func (s *Store) Set(ctx context.Context, sid string, sess Session, ttl time.Duration) error {
	b, err := json.Marshal(sess)
	if err != nil {
		return err
	}
	return s.rdb.Set(ctx, key(sid), string(b), ttl).Err()
}

func (s *Store) Get(ctx context.Context, sid string) (*Session, error) {
	v, err := s.rdb.Get(ctx, key(sid)).Result()
	if err != nil {
		return nil, err
	}
	var sess Session
	if err := json.Unmarshal([]byte(v), &sess); err != nil {
		return nil, err
	}
	return &sess, nil
}

func (s *Store) Delete(ctx context.Context, sid string) error {
	return s.rdb.Del(ctx, key(sid)).Err()
}

func (s *Store) DeleteUserSessions(ctx context.Context, userID string) error {
	iter := s.rdb.Scan(ctx, 0, "session:*", 0).Iterator()
	for iter.Next(ctx) {
		k := iter.Val()
		v, err := s.rdb.Get(ctx, k).Result()
		if err != nil {
			continue
		}
		var sess Session
		if json.Unmarshal([]byte(v), &sess) == nil && sess.UserID == userID {
			_ = s.rdb.Del(ctx, k).Err()
		}
	}
	return iter.Err()
}

func key(sid string) string {
	return fmt.Sprintf("session:%s", sid)
}
