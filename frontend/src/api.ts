// 백엔드 HTTP 호출 모음. VITE_API_URL이 비어 있으면 빈 문자열 → 같은 오리진(또는 Vite 프록시) 기준 URL.

const base = import.meta.env.VITE_API_URL?.replace(/\/$/, "") ?? "";

export async function signup(username: string, email: string, password: string, passwordConfirm: string, turnstileToken: string) {
  const res = await fetch(`${base}/api/v1/auth/signup`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      email,
      password,
      password_confirm: passwordConfirm,
      turnstile_token: turnstileToken,
      agree_policy: true,
      agree_terms: true,
    }),
  });
  if (!res.ok) {
    if (res.status === 429) {
      throw new Error("短時間に登録リクエストが集中しました。しばらく待ってから再度お試しください。");
    }
    if (res.status === 409) {
      const detail = (await res.text()).toLowerCase();
      if (detail.includes("email")) {
        throw new Error("このメールアドレスはすでに登録されています。ログインまたはパスワード再設定をご利用ください。");
      }
      if (detail.includes("username")) {
        throw new Error("このIDはすでに使われています。別のIDを入力してください。");
      }
      throw new Error("この情報はすでに使用されています。別の内容でお試しください。");
    }
    if (res.status === 400) {
      const detail = (await res.text()).toLowerCase();
      if (detail.includes("captcha")) {
        throw new Error("CAPTCHA の検証に失敗しました。もう一度お試しください。");
      }
      throw new Error("入力内容を確認してください。");
    }
    if (res.status === 502) {
      throw new Error("確認メールの送信に失敗しました。時間をおいて再度お試しください。");
    }
    throw new Error(`signup failed: ${res.status}`);
  }
}

export async function login(email: string, password: string, remember: boolean, turnstileToken?: string) {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, remember, turnstile_token: turnstileToken ?? "" }),
  });
  if (!res.ok) {
    const detail = (await res.text()).toLowerCase();
    if (res.status === 400 && detail.includes("captcha required")) {
      throw new Error("CAPTCHA_REQUIRED");
    }
    if (res.status === 403 && detail.includes("not verified")) {
      throw new Error("EMAIL_NOT_VERIFIED");
    }
    if (res.status === 401) {
      throw new Error("メールアドレスまたはパスワードが正しくありません。");
    }
    if (res.status === 400) {
      throw new Error("入力内容を確認してください。");
    }
    throw new Error(`login failed: ${res.status}`);
  }
}

export async function resendVerification(email: string, turnstileToken: string) {
  const res = await fetch(`${base}/api/v1/auth/resend-verification`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, turnstile_token: turnstileToken }),
  });
  if (!res.ok) {
    if (res.status === 429) {
      throw new Error("短時間に再送信が集中しました。しばらく待ってから再度お試しください。");
    }
    const detail = (await res.text()).toLowerCase();
    if (res.status === 400 && detail.includes("captcha")) {
      throw new Error("CAPTCHA の検証に失敗しました。もう一度お試しください。");
    }
    throw new Error("入力内容を確認してください。");
  }
}

export async function logout(csrfToken: string) {
  const res = await fetch(`${base}/api/v1/auth/logout`, {
    method: "POST",
    credentials: "include",
    headers: { "X-CSRF-Token": csrfToken },
  });
  if (!res.ok) throw new Error(`logout failed: ${res.status}`);
}

export async function forgotPassword(email: string, turnstileToken: string) {
  const res = await fetch(`${base}/api/v1/auth/forgot-password`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, turnstile_token: turnstileToken }),
  });
  if (!res.ok) throw new Error(`forgot password failed: ${res.status}`);
}

export async function resetPassword(token: string, newPassword: string) {
  const res = await fetch(`${base}/api/v1/auth/reset-password`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, new_password: newPassword }),
  });
  if (!res.ok) {
    if (res.status === 400) {
      const detail = (await res.text()).toLowerCase();
      if (detail.includes("weak password")) {
        throw new Error("パスワードは10文字以上で入力してください。");
      }
      if (detail.includes("invalid token")) {
        throw new Error("再設定リンクが無効か、期限切れです。もう一度パスワード再設定をお試しください。");
      }
      throw new Error("入力内容を確認して、もう一度お試しください。");
    }
    throw new Error("パスワードの再設定に失敗しました。時間をおいて再度お試しください。");
  }
}

export async function deleteAccount(csrfToken: string) {
  const res = await fetch(`${base}/api/v1/auth/account`, {
    method: "DELETE",
    credentials: "include",
    headers: { "X-CSRF-Token": csrfToken },
  });
  if (!res.ok) throw new Error(`delete account failed: ${res.status}`);
}

export async function authMe() {
  const res = await fetch(`${base}/api/v1/auth/me`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`auth me failed: ${res.status}`);
  return res.json() as Promise<{
    user_id: string;
    public_id: number;
    email: string;
    display_name: string;
    email_verified: boolean;
    ingest_token: string;
  }>;
}

/** GET /api/v1/me — Bearer ingest token으로 최신 스냅샷 조회(기존 호환). */
export async function fetchMe(token: string) {
  const res = await fetch(`${base}/api/v1/me`, {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`me failed: ${res.status}`);
  return res.json() as Promise<{
    user_id: string;
    display_name: string;
    ingest_token: string;
    last_payload: Record<string, unknown> | null;
    last_synced_at: string | null;
  }>;
}

export type RatedTrack = {
  name: string;
  difficulty: string;
  level: string;
  music_ex_id?: number;
  technical_high_score: number;
  platinum_high_score: number;
  platinum_star: number;
  lamp_for_rating: string;
  tech_rate: number;
  plat_rate: number;
};

type RatingTargetsResponse = {
  last_synced_at: string | null;
  new_top: RatedTrack[];
  old_top: RatedTrack[];
  plat_top: RatedTrack[];
};

export async function fetchRatingTargets(token: string): Promise<RatingTargetsResponse> {
  const res = await fetch(`${base}/api/v1/rating-targets`, {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`rating-targets failed: ${res.status}`);
  return res.json() as Promise<RatingTargetsResponse>;
}

/** POST /api/v1/bookmarklet-session — 짧은 북마크릿용 일회(시간 제한) 세션 ID 발급 */
export async function createBookmarkletSession(
  token: string,
  apiBase: string,
  beatmapBucketUrl: string,
) {
  const res = await fetch(`${base}/api/v1/bookmarklet-session`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      api_base: apiBase,
      beatmap_bucket_url: beatmapBucketUrl,
    }),
  });
  if (!res.ok) throw new Error(`bookmarklet-session failed: ${res.status}`);
  return res.json() as Promise<{
    bookmarklet_session_id: string;
    expires_at: string;
    reissue_available_at: string;
    reused: boolean;
  }>;
}

export async function getBookmarkletSession(token: string) {
  const res = await fetch(`${base}/api/v1/bookmarklet-session`, {
    credentials: "include",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`bookmarklet-session get failed: ${res.status}`);
  return res.json() as Promise<{
    bookmarklet_session_id: string;
    expires_at: string | null;
    reissue_available_at: string | null;
    has_active: boolean;
    has_cooldown: boolean;
  }>;
}
