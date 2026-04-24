import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { authMe, login as loginApi, logout as logoutApi } from "../api";

type AuthUser = {
  user_id: string;
  public_id: number;
  email: string;
  display_name: string;
  email_verified: boolean;
  ingest_token: string;
};

type AuthContextType = {
  user: AuthUser | null;
  loading: boolean;
  csrfToken: string;
  refresh: () => Promise<void>;
  login: (email: string, password: string, remember: boolean, turnstileToken?: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | null>(null);

function readCSRFTokenCookie() {
  const m = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "";
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [csrfToken, setCsrfToken] = useState("");

  const refresh = async () => {
    try {
      const me = await authMe();
      setUser(me);
      setCsrfToken(readCSRFTokenCookie());
    } catch {
      setUser(null);
      setCsrfToken("");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const value = useMemo<AuthContextType>(
    () => ({
      user,
      loading,
      csrfToken,
      refresh,
      async login(email, password, remember, turnstileToken) {
        await loginApi(email, password, remember, turnstileToken);
        await refresh();
      },
      async logout() {
        await logoutApi(csrfToken);
        setUser(null);
      },
    }),
    [user, loading, csrfToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("AuthProvider missing");
  return ctx;
}
