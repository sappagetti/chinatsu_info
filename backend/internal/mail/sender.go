package mail

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/smtp"
	"strings"
	"time"
)

type Sender struct {
	Host string
	Port string
	User string
	Pass string
	From string
}

func (s Sender) Send(to, subject, body string) error {
	addr := fmt.Sprintf("%s:%s", s.Host, s.Port)
	msgID := buildMessageID(s.From)
	safeSubject := strings.ReplaceAll(strings.ReplaceAll(subject, "\r", " "), "\n", " ")
	msg := []byte(
		"From: " + s.From + "\r\n" +
			"To: " + to + "\r\n" +
			"Subject: " + safeSubject + "\r\n" +
			"Date: " + time.Now().UTC().Format(time.RFC1123Z) + "\r\n" +
			"Message-ID: " + msgID + "\r\n" +
			"MIME-Version: 1.0\r\n" +
			"Content-Type: text/plain; charset=UTF-8\r\n" +
			"Content-Transfer-Encoding: 8bit\r\n\r\n" +
			body + "\r\n",
	)
	auth := smtp.PlainAuth("", s.User, s.Pass, s.Host)
	return smtp.SendMail(addr, auth, s.From, []string{to}, msg)
}

func buildMessageID(from string) string {
	domain := "localhost"
	if at := strings.LastIndex(from, "@"); at >= 0 && at+1 < len(from) {
		if d := strings.TrimSpace(from[at+1:]); d != "" {
			domain = d
		}
	}
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("<%d@%s>", time.Now().UTC().UnixNano(), domain)
	}
	return fmt.Sprintf("<%s.%d@%s>", hex.EncodeToString(buf), time.Now().UTC().UnixNano(), domain)
}
