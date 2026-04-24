// 전역 레이아웃(헤더 + 라우트). 사용자에게 보이는 라벨은 일본어 유지.
import { Link, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { useAuth } from "./auth/AuthContext";
import { GuestOnly, RequireAuth } from "./auth/guards";
import { HomePage } from "./pages/HomePage";
import { SetupPage } from "./pages/SetupPage";
import { RatingTargetsPage } from "./pages/RatingTargetsPage";
import { PolicyPage } from "./pages/PolicyPage";
import { SongCatalogPage } from "./pages/SongCatalogPage";
import { AchievementBoardPage } from "./pages/AchievementBoardPage";
import { LoginPage } from "./pages/LoginPage";
import { SignupPage } from "./pages/SignupPage";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";
import { ResendVerificationPage } from "./pages/ResendVerificationPage";
import { AccountSettingsPage } from "./pages/AccountSettingsPage";
import { TermsPage } from "./pages/TermsPage";
import { RatingSimulatorPage } from "./pages/RatingSimulatorPage";

export default function App() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const stored = localStorage.getItem("theme");
    return stored === "dark" ? "dark" : "light";
  });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);
  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

  return (
    <div className="layout">
      <header className="header">
        <Link to="/" className="brand">
          <img src="/favicon-hanamaru.png" alt="" className="brand-mark" aria-hidden="true" />
          <span>Chinatsu Info</span>
        </Link>
        <div className="header-actions">
          {mobileMenuOpen ? <button type="button" className="mobile-menu-backdrop" aria-label="メニューを閉じる" onClick={() => setMobileMenuOpen(false)} /> : null}
          <button
            type="button"
            className="menu-toggle"
            aria-expanded={mobileMenuOpen}
            aria-label="メニューを開く"
            onClick={() => setMobileMenuOpen((v) => !v)}
          >
            <span />
            <span />
            <span />
          </button>
          <nav className={`nav ${mobileMenuOpen ? "open" : ""}`}>
            <NavLink to="/" className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>ホーム</NavLink>
            {user ? (
              <NavLink to="/setup" className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>ブックマーク</NavLink>
            ) : (
              <NavLink to="/signup" className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>会員登録</NavLink>
            )}
            {user ? (
              <NavLink to="/rating" className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>レーティング対象</NavLink>
            ) : (
              <NavLink to="/login" className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>ログイン</NavLink>
            )}
            {user && <NavLink to="/achievement" className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>レコード</NavLink>}
            {user && <NavLink to="/rating-sim" className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>目標計算</NavLink>}
            <NavLink to="/songs" className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>楽曲データ</NavLink>
            {user ? (
              <>
                <NavLink to="/account" className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>プロフィール</NavLink>
                <button type="button" className="btn nav-logout-btn" onClick={() => void logout()}>
                  ログアウト
                </button>
              </>
            ) : null}
          </nav>
          <label className="theme-toggle" title="テーマ切替">
            <input
              type="checkbox"
              checked={theme === "dark"}
              onChange={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
            />
            <span className="theme-toggle-track" />
            <span className="theme-toggle-label">{theme === "dark" ? "Dark" : "Light"}</span>
          </label>
        </div>
      </header>
      <main className="main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/signup" element={<GuestOnly><SignupPage /></GuestOnly>} />
          <Route path="/login" element={<GuestOnly><LoginPage /></GuestOnly>} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/resend-verification" element={<GuestOnly><ResendVerificationPage /></GuestOnly>} />
          <Route path="/setup" element={<RequireAuth><SetupPage /></RequireAuth>} />
          <Route path="/rating" element={<RequireAuth><RatingTargetsPage /></RequireAuth>} />
          <Route path="/achievement" element={<RequireAuth><AchievementBoardPage /></RequireAuth>} />
          <Route path="/rating-sim" element={<RequireAuth><RatingSimulatorPage /></RequireAuth>} />
          <Route path="/account" element={<RequireAuth><AccountSettingsPage /></RequireAuth>} />
          <Route path="/songs" element={<SongCatalogPage />} />
          <Route path="/policy" element={<PolicyPage />} />
          <Route path="/terms" element={<TermsPage />} />
        </Routes>
      </main>
      <footer className="footer">
        <div className="footer-inner">
          <span>Unofficial Fanmade Site of ONGEKI / SEGA</span>
          <Link to="/policy">運営ポリシー</Link>
        </div>
      </footer>
    </div>
  );
}
